import type Database from 'better-sqlite3';
import type { Indexer } from '../indexer/index.js';
import type { VectorStore } from '../vectorStore/index.js';
import { ContextPacker } from './ContextPacker.js';
import { HybridRecallEngine } from './HybridRecallEngine.js';
import type { SearchPipelineCallbacks } from './SearchPipelineCallbacks.js';
import {
  buildContextRequest,
  buildRetrievalStats,
  buildResultStats,
  type BuildContextPackOptions,
} from './SearchPipelineSupport.js';
import { applySmartCutoff } from './RerankPolicy.js';
import type {
  ContextPack,
  RetrievalStats,
  SearchConfig,
} from './types.js';

export type SearchProgressStage = 'retrieve' | 'rerank' | 'expand' | 'pack';

export interface SearchRuntimeContext {
  projectId: string;
  snapshotId: string | null | undefined;
  indexer: Indexer | null;
  vectorStore: VectorStore | null;
  db: Database.Database | null;
}

export type { SearchPipelineCallbacks } from './SearchPipelineCallbacks.js';

export async function buildContextPackFromRuntime(
  runtime: SearchRuntimeContext,
  query: string,
  baseConfig: SearchConfig,
  extractQueryTokens: (query: string) => Set<string>,
  onStage?: (stage: SearchProgressStage) => void,
  options: BuildContextPackOptions = {},
  callbacks: SearchPipelineCallbacks = {},
): Promise<ContextPack> {
  const request = buildContextRequest(query, options, baseConfig);
  const timingMs: Record<string, number> = {};
  let t0 = Date.now();

  onStage?.('retrieve');
  const recallEngine = new HybridRecallEngine({
    indexer: runtime.indexer,
    vectorStore: runtime.vectorStore,
    db: runtime.db,
    config: request.activeConfig,
    extractQueryTokens,
  });
  const retrieved = await recallEngine.hybridRetrieve(request.semanticQuery, request.lexicalQuery);
  const candidates = retrieved.chunks;
  timingMs.retrieve = Date.now() - t0;
  timingMs.retrieveVector = retrieved.timingMs.retrieveVector;
  timingMs.retrieveLexical = retrieved.timingMs.retrieveLexical;
  timingMs.retrieveFuse = retrieved.timingMs.retrieveFuse;

  t0 = Date.now();
  const topM = candidates.sort((a, b) => b.score - a.score).slice(0, request.activeConfig.fusedTopM);
  const topMCount = topM.length;

  onStage?.('rerank');
  if (!callbacks.rerank) {
    throw new Error('Search pipeline rerank callback is not configured');
  }
  const reranked = await callbacks.rerank(query, topM, request.activeConfig);
  timingMs.rerank = Date.now() - t0;

  t0 = Date.now();
  const seeds = applySmartCutoff(reranked.chunks, request.activeConfig);
  timingMs.smartCutoff = Date.now() - t0;

  t0 = Date.now();
  onStage?.('expand');
  const queryTokens = extractQueryTokens(query);
  if (!callbacks.expand) {
    throw new Error('Search pipeline expand callback is not configured');
  }
  const expandedResult = await callbacks.expand(seeds, queryTokens, request.activeConfig);
  const expanded = Array.isArray(expandedResult) ? expandedResult : expandedResult.chunks;
  timingMs.expand = Date.now() - t0;

  t0 = Date.now();
  onStage?.('pack');
  const packer = new ContextPacker(runtime.projectId, request.activeConfig, runtime.snapshotId);
  const chunksToPack = request.responseMode === 'overview' ? seeds : [...seeds, ...expanded];
  const packResult = await packer.packWithStats(chunksToPack);
  const files = packResult.files;
  timingMs.pack = Date.now() - t0;

  const retrievalStats = buildRetrievalStats({
    queryIntent: request.queryIntent,
    retrievedStats: retrieved.stats,
    topMCount,
    rerankInputCount: reranked.inputCount,
    rerankedCount: reranked.chunks.length,
  });
  const resultStats = buildResultStats({
    seeds,
    expanded,
    files,
    packStats: packResult.stats,
  });

  return {
    query,
    mode: request.responseMode,
    seeds,
    expanded,
    files,
    expansionCandidates: Array.isArray(expandedResult) ? [] : expandedResult.explorationCandidates,
    nextInspectionSuggestions: Array.isArray(expandedResult) ? [] : expandedResult.nextInspectionSuggestions,
    debug: {
      wVec: request.activeConfig.wVec,
      wLex: request.activeConfig.wLex,
      timingMs,
      retrievalStats,
      resultStats,
      rerankUsage: reranked.usage,
    },
  };
}
