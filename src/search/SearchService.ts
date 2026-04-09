/**
 * SearchService - 检索编排 facade
 *
 * 负责持有运行时依赖并委托 SearchPipeline 执行具体编排。
 */

import type Database from 'better-sqlite3';
import { getRerankerClient, type RerankUsage } from '../api/reranker.js';
import { getEmbeddingConfig } from '../config.js';
import { initDb } from '../db/index.js';
import { getIndexer, type Indexer } from '../indexer/index.js';
import { logger } from '../utils/logger.js';
import { getVectorStore, type VectorStore } from '../vectorStore/index.js';
import { createQueryTokenSet } from './SearchQueryTokens.js';
import {
  buildContextPackFromRuntime,
  type SearchPipelineCallbacks,
  type SearchProgressStage,
} from './SearchPipeline.js';
import type { BuildContextPackOptions } from './SearchPipelineSupport.js';
import { DEFAULT_CONFIG } from './config.js';
import { getGraphExpander } from './GraphExpander.js';
import { classifyQueryIntent, deriveQueryAwareSearchConfig } from './QueryIntentClassifier.js';
import { applySmartCutoff, selectRerankPoolCandidates } from './RerankPolicy.js';
import { buildRerankText } from './SnippetExtractor.js';
import type { ContextPack, ExpansionCandidate, ScoredChunk, SearchConfig } from './types.js';
import {
  initializeSearchDependencies,
  type SearchDependencyLoaders,
} from './runtime/initializeSearchDependencies.js';

export type { BuildContextPackOptions } from './SearchPipelineSupport.js';
export type { SearchProgressStage } from './SearchPipeline.js';
export { applySmartCutoff, selectRerankPoolCandidates } from './RerankPolicy.js';
export { classifyQueryIntent, deriveQueryAwareSearchConfig } from './QueryIntentClassifier.js';
export {
  initializeSearchDependencies,
  type SearchDependencyLoaders,
} from './runtime/initializeSearchDependencies.js';

export class SearchService {
  private projectId: string;
  private snapshotId: string | null | undefined;
  private indexer: Indexer | null = null;
  private vectorStore: VectorStore | null = null;
  private db: Database.Database | null = null;
  private config: SearchConfig;

  constructor(
    projectId: string,
    _projectPath: string,
    config?: Partial<SearchConfig>,
    snapshotId?: string | null,
  ) {
    this.projectId = projectId;
    this.snapshotId = snapshotId;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async init(): Promise<void> {
    const embeddingConfig = getEmbeddingConfig();
    const deps = await initializeSearchDependencies({
      loadIndexer: () => getIndexer(this.projectId, embeddingConfig.dimensions, this.snapshotId),
      loadVectorStore: () => getVectorStore(this.projectId, embeddingConfig.dimensions, this.snapshotId),
      loadDb: async () => initDb(this.projectId, this.snapshotId),
    });
    this.indexer = deps.indexer;
    this.vectorStore = deps.vectorStore;
    this.db = deps.db;
  }

  async buildContextPack(
    query: string,
    onStage?: (stage: SearchProgressStage) => void,
    options: BuildContextPackOptions = {},
  ): Promise<ContextPack> {
    const callbacks: SearchPipelineCallbacks = {
      rerank: (activeQuery, candidates, config) => this.rerank(activeQuery, candidates, config),
      expand: (seeds, queryTokens, config) => this.expand(seeds, queryTokens, config),
    };

    return buildContextPackFromRuntime(
      {
        projectId: this.projectId,
        snapshotId: this.snapshotId,
        indexer: this.indexer,
        vectorStore: this.vectorStore,
        db: this.db,
      },
      query,
      this.config,
      createQueryTokenSet,
      onStage,
      options,
      callbacks,
    );
  }

  private async rerank(
    query: string,
    candidates: ScoredChunk[],
    config: SearchConfig,
  ): Promise<{ chunks: ScoredChunk[]; usage?: RerankUsage; inputCount: number }> {
    if (candidates.length === 0) {
      return { chunks: [], inputCount: 0 };
    }

    const reranker = getRerankerClient();
    const queryTokens = createQueryTokenSet(query);
    const rerankPool = selectRerankPoolCandidates(candidates, config);
    const textExtractor = (chunk: ScoredChunk): string =>
      buildRerankText(
        {
          breadcrumb: chunk.record.breadcrumb,
          displayCode: chunk.record.display_code,
        },
        queryTokens,
        {
          maxBreadcrumbChars: config.maxBreadcrumbChars,
          maxRerankChars: config.maxRerankChars,
          headRatio: config.headRatio,
        },
      );

    const reranked = await reranker.rerankWithDataDetailed(query, rerankPool, textExtractor, {
      topN: config.rerankTopN,
    });

    return {
      chunks: reranked.results
        .filter((result) => result.data !== undefined)
        .map((result) => ({
          ...(result.data as ScoredChunk),
          score: result.score,
        })),
      usage: reranked.usage,
      inputCount: rerankPool.length,
    };
  }

  private async expand(
    seeds: ScoredChunk[],
    queryTokens: Set<string> | undefined,
    config: SearchConfig,
  ): Promise<{
    chunks: ScoredChunk[];
    explorationCandidates: ExpansionCandidate[];
    nextInspectionSuggestions: string[];
  }> {
    if (seeds.length === 0) {
      return {
        chunks: [],
        explorationCandidates: [],
        nextInspectionSuggestions: [],
      };
    }

    const expander = await getGraphExpander(this.projectId, config, this.snapshotId);
    const { chunks, stats, explorationCandidates, nextInspectionSuggestions } = await expander.expand(
      seeds,
      queryTokens,
    );

    logger.debug(stats, '上下文扩展统计');

    return {
      chunks,
      explorationCandidates,
      nextInspectionSuggestions,
    };
  }

  getConfig(): SearchConfig {
    return { ...this.config };
  }
}
