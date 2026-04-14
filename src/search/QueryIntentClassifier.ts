/**
 * Query Intent Classifier
 *
 * Classifies search queries into intent categories and derives
 * intent-aware search configurations with tuned RRF weights.
 *
 * Weight profiles by intent:
 * - symbol_lookup: wVec=0.35, wLex=0.65 (code identifiers matched lexically)
 * - navigation:    wVec=0.30, wLex=0.70 (path-based queries are purely lexical)
 * - conceptual:    wVec=0.55, wLex=0.45 (natural language benefits from semantics)
 * - balanced:      wVec=base, wLex=base (default, reads from env or hardcoded)
 */

import { segmentQuery } from './fts.js';
import type { QueryIntent, SearchConfig } from './types.js';

export function classifyQueryIntent(query: string, technicalTerms: string[] = []): QueryIntent {
  if (technicalTerms.length > 0) {
    return 'symbol_lookup';
  }

  const tokens = segmentQuery(query);
  const rawSegments = query.split(/\s+/).filter(Boolean);
  const codeLikeTokenCount = rawSegments.filter((token) => {
    if (/[A-Z]/.test(token)) return true;
    if (token.includes('_')) return true;
    if (token.includes('.')) return true;
    return /[a-z][A-Z]/.test(token);
  }).length;
  const pathLikeTokenCount = rawSegments.filter((token) => token.includes('/') || token.includes('\\')).length;
  const conceptualHintCount = rawSegments.filter((token) =>
    /(how|why|what|flow|architecture|concept|流程|原理|架构|实现|如何)/i.test(token),
  ).length;

  if (pathLikeTokenCount >= 1) {
    return 'navigation';
  }

  if (tokens.length > 0 && tokens.length <= 6 && codeLikeTokenCount >= 1) {
    return 'symbol_lookup';
  }

  if (conceptualHintCount >= 1) {
    return 'conceptual';
  }

  return 'balanced';
}

export function deriveQueryAwareSearchConfig(
  baseConfig: SearchConfig,
  intent: QueryIntent,
): SearchConfig {
  if (intent === 'symbol_lookup') {
    return {
      ...baseConfig,
      wVec: 0.35,
      wLex: 0.65,
      rerankTopN: Math.min(baseConfig.rerankTopN, 8),
      rerankMinPool: Math.max(Math.min(baseConfig.rerankMinPool, 10), 8),
      rerankMaxPool: Math.max(Math.min(baseConfig.rerankMaxPool, 16), 12),
    };
  }

  if (intent === 'navigation') {
    return {
      ...baseConfig,
      wVec: 0.3,
      wLex: 0.7,
      rerankTopN: Math.min(baseConfig.rerankTopN, 6),
      rerankMinPool: Math.max(Math.min(baseConfig.rerankMinPool, 8), 6),
      rerankMaxPool: Math.max(Math.min(baseConfig.rerankMaxPool, 12), 8),
    };
  }

  if (intent === 'conceptual') {
    return {
      ...baseConfig,
      wVec: 0.55,
      wLex: 0.45,
    };
  }

  return baseConfig;
}
