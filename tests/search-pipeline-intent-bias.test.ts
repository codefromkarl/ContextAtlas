import assert from 'node:assert/strict';
import test from 'node:test';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyIntentCandidateBias,
  collectArchitecturePrimaryFiles,
  dedupeArchitectureRerankedFiles,
  ensureArchitectureFileDiversity,
  ensureSymbolLookupSourceDiversity,
} from '../src/search/SearchPipeline.ts';
import type { ScoredChunk } from '../src/search/types.ts';

function makeChunk(filePath: string, score: number): ScoredChunk {
  return {
    filePath,
    chunkIndex: 0,
    score,
    source: 'lexical',
    record: {
      chunk_id: `${filePath}#0`,
      file_path: filePath,
      file_hash: 'hash',
      chunk_index: 0,
      vector: [0.1],
      display_code: 'code',
      language: 'typescript',
      breadcrumb: filePath,
      start_index: 0,
      end_index: 4,
      raw_start: 0,
      raw_end: 4,
      vec_start: 0,
      vec_end: 4,
      _distance: 0,
    },
  };
}

test('applyIntentCandidateBias 为 architecture 查询提升 src 并压低 tests/docs/README', () => {
  const biased = applyIntentCandidateBias([
    makeChunk('src/index.ts', 1),
    makeChunk('tests/cli-registration.test.ts', 1),
    makeChunk('docs/guides/deployment.md', 1),
    makeChunk('README.md', 1),
  ], 'architecture');

  assert.equal(biased[0].score, 1.2);
  assert.equal(biased[1].score, 0.75);
  assert.equal(biased[2].score, 0.65);
  assert.equal(biased[3].score, 0.65);
});

test('applyIntentCandidateBias 对 balanced 查询不改分', () => {
  const original = [makeChunk('src/index.ts', 1)];
  const biased = applyIntentCandidateBias(original, 'balanced');

  assert.equal(biased[0].score, 1);
});

test('applyIntentCandidateBias 为 symbol_lookup 查询提升 src 并压低 tests/docs/README', () => {
  const biased = applyIntentCandidateBias([
    makeChunk('src/index.ts', 1),
    makeChunk('tests/cli-registration.test.ts', 1),
    makeChunk('docs/guides/deployment.md', 1),
    makeChunk('README.md', 1),
  ], 'symbol_lookup');

  assert.equal(biased[0].score, 1.2);
  assert.equal(biased[1].score, 0.55);
  assert.equal(biased[2].score, 0.45);
  assert.equal(biased[3].score, 0.45);
});

test('ensureArchitectureFileDiversity 为 architecture 查询补齐唯一文件数', () => {
  const seeds = [
    makeChunk('tests/cli-registration.test.ts', 1),
    makeChunk('src/index.ts', 0.8),
  ];
  const reranked = [
    makeChunk('tests/cli-registration.test.ts', 1),
    makeChunk('src/index.ts', 0.8),
    makeChunk('src/cli/commands/search.ts', 0.7),
    makeChunk('src/cli/registerCommands.ts', 0.6),
  ];

  const diversified = ensureArchitectureFileDiversity(seeds, reranked, reranked, 'architecture', 4);

  assert.deepEqual(
    diversified.map((chunk) => chunk.filePath),
    [
      'tests/cli-registration.test.ts',
      'src/index.ts',
      'src/cli/commands/search.ts',
      'src/cli/registerCommands.ts',
    ],
  );
  assert.equal(
    diversified.filter((chunk) => chunk.filePath.startsWith('src/')).length,
    3,
  );
});

test('ensureArchitectureFileDiversity 优先补齐 src 文件数量', () => {
  const seeds = [
    makeChunk('tests/a.test.ts', 1),
    makeChunk('src/index.ts', 0.8),
  ];
  const reranked = [
    makeChunk('tests/a.test.ts', 1),
    makeChunk('src/index.ts', 0.8),
    makeChunk('tests/b.test.ts', 0.7),
    makeChunk('src/cli/registerCommands.ts', 0.6),
    makeChunk('src/search/SearchService.ts', 0.5),
  ];

  const diversified = ensureArchitectureFileDiversity(seeds, reranked, reranked, 'architecture', 4, 3);

  assert.ok(diversified.some((chunk) => chunk.filePath === 'src/cli/registerCommands.ts'));
  assert.ok(diversified.some((chunk) => chunk.filePath === 'src/search/SearchService.ts'));
});

test('dedupeArchitectureRerankedFiles collapses duplicate files before cutoff', () => {
  const deduped = dedupeArchitectureRerankedFiles([
    makeChunk('tests/cli-registration.test.ts', 1),
    makeChunk('tests/cli-registration.test.ts', 0.9),
    makeChunk('src/index.ts', 0.8),
    makeChunk('src/cli/registerCommands.ts', 0.7),
  ], 'architecture');

  assert.deepEqual(
    deduped.map((chunk) => chunk.filePath),
    ['tests/cli-registration.test.ts', 'src/index.ts', 'src/cli/registerCommands.ts'],
  );
});

test('ensureArchitectureFileDiversity can fall back to topM source files when rerank omits them', () => {
  const seeds = [
    makeChunk('tests/cli-registration.test.ts', 1),
    makeChunk('src/index.ts', 0.8),
  ];
  const reranked = [
    makeChunk('tests/cli-registration.test.ts', 1),
    makeChunk('src/index.ts', 0.8),
    makeChunk('src/cli/commands/search.ts', 0.7),
  ];
  const topM = [
    ...reranked,
    makeChunk('src/cli/registerCommands.ts', 0.6),
  ];

  const diversified = ensureArchitectureFileDiversity(seeds, reranked, topM, 'architecture', 4, 3);

  assert.ok(diversified.some((chunk) => chunk.filePath === 'src/cli/registerCommands.ts'));
});

test('collectArchitecturePrimaryFiles 仅返回未进入 pack 的 src 主文件', () => {
  const primaries = collectArchitecturePrimaryFiles(
    [
      makeChunk('tests/cli-registration.test.ts', 1),
      makeChunk('src/index.ts', 0.9),
      makeChunk('src/cli/registerCommands.ts', 0.8),
    ],
    [
      makeChunk('src/cli/commands/search.ts', 0.7),
      makeChunk('src/cli/commands/bootstrap.ts', 0.75),
    ],
    [{ filePath: 'src/index.ts', segments: [] }],
    'architecture',
    new Set(['cli', 'command', 'register']),
    2,
  );

  assert.deepEqual(primaries, ['src/cli/registerCommands.ts', 'src/cli/commands/bootstrap.ts']);
});

test('collectArchitecturePrimaryFiles treats registration and command-entry synonyms as path overlap', () => {
  const primaries = collectArchitecturePrimaryFiles(
    [
      makeChunk('src/index.ts', 0.9),
      makeChunk('src/cli/registerCommands.ts', 0.75),
      makeChunk('src/cli/commands/bootstrap.ts', 0.7),
    ],
    [],
    [{ filePath: 'src/index.ts', segments: [] }],
    'architecture',
    new Set(['cli', 'command', 'registration', 'entrypoint', 'startup']),
    2,
  );

  assert.deepEqual(primaries, ['src/cli/registerCommands.ts', 'src/cli/commands/bootstrap.ts']);
});

test('ensureSymbolLookupSourceDiversity 为 symbol_lookup 补齐额外 src 文件', () => {
  const seeds = [
    makeChunk('src/application/retrieval/executeRetrieval.ts', 1),
  ];
  const reranked = [
    makeChunk('src/application/retrieval/executeRetrieval.ts', 1),
    makeChunk('src/application/retrieval/codebaseRetrieval.ts', 0.95),
    makeChunk('src/mcp/tools/codebaseRetrieval.ts', 0.9),
    makeChunk('tests/codebase-retrieval.test.ts', 0.99),
  ];

  const supplemented = ensureSymbolLookupSourceDiversity(seeds, reranked, reranked, 'symbol_lookup', 3);

  assert.deepEqual(
    supplemented.map((chunk) => chunk.filePath),
    [
      'src/application/retrieval/executeRetrieval.ts',
      'src/application/retrieval/codebaseRetrieval.ts',
      'src/mcp/tools/codebaseRetrieval.ts',
    ],
  );
});
