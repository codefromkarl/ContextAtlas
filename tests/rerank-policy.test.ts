import assert from 'node:assert/strict';
import test from 'node:test';
import { applySmartCutoff } from '../src/search/RerankPolicy.ts';
import type { ScoredChunk, SearchConfig } from '../src/search/types.ts';

function makeChunk(score: number, chunkIndex: number): ScoredChunk {
  return {
    filePath: 'src/search/SearchService.ts',
    chunkIndex,
    score,
    source: 'vector',
    record: {
      chunk_id: `src/search/SearchService.ts#hash#${chunkIndex}`,
      file_path: 'src/search/SearchService.ts',
      file_hash: 'hash',
      chunk_index: chunkIndex,
      vector: [],
      content: '',
      display_code: '',
      vector_text: '',
      language: 'typescript',
      breadcrumb: `SearchService#${chunkIndex}`,
      start_index: 0,
      end_index: 1,
      start_line: 1,
      end_line: 1,
      start_byte: 0,
      end_byte: 1,
      raw_start: 0,
      raw_end: 1,
      vec_start: 0,
      vec_end: 1,
      hash: 'hash',
      _distance: 0,
    },
  };
}

const baseConfig: SearchConfig = {
  vectorTopK: 80,
  vectorTopM: 60,
  ftsTopKFiles: 20,
  lexChunksPerFile: 2,
  lexTotalChunks: 40,
  enableSkeletonRecall: false,
  skeletonTopKFiles: 6,
  skeletonChunksPerFile: 2,
  enableGraphRecall: false,
  graphRecallTopSymbols: 6,
  graphRecallChunksPerFile: 1,
  rrfK0: 20,
  wVec: 0.6,
  wLex: 0.4,
  fusedTopM: 60,
  rerankTopN: 10,
  rerankMinPool: 12,
  rerankMaxPool: 24,
  rerankPoolScoreRatio: 0.6,
  maxRerankChars: 1000,
  maxBreadcrumbChars: 250,
  headRatio: 0.67,
  neighborHops: 2,
  breadcrumbExpandLimit: 3,
  importFilesPerSeed: 0,
  chunksPerImportFile: 0,
  decayNeighbor: 0.8,
  decayBreadcrumb: 0.7,
  decayImport: 0.6,
  decayDepth: 0.7,
  maxSegmentsPerFile: 3,
  maxTotalChars: 48000,
  enableSmartTopK: true,
  smartTopScoreRatio: 0.5,
  smartTopScoreDeltaAbs: 0.25,
  smartMinScore: 0.25,
  smartMinK: 2,
  smartMaxK: 8,
};

test('applySmartCutoff returns top1 when top score is below floor', () => {
  const result = applySmartCutoff([makeChunk(0.2, 0), makeChunk(0.18, 1)], baseConfig);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.chunkIndex, 0);
});

test('applySmartCutoff keeps safe-harbor minimum and removes duplicates', () => {
  const result = applySmartCutoff(
    [
      makeChunk(1, 0),
      makeChunk(0.92, 0),
      makeChunk(0.9, 1),
      makeChunk(0.48, 2),
      makeChunk(0.47, 3),
    ],
    baseConfig,
  );

  assert.ok(result.length >= 2);
  assert.equal(result[0]?.chunkIndex, 0);
  assert.equal(result[1]?.chunkIndex, 1);
});

test('applySmartCutoff stops when scores fall below dynamic threshold', () => {
  const result = applySmartCutoff(
    [makeChunk(1, 0), makeChunk(0.78, 1), makeChunk(0.72, 2), makeChunk(0.18, 3)],
    baseConfig,
  );

  assert.deepEqual(
    result.map((chunk) => chunk.chunkIndex),
    [0, 1, 2],
  );
});
