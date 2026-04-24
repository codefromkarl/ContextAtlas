import { initDb } from '../db/index.js';
import { type RerankUsage } from '../api/reranker.js';
import { getRerankerBackend } from '../api/rerankerRouter.js';
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

function loadSkeletonSummaryMap(
  projectId: string,
  snapshotId: string | null | undefined,
  filePaths: string[],
): Map<string, string> {
  if (filePaths.length === 0) {
    return new Map();
  }

  const db = initDb(projectId, snapshotId);
  const placeholders = filePaths.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT path, summary FROM file_skeleton WHERE path IN (${placeholders})`)
    .all(...filePaths) as Array<{ path: string; summary: string }>;

  return new Map(rows.map((row) => [row.path, row.summary]));
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

      const reranker = getRerankerBackend();
      const queryTokens = input.extractQueryTokens(query);
      const rerankPool = selectRerankPoolCandidates(candidates, config);
      const skeletonSummaryMap = loadSkeletonSummaryMap(
        input.projectId,
        input.snapshotId,
        Array.from(new Set(rerankPool.map((chunk) => chunk.filePath))),
      );
      const textExtractor = (chunk: ScoredChunk): string =>
        buildRerankText(
          {
            breadcrumb: chunk.source === 'skeleton' && skeletonSummaryMap.has(chunk.filePath)
              ? `${skeletonSummaryMap.get(chunk.filePath) ?? chunk.filePath}\n${chunk.record.breadcrumb}`
              : chunk.record.breadcrumb,
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
