import { logger } from '../utils/logger.js';
import type { ScoredChunk, SearchConfig } from './types.js';

export function selectRerankPoolCandidates<T extends { score: number }>(
  candidates: T[],
  config: Pick<SearchConfig, 'rerankTopN' | 'rerankMinPool' | 'rerankMaxPool' | 'rerankPoolScoreRatio'>,
): T[] {
  if (candidates.length <= config.rerankTopN) {
    return candidates;
  }

  const minPool = Math.min(
    candidates.length,
    Math.max(config.rerankTopN, config.rerankMinPool),
  );
  const maxPool = Math.min(
    candidates.length,
    Math.max(minPool, config.rerankMaxPool),
  );
  const topScore = candidates[0]?.score ?? 0;
  const threshold = topScore * config.rerankPoolScoreRatio;
  const selected = candidates.slice(0, minPool);

  for (let i = minPool; i < candidates.length && selected.length < maxPool; i++) {
    const candidate = candidates[i];
    if (candidate.score < threshold) {
      break;
    }
    selected.push(candidate);
  }

  return selected;
}

function chunkKey(chunk: ScoredChunk): string {
  return `${chunk.filePath}#${chunk.chunkIndex}`;
}

function dedupChunks(list: ScoredChunk[]): ScoredChunk[] {
  const seen = new Set<string>();
  const out: ScoredChunk[] = [];
  for (const c of list) {
    const k = chunkKey(c);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

export function applySmartCutoff(
  candidates: ScoredChunk[],
  config: Pick<
    SearchConfig,
    | 'enableSmartTopK'
    | 'smartTopScoreRatio'
    | 'smartTopScoreDeltaAbs'
    | 'smartMinScore'
    | 'smartMinK'
    | 'smartMaxK'
  >,
): ScoredChunk[] {
  if (!config.enableSmartTopK) {
    return candidates;
  }

  if (candidates.length === 0) return [];

  const sorted = candidates.slice().sort((a, b) => b.score - a.score);

  const {
    smartTopScoreRatio: ratio,
    smartTopScoreDeltaAbs: deltaAbs,
    smartMinScore: floor,
    smartMinK: minK,
    smartMaxK: maxK,
  } = config;

  const topScore = sorted[0].score;

  if (topScore < floor) {
    logger.debug({ topScore, floor }, 'SmartTopK: Top1 below floor, returning top1 only');
    return [sorted[0]];
  }

  const ratioThreshold = topScore * ratio;
  const deltaThreshold = topScore - deltaAbs;
  const dynamicThreshold = Math.max(floor, Math.min(ratioThreshold, deltaThreshold));

  const picked: ScoredChunk[] = [];

  for (let i = 0; i < sorted.length; i++) {
    if (picked.length >= maxK) break;

    const chunk = sorted[i];

    if (i < minK) {
      if (chunk.score >= floor) {
        picked.push(chunk);
        continue;
      }
      logger.debug(
        { rank: i, score: chunk.score, floor },
        'SmartTopK: Safe harbor chunk below floor, breaking',
      );
      break;
    }

    if (chunk.score < dynamicThreshold) {
      logger.debug(
        {
          rank: i,
          score: chunk.score,
          dynamicThreshold,
          topScore,
          ratioThreshold,
          deltaThreshold,
        },
        'SmartTopK: cutoff at dynamic threshold',
      );
      break;
    }

    picked.push(chunk);
  }

  const deduped = dedupChunks(picked);

  if (deduped.length < Math.min(minK, maxK)) {
    const seen = new Set(deduped.map((c) => chunkKey(c)));
    for (const c of sorted) {
      if (deduped.length >= Math.min(minK, maxK)) break;
      if (c.score < floor) break;
      const key = chunkKey(c);
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(c);
      }
    }
  }

  logger.debug(
    {
      originalCount: candidates.length,
      pickedCount: picked.length,
      finalCount: deduped.length,
      topScore,
      floor,
      ratio,
      deltaAbs,
      ratioThreshold: ratioThreshold.toFixed(3),
      deltaThreshold: deltaThreshold.toFixed(3),
      dynamicThreshold: dynamicThreshold.toFixed(3),
    },
    'SmartTopK: done',
  );

  return deduped;
}
