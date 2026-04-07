import assert from 'node:assert/strict';
import test from 'node:test';
import { fuseRecallResults, scoreChunkTokenOverlap } from '../src/search/HybridRecallEngine.ts';
import type { ScoredChunk } from '../src/search/types.ts';

function buildChunk(
  filePath: string,
  chunkIndex: number,
  score: number,
  source: ScoredChunk['source'],
  rank: number,
): ScoredChunk & { _rank: number } {
  return {
    filePath,
    chunkIndex,
    score,
    source,
    _rank: rank,
    record: {
      chunk_id: `${filePath}#hash#${chunkIndex}`,
      file_path: filePath,
      file_hash: 'hash',
      chunk_index: chunkIndex,
      vector: [],
      content: '',
      display_code: 'export class SearchService {}',
      vector_text: '',
      language: 'typescript',
      breadcrumb: `${filePath} > SearchService`,
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

test('fuseRecallResults merges vector and lexical rankings with RRF and preserves dual-source chunks', () => {
  const vectorResults = [
    buildChunk('src/search/SearchService.ts', 0, 0.9, 'vector', 0),
    buildChunk('src/search/GraphExpander.ts', 1, 0.8, 'vector', 1),
  ];
  const lexicalResults = [
    buildChunk('src/search/SearchService.ts', 0, 3.2, 'lexical', 0),
    buildChunk('src/search/ContextPacker.ts', 2, 2.4, 'lexical', 1),
  ];

  const fused = fuseRecallResults(vectorResults, lexicalResults, {
    rrfK0: 20,
    wVec: 0.35,
    wLex: 0.65,
  });

  assert.equal(fused.length, 3);
  assert.equal(fused[0]?.filePath, 'src/search/SearchService.ts');
  assert.equal(fused[0]?.chunkIndex, 0);
  assert.equal(fused[0]?.source, 'vector');
  assert.ok((fused[0]?.score || 0) > (fused[1]?.score || 0));
});

test('scoreChunkTokenOverlap distinguishes exact token matches from substring matches', () => {
  const exact = scoreChunkTokenOverlap(
    {
      breadcrumb: 'src/search/SearchService.ts > SearchService',
      display_code: 'export class SearchService { buildContextPack() {} }',
    },
    new Set(['searchservice', 'buildcontextpack']),
  );

  const substring = scoreChunkTokenOverlap(
    {
      breadcrumb: 'src/search/service.ts > service',
      display_code: 'const searchservicehelper = true;',
    },
    new Set(['searchservice']),
  );

  assert.equal(exact, 2);
  assert.equal(substring, 0.5);
});
