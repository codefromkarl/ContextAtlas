import fs from 'node:fs';
import path from 'node:path';
import { getEmbeddingConfig, getIndexUpdateStrategyConfig } from '../config.js';
import {
  type FileMeta,
  generateProjectId,
  getAllFileMeta,
  getAllPaths,
  getFilesNeedingVectorIndex,
  getStoredIndexContentSchemaVersion,
  getStoredEmbeddingDimensions,
  initDb,
} from '../db/index.js';
import { enqueueIndexTask } from './queue.js';
import type { IncrementalExecutionHint } from './types.js';
import { MEMORY_CATALOG_VERSION, MemoryRouter } from '../memory/MemoryRouter.js';
import { MemoryStore } from '../memory/MemoryStore.js';
import type { FeatureMemory } from '../memory/types.js';
import { hasIndexedData, resolveCurrentSnapshotId, resolveIndexPaths } from '../storage/layout.js';
import { crawl } from '../scanner/crawler.js';
import { initFilter } from '../scanner/filter.js';
import { INDEX_CONTENT_SCHEMA_VERSION } from '../scanner/processor.js';
import { processFiles } from '../scanner/processor.js';

const DEFAULT_INCREMENTAL_HINT_TTL_MS = 10 * 60_000;

export interface ImpactedMemorySummary {
  name: string;
  location: string;
  scope: 'direct' | 'routed' | 'broad-review';
  reasons: string[];
  matchedPaths: string[];
}

export interface IndexPlanSchemaStatus {
  snapshot: {
    layout: 'missing' | 'legacy' | 'snapshot';
    currentSnapshotId: string | null;
    hasIndexData: boolean;
    hasVectorStore: boolean;
  };
  embeddings: {
    storedDimensions: number | null;
    currentDimensions: number;
    compatible: boolean;
  };
  contentSchema: {
    storedVersion: number | null;
    currentVersion: number;
    compatible: boolean;
  };
  memoryCatalog: {
    status: 'missing' | 'consistent' | 'inconsistent' | 'version-mismatch';
    storedVersion: number | null;
    expectedVersion: number;
    missingModules: number;
    staleModules: number;
    missingModuleNames: string[];
    staleModuleNames: string[];
  };
}

export interface IndexPlanStrategySignals {
  changedFiles: number;
  eligibleForFullRebuildEscalation: boolean;
  churnRatio: number;
  churnThreshold: number;
  estimatedIncrementalBytes: number;
  estimatedFullBytes: number;
  incrementalCostRatio: number;
  costThresholdRatio: number;
  fullRebuildTriggers: string[];
}

export interface IndexUpdatePlan {
  repoPath: string;
  projectId: string;
  mode: 'none' | 'incremental' | 'full';
  reasons: Array<{ code: string; message: string }>;
  changeSummary: {
    added: number;
    modified: number;
    deleted: number;
    unchangedNeedingVectorRepair: number;
    unchanged: number;
    skipped: number;
    errors: number;
    totalFiles: number;
  };
  impactedMemories: ImpactedMemorySummary[];
  commands: string[];
  memoryCatalogStatus: 'missing' | 'consistent' | 'inconsistent' | 'version-mismatch';
  schemaStatus: IndexPlanSchemaStatus;
  strategySignals: IndexPlanStrategySignals;
  executionHint: IncrementalExecutionHint | null;
}

export interface IndexUpdateExecutionResult {
  plan: IndexUpdatePlan;
  enqueued: boolean;
  taskId: string | null;
  reusedExisting: boolean;
}

export interface IndexUpdateStrategyDiagnostics {
  churnThreshold: number;
  costThresholdRatio: number;
  minFilesForEscalation: number;
  minChangedFilesForEscalation: number;
}

type KnownFilePlanMeta = Pick<FileMeta, 'mtime' | 'hash' | 'size' | 'vectorIndexHash'>;

export interface LightweightPlanCandidate {
  relPath: string;
  absPath: string;
  mtime: number;
  size: number;
}

export interface LightweightPlanDelta {
  totalFiles: number;
  totalBytes: number;
  candidateEntries: LightweightPlanCandidate[];
  deletedPaths: string[];
  healingEntries: LightweightPlanCandidate[];
}

export interface CollectLightweightPlanDeltaInput {
  knownFiles: Map<string, KnownFilePlanMeta>;
  indexedPaths: string[];
  healingPaths: Set<string>;
  filePaths?: string[];
}

export async function collectLightweightPlanDelta(
  repoPath: string,
  input: CollectLightweightPlanDeltaInput,
): Promise<LightweightPlanDelta> {
  const resolvedRepoPath = path.resolve(repoPath);
  const effectiveFilePaths =
    input.filePaths
    ?? await (async () => {
      await initFilter(resolvedRepoPath);
      return crawl(resolvedRepoPath);
    })();

  const candidateEntries: LightweightPlanCandidate[] = [];
  const relPathToAbs = new Map<string, string>();
  const candidatePathSet = new Set<string>();
  let totalBytes = 0;

  for (const filePath of effectiveFilePaths) {
    const relPath = path.relative(resolvedRepoPath, filePath).replace(/\\/g, '/');
    relPathToAbs.set(relPath, filePath);

    const known = input.knownFiles.get(relPath);
    try {
      const stat = fs.statSync(filePath);
      totalBytes += stat.size;
      if (!known || known.mtime !== stat.mtimeMs || known.size !== stat.size) {
        candidateEntries.push({
          relPath,
          absPath: filePath,
          mtime: stat.mtimeMs,
          size: stat.size,
        });
        candidatePathSet.add(relPath);
      }
    } catch {
      candidateEntries.push({
        relPath,
        absPath: filePath,
        mtime: 0,
        size: 0,
      });
      candidatePathSet.add(relPath);
    }
  }

  const scannedPaths = new Set(relPathToAbs.keys());
  const deletedPaths = input.indexedPaths.filter(
    (indexedPath) => !scannedPaths.has(indexedPath.replace(/\\/g, '/')),
  );

  const healingEntries: LightweightPlanCandidate[] = [];
  for (const relPath of input.healingPaths) {
    if (candidatePathSet.has(relPath)) {
      continue;
    }
    const absPath = relPathToAbs.get(relPath);
    if (!absPath) {
      continue;
    }
    try {
      const stat = fs.statSync(absPath);
      healingEntries.push({
        relPath,
        absPath,
        mtime: stat.mtimeMs,
        size: stat.size,
      });
    } catch {
      // 文件已漂移；执行阶段会回退到常规扫描
    }
  }

  return {
    totalFiles: effectiveFilePaths.length,
    totalBytes,
    candidateEntries,
    deletedPaths,
    healingEntries,
  };
}

export async function analyzeIndexUpdatePlan(repoPath: string): Promise<IndexUpdatePlan> {
  const resolvedRepoPath = path.resolve(repoPath);
  const projectId = generateProjectId(resolvedRepoPath);
  const indexed = hasIndexedData(projectId);
  const currentSnapshotId = resolveCurrentSnapshotId(projectId);

  await initFilter(resolvedRepoPath);
  const filePaths = await crawl(resolvedRepoPath);

  if (!indexed) {
    const currentDimensions = getEmbeddingConfig().dimensions;
    return {
      repoPath: resolvedRepoPath,
      projectId,
      mode: 'full',
      reasons: [{ code: 'missing-index', message: '当前仓库尚未建立索引，需要先执行全量索引。' }],
      changeSummary: {
        added: filePaths.length,
        modified: 0,
        deleted: 0,
        unchangedNeedingVectorRepair: 0,
        unchanged: 0,
        skipped: 0,
        errors: 0,
        totalFiles: filePaths.length,
      },
      impactedMemories: [],
      commands: [`contextatlas index ${resolvedRepoPath}`],
      memoryCatalogStatus: 'missing',
      schemaStatus: {
        snapshot: {
          layout: 'missing',
          currentSnapshotId,
          hasIndexData: false,
          hasVectorStore: false,
        },
        embeddings: {
          storedDimensions: null,
          currentDimensions,
          compatible: true,
        },
        contentSchema: {
          storedVersion: null,
          currentVersion: INDEX_CONTENT_SCHEMA_VERSION,
          compatible: true,
        },
        memoryCatalog: {
          status: 'missing',
          storedVersion: null,
          expectedVersion: MEMORY_CATALOG_VERSION,
          missingModules: 0,
          staleModules: 0,
          missingModuleNames: [],
          staleModuleNames: [],
        },
      },
      strategySignals: createStrategySignals({
        changedFiles: filePaths.length,
        totalFiles: filePaths.length,
        estimatedIncrementalBytes: 0,
        estimatedFullBytes: 0,
      }),
      executionHint: null,
    };
  }

  const snapshotId = currentSnapshotId;
  const db = initDb(projectId, snapshotId);

  try {
    const knownFiles = getAllFileMeta(db);
    const currentDimensions = getEmbeddingConfig().dimensions;
    const storedDimensions = getStoredEmbeddingDimensions(db);
    const storedContentSchemaVersion = getStoredIndexContentSchemaVersion(db);
    const indexPaths = resolveIndexPaths(projectId, { snapshotId });
    const vectorStorePresent = fs.existsSync(indexPaths.vectorPath);
    const indexedPaths = getAllPaths(db);
    const healing = new Set(getFilesNeedingVectorIndex(db));
    const delta = await collectLightweightPlanDelta(resolvedRepoPath, {
      knownFiles,
      indexedPaths,
      healingPaths: healing,
      filePaths,
    });
    const candidateResults = delta.candidateEntries.length > 0
      ? await processFiles(
          resolvedRepoPath,
          delta.candidateEntries.map((entry) => entry.absPath),
          knownFiles,
        )
      : [];
    const catalogStatus = await resolveMemoryCatalogStatus(resolvedRepoPath);

    const added = candidateResults.filter((result) => result.status === 'added').length;
    const modified = candidateResults.filter((result) => result.status === 'modified').length;
    const skipped = candidateResults.filter((result) => result.status === 'skipped').length;
    const errors = candidateResults.filter((result) => result.status === 'error').length;
    const changeSummary = {
      added,
      modified,
      deleted: delta.deletedPaths.length,
      unchangedNeedingVectorRepair: delta.healingEntries.length,
      unchanged: Math.max(0, delta.totalFiles - added - modified - skipped - errors),
      skipped,
      errors,
      totalFiles: delta.totalFiles,
    };
    const changedFiles =
      changeSummary.added
      + changeSummary.modified
      + changeSummary.deleted
      + changeSummary.unchangedNeedingVectorRepair;
    const estimatedIncrementalBytes =
      candidateResults
        .filter((result) => result.status === 'added' || result.status === 'modified')
        .reduce((sum, result) => sum + result.size, 0)
      + delta.healingEntries.reduce((sum, entry) => sum + entry.size, 0)
      + delta.deletedPaths.reduce((sum, relPath) => sum + (knownFiles.get(relPath)?.size || 0), 0);
    const strategySignals = createStrategySignals({
      changedFiles,
      totalFiles: changeSummary.totalFiles,
      estimatedIncrementalBytes,
      estimatedFullBytes: delta.totalBytes,
    });

    const schemaStatus: IndexPlanSchemaStatus = {
      snapshot: {
        layout: snapshotId ? 'snapshot' : 'legacy',
        currentSnapshotId: snapshotId,
        hasIndexData: true,
        hasVectorStore: vectorStorePresent,
      },
      embeddings: {
        storedDimensions,
        currentDimensions,
        compatible: storedDimensions === null || storedDimensions === currentDimensions,
      },
      contentSchema: {
        storedVersion: storedContentSchemaVersion,
        currentVersion: INDEX_CONTENT_SCHEMA_VERSION,
        compatible:
          storedContentSchemaVersion === null
          || storedContentSchemaVersion === INDEX_CONTENT_SCHEMA_VERSION,
      },
      memoryCatalog: {
        status: catalogStatus.status,
        storedVersion: catalogStatus.storedVersion,
        expectedVersion: MEMORY_CATALOG_VERSION,
        missingModules: catalogStatus.missingModules.length,
        staleModules: catalogStatus.staleModules.length,
        missingModuleNames: catalogStatus.missingModules,
        staleModuleNames: catalogStatus.staleModules,
      },
    };

    const reasons: Array<{ code: string; message: string }> = [];
    let mode: IndexUpdatePlan['mode'] = 'none';

    if (storedDimensions !== null && storedDimensions !== currentDimensions) {
      mode = 'full';
      reasons.push({
        code: 'embedding-dimension-changed',
        message: `Embedding 维度从 ${storedDimensions} 变为 ${currentDimensions}，需要全量重建。`,
      });
    } else if (
      storedContentSchemaVersion !== null
      && storedContentSchemaVersion !== INDEX_CONTENT_SCHEMA_VERSION
    ) {
      mode = 'full';
      reasons.push({
        code: 'index-content-schema-changed',
        message: `索引内容 schema 版本从 ${storedContentSchemaVersion} 变为 ${INDEX_CONTENT_SCHEMA_VERSION}，需要全量重建。`,
      });
    } else if (!vectorStorePresent && storedDimensions !== null && indexedPaths.length > 0) {
      mode = 'full';
      reasons.push({
        code: 'vector-store-missing',
        message: '当前索引已记录 embedding metadata，但 vectors.lance 缺失，需要全量重建。',
      });
    } else if (strategySignals.fullRebuildTriggers.length > 0) {
      mode = 'full';
      if (strategySignals.fullRebuildTriggers.includes('high-churn')) {
        reasons.push({
          code: 'high-churn',
          message:
            `改动文件占比 ${(strategySignals.churnRatio * 100).toFixed(1)}% `
            + `已超过 ${(strategySignals.churnThreshold * 100).toFixed(0)}% 阈值，建议直接全量重建。`,
        });
      }
      if (strategySignals.fullRebuildTriggers.includes('incremental-cost-high')) {
        reasons.push({
          code: 'incremental-cost-high',
          message:
            `估算增量处理成本已达到全量的 ${(strategySignals.incrementalCostRatio * 100).toFixed(1)}%，`
            + `超过 ${(strategySignals.costThresholdRatio * 100).toFixed(0)}% 阈值。`,
        });
      }
    } else if (
      changeSummary.added > 0
      || changeSummary.modified > 0
      || changeSummary.deleted > 0
      || changeSummary.unchangedNeedingVectorRepair > 0
    ) {
      mode = 'incremental';
      if (changeSummary.added > 0) {
        reasons.push({ code: 'files-added', message: `${changeSummary.added} 个文件新增。` });
      }
      if (changeSummary.modified > 0) {
        reasons.push({ code: 'files-modified', message: `${changeSummary.modified} 个文件发生修改。` });
      }
      if (changeSummary.deleted > 0) {
        reasons.push({ code: 'files-deleted', message: `${changeSummary.deleted} 个文件已删除。` });
      }
      if (changeSummary.unchangedNeedingVectorRepair > 0) {
        reasons.push({
          code: 'vector-repair',
          message: `${changeSummary.unchangedNeedingVectorRepair} 个未变文件需要补向量索引。`,
        });
      }
    } else {
      reasons.push({ code: 'up-to-date', message: '当前索引与文件系统状态一致，无需更新。' });
    }

    if (schemaStatus.snapshot.layout === 'legacy') {
      reasons.push({
        code: 'legacy-index-layout',
        message: '当前仍在使用 legacy 索引布局，后续写入会迁移到 snapshot layout。',
      });
    }

    if (catalogStatus.status === 'version-mismatch') {
      reasons.push({
        code: 'memory-catalog-version-mismatch',
        message: `memory catalog schema 版本为 ${catalogStatus.storedVersion ?? 'unknown'}，当前需要 ${MEMORY_CATALOG_VERSION}。`,
      });
    } else if (catalogStatus.status === 'missing') {
      reasons.push({
        code: 'memory-catalog-missing',
        message: 'memory catalog 缺失，建议重建 catalog 以恢复精确路由。',
      });
    } else if (catalogStatus.status === 'inconsistent') {
      reasons.push({
        code: 'memory-catalog-inconsistent',
        message: `memory catalog 与 feature memories 不一致（缺失 ${catalogStatus.missingModules.length}，陈旧 ${catalogStatus.staleModules.length}），建议同时检查或重建 catalog。`,
      });
    }

    const impactedFilePaths = [
      ...candidateResults
        .filter((result) => result.status === 'added' || result.status === 'modified')
        .map((result) => result.relPath),
      ...delta.deletedPaths,
    ];

    const impactedMemories = await resolveImpactedMemories(resolvedRepoPath, mode, impactedFilePaths, reasons);
    const commands =
      mode === 'full'
        ? [`contextatlas index ${resolvedRepoPath} --force`]
        : mode === 'incremental'
          ? [`contextatlas index ${resolvedRepoPath}`]
          : ['当前无需执行索引更新'];

    if (catalogStatus.status !== 'consistent') {
      commands.push('contextatlas memory:check-consistency');
      commands.push('contextatlas memory:rebuild-catalog');
    }

    return {
      repoPath: resolvedRepoPath,
      projectId,
      mode,
      reasons,
      changeSummary,
      impactedMemories,
      commands,
      memoryCatalogStatus: catalogStatus.status,
      schemaStatus,
      strategySignals,
      executionHint:
        mode === 'incremental'
          ? buildIncrementalExecutionHint(
              candidateResults,
              delta.deletedPaths,
              delta.healingEntries,
              changeSummary,
            )
          : null,
    };
  } finally {
    db.close();
  }
}

export async function executeIndexUpdatePlan(
  repoPath: string,
  options: { requestedBy?: string; priority?: number } = {},
): Promise<IndexUpdateExecutionResult> {
  const plan = await analyzeIndexUpdatePlan(repoPath);

  if (plan.mode === 'none') {
    return {
      plan,
      enqueued: false,
      taskId: null,
      reusedExisting: false,
    };
  }

  const enqueueResult = enqueueIndexTask({
    projectId: plan.projectId,
    repoPath: plan.repoPath,
    scope: plan.mode,
    priority: options.priority,
    requestedBy: options.requestedBy || 'index:update',
    reason: plan.reasons.map((reason) => reason.code).join(','),
    executionHint: plan.executionHint,
  });

  return {
    plan,
    enqueued: true,
    taskId: enqueueResult.task.taskId,
    reusedExisting: enqueueResult.reusedExisting,
  };
}

export function getIndexUpdateStrategyDiagnostics(): IndexUpdateStrategyDiagnostics {
  const config = getIndexUpdateStrategyConfig();
  return {
    churnThreshold: config.churnThreshold,
    costThresholdRatio: config.costThresholdRatio,
    minFilesForEscalation: config.minFilesForEscalation,
    minChangedFilesForEscalation: config.minChangedFilesForEscalation,
  };
}

function buildIncrementalExecutionHint(
  fileResults: Awaited<ReturnType<typeof processFiles>>,
  deletedPaths: string[],
  healingEntries: LightweightPlanCandidate[],
  changeSummary: IndexUpdatePlan['changeSummary'],
): IncrementalExecutionHint {
  return {
    generatedAt: Date.now(),
    ttlMs: DEFAULT_INCREMENTAL_HINT_TTL_MS,
    changeSummary,
    candidates: fileResults
      .filter((result) => result.status === 'added' || result.status === 'modified')
      .map((result) => ({
        relPath: result.relPath,
        mtime: result.mtime,
        size: result.size,
      })),
    deletedPaths,
    healingPaths: healingEntries.map((entry) => ({
      relPath: entry.relPath,
      mtime: entry.mtime,
      size: entry.size,
    })),
  };
}

async function resolveImpactedMemories(
  repoPath: string,
  mode: IndexUpdatePlan['mode'],
  changedPaths: string[],
  planReasons: Array<{ code: string; message: string }>,
): Promise<ImpactedMemorySummary[]> {
  const store = new MemoryStore(repoPath);
  const router = MemoryRouter.forProject(repoPath);
  await router.initialize();
  const memories = await store.listFeatures();

  if (mode === 'full') {
    return collectBroadReviewMatches(memories, planReasons);
  }

  if (changedPaths.length === 0) {
    return [];
  }

  const directMatches = collectDirectMemoryMatches(memories, changedPaths);
  if (directMatches.length > 0) {
    return directMatches;
  }

  const routed = await router.route({
    filePaths: changedPaths,
    enableScopeCascade: false,
  });

  return routed.memories.slice(0, 10).map((memory) => ({
    name: memory.name,
    location: resolveMemoryLocation(memory),
    scope: 'routed',
    reasons: ['catalog-trigger'],
    matchedPaths: changedPaths.filter((changedPath) => matchesMemoryDirectory(memory, changedPath)),
  }));
}

async function resolveMemoryCatalogStatus(repoPath: string): Promise<{
  status: 'missing' | 'consistent' | 'inconsistent' | 'version-mismatch';
  storedVersion: number | null;
  missingModules: string[];
  staleModules: string[];
}> {
  const store = new MemoryStore(repoPath);
  const features = await store.listFeatures();
  const featureNames = new Set(features.map((feature) => normalizeModuleName(feature.name)));
  const catalog = await store.readCatalog();

  if (!catalog) {
    return {
      status: 'missing',
      storedVersion: null,
      missingModules: [...featureNames],
      staleModules: [],
    };
  }

  if (catalog.version !== MEMORY_CATALOG_VERSION) {
    return {
      status: 'version-mismatch',
      storedVersion: catalog.version ?? null,
      missingModules: [],
      staleModules: [],
    };
  }

  const catalogNames = new Set(Object.keys(catalog.modules || {}));
  const missingModules = [...featureNames].filter((name) => !catalogNames.has(name));
  const staleModules = [...catalogNames].filter((name) => !featureNames.has(name));

  return {
    status: missingModules.length === 0 && staleModules.length === 0 ? 'consistent' : 'inconsistent',
    storedVersion: catalog.version,
    missingModules,
    staleModules,
  };
}

export function formatIndexUpdatePlanReport(plan: IndexUpdatePlan): string {
  const lines: string[] = [];
  lines.push('Index Update Plan');
  lines.push(`Repo: ${plan.repoPath}`);
  lines.push(`Project ID: ${plan.projectId}`);
  lines.push(`Mode: ${plan.mode.toUpperCase()}`);
  lines.push(`Memory Catalog: ${plan.memoryCatalogStatus}`);
  lines.push('');
  lines.push('Reasons:');
  for (const reason of plan.reasons) {
    lines.push(`- [${reason.code}] ${reason.message}`);
  }
  lines.push('');
  lines.push('Schema Status:');
  lines.push(
    `- Snapshot: ${plan.schemaStatus.snapshot.layout} (${plan.schemaStatus.snapshot.currentSnapshotId ?? 'legacy/no-current'})`,
  );
  lines.push(`- Vector Store Present: ${plan.schemaStatus.snapshot.hasVectorStore ? 'yes' : 'no'}`);
  lines.push(
    `- Embedding Dimensions: ${plan.schemaStatus.embeddings.storedDimensions ?? 'unknown'} -> ${plan.schemaStatus.embeddings.currentDimensions}`,
  );
  lines.push(
    `- Content Schema: ${plan.schemaStatus.contentSchema.storedVersion ?? 'unknown'} -> ${plan.schemaStatus.contentSchema.currentVersion}`,
  );
  lines.push(
    `- Memory Catalog: ${plan.schemaStatus.memoryCatalog.status} (schema ${plan.schemaStatus.memoryCatalog.storedVersion ?? 'unknown'}/${plan.schemaStatus.memoryCatalog.expectedVersion})`,
  );
  lines.push(
    `- Catalog Drift: missing=${plan.schemaStatus.memoryCatalog.missingModules}, stale=${plan.schemaStatus.memoryCatalog.staleModules}`,
  );
  if (plan.schemaStatus.memoryCatalog.missingModuleNames.length > 0) {
    lines.push(`- Missing Modules: ${plan.schemaStatus.memoryCatalog.missingModuleNames.join(', ')}`);
  }
  if (plan.schemaStatus.memoryCatalog.staleModuleNames.length > 0) {
    lines.push(`- Stale Modules: ${plan.schemaStatus.memoryCatalog.staleModuleNames.join(', ')}`);
  }
  lines.push('');
  lines.push('Change Summary:');
  lines.push(`- Added: ${plan.changeSummary.added}`);
  lines.push(`- Modified: ${plan.changeSummary.modified}`);
  lines.push(`- Deleted: ${plan.changeSummary.deleted}`);
  lines.push(`- Vector Repair: ${plan.changeSummary.unchangedNeedingVectorRepair}`);
  lines.push(`- Unchanged: ${plan.changeSummary.unchanged}`);
  lines.push(`- Skipped: ${plan.changeSummary.skipped}`);
  lines.push(`- Errors: ${plan.changeSummary.errors}`);
  lines.push(`- Total Files: ${plan.changeSummary.totalFiles}`);
  lines.push('');
  lines.push('Strategy Signals:');
  lines.push(`- Changed Files: ${plan.strategySignals.changedFiles}`);
  lines.push(`- Churn: ${(plan.strategySignals.churnRatio * 100).toFixed(1)}%`);
  lines.push(`- Churn Threshold: ${(plan.strategySignals.churnThreshold * 100).toFixed(0)}%`);
  lines.push(
    `- Estimated Incremental Cost: ${plan.strategySignals.estimatedIncrementalBytes} bytes (${(plan.strategySignals.incrementalCostRatio * 100).toFixed(1)}% of full)`,
  );
  lines.push(
    `- Cost Threshold: ${(plan.strategySignals.costThresholdRatio * 100).toFixed(0)}% of full`,
  );
  if (plan.strategySignals.fullRebuildTriggers.length > 0) {
    lines.push(`- Full Rebuild Triggers: ${plan.strategySignals.fullRebuildTriggers.join(', ')}`);
  }
  lines.push('');
  lines.push('Impacted Memories:');
  if (plan.impactedMemories.length === 0) {
    lines.push('- 无明显受影响的模块记忆');
  } else {
    for (const memory of plan.impactedMemories) {
      const matchText = memory.matchedPaths.length > 0 ? ` [${memory.matchedPaths.join(', ')}]` : '';
      lines.push(
        `- ${memory.name}: ${memory.location} [${memory.scope}] (${memory.reasons.join(', ')})${matchText}`,
      );
    }
  }
  lines.push('');
  lines.push('Commands:');
  for (const command of plan.commands) {
    lines.push(`- ${command}`);
  }
  return lines.join('\n');
}

export function formatIndexUpdateStrategyDiagnosticsReport(
  diagnostics: IndexUpdateStrategyDiagnostics,
): string {
  const lines: string[] = [];
  lines.push('Index Strategy Diagnostics');
  lines.push(`- Churn Threshold: ${(diagnostics.churnThreshold * 100).toFixed(0)}%`);
  lines.push(`- Cost Threshold: ${(diagnostics.costThresholdRatio * 100).toFixed(0)}% of full`);
  lines.push(`- Min Files For Escalation: ${diagnostics.minFilesForEscalation}`);
  lines.push(
    `- Min Changed Files For Escalation: ${diagnostics.minChangedFilesForEscalation}`,
  );
  lines.push('');
  lines.push('Environment Keys:');
  lines.push('- INDEX_UPDATE_CHURN_THRESHOLD');
  lines.push('- INDEX_UPDATE_COST_RATIO_THRESHOLD');
  lines.push('- INDEX_UPDATE_MIN_FILES');
  lines.push('- INDEX_UPDATE_MIN_CHANGED_FILES');
  return lines.join('\n');
}

function collectDirectMemoryMatches(
  memories: FeatureMemory[],
  changedPaths: string[],
): ImpactedMemorySummary[] {
  const normalizedChangedPaths = changedPaths.map(normalizeRelPath);
  const directHits = new Map<string, ImpactedMemorySummary>();

  for (const memory of memories) {
    const candidateFiles = getMemoryCandidateFiles(memory);
    const matchedPaths = normalizedChangedPaths.filter((changedPath) => candidateFiles.has(changedPath));
    if (matchedPaths.length === 0) {
      continue;
    }

    directHits.set(memory.name, {
      name: memory.name,
      location: resolveMemoryLocation(memory),
      scope: 'direct',
      reasons: ['direct-file'],
      matchedPaths,
    });
  }

  return Array.from(directHits.values()).slice(0, 10);
}

function collectBroadReviewMatches(
  memories: FeatureMemory[],
  planReasons: Array<{ code: string; message: string }>,
): ImpactedMemorySummary[] {
  if (memories.length === 0) {
    return [];
  }

  const broadReasons = new Set<string>();
  for (const reason of planReasons) {
    if (reason.code === 'embedding-dimension-changed') {
      broadReasons.add('embedding-schema-wide-impact');
    } else if (reason.code === 'index-content-schema-changed') {
      broadReasons.add('content-schema-wide-impact');
    } else if (reason.code === 'vector-store-missing') {
      broadReasons.add('vector-store-wide-impact');
    }
  }
  if (broadReasons.size === 0) {
    broadReasons.add('full-rebuild-wide-impact');
  }

  return memories.slice(0, 10).map((memory) => ({
    name: memory.name,
    location: resolveMemoryLocation(memory),
    scope: 'broad-review',
    reasons: [...broadReasons],
    matchedPaths: [],
  }));
}

function getMemoryCandidateFiles(memory: FeatureMemory): Set<string> {
  const files = new Set<string>();
  const normalizedDir = normalizeRelPath(memory.location.dir);

  for (const file of memory.location.files) {
    const normalizedFile = normalizeRelPath(file);
    if (!normalizedFile) {
      continue;
    }

    if (normalizedFile.includes('/')) {
      files.add(normalizedFile);
    } else if (normalizedDir) {
      files.add(normalizeRelPath(path.posix.join(normalizedDir, normalizedFile)));
    } else {
      files.add(normalizedFile);
    }
  }

  if (memory.location.entryPoint) {
    const normalizedEntryPoint = normalizeRelPath(memory.location.entryPoint);
    if (normalizedEntryPoint) {
      files.add(normalizedEntryPoint);
    }
  }

  return files;
}

function resolveMemoryLocation(memory: FeatureMemory): string {
  const primaryFile = memory.location.files[0] || memory.location.entryPoint || '';
  if (!primaryFile) {
    return normalizeRelPath(memory.location.dir);
  }

  const normalizedPrimary = normalizeRelPath(primaryFile);
  if (normalizedPrimary.includes('/')) {
    return normalizedPrimary;
  }

  return normalizeRelPath(path.posix.join(memory.location.dir, normalizedPrimary));
}

function matchesMemoryDirectory(memory: FeatureMemory, changedPath: string): boolean {
  const normalizedDir = normalizeRelPath(memory.location.dir).replace(/\/$/, '');
  const normalizedChangedPath = normalizeRelPath(changedPath);
  return normalizedDir.length > 0 && normalizedChangedPath.startsWith(`${normalizedDir}/`);
}

function normalizeModuleName(moduleName: string): string {
  return moduleName.toLowerCase().trim().replace(/\s+/g, '-');
}

function normalizeRelPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/').trim();
}

function createStrategySignals(input: {
  changedFiles: number;
  totalFiles: number;
  estimatedIncrementalBytes: number;
  estimatedFullBytes: number;
}): IndexPlanStrategySignals {
  const config = getIndexUpdateStrategyConfig();
  const totalFiles = Math.max(input.totalFiles, 0);
  const estimatedFullBytes = Math.max(input.estimatedFullBytes, input.estimatedIncrementalBytes, 0);
  const churnRatio = totalFiles > 0 ? input.changedFiles / totalFiles : 0;
  const incrementalCostRatio =
    estimatedFullBytes > 0 ? input.estimatedIncrementalBytes / estimatedFullBytes : 0;
  const eligibleForFullRebuildEscalation =
    totalFiles >= config.minFilesForEscalation
    && input.changedFiles >= config.minChangedFilesForEscalation;
  const fullRebuildTriggers: string[] = [];

  if (eligibleForFullRebuildEscalation && churnRatio >= config.churnThreshold) {
    fullRebuildTriggers.push('high-churn');
  }

  if (eligibleForFullRebuildEscalation && incrementalCostRatio >= config.costThresholdRatio) {
    fullRebuildTriggers.push('incremental-cost-high');
  }

  return {
    changedFiles: input.changedFiles,
    eligibleForFullRebuildEscalation,
    churnRatio,
    churnThreshold: config.churnThreshold,
    estimatedIncrementalBytes: input.estimatedIncrementalBytes,
    estimatedFullBytes,
    incrementalCostRatio,
    costThresholdRatio: config.costThresholdRatio,
    fullRebuildTriggers,
  };
}
