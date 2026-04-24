/**
 * GraphExpander - 上下文扩展器 (多语言支持版)
 *
 * 基于 seed chunks 进行智能扩展，补充相关上下文：
 * - E1: 同文件邻居（前后相邻的 chunks）
 * - E2: breadcrumb 补段（同前缀的其他 chunks）
 * - E3: 跨文件引用（支持 TS/JS, Python, Go, Java, Rust）
 */

import type Database from 'better-sqlite3';
import { getEmbeddingConfig } from '../config.js';
import { initDb } from '../db/index.js';
import { GraphStore, type StoredSymbol } from '../graph/GraphStore.js';
import { logger } from '../utils/logger.js';
import { type ChunkRecord, getVectorStore, type VectorStore } from '../vectorStore/index.js';
import { createResolvers, type ImportResolver } from './resolvers/index.js';
import type { ExpansionCandidate, ScoredChunk, SearchConfig } from './types.js';

// ===========================================
// 类型定义
// ===========================================

/** 扩展结果 */
interface ExpandResult {
  chunks: ScoredChunk[];
  explorationCandidates: ExpansionCandidate[];
  nextInspectionSuggestions: string[];
  stats: {
    neighborCount: number;
    breadcrumbCount: number;
    importCount: number;
    importDepth1Count: number;
  };
}

// ===========================================
// GraphExpander 类
// ===========================================

export class GraphExpander {
  private projectId: string;
  private snapshotId: string | null | undefined;
  private config: SearchConfig;
  private vectorStore: VectorStore | null = null;
  private db: Database.Database | null = null;

  // 缓存所有文件路径 (用于快速查找和模糊匹配)
  private allFilePaths: Set<string> | null = null;

  // 注册解析器（按优先级排列）
  private resolvers: ImportResolver[] = createResolvers();

  constructor(projectId: string, config: SearchConfig, snapshotId?: string | null) {
    this.projectId = projectId;
    this.snapshotId = snapshotId;
    this.config = config;
  }

  async init(): Promise<void> {
    const embeddingConfig = getEmbeddingConfig();
    this.vectorStore = await getVectorStore(this.projectId, embeddingConfig.dimensions, this.snapshotId);
    this.db = initDb(this.projectId, this.snapshotId);
  }

  /**
   * 加载文件索引 (Lazy Load)
   * 相比反复查 DB，一次性加载所有路径到 Set 内存占用极低且速度极快
   */
  private loadFileIndex(): void {
    if (this.allFilePaths) return;

    if (!this.db) this.db = initDb(this.projectId, this.snapshotId);

    // 只查询 path 字段
    const rows = this.db.prepare('SELECT path FROM files').all() as { path: string }[];
    this.allFilePaths = new Set(rows.map((r) => r.path));

    logger.debug({ count: this.allFilePaths.size }, 'GraphExpander: 文件索引已加载');
  }

  /**
   * 使文件索引失效（用于增量索引后刷新）
   */
  invalidateFileIndex(): void {
    this.allFilePaths = null;
  }

  /**
   * 扩展 seed chunks
   */
  async expand(seeds: ScoredChunk[], queryTokens?: Set<string>): Promise<ExpandResult> {
    if (!this.vectorStore || !this.db) {
      await this.init();
    }

    // 确保文件索引已加载 (供 E3 使用)
    this.loadFileIndex();

    const stats = {
      neighborCount: 0,
      breadcrumbCount: 0,
      importCount: 0,
      importDepth1Count: 0,
    };

    if (seeds.length === 0) {
      return { chunks: [], explorationCandidates: [], nextInspectionSuggestions: [], stats };
    }

    // 已有的 chunk keys（用于去重）
    const existingKeys = new Set(seeds.map((s) => this.getChunkKey(s)));
    const expandedChunks: ScoredChunk[] = [];

    // 按文件分组 seeds
    const seedsByFile = this.groupByFile(seeds);

    // E1: 同文件邻居扩展
    const neighborChunks = await this.expandNeighbors(seedsByFile, existingKeys);
    this.addChunks(neighborChunks, expandedChunks, existingKeys);
    stats.neighborCount = neighborChunks.length;

    // E2: breadcrumb 补段
    const breadcrumbChunks = await this.expandBreadcrumb(seeds, existingKeys);
    this.addChunks(breadcrumbChunks, expandedChunks, existingKeys);
    stats.breadcrumbCount = breadcrumbChunks.length;

    // E3: 跨文件引用解析（多语言支持）
    const importChunks = await this.expandImports(seeds, existingKeys, queryTokens, stats);
    this.addChunks(importChunks, expandedChunks, existingKeys);
    stats.importCount = importChunks.length;

    const explorationCandidates = this.buildExplorationCandidates(
      expandedChunks,
      new Set(seeds.map((seed) => seed.filePath)),
      queryTokens,
    );
    const nextInspectionSuggestions = explorationCandidates.map(
      (candidate) => `Inspect ${candidate.filePath} (${candidate.reason})`,
    );

    logger.debug(
      {
        ...stats,
        explorationCandidateCount: explorationCandidates.length,
      },
      '上下文扩展完成',
    );

    return { chunks: expandedChunks, explorationCandidates, nextInspectionSuggestions, stats };
  }

  /**
   * 添加 chunks 并更新去重集合
   */
  private addChunks(newChunks: ScoredChunk[], target: ScoredChunk[], keys: Set<string>): void {
    for (const chunk of newChunks) {
      const key = this.getChunkKey(chunk);
      if (!keys.has(key)) {
        keys.add(key);
        target.push(chunk);
      }
    }
  }

  // =========================================
  // E1: 同文件邻居扩展
  // =========================================

  /**
   * 扩展同文件邻居
   *
   * 对于每个 seed，获取其前后 ±neighborHops 个 chunks
   */
  private async expandNeighbors(
    seedsByFile: Map<string, ScoredChunk[]>,
    existingKeys: Set<string>,
  ): Promise<ScoredChunk[]> {
    const result: ScoredChunk[] = [];
    const { neighborHops, decayNeighbor } = this.config;

    // 性能优化：批量获取所有文件的 chunks（N 次查询 → 1 次）
    const allFilePaths = Array.from(seedsByFile.keys());
    const allChunksMap = await this.vectorStore?.getFilesChunks(allFilePaths);
    if (!allChunksMap) return result;

    for (const [filePath, fileSeeds] of seedsByFile) {
      // 从批量结果中获取该文件的 chunks
      const allChunks = allChunksMap.get(filePath) ?? [];
      if (allChunks.length === 0) continue;

      // 按 chunk_index 排序
      const sortedChunks = allChunks.sort((a, b) => a.chunk_index - b.chunk_index);
      const chunkMap = new Map(sortedChunks.map((c) => [c.chunk_index, c]));

      // 收集每个 seed 的邻居索引
      const seedIndices = new Set(fileSeeds.map((s) => s.chunkIndex));
      const neighborIndices = new Set<number>();

      for (const seed of fileSeeds) {
        const baseIndex = seed.chunkIndex;
        for (let delta = -neighborHops; delta <= neighborHops; delta++) {
          if (delta === 0) continue; // 跳过自身
          const neighborIndex = baseIndex + delta;
          if (!seedIndices.has(neighborIndex) && chunkMap.has(neighborIndex)) {
            neighborIndices.add(neighborIndex);
          }
        }
      }

      // 为邻居 chunks 计算衰减分数
      for (const neighborIndex of neighborIndices) {
        const chunk = chunkMap.get(neighborIndex);
        // 前面已经用 chunkMap.has(neighborIndex) 检查过，这里一定存在
        if (!chunk) continue;
        const key = `${filePath}#${neighborIndex}`;
        if (existingKeys.has(key)) continue;

        // 找到最近的 seed 及其距离
        let minDistance = Infinity;
        let maxSeedScore = 0;
        for (const seed of fileSeeds) {
          const distance = Math.abs(neighborIndex - seed.chunkIndex);
          if (distance < minDistance) {
            minDistance = distance;
            maxSeedScore = seed.score;
          } else if (distance === minDistance && seed.score > maxSeedScore) {
            maxSeedScore = seed.score;
          }
        }

        // 衰减分数：score * decay^distance
        const decayedScore = maxSeedScore * decayNeighbor ** minDistance;

        result.push({
          filePath,
          chunkIndex: neighborIndex,
          score: decayedScore,
          source: 'neighbor',
          record: { ...chunk, _distance: 0 },
        });
      }
    }

    return result;
  }

  // =========================================
  // E2: breadcrumb 补段
  // =========================================

  /**
   * 扩展 breadcrumb 补段
   *
   * 对于每个 seed，找到具有相同 breadcrumb 前缀的其他 chunks
   * 例如：如果 seed 的 breadcrumb 是 "src/foo.ts > class Foo > method bar"
   * 则会找到 "src/foo.ts > class Foo > ..." 的其他 chunks
   */
  private async expandBreadcrumb(
    seeds: ScoredChunk[],
    existingKeys: Set<string>,
  ): Promise<ScoredChunk[]> {
    const result: ScoredChunk[] = [];
    const { breadcrumbExpandLimit, decayBreadcrumb } = this.config;

    // 按 breadcrumb 前缀分组
    const prefixGroups = new Map<string, ScoredChunk[]>();

    for (const seed of seeds) {
      const prefix = this.extractBreadcrumbPrefix(seed.record.breadcrumb);
      if (!prefix) continue;

      if (!prefixGroups.has(prefix)) {
        prefixGroups.set(prefix, []);
      }
      prefixGroups.get(prefix)?.push(seed);
    }

    // 性能优化：批量获取所有涉及文件的 chunks（N 次查询 → 1 次）
    const uniqueFilePaths = new Set<string>();
    for (const prefixSeeds of prefixGroups.values()) {
      uniqueFilePaths.add(prefixSeeds[0].filePath);
    }
    const allChunksMap = await this.vectorStore?.getFilesChunks(Array.from(uniqueFilePaths));
    if (!allChunksMap) return result;

    // 对于每个前缀，查找同前缀的其他 chunks
    for (const [prefix, prefixSeeds] of prefixGroups) {
      const filePath = prefixSeeds[0].filePath;
      const allChunks = allChunksMap.get(filePath) ?? [];

      // 找到同前缀的 chunks
      const matchingChunks = allChunks.filter((chunk) => {
        const chunkPrefix = this.extractBreadcrumbPrefix(chunk.breadcrumb);
        return chunkPrefix === prefix;
      });

      // 排除已有的 chunks，取前 N 个
      const seedIndices = new Set(prefixSeeds.map((s) => s.chunkIndex));
      const newChunks = matchingChunks
        .filter((chunk) => !seedIndices.has(chunk.chunk_index))
        .filter((chunk) => !existingKeys.has(`${filePath}#${chunk.chunk_index}`))
        .slice(0, breadcrumbExpandLimit);

      // 计算衰减分数
      const maxSeedScore = Math.max(...prefixSeeds.map((s) => s.score));
      for (const chunk of newChunks) {
        result.push({
          filePath,
          chunkIndex: chunk.chunk_index,
          score: maxSeedScore * decayBreadcrumb,
          source: 'breadcrumb',
          record: { ...chunk, _distance: 0 },
        });
      }
    }

    return result;
  }

  /**
   * 提取 breadcrumb 的父级前缀
   *
   * 例如：
   * - "src/foo.ts > class Foo > method bar" → "src/foo.ts > class Foo"
   * - "src/foo.ts > function baz" → "src/foo.ts"
   * - "src/foo.ts" → null (没有父级)
   */
  private extractBreadcrumbPrefix(breadcrumb: string): string | null {
    const parts = breadcrumb.split(' > ');
    if (parts.length <= 1) return null;
    return parts.slice(0, -1).join(' > ');
  }

  // =========================================
  // E3: 跨文件引用解析（多语言支持）
  // =========================================

  /**
   * 扩展 import 关系
   *
   * 解析 seed 文件中的 import 语句，获取被导入文件的 chunks
   * 支持多语言：TypeScript/JavaScript, Python, Go, Java, Rust
   */
  private async expandImports(
    seeds: ScoredChunk[],
    existingKeys: Set<string>,
    queryTokens?: Set<string>,
    stats?: ExpandResult['stats'],
  ): Promise<ScoredChunk[]> {
    const result: ScoredChunk[] = [];
    const { importFilesPerSeed, chunksPerImportFile, decayImport, decayDepth } = this.config;
    const seedScoreByFile = this.buildSeedScoreByFile(seeds);
    const seedsByFile = this.groupByFile(seeds);
    const queue: Array<{ filePath: string; depth: number; seedScore: number }> = [];
    const visited = new Set<string>();

    for (const [filePath, seedScore] of seedScoreByFile.entries()) {
      queue.push({ filePath, depth: 0, seedScore });
    }

    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      const { filePath, depth, seedScore } = item;
      if (visited.has(filePath)) continue;
      visited.add(filePath);

      // depth=1 只允许 barrel 文件
      if (depth > 0 && !this.isBarrelFile(filePath)) continue;

      if (depth === 0) {
        const graphFirstChunks = await this.expandGraphRelations(
          seedsByFile.get(filePath) ?? [],
          existingKeys,
          queryTokens,
          seedScore,
          chunksPerImportFile,
          decayImport,
        );
        if (graphFirstChunks.length > 0) {
          result.push(...graphFirstChunks);
          continue;
        }
      }

      // 1. 查找对应的解析器
      const resolver = this.resolvers.find((r) => r.supports(filePath));
      if (!resolver) continue;

      // 2. 获取文件内容
      const row = this.db?.prepare('SELECT content FROM files WHERE path = ?').get(filePath) as
        | { content: string }
        | undefined;
      if (!row?.content) continue;

      // 3. 提取导入语句
      const importStrs = resolver.extract(row.content);
      if (importStrs.length === 0) continue;

      // 4. 批量解析路径并获取 Chunks（N 次查询 → 1 次）
      const perFileLimit = depth === 0 ? importFilesPerSeed : Math.min(importFilesPerSeed, 2);
      // 缓存已处理的 import，避免重复处理
      const processedImports = new Set<string>();
      const importTargets = new Map<string, string>(); // importStr -> targetPath

      // Phase A: 收集所有不重复的 targetPath
      for (const importStr of importStrs) {
        if (importTargets.size >= perFileLimit) break;
        if (processedImports.has(importStr)) continue;
        processedImports.add(importStr);

        // 核心: 使用解析器 + 全局文件索引进行解析
        // allFilePaths 在 expand() 入口处通过 loadFileIndex() 确保已加载
        const targetPath = resolver.resolve(importStr, filePath, this.allFilePaths as Set<string>);
        if (!targetPath || targetPath === filePath) continue; // 排除引用自己

        importTargets.set(importStr, targetPath);
      }

      if (importTargets.size === 0) continue;

      // Phase B: 一次性批量查询所有目标文件的 chunks
      const allTargetPaths = Array.from(new Set(importTargets.values()));
      const chunksByFile = await this.vectorStore?.getFilesChunks(allTargetPaths);
      if (!chunksByFile) continue;

      // Phase C: 按目标分配批量查询结果
      const depthDecay = depth === 0 ? 1 : decayDepth;
      let importCount = 0;
      const seenTargetPaths = new Set<string>();

      for (const [, targetPath] of importTargets) {
        if (importCount >= perFileLimit) break;
        // 同一 targetPath 只处理一次（多个 import 可能指向同一文件）
        if (seenTargetPaths.has(targetPath)) continue;
        seenTargetPaths.add(targetPath);

        const importChunks = chunksByFile.get(targetPath);
        if (!importChunks || importChunks.length === 0) continue;

        const selectedChunks = this.selectImportChunks(
          importChunks,
          chunksPerImportFile,
          queryTokens,
        );

        for (const chunk of selectedChunks) {
          const key = `${targetPath}#${chunk.chunk_index}`;
          if (existingKeys.has(key)) continue;

          result.push({
            filePath: targetPath,
            chunkIndex: chunk.chunk_index,
            score: seedScore * decayImport * depthDecay,
            source: 'import',
            record: { ...chunk, _distance: 0 },
          });
        }

        importCount++;

        if (depth === 0 && this.isBarrelFile(targetPath)) {
          if (stats) stats.importDepth1Count++;
          queue.push({ filePath: targetPath, depth: 1, seedScore });
        }
      }
    }
    return result;
  }

  /**
   * 基于 code graph 关系扩展（批量查询优化）
   *
   * Phase A: 收集所有下游目标的 filePath
   * Phase B: 一次性批量查询所有目标文件的 chunks
   * Phase C: 按目标分配结果并计算衰减分数
   */
  private async expandGraphRelations(
    seeds: ScoredChunk[],
    existingKeys: Set<string>,
    queryTokens: Set<string> | undefined,
    seedScore: number,
    chunksPerImportFile: number,
    decayImport: number,
  ): Promise<ScoredChunk[]> {
    if (!this.db || !this.vectorStore || seeds.length === 0 || chunksPerImportFile <= 0) {
      return [];
    }

    const store = new GraphStore(this.db);
    const resolvedSeedSymbols = this.resolveSeedSymbols(store, seeds);
    if (resolvedSeedSymbols.length === 0) {
      return [];
    }

    // Phase A: 收集所有不重复的下游目标
    const targetsBySymbolId = new Map<string, { filePath: string; symbol: StoredSymbol }>();
    const seenTargets = new Set<string>();

    for (const symbol of resolvedSeedSymbols) {
      const relations = store
        .getDirectRelations(symbol.id, 'downstream')
        .filter((relation) => relation.resolved && relation.symbol);

      for (const relation of relations) {
        const target = relation.symbol!;
        const targetKey = target.id;
        if (seenTargets.has(targetKey)) continue;
        seenTargets.add(targetKey);
        targetsBySymbolId.set(targetKey, { filePath: target.filePath, symbol: target });
      }
    }

    if (targetsBySymbolId.size === 0) return [];

    // Phase B: 批量查询所有目标文件的 chunks（N 次查询 → 1 次）
    const allTargetPaths = Array.from(new Set(
      Array.from(targetsBySymbolId.values()).map((t) => t.filePath),
    ));
    const chunksByFile = await this.vectorStore.getFilesChunks(allTargetPaths);

    // Phase C: 按目标分配批量查询结果
    const results: ScoredChunk[] = [];

    for (const [, { filePath, symbol: target }] of targetsBySymbolId) {
      const targetChunks = chunksByFile.get(filePath);
      if (!targetChunks || targetChunks.length === 0) continue;

      const prioritized = targetChunks.filter((chunk) => this.chunkMatchesSymbol(chunk, target));
      const selectedChunks = this.selectImportChunks(
        prioritized.length > 0 ? prioritized : targetChunks,
        chunksPerImportFile,
        queryTokens,
      );

      for (const chunk of selectedChunks) {
        const key = `${filePath}#${chunk.chunk_index}`;
        if (existingKeys.has(key)) continue;
        results.push({
          filePath,
          chunkIndex: chunk.chunk_index,
          score: seedScore * decayImport,
          source: 'import',
          record: { ...chunk, _distance: 0 },
        });
      }
    }

    return results;
  }

  // =========================================
  // 工具方法
  // =========================================

  /**
   * 生成 chunk 唯一键
   */
  private getChunkKey(chunk: ScoredChunk): string {
    return `${chunk.filePath}#${chunk.chunkIndex}`;
  }

  /**
   * 按文件分组
   */
  private groupByFile(chunks: ScoredChunk[]): Map<string, ScoredChunk[]> {
    const groups = new Map<string, ScoredChunk[]>();
    for (const chunk of chunks) {
      if (!groups.has(chunk.filePath)) {
        groups.set(chunk.filePath, []);
      }
      groups.get(chunk.filePath)?.push(chunk);
    }
    return groups;
  }

  /**
   * 按文件汇总 seed 最大得分
   */
  private buildSeedScoreByFile(seeds: ScoredChunk[]): Map<string, number> {
    const map = new Map<string, number>();
    for (const seed of seeds) {
      const current = map.get(seed.filePath);
      if (current === undefined || seed.score > current) {
        map.set(seed.filePath, seed.score);
      }
    }
    return map;
  }

  private resolveSeedSymbols(store: GraphStore, seeds: ScoredChunk[]): StoredSymbol[] {
    const resolved = new Map<string, StoredSymbol>();

    for (const seed of seeds) {
      const symbolName = this.extractSymbolNameFromBreadcrumb(seed.record.breadcrumb);
      if (!symbolName) continue;

      const matches = store
        .findSymbolsByName(symbolName)
        .filter((symbol) => symbol.filePath === seed.filePath);
      for (const match of matches) {
        resolved.set(match.id, match);
      }
    }

    return Array.from(resolved.values());
  }

  private extractSymbolNameFromBreadcrumb(breadcrumb: string): string | null {
    const parts = breadcrumb.split(' > ');
    const tail = parts[parts.length - 1];
    if (!tail || tail.includes('/')) {
      return null;
    }

    return tail
      .replace(/^(abstract class |class |interface |fn\*? |def |func |struct |enum |trait |record |@interface )/, '')
      .trim() || null;
  }

  private chunkMatchesSymbol(chunk: ChunkRecord, symbol: StoredSymbol): boolean {
    const normalizedBreadcrumb = chunk.breadcrumb.toLowerCase();
    const normalizedName = symbol.name.toLowerCase();
    return normalizedBreadcrumb.includes(normalizedName);
  }

  /**
   * 选择导入文件的 chunks（优先 query overlap）
   */
  private selectImportChunks(
    chunks: ChunkRecord[],
    limit: number,
    queryTokens?: Set<string>,
  ): ChunkRecord[] {
    if (limit <= 0) return [];

    const sortedByIndex = chunks.slice().sort((a, b) => a.chunk_index - b.chunk_index);
    if (!queryTokens || queryTokens.size === 0) {
      return sortedByIndex.slice(0, limit);
    }

    const scored = sortedByIndex.map((chunk) => ({
      chunk,
      score: this.scoreChunkTokenOverlap(chunk, queryTokens),
    }));

    const overlapped = scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.chunk);

    return overlapped.length > 0 ? overlapped : sortedByIndex.slice(0, limit);
  }

  /**
   * 计算 chunk 与查询的 token overlap 得分
   */
  private scoreChunkTokenOverlap(
    chunk: Pick<ChunkRecord, 'breadcrumb' | 'display_code'>,
    queryTokens: Set<string>,
  ): number {
    const text = `${chunk.breadcrumb} ${chunk.display_code}`.toLowerCase();
    let score = 0;

    for (const token of queryTokens) {
      if (text.includes(token)) {
        const wordBoundaryRegex = new RegExp(
          `\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
        );
        if (wordBoundaryRegex.test(text)) {
          score += 1;
        } else {
          score += 0.5;
        }
      }
    }

    return score;
  }

  /**
   * 判断是否为 barrel/index 文件
   */
  private isBarrelFile(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    if (lower.endsWith('/__init__.py')) return true;
    if (lower.endsWith('/mod.rs')) return true;
    return /\/index\.(ts|tsx|js|jsx|mts|mjs|cts|cjs)$/.test(lower);
  }

  private buildExplorationCandidates(
    chunks: ScoredChunk[],
    seedFiles: Set<string>,
    queryTokens?: Set<string>,
  ): ExpansionCandidate[] {
    const byFile = new Map<string, ScoredChunk>();
    const sourcePriority = (source: ScoredChunk['source']): number =>
      source === 'import' ? 3 : source === 'breadcrumb' ? 2 : 1;
    const overlapScore = (filePath: string): number => this.computeExplorationPathOverlap(filePath, queryTokens);

    for (const chunk of [...chunks].sort((a, b) => {
      const sourceDelta = sourcePriority(b.source) - sourcePriority(a.source);
      if (sourceDelta !== 0) return sourceDelta;
      const overlapDelta = overlapScore(b.filePath) - overlapScore(a.filePath);
      if (overlapDelta !== 0) return overlapDelta;
      return b.score - a.score;
    })) {
      if (seedFiles.has(chunk.filePath)) {
        continue;
      }
      if (!byFile.has(chunk.filePath)) {
        byFile.set(chunk.filePath, chunk);
      }
    }

    return Array.from(byFile.values())
      .slice(0, 5)
      .map((chunk) => ({
        filePath: chunk.filePath,
        source: chunk.source,
        reason: `expanded via ${chunk.source}`,
        priority: chunk.source === 'import' ? 'high' : chunk.source === 'breadcrumb' ? 'medium' : 'low',
      }));
  }

  private computeExplorationPathOverlap(filePath: string, queryTokens?: Set<string>): number {
    if (!queryTokens || queryTokens.size === 0) {
      return 0;
    }

    const pathTokens = filePath
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 0);

    let overlap = 0;
    for (const queryToken of queryTokens) {
      if (queryToken.length < 3) continue;
      if (pathTokens.some((pathToken) => pathToken === queryToken || pathToken.includes(queryToken) || queryToken.includes(pathToken))) {
        overlap++;
      }
    }
    return overlap;
  }
}

// ===========================================
// 工厂函数
// ===========================================

const expanders = new Map<string, GraphExpander>();

function buildExpanderKey(projectId: string, snapshotId?: string | null): string {
  const suffix = snapshotId === undefined ? '__current__' : snapshotId === null ? '__legacy__' : snapshotId;
  return `${projectId}::${suffix}`;
}

/**
 * 获取或创建 GraphExpander 实例
 */
export async function getGraphExpander(
  projectId: string,
  config: SearchConfig,
  snapshotId?: string | null,
): Promise<GraphExpander> {
  const key = buildExpanderKey(projectId, snapshotId);
  let expander = expanders.get(key);
  if (!expander) {
    expander = new GraphExpander(projectId, config, snapshotId);
    await expander.init();
    expanders.set(key, expander);
  }
  return expander;
}

/**
 * 关闭所有 GraphExpander 缓存实例
 * 供 closeAllCachedResources 调用
 */
export function closeAllGraphExpanders(): void {
  for (const expander of expanders.values()) {
    expander.invalidateFileIndex();
  }
  expanders.clear();
}
