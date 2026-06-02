/**
 * RRF Fusion — Reciprocal Rank Fusion 工具函数
 *
 * 独立于 HybridRecallEngine，避免循环依赖。
 */

import type { ScoredChunk, SearchConfig } from './types.js';

export function fuseRecallResults(
  vectorResults: (ScoredChunk & { _rank?: number })[],
  lexicalResults: (ScoredChunk & { _rank?: number })[],
  config: Pick<SearchConfig, 'rrfK0' | 'wVec' | 'wLex'>,
): ScoredChunk[] {
  const { rrfK0, wVec, wLex } = config;
  const fusedScores = new Map<
    string,
    {
      score: number;
      chunk: ScoredChunk;
      sources: Set<string>;
    }
  >();

  const getKey = (chunk: ScoredChunk) => `${chunk.filePath}#${chunk.chunkIndex}`;

  for (const result of vectorResults) {
    const key = getKey(result);
    const rank = result._rank ?? 0;
    const rrfScore = wVec / (rrfK0 + rank);

    const existing = fusedScores.get(key);
    if (existing) {
      existing.score += rrfScore;
      existing.sources.add('vector');
    } else {
      fusedScores.set(key, {
        score: rrfScore,
        chunk: result,
        sources: new Set(['vector']),
      });
    }
  }

  for (const result of lexicalResults) {
    const key = getKey(result);
    const rank = result._rank ?? 0;
    const rrfScore = wLex / (rrfK0 + rank);

    const existing = fusedScores.get(key);
    if (existing) {
      existing.score += rrfScore;
      existing.sources.add('lexical');
    } else {
      fusedScores.set(key, {
        score: rrfScore,
        chunk: result,
        sources: new Set(['lexical']),
      });
    }
  }

  const fused = Array.from(fusedScores.values())
    .map(({ score, chunk, sources }) => ({
      ...chunk,
      score,
      source: sources.has('vector')
        ? ('vector' as const)
        : sources.has('lexical')
          ? ('lexical' as const)
          : chunk.source,
    }))
    .sort((a, b) => b.score - a.score);

  return fused;
}
