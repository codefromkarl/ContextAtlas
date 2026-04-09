import { classifyQueryIntent, deriveQueryAwareSearchConfig } from './QueryIntentClassifier.js';
import type {
  QueryIntent,
  ResultStats,
  RetrievalStats,
  ScoredChunk,
  SearchConfig,
  SearchResultMode,
} from './types.js';

export interface BuildContextPackOptions {
  technicalTerms?: string[];
  semanticQuery?: string;
  lexicalQuery?: string;
  responseMode?: SearchResultMode;
}

export interface BuildContextRequest {
  queryIntent: QueryIntent;
  activeConfig: SearchConfig;
  semanticQuery: string;
  lexicalQuery: string;
  responseMode: SearchResultMode;
}

export function buildContextRequest(
  query: string,
  options: BuildContextPackOptions,
  baseConfig: SearchConfig,
): BuildContextRequest {
  const queryIntent = classifyQueryIntent(query, options.technicalTerms || []);
  return {
    queryIntent,
    activeConfig: deriveQueryAwareSearchConfig(baseConfig, queryIntent),
    semanticQuery: options.semanticQuery?.trim() || query,
    lexicalQuery: options.lexicalQuery?.trim() || query,
    responseMode: options.responseMode || 'expanded',
  };
}

export function buildResultStats({
  seeds,
  expanded,
  files,
  packStats,
}: {
  seeds: ScoredChunk[];
  expanded: ScoredChunk[];
  files: Array<{ filePath: string; segments: { text: string }[] }>;
  packStats: {
    segmentCount: number;
    totalChars: number;
    budgetLimitChars: number;
    budgetUsedChars: number;
    budgetExhausted: boolean;
    blockBudgetLimit?: number;
    blockBudgetUsed?: number;
    blockBudgetExhausted?: boolean;
    filesConsidered: number;
    filesIncluded: number;
  };
}): ResultStats {
  return {
    seedCount: seeds.length,
    expandedCount: expanded.length,
    fileCount: files.length,
    segmentCount: packStats.segmentCount,
    totalChars: packStats.totalChars,
    budgetLimitChars: packStats.budgetLimitChars,
    budgetUsedChars: packStats.budgetUsedChars,
    budgetExhausted: packStats.budgetExhausted,
    blockBudgetLimit: packStats.blockBudgetLimit,
    blockBudgetUsed: packStats.blockBudgetUsed,
    blockBudgetExhausted: packStats.blockBudgetExhausted,
    filesConsidered: packStats.filesConsidered,
    filesIncluded: packStats.filesIncluded,
  };
}

export function buildRetrievalStats(input: {
  queryIntent: QueryIntent;
  retrievedStats: Omit<RetrievalStats, 'queryIntent' | 'topMCount' | 'rerankedCount'>;
  topMCount: number;
  rerankInputCount: number;
  rerankedCount: number;
}): RetrievalStats {
  return {
    queryIntent: input.queryIntent,
    ...input.retrievedStats,
    topMCount: input.topMCount,
    rerankInputCount: input.rerankInputCount,
    rerankedCount: input.rerankedCount,
  };
}
