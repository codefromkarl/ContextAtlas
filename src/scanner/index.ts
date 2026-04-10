import fs from 'node:fs/promises';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getEmbeddingConfig } from '../config.js';
import {
  batchDelete,
  batchUpdateMtime,
  batchUpsert,
  clear,
  closeDb,
  type FileMeta,
  generateProjectId,
  getAllFileMeta,
  getAllPaths,
  getFilesNeedingVectorIndex,
  getStoredIndexContentSchemaVersion,
  getStoredEmbeddingDimensions,
  initDb,
  setStoredIndexContentSchemaVersion,
  setStoredEmbeddingDimensions,
} from '../db/index.js';
import { GraphStore } from '../graph/GraphStore.js';
import { getIndexer } from '../indexer/index.js';
import { closeAllCachedResources } from '../runtime/closeAllCachedResources.js';
import {
  commitSnapshot,
  ensureSnapshotArtifacts,
  prepareWritableSnapshot,
  pruneSnapshots,
  validateSnapshot,
} from '../storage/layout.js';
import { logger } from '../utils/logger.js';
import type { IncrementalExecutionHint } from '../indexing/types.js';
import { crawl } from './crawler.js';
import { initFilter } from './filter.js';
import { type ProcessResult, processFiles } from './processor.js';
import { INDEX_CONTENT_SCHEMA_VERSION } from './processor.js';

function syncGraphArtifacts(db: Database.Database, results: ProcessResult[]): void {
  const store = new GraphStore(db);
  for (const result of results) {
    if (result.status !== 'added' && result.status !== 'modified') continue;
    if (result.graph) {
      store.upsertFile(result.relPath, result.graph);
    } else {
      store.deleteFile(result.relPath);
    }
  }
}

function deleteGraphArtifacts(db: Database.Database, paths: string[]): void {
  const store = new GraphStore(db);
  for (const filePath of paths) {
    store.deleteFile(filePath);
  }
}

/**
 * 扫描结果统计
 */
export interface ScanStats {
  totalFiles: number;
  added: number;
  modified: number;
  unchanged: number;
  deleted: number;
  skipped: number;
  errors: number;
  /** 向量索引统计 */
  vectorIndex?: {
    indexed: number;
    deleted: number;
    errors: number;
  };
}

export interface ProcessResultsSummary {
  added: number;
  modified: number;
  unchanged: number;
  skipped: number;
  errors: number;
  toAdd: FileMeta[];
  toUpdateMtime: Array<{ path: string; mtime: number }>;
}

export interface ScanStatsDelta {
  added: number;
  modified: number;
  unchanged: number;
  deleted: number;
  skipped: number;
  errors: number;
  vectorIndex?: {
    indexed: number;
    deleted: number;
    errors: number;
  };
}

/**
 * 进度回调函数类型
 *
 * @param current 当前进度值
 * @param total 总进度值（可选，未知时为 undefined）
 * @param message 人可读的进度消息（可选）
 */
export type ProgressCallback = (current: number, total?: number, message?: string) => void;

/**
 * 扫描选项
 */
export interface ScanOptions {
  /** 强制重新扫描所有文件 */
  force?: boolean;
  /** 是否进行向量索引（默认 true） */
  vectorIndex?: boolean;
  /** 指定写入快照 ID（默认读取 current/legacy） */
  snapshotId?: string | null;
  /** 进度回调 */
  onProgress?: ProgressCallback;
  /** 需要进入向量阶段前，按需补齐快照中的向量工件 */
  ensureVectorArtifacts?: (() => void | Promise<void>) | null;
}

export interface SnapshotScanOptions extends Omit<ScanOptions, 'snapshotId'> {
  /** 保留最近快照数量（额外保留 current），默认 5 */
  snapshotRetention?: number;
  /** 是否在切换 current 前做健康检查，默认 true */
  validateBeforeSwap?: boolean;
  /** 预扫描生成的增量执行提示 */
  incrementalHint?: IncrementalExecutionHint | null;
  /** 预先确认无需索引时直接返回的统计结果 */
  noopStats?: ScanStats | null;
}

export function summarizeProcessResults(results: ProcessResult[]): ProcessResultsSummary {
  const summary: ProcessResultsSummary = {
    added: 0,
    modified: 0,
    unchanged: 0,
    skipped: 0,
    errors: 0,
    toAdd: [],
    toUpdateMtime: [],
  };

  for (const result of results) {
    switch (result.status) {
      case 'added':
        summary.added++;
        summary.toAdd.push({
          path: result.relPath,
          hash: result.hash,
          mtime: result.mtime,
          size: result.size,
          content: result.content,
          language: result.language,
          vectorIndexHash: null,
        });
        break;

      case 'modified':
        summary.modified++;
        summary.toAdd.push({
          path: result.relPath,
          hash: result.hash,
          mtime: result.mtime,
          size: result.size,
          content: result.content,
          language: result.language,
          vectorIndexHash: null,
        });
        break;

      case 'unchanged':
        summary.unchanged++;
        summary.toUpdateMtime.push({ path: result.relPath, mtime: result.mtime });
        break;

      case 'skipped':
        summary.skipped++;
        logger.debug({ path: result.relPath, reason: result.error }, '跳过文件');
        break;

      case 'error':
        summary.errors++;
        logger.error({ path: result.relPath, error: result.error }, '处理文件错误');
        break;
    }
  }

  return summary;
}

export function mergeScanStats(base: ScanStats, delta: ScanStatsDelta): ScanStats {
  const mergedVectorIndex =
    base.vectorIndex || delta.vectorIndex
      ? {
          indexed: (base.vectorIndex?.indexed ?? 0) + (delta.vectorIndex?.indexed ?? 0),
          deleted: (base.vectorIndex?.deleted ?? 0) + (delta.vectorIndex?.deleted ?? 0),
          errors: (base.vectorIndex?.errors ?? 0) + (delta.vectorIndex?.errors ?? 0),
        }
      : undefined;

  return {
    totalFiles: base.totalFiles,
    added: base.added + delta.added,
    modified: base.modified + delta.modified,
    unchanged: base.unchanged + delta.unchanged,
    deleted: base.deleted + delta.deleted,
    skipped: base.skipped + delta.skipped,
    errors: base.errors + delta.errors,
    vectorIndex: mergedVectorIndex,
  };
}

function createInitialScanStats(totalFiles: number, deleted: number): ScanStats {
  return {
    totalFiles,
    added: 0,
    modified: 0,
    unchanged: 0,
    deleted,
    skipped: 0,
    errors: 0,
  };
}

function createDeletedResults(paths: string[]): ProcessResult[] {
  return paths.map((filePath) => ({
    absPath: '',
    relPath: filePath,
    hash: '',
    content: null,
    chunks: [],
    language: '',
    mtime: 0,
    size: 0,
    status: 'deleted' as const,
  }));
}

function isFileStatMatch(expected: { mtime: number; size: number }, actual: { mtime: number; size: number }): boolean {
  return expected.size === actual.size && expected.mtime === actual.mtime;
}

async function validateIncrementalHint(
  rootPath: string,
  hint: IncrementalExecutionHint,
): Promise<boolean> {
  if (Date.now() - hint.generatedAt > hint.ttlMs) {
    return false;
  }

  const candidates = [...hint.candidates, ...hint.healingPaths];
  for (const item of candidates) {
    try {
      const stat = await fs.stat(path.join(rootPath, item.relPath));
      if (!isFileStatMatch(item, { mtime: stat.mtimeMs, size: stat.size })) {
        return false;
      }
    } catch {
      return false;
    }
  }

  for (const relPath of hint.deletedPaths) {
    try {
      await fs.stat(path.join(rootPath, relPath));
      return false;
    } catch {
      // expected missing
    }
  }

  return true;
}

async function scanWithIncrementalHint(
  rootPath: string,
  options: ScanOptions,
  hint: IncrementalExecutionHint,
): Promise<ScanStats | null> {
  if (!(await validateIncrementalHint(rootPath, hint))) {
    logger.info('增量执行提示已失效，回退到常规扫描');
    return null;
  }

  const projectId = generateProjectId(rootPath);
  const db = initDb(projectId, options.snapshotId);

  try {
    await initFilter(rootPath);

    let forceReindex = options.force ?? false;
    if (options.vectorIndex !== false) {
      const currentDimensions = getEmbeddingConfig().dimensions;
      const storedDimensions = getStoredEmbeddingDimensions(db);
      const storedSchemaVersion = getStoredIndexContentSchemaVersion(db);

      if (storedDimensions !== null && storedDimensions !== currentDimensions) {
        forceReindex = true;
      }

      if (
        storedSchemaVersion !== null
        && storedSchemaVersion !== INDEX_CONTENT_SCHEMA_VERSION
      ) {
        forceReindex = true;
      }

      setStoredEmbeddingDimensions(db, currentDimensions);
      setStoredIndexContentSchemaVersion(db, INDEX_CONTENT_SCHEMA_VERSION);
    }

    if (forceReindex) {
      return null;
    }

    const knownFiles = getAllFileMeta(db);
    const candidateFilePaths = hint.candidates.map((item) => path.join(rootPath, item.relPath));
    const candidateResults = candidateFilePaths.length > 0
      ? await processFiles(rootPath, candidateFilePaths, knownFiles)
      : [];
    const candidateSummary = summarizeProcessResults(candidateResults);

    if (candidateSummary.toAdd.length > 0) {
      batchUpsert(db, candidateSummary.toAdd);
    }
    syncGraphArtifacts(db, candidateResults);
    if (candidateSummary.toUpdateMtime.length > 0) {
      batchUpdateMtime(db, candidateSummary.toUpdateMtime);
    }

    if (hint.deletedPaths.length > 0) {
      batchDelete(db, hint.deletedPaths);
      deleteGraphArtifacts(db, hint.deletedPaths);
    }

    let stats: ScanStats = {
      totalFiles: hint.changeSummary.totalFiles,
      added: hint.changeSummary.added,
      modified: hint.changeSummary.modified,
      unchanged: hint.changeSummary.unchanged,
      deleted: hint.changeSummary.deleted,
      skipped: hint.changeSummary.skipped,
      errors: hint.changeSummary.errors,
    };

    if (options.vectorIndex !== false) {
      let vectorArtifactsReady = false;
      const ensureVectorArtifacts = async (): Promise<void> => {
        if (vectorArtifactsReady) return;
        await options.ensureVectorArtifacts?.();
        vectorArtifactsReady = true;
      };
      const embeddingConfig = getEmbeddingConfig();
      let indexer: Awaited<ReturnType<typeof getIndexer>> | null = null;
      const getOrCreateIndexer = async () => {
        await ensureVectorArtifacts();
        if (!indexer) {
          indexer = await getIndexer(projectId, embeddingConfig.dimensions, options.snapshotId);
        }
        return indexer;
      };
      let vectorDelta = { indexed: 0, deleted: 0, errors: 0 };
      let hasReportedVectorStage = false;

      if (candidateResults.length > 0) {
        hasReportedVectorStage = true;
        options.onProgress?.(45, 100, '正在准备向量索引...');
        const indexStats = await (await getOrCreateIndexer()).indexFiles(db, candidateResults, (completed, total) => {
          const progress = 45 + Math.floor((completed / total) * 54);
          options.onProgress?.(progress, 100, `正在生成向量嵌入... (${completed}/${total} 批次)`);
        });
        vectorDelta = {
          indexed: vectorDelta.indexed + indexStats.indexed,
          deleted: vectorDelta.deleted + indexStats.deleted,
          errors: vectorDelta.errors + indexStats.errors,
        };
      }

      if (hint.deletedPaths.length > 0) {
        if (!hasReportedVectorStage) {
          options.onProgress?.(45, 100, '正在准备向量索引...');
        }
        const deletedResults = createDeletedResults(hint.deletedPaths);
        const indexStats = await (await getOrCreateIndexer()).indexFiles(db, deletedResults);
        vectorDelta = {
          indexed: vectorDelta.indexed + indexStats.indexed,
          deleted: vectorDelta.deleted + indexStats.deleted,
          errors: vectorDelta.errors + indexStats.errors,
        };
      }

      if (hint.healingPaths.length > 0) {
        const healingFilePaths = hint.healingPaths.map((item) => path.join(rootPath, item.relPath));
        const processedHealingFiles = await processFiles(rootPath, healingFilePaths, new Map());
        const healingFiles = processedHealingFiles
          .filter((result) => result.status === 'added' || result.status === 'modified')
          .map((result) => ({ ...result, status: 'modified' as const }));

        if (healingFiles.length > 0) {
          if (!hasReportedVectorStage) {
            options.onProgress?.(45, 100, '正在准备向量索引...');
          }
          const indexStats = await (await getOrCreateIndexer()).indexFiles(db, healingFiles, (completed, total) => {
            const progress = 45 + Math.floor((completed / total) * 54);
            options.onProgress?.(progress, 100, `正在生成向量嵌入... (${completed}/${total} 批次)`);
          });
          vectorDelta = {
            indexed: vectorDelta.indexed + indexStats.indexed,
            deleted: vectorDelta.deleted + indexStats.deleted,
            errors: vectorDelta.errors + indexStats.errors,
          };
        }
      }

      stats = {
        ...stats,
        vectorIndex: vectorDelta,
      };
    }

    options.onProgress?.(100, 100, '索引完成');
    return stats;
  } finally {
    closeDb(db);
    await closeAllCachedResources();
  }
}

/**
 * 执行代码库扫描
 */
export async function scan(rootPath: string, options: ScanOptions = {}): Promise<ScanStats> {
  // 生成项目 ID
  const projectId = generateProjectId(rootPath);

  // 初始化数据库连接
  const db = initDb(projectId, options.snapshotId);

  try {
    // 初始化过滤器
    await initFilter(rootPath);

    // 检查 embedding dimensions 是否变化
    let forceReindex = options.force ?? false;
    if (options.vectorIndex !== false) {
      const currentDimensions = getEmbeddingConfig().dimensions;
      const storedDimensions = getStoredEmbeddingDimensions(db);
      const storedSchemaVersion = getStoredIndexContentSchemaVersion(db);

      if (storedDimensions !== null && storedDimensions !== currentDimensions) {
        logger.warn(
          { stored: storedDimensions, current: currentDimensions },
          'Embedding 维度变化，强制重新索引',
        );
        forceReindex = true;
      }

      if (
        storedSchemaVersion !== null
        && storedSchemaVersion !== INDEX_CONTENT_SCHEMA_VERSION
      ) {
        logger.warn(
          { stored: storedSchemaVersion, current: INDEX_CONTENT_SCHEMA_VERSION },
          '索引内容 schema 变化，强制重新索引',
        );
        forceReindex = true;
      }

      // 更新存储的维度值
      setStoredEmbeddingDimensions(db, currentDimensions);
      setStoredIndexContentSchemaVersion(db, INDEX_CONTENT_SCHEMA_VERSION);
    }

    // 如果强制重新索引，清空数据库和向量索引
    if (forceReindex) {
      clear(db);

      // 清空向量索引
      if (options.vectorIndex !== false) {
        const embeddingConfig = getEmbeddingConfig();
        await options.ensureVectorArtifacts?.();
        const indexer = await getIndexer(projectId, embeddingConfig.dimensions, options.snapshotId);
        await indexer.clear();
      }
    }

    // 获取已知的文件元数据
    const knownFiles = getAllFileMeta(db);

    // 扫描文件系统
    const filePaths = await crawl(rootPath);
    // 使用 path.relative 确保跨平台兼容，并标准化为 / 分隔符
    const scannedPaths = new Set(
      filePaths.map((p) => path.relative(rootPath, p).replace(/\\/g, '/')),
    );

    // 处理已删除的文件
    const deletedPaths: string[] = [];
    const allIndexedPaths = getAllPaths(db);
    for (const indexedPath of allIndexedPaths) {
      // 标准化路径分隔符进行比较
      const normalizedIndexedPath = indexedPath.replace(/\\/g, '/');
      if (!scannedPaths.has(normalizedIndexedPath)) {
        deletedPaths.push(indexedPath);
      }
    }

    const relPathToAbsPath = new Map(
      filePaths.map((filePath) => [
        path.relative(rootPath, filePath).replace(/\\/g, '/'),
        filePath,
      ]),
    );
    let stats = createInitialScanStats(filePaths.length, deletedPaths.length);

    // ===== 向量索引 =====
    let indexer = null;
    if (options.vectorIndex !== false) {
      let vectorArtifactsReady = false;
      const ensureVectorArtifacts = async (): Promise<void> => {
        if (vectorArtifactsReady) return;
        await options.ensureVectorArtifacts?.();
        vectorArtifactsReady = true;
      };
      const embeddingConfig = getEmbeddingConfig();
      indexer = {
        get: async () => {
          await ensureVectorArtifacts();
          return getIndexer(projectId, embeddingConfig.dimensions, options.snapshotId);
        },
      };
    }

    const processingBatchSize = 100;
    const processingBatches: string[][] = [];
    for (let i = 0; i < filePaths.length; i += processingBatchSize) {
      processingBatches.push(filePaths.slice(i, i + processingBatchSize));
    }

    let hasReportedVectorStage = false;
    let pendingBatchResults =
      processingBatches.length > 0 ? processFiles(rootPath, processingBatches[0], knownFiles) : null;

    for (let batchIndex = 0; batchIndex < processingBatches.length; batchIndex++) {
      const batch = processingBatches[batchIndex];
      const batchResults = await pendingBatchResults!;
      const nextBatch = processingBatches[batchIndex + 1];
      pendingBatchResults = nextBatch ? processFiles(rootPath, nextBatch, knownFiles) : null;
      const summary = summarizeProcessResults(batchResults);

      if (summary.toAdd.length > 0) {
        batchUpsert(db, summary.toAdd);
      }
      syncGraphArtifacts(db, batchResults);
      if (summary.toUpdateMtime.length > 0) {
        batchUpdateMtime(db, summary.toUpdateMtime);
      }

      stats = mergeScanStats(stats, {
        added: summary.added,
        modified: summary.modified,
        unchanged: summary.unchanged,
        deleted: 0,
        skipped: summary.skipped,
        errors: summary.errors,
      });

      if (options.vectorIndex !== false && indexer) {
        const needsVectorIndex = batchResults.filter(
          (result) => result.status === 'added' || result.status === 'modified',
        );

        if (needsVectorIndex.length > 0) {
          if (!hasReportedVectorStage) {
            hasReportedVectorStage = true;
            options.onProgress?.(45, 100, '正在准备向量索引...');
          }

          const embeddingFileCount = needsVectorIndex.filter((result) => result.chunks.length > 0).length;
          if (embeddingFileCount > 0) {
            options.onProgress?.(45, 100, `正在生成向量嵌入... (${embeddingFileCount} 个文件)`);
          } else {
            options.onProgress?.(45, 100, '正在同步向量索引状态...');
          }

          const indexStats = await (await indexer.get()).indexFiles(db, needsVectorIndex, (completed, total) => {
            const progress = 45 + Math.floor((completed / total) * 54);
            options.onProgress?.(progress, 100, `正在生成向量嵌入... (${completed}/${total} 批次)`);
          });

          stats = mergeScanStats(stats, {
            added: 0,
            modified: 0,
            unchanged: 0,
            deleted: 0,
            skipped: 0,
            errors: 0,
            vectorIndex: {
              indexed: indexStats.indexed,
              deleted: indexStats.deleted,
              errors: indexStats.errors,
            },
          });
        }
      }
    }

    batchDelete(db, deletedPaths);
    deleteGraphArtifacts(db, deletedPaths);

    if (options.vectorIndex !== false && indexer) {
      const deletedResults = createDeletedResults(deletedPaths);
      if (deletedResults.length > 0) {
        if (!hasReportedVectorStage) {
          hasReportedVectorStage = true;
          options.onProgress?.(45, 100, '正在准备向量索引...');
        }
        options.onProgress?.(45, 100, '正在同步向量索引状态...');
        const indexStats = await (await indexer.get()).indexFiles(db, deletedResults);
        stats = mergeScanStats(stats, {
          added: 0,
          modified: 0,
          unchanged: 0,
          deleted: 0,
          skipped: 0,
          errors: 0,
          vectorIndex: {
            indexed: indexStats.indexed,
            deleted: indexStats.deleted,
            errors: indexStats.errors,
          },
        });
      }

      // 自愈：检查未变文件是否仍需要补索引
      const healingPathSet = new Set(getFilesNeedingVectorIndex(db));
      const healingFilePaths = [...healingPathSet]
        .map((relPath) => relPathToAbsPath.get(relPath))
        .filter((filePath): filePath is string => !!filePath);

      if (healingFilePaths.length > 0) {
        if (!hasReportedVectorStage) {
          hasReportedVectorStage = true;
          options.onProgress?.(45, 100, '正在准备向量索引...');
        }

        const processedHealingFiles = await processFiles(rootPath, healingFilePaths, new Map());
        const healingIndexableCount = processedHealingFiles.filter(
          (result) => (result.status === 'added' || result.status === 'modified') && result.chunks.length > 0,
        ).length;
        const healingSettledCount = processedHealingFiles.filter(
          (result) =>
            (result.status === 'added' || result.status === 'modified')
            && result.chunks.length === 0
            && result.chunking?.settleNoChunks !== false,
        ).length;
        const healingPendingCount = processedHealingFiles.filter(
          (result) =>
            (result.status === 'added' || result.status === 'modified')
            && result.chunks.length === 0
            && result.chunking?.settleNoChunks === false,
        ).length;

        if (healingIndexableCount > 0) {
          logger.info({ count: healingIndexableCount }, '自愈：发现需要补索引的文件');
          options.onProgress?.(45, 100, `正在生成向量嵌入... (${healingIndexableCount} 个文件)`);
        }
        if (healingSettledCount > 0) {
          logger.info({ count: healingSettledCount }, '自愈：文件无可索引 chunk，标记为已收敛');
        }
        if (healingPendingCount > 0) {
          logger.warn({ count: healingPendingCount }, '自愈：解析失败导致空 chunk，保留待修复状态');
        }

        const healingFiles = processedHealingFiles
          .filter((result) => result.status === 'added' || result.status === 'modified')
          .map((result) => ({ ...result, status: 'modified' as const }));

        if (healingFiles.length > 0) {
          const indexStats = await (await indexer.get()).indexFiles(db, healingFiles, (completed, total) => {
            const progress = 45 + Math.floor((completed / total) * 54);
            options.onProgress?.(progress, 100, `正在生成向量嵌入... (${completed}/${total} 批次)`);
          });
          stats = mergeScanStats(stats, {
            added: 0,
            modified: 0,
            unchanged: 0,
            deleted: 0,
            skipped: 0,
            errors: 0,
            vectorIndex: {
              indexed: indexStats.indexed,
              deleted: indexStats.deleted,
              errors: indexStats.errors,
            },
          });
        }
      }
    }

    // 报告完成
    options.onProgress?.(100, 100, '索引完成');

    return stats;
  } finally {
    // 确保关闭所有连接
    closeDb(db);
    await closeAllCachedResources();
  }
}

/**
 * 以快照模式执行索引并原子切换 current 指针
 *
 * 流程：
 * 1. 准备 staging 快照（从 current 或 legacy 复制）
 * 2. 在 staging 快照内执行 scan
 * 3. 扫描成功后原子切换 current
 */
export async function scanWithSnapshotSwap(
  rootPath: string,
  options: SnapshotScanOptions = {},
): Promise<ScanStats> {
  if (options.noopStats) {
    options.onProgress?.(100, 100, '索引已是最新');
    return options.noopStats;
  }

  const projectId = generateProjectId(rootPath);
  const staging = prepareWritableSnapshot(projectId, undefined, {
    artifacts: {
      indexDb: true,
      vectorStore: false,
    },
  });
  const ensureVectorArtifacts = (): void => {
    ensureSnapshotArtifacts(projectId, staging.snapshotId, undefined, {
      vectorStore: true,
    });
  };
  const scanOptions = {
    ...options,
    snapshotId: staging.snapshotId,
    ensureVectorArtifacts,
  };
  const hinted =
    options.incrementalHint
      ? await scanWithIncrementalHint(rootPath, scanOptions, options.incrementalHint)
      : null;
  const stats = hinted ?? await scan(rootPath, scanOptions);

  if (options.vectorIndex !== false) {
    ensureVectorArtifacts();
  }

  if (options.validateBeforeSwap !== false) {
    await validateSnapshot(projectId, staging.snapshotId, {
      expectVectorIndex: options.vectorIndex !== false,
    });
  }

  commitSnapshot(projectId, staging.snapshotId);

  const retention = options.snapshotRetention ?? 5;
  pruneSnapshots(projectId, retention);
  return stats;
}
