import { getRerankerClient, type RerankUsage } from '../api/reranker.js';
import { logger } from '../utils/logger.js';
import { getGraphExpander } from './GraphExpander.js';
import { selectRerankPoolCandidates } from './RerankPolicy.js';
import { buildRerankText } from './SnippetExtractor.js';
import type { ExpansionCandidate, ScoredChunk, SearchConfig } from './types.js';

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

export function createSearchPipelineCallbacks(input: {
  projectId: string;
  snapshotId?: string | null;
  extractQueryTokens: (query: string) => Set<string>;
}): SearchPipelineCallbacks {
  return {
    rerank: async (query, candidates, config) => {
      if (candidates.length === 0) {
        return { chunks: [], inputCount: 0 };
      }

      const reranker = getRerankerClient();
      const queryTokens = input.extractQueryTokens(query);
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
    },
    expand: async (seeds, queryTokens, config) => {
      if (seeds.length === 0) {
        return {
          chunks: [],
          explorationCandidates: [],
          nextInspectionSuggestions: [],
        };
      }

      const expander = await getGraphExpander(input.projectId, config, input.snapshotId);
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
    },
  };
}
