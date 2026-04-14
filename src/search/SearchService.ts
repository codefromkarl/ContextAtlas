/**
 * SearchService - 检索编排 facade
 *
 * 负责持有运行时依赖并委托 SearchPipeline 执行具体编排。
 */

import type Database from 'better-sqlite3';
import { getEmbeddingConfig } from '../config.js';
import { initDb } from '../db/index.js';
import { getIndexer, type Indexer } from '../indexer/index.js';
import { getVectorStore, type VectorStore } from '../vectorStore/index.js';
import { createQueryTokenSet } from './SearchQueryTokens.js';
import {
  buildContextPackFromRuntime,
  type SearchProgressStage,
} from './SearchPipeline.js';
import { createSearchPipelineCallbacks } from './SearchPipelineCallbacks.js';
import type { BuildContextPackOptions } from './SearchPipelineSupport.js';
import { DEFAULT_CONFIG } from './config.js';
import type { ContextPack, SearchConfig } from './types.js';
import {
  initializeSearchDependencies,
} from './runtime/initializeSearchDependencies.js';
import {
  createSearchRuntimeContext,
  type SearchRuntimeState,
} from './runtime/SearchRuntimeProvider.js';
import type { SearchPipelineCallbacks } from './SearchPipelineCallbacks.js';

export type { BuildContextPackOptions } from './SearchPipelineSupport.js';
export type { SearchProgressStage } from './SearchPipeline.js';
export { applySmartCutoff, selectRerankPoolCandidates } from './RerankPolicy.js';
export { classifyQueryIntent, deriveQueryAwareSearchConfig } from './QueryIntentClassifier.js';
export {
  initializeSearchDependencies,
  type SearchDependencyLoaders,
} from './runtime/initializeSearchDependencies.js';
export {
  createSearchRuntimeContext,
  type SearchRuntimeState,
} from './runtime/SearchRuntimeProvider.js';

export interface SearchServiceDependencies {
  callbacksFactory?: (state: SearchRuntimeState) => SearchPipelineCallbacks;
}

export class SearchService {
  private projectId: string;
  private snapshotId: string | null | undefined;
  private indexer: Indexer | null = null;
  private vectorStore: VectorStore | null = null;
  private db: Database.Database | null = null;
  private config: SearchConfig;
  private callbacksFactory: (state: SearchRuntimeState) => SearchPipelineCallbacks;

  constructor(
    projectId: string,
    _projectPath: string,
    config?: Partial<SearchConfig>,
    snapshotId?: string | null,
    dependencies: SearchServiceDependencies = {},
  ) {
    this.projectId = projectId;
    this.snapshotId = snapshotId;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.callbacksFactory = dependencies.callbacksFactory
      ?? ((state) =>
        createSearchPipelineCallbacks({
          projectId: state.projectId,
          snapshotId: state.snapshotId,
          extractQueryTokens: createQueryTokenSet,
        }));
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
    const runtimeState = this.getRuntimeState();

    return buildContextPackFromRuntime(
      createSearchRuntimeContext(runtimeState),
      query,
      this.config,
      createQueryTokenSet,
      onStage,
      options,
      this.callbacksFactory(runtimeState),
    );
  }

  private getRuntimeState(): SearchRuntimeState {
    const { projectId, snapshotId, indexer, vectorStore, db } = this;
    return {
      projectId,
      snapshotId,
      indexer,
      vectorStore,
      db,
    };
  }

  getConfig(): SearchConfig {
    return { ...this.config };
  }
}
