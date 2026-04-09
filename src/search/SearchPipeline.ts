import type Database from 'better-sqlite3';
import { getRerankerClient, type RerankUsage } from '../api/reranker.js';
import { logger } from '../utils/logger.js';
import type { Indexer } from '../indexer/index.js';
import type { VectorStore } from '../vectorStore/index.js';
import { ContextPacker } from './ContextPacker.js';
import { getGraphExpander } from './GraphExpander.js';
import { HybridRecallEngine } from './HybridRecallEngine.js';
import {
  buildContextRequest,
  buildResultStats,
  type BuildContextPackOptions,
} from './SearchPipelineSupport.js';
import { applySmartCutoff, selectRerankPoolCandidates } from './RerankPolicy.js';
import { buildRerankText } from './SnippetExtractor.js';
import type {
  ContextPack,
  ExpansionCandidate,
  RetrievalStats,
  ScoredChunk,
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

export interface SearchPipelineCallbacks {
  rerank?: (
    query: string,
    candidates: ScoredChunk[],
    config: SearchConfig,
  ) => Promise<{ chunks: ScoredChunk[]; usage?: RerankUsage; inputCount: number }>;
  expand?: (
    seeds: ScoredChunk[],
    queryTokens: Set<string> | undefined,
    config: SearchConfig,
  ) => Promise<{
    chunks: ScoredChunk[];
    explorationCandidates: ExpansionCandidate[];
    nextInspectionSuggestions: string[];
  }>;
}

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
  const reranked = await (callbacks.rerank
    ? callbacks.rerank(query, topM, request.activeConfig)
    : rerankCandidates(query, topM, request.activeConfig, extractQueryTokens));
  timingMs.rerank = Date.now() - t0;

  t0 = Date.now();
  const seeds = applySmartCutoff(reranked.chunks, request.activeConfig);
  timingMs.smartCutoff = Date.now() - t0;

  t0 = Date.now();
  onStage?.('expand');
  const queryTokens = extractQueryTokens(query);
  const expandedResult = await (callbacks.expand
    ? callbacks.expand(seeds, queryTokens, request.activeConfig)
    : expandSeeds(runtime.projectId, runtime.snapshotId, seeds, queryTokens, request.activeConfig));
  const expanded = Array.isArray(expandedResult) ? expandedResult : expandedResult.chunks;
  timingMs.expand = Date.now() - t0;

  t0 = Date.now();
  onStage?.('pack');
  const packer = new ContextPacker(runtime.projectId, request.activeConfig, runtime.snapshotId);
  const chunksToPack = request.responseMode === 'overview' ? seeds : [...seeds, ...expanded];
  const packResult = await packer.packWithStats(chunksToPack);
  const files = packResult.files;
  timingMs.pack = Date.now() - t0;

  const retrievalStats: RetrievalStats = {
    queryIntent: request.queryIntent,
    ...retrieved.stats,
    topMCount,
    rerankInputCount: reranked.inputCount,
    rerankedCount: reranked.chunks.length,
  };
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

async function rerankCandidates(
  query: string,
  candidates: ScoredChunk[],
  config: SearchConfig,
  extractQueryTokens: (query: string) => Set<string>,
): Promise<{ chunks: ScoredChunk[]; usage?: RerankUsage; inputCount: number }> {
  if (candidates.length === 0) {
    return { chunks: [], inputCount: 0 };
  }

  const reranker = getRerankerClient();
  const queryTokens = extractQueryTokens(query);
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

async function expandSeeds(
  projectId: string,
  snapshotId: string | null | undefined,
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

  const expander = await getGraphExpander(projectId, config, snapshotId);
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
