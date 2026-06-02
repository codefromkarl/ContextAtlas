import type Database from 'better-sqlite3';
import { isDebugEnabled, logger } from '../utils/logger.js';
import { retrieveGraphChunks } from './GraphRecall.js';
import type { SearchResult as VectorSearchResult } from '../vectorStore/index.js';
import type { VectorStore } from '../vectorStore/index.js';
import { isChunksFtsInitialized, isFtsInitialized, searchChunksFts, searchFilesFts } from './fts.js';
import { retrieveSkeletonChunks } from './SkeletonRecall.js';
import type { LexicalStrategy, RetrievalStats, ScoredChunk, SearchConfig } from './types.js';
import type { Indexer } from '../indexer/index.js';

import { SmartFusionStrategy, type FusionStrategy } from './FusionStrategy.js';
import { fuseRecallResults } from './rrfFusion.js';

const tokenBoundaryRegexCache = new Map<string, RegExp>();

function getTokenBoundaryRegex(token: string): RegExp {
  let regex = tokenBoundaryRegexCache.get(token);
  if (!regex) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    regex = new RegExp(`\\b${escaped}\\b`);
    tokenBoundaryRegexCache.set(token, regex);
  }
  return regex;
}

export interface HybridRetrieveResult {
  chunks: ScoredChunk[];
  stats: Omit<RetrievalStats, 'topMCount' | 'rerankedCount'>;
  timingMs: {
    retrieveVector: number;
    retrieveLexical: number;
    retrieveFuse: number;
  };
}

interface LexicalRetrieveResult {
  chunks: ScoredChunk[];
  strategy: LexicalStrategy;
}

interface NonVectorRetrieveResult {
  chunks: ScoredChunk[];
  strategy: LexicalStrategy;
  lexicalCount: number;
  skeletonCount: number;
  graphCount: number;
}

export function scoreChunkTokenOverlap(
  chunk: { breadcrumb: string; display_code: string },
  queryTokens: Set<string>,
): number {
  const text = `${chunk.breadcrumb} ${chunk.display_code}`.toLowerCase();
  let score = 0;

  for (const token of queryTokens) {
    if (text.includes(token)) {
      const regex = getTokenBoundaryRegex(token);
      if (regex.test(text)) {
        score += 1;
      } else {
        score += 0.5;
      }
    }
  }

  return score;
}

function scoreFilePathBias(filePath: string, intent: QueryIntent): number {
  const lowerPath = filePath.toLowerCase();

  if (intent === 'symbol_lookup') {
    if (lowerPath.startsWith('src/')) return 1.25;
    if (lowerPath.startsWith('tests/')) return 0.5;
    if (lowerPath.startsWith('docs/') || lowerPath === 'readme.md' || lowerPath === 'readme_zh.md') return 0.4;
  }

  return 1;
}

// Re-export for backward compatibility
export { fuseRecallResults } from './rrfFusion.js';

export interface HybridRecallEngineOptions {
  indexer: Indexer | null;
  vectorStore: VectorStore | null;
  db: Database.Database | null;
  config: SearchConfig;
  extractQueryTokens: (query: string) => Set<string>;
  fusionStrategy?: FusionStrategy;
}

export class HybridRecallEngine {
  private readonly indexer: Indexer | null;
  private readonly vectorStore: VectorStore | null;
  private readonly db: Database.Database | null;
  private readonly config: SearchConfig;
  private readonly extractQueryTokensFn: (query: string) => Set<string>;
  private readonly fusionStrategy: FusionStrategy;

  constructor(options: HybridRecallEngineOptions) {
    this.indexer = options.indexer;
    this.vectorStore = options.vectorStore;
    this.db = options.db;
    this.config = options.config;
    this.extractQueryTokensFn = options.extractQueryTokens;
    this.fusionStrategy = options.fusionStrategy ?? new SmartFusionStrategy();
  }

  async hybridRetrieve(
    semanticQuery: string,
    lexicalQuery: string,
    queryIntent: QueryIntent = 'balanced',
  ): Promise<HybridRetrieveResult> {
    const vectorStart = Date.now();
    const vectorPromise = this.vectorRetrieve(semanticQuery).then((results) => ({
      results,
      durationMs: Date.now() - vectorStart,
    }));
    const nonVectorStart = Date.now();
    const nonVectorPromise = Promise.all([
      this.lexicalRetrieve(lexicalQuery, queryIntent),
      retrieveSkeletonChunks({
        db: this.db,
        vectorStore: this.vectorStore,
        query: lexicalQuery,
        queryTokens: this.extractQueryTokensFn(lexicalQuery),
        config: this.config,
      }),
      retrieveGraphChunks({
        db: this.db,
        vectorStore: this.vectorStore,
        query: lexicalQuery,
        config: this.config,
      }),
    ]).then(([lexicalResult, skeletonChunks, graphChunks]) => {
      const result: NonVectorRetrieveResult = {
        chunks: [...lexicalResult.chunks, ...skeletonChunks, ...graphChunks],
        strategy: lexicalResult.strategy,
        lexicalCount: lexicalResult.chunks.length,
        skeletonCount: skeletonChunks.length,
        graphCount: graphChunks.length,
      };
      return {
        ...result,
        durationMs: Date.now() - nonVectorStart,
      };
    });
    const [{ results: vectorResults, durationMs: retrieveVector }, lexicalOutcome] = await Promise.all([
      vectorPromise,
      nonVectorPromise,
    ]);
    const lexicalResults = lexicalOutcome.chunks;
    const retrieveLexical = lexicalOutcome.durationMs;

    logger.debug(
      {
        vectorCount: vectorResults.length,
        lexicalCount: lexicalResults.length,
        lexicalStrategy: lexicalOutcome.strategy,
      },
      '混合召回完成',
    );

    const fusionOutput = this.fusionStrategy.fuse({
      vectorResults,
      lexicalResults,
      config: this.config,
      lexicalStrategy: lexicalOutcome.strategy,
      queryIntent,
      lexicalCount: lexicalOutcome.lexicalCount,
      skeletonCount: lexicalOutcome.skeletonCount,
      graphCount: lexicalOutcome.graphCount,
      timingMs: {
        retrieveVector,
        retrieveLexical,
      },
    });

    return {
      chunks: fusionOutput.chunks,
      stats: {
        lexicalStrategy: lexicalOutcome.strategy,
        vectorCount: vectorResults.length,
        lexicalCount: lexicalOutcome.lexicalCount,
        skeletonCount: lexicalOutcome.skeletonCount,
        graphCount: lexicalOutcome.graphCount,
        fusedCount: fusionOutput.chunks.length,
        rerankInputCount: 0,
        queryIntent: 'balanced',
      },
      timingMs: fusionOutput.timingMs,
    };
  }

  private async vectorRetrieve(query: string): Promise<ScoredChunk[]> {
    if (!this.indexer) throw new Error('SearchService not initialized');

    const results = await this.indexer.textSearch(query, this.config.vectorTopK);
    if (!results) return [];

    return results
      .sort((a, b) => a._distance - b._distance)
      .slice(0, this.config.vectorTopM)
      .map((r: VectorSearchResult, rank: number) => ({
        filePath: r.file_path,
        chunkIndex: r.chunk_index,
        score: 1 / (1 + r._distance),
        source: 'vector' as const,
        record: r,
        _rank: rank,
      }));
  }

  private async lexicalRetrieve(query: string, queryIntent: QueryIntent = 'balanced'): Promise<LexicalRetrieveResult> {
    if (!this.db || !this.vectorStore) return { chunks: [], strategy: 'none' };

    if (isChunksFtsInitialized(this.db)) {
      const chunkResults = await this.lexicalRetrieveFromChunksFts(query);
      if (chunkResults.length > 0) {
        return {
          chunks: chunkResults,
          strategy: 'chunks_fts',
        };
      }

      if (isFtsInitialized(this.db)) {
        logger.debug('Chunk FTS 为空，自动回退到 files_fts');
        return {
          chunks: await this.lexicalRetrieveFromFilesFts(query, queryIntent),
          strategy: 'files_fts',
        };
      }

      return {
        chunks: [],
        strategy: 'chunks_fts',
      };
    }

    if (isFtsInitialized(this.db)) {
      return {
        chunks: await this.lexicalRetrieveFromFilesFts(query, queryIntent),
        strategy: 'files_fts',
      };
    }

    logger.debug('FTS 未初始化，跳过词法召回');
    return { chunks: [], strategy: 'none' };
  }

  private async lexicalRetrieveFromChunksFts(query: string): Promise<ScoredChunk[]> {
    const chunkResults = searchChunksFts(
      this.db as Database.Database,
      query,
      this.config.lexTotalChunks,
    );

    if (chunkResults.length === 0) {
      logger.debug('Chunk FTS 无命中');
      return [];
    }

    const allChunks: ScoredChunk[] = [];
    const fileChunksMap = new Map<string, Map<number, number>>();
    for (const result of chunkResults) {
      if (!fileChunksMap.has(result.filePath)) {
        fileChunksMap.set(result.filePath, new Map());
      }
      fileChunksMap.get(result.filePath)?.set(result.chunkIndex, result.score);
    }

    const allFilePaths = Array.from(fileChunksMap.keys());
    const chunksMap = await this.vectorStore?.getFilesChunks(allFilePaths);
    if (!chunksMap) return allChunks;

    for (const [filePath, chunkScores] of fileChunksMap) {
      const chunks = chunksMap.get(filePath) ?? [];

      for (const chunk of chunks) {
        const score = chunkScores.get(chunk.chunk_index);
        if (score !== undefined) {
          allChunks.push({
            filePath: chunk.file_path,
            chunkIndex: chunk.chunk_index,
            score,
            source: 'lexical' as const,
            record: { ...chunk, _distance: 0 },
          });
        }
      }
    }

    logger.debug(
      {
        totalChunks: allChunks.length,
        filesWithChunks: fileChunksMap.size,
      },
      'Chunk FTS 召回完成',
    );

    return allChunks
      .sort((a, b) => b.score - a.score)
      .map((chunk, rank) => ({ ...chunk, _rank: rank }));
  }

  private async lexicalRetrieveFromFilesFts(query: string, queryIntent: QueryIntent): Promise<ScoredChunk[]> {
    const fileResults = searchFilesFts(
      this.db as Database.Database,
      query,
      this.config.ftsTopKFiles,
    ).map((result) => ({
      ...result,
      score: result.score * scoreFilePathBias(result.path, queryIntent),
    }))
      .sort((a, b) => b.score - a.score);
    if (fileResults.length === 0) {
      logger.debug('FTS 无命中文件');
      return [];
    }

    const queryTokens = this.extractQueryTokensFn(query);
    const filePaths = Array.from(new Set(fileResults.map((result) => result.path)));
    const chunksMap = await this.vectorStore?.getFilesChunks(filePaths);
    if (!chunksMap) return [];

    logger.debug(
      {
        fileCount: fileResults.length,
        queryTokens: Array.from(queryTokens).slice(0, 10),
      },
      'FTS 召回开始 chunk 选择',
    );

    const allChunks: ScoredChunk[] = [];
    let totalChunks = 0;
    let skippedFiles = 0;

    for (const { path: filePath, score: fileScore } of fileResults) {
      if (totalChunks >= this.config.lexTotalChunks) break;

      const chunks = chunksMap.get(filePath) ?? [];
      if (chunks.length === 0) continue;

      const scoredChunks = chunks.map((chunk) => ({
        chunk,
        overlapScore: scoreChunkTokenOverlap(chunk, queryTokens),
      }));

      const maxOverlap = Math.max(...scoredChunks.map((c) => c.overlapScore));
      if (maxOverlap === 0) {
        skippedFiles++;
        continue;
      }

      const topChunks = scoredChunks
        .filter((c) => c.overlapScore > 0)
        .sort((a, b) => b.overlapScore - a.overlapScore)
        .slice(0, this.config.lexChunksPerFile);

      for (const { chunk, overlapScore } of topChunks) {
        if (totalChunks >= this.config.lexTotalChunks) break;

        const combinedScore = fileScore * (1 + overlapScore * 0.5);

        allChunks.push({
          filePath: chunk.file_path,
          chunkIndex: chunk.chunk_index,
          score: combinedScore,
          source: 'lexical' as const,
          record: { ...chunk, _distance: 0 },
        });
        totalChunks++;
      }
    }

    if (skippedFiles > 0) {
      logger.debug({ skippedFiles }, 'FTS 跳过 overlap=0 的文件');
    }

    logger.debug(
      {
        totalChunks: allChunks.length,
        filesWithChunks: new Set(allChunks.map((c) => c.filePath)).size,
      },
      'FTS chunk 选择完成',
    );

    return allChunks
      .sort((a, b) => b.score - a.score)
      .map((chunk, rank) => ({ ...chunk, _rank: rank }));
  }
}
