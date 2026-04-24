import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  formatRetrievalBenchmarkReport,
  loadRetrievalBenchmarkFixture,
  summarizeRetrievalBenchmark,
} from '../src/monitoring/retrievalBenchmark.js';

test('loadRetrievalBenchmarkFixture 读取 fixture 并校验版本', () => {
  const fixture = loadRetrievalBenchmarkFixture(
    path.join(process.cwd(), 'tests/fixtures/retrieval-benchmark/contextatlas-dual-track.json'),
  );

  assert.equal(fixture.version, 1);
  assert.equal(fixture.cases.length, 6);
  assert.equal(fixture.cases[0].id, 'gateway-entrypoints');
});

test('summarizeRetrievalBenchmark 计算 File Hit@K 与分组覆盖率', () => {
  const summary = summarizeRetrievalBenchmark([
    {
      id: 'entry-hit',
      query: 'q1',
      tags: ['entry'],
      expectedFiles: ['a.ts'],
      actualTopFiles: ['a.ts', 'b.ts'],
      actualPrimaryFiles: [],
      actualVisibleFiles: ['a.ts', 'b.ts'],
      matchedFiles: ['a.ts'],
      primaryMatchedFiles: [],
      visibleMatchedFiles: ['a.ts'],
      fileHit: true,
      expectedCoverage: 1,
      primaryCoverage: 0,
      dualTrackCoverage: 1,
    },
    {
      id: 'arch-miss',
      query: 'q2',
      tags: ['architecture'],
      expectedFiles: ['c.ts'],
      actualTopFiles: ['d.ts'],
      actualPrimaryFiles: ['c.ts'],
      actualVisibleFiles: ['d.ts', 'c.ts'],
      matchedFiles: [],
      primaryMatchedFiles: ['c.ts'],
      visibleMatchedFiles: ['c.ts'],
      fileHit: false,
      expectedCoverage: 0,
      primaryCoverage: 1,
      dualTrackCoverage: 1,
    },
    {
      id: 'both-hit',
      query: 'q3',
      tags: ['entry', 'architecture'],
      expectedFiles: ['e.ts', 'f.ts'],
      actualTopFiles: ['e.ts'],
      actualPrimaryFiles: ['x.ts'],
      actualVisibleFiles: ['e.ts', 'x.ts'],
      matchedFiles: ['e.ts'],
      primaryMatchedFiles: [],
      visibleMatchedFiles: ['e.ts'],
      fileHit: true,
      expectedCoverage: 0.5,
      primaryCoverage: 0,
      dualTrackCoverage: 0.5,
    },
  ]);

  assert.deepEqual(summary, {
    caseCount: 3,
    fileHitAtK: 0.667,
    expectedFileCoverage: 0.5,
    primaryFileCoverage: 0.5,
    dualTrackFileCoverage: 0.833,
    entryFileCoverage: 1,
    architectureCoverage: 0.5,
    graphCoverage: 0,
  });
});

test('formatRetrievalBenchmarkReport 输出摘要与 case 详情', () => {
  const text = formatRetrievalBenchmarkReport({
    fixture: {
      name: 'fixture-a',
      version: 1,
      path: '/tmp/fixture.json',
    },
    repoPath: '/repo',
    projectId: '1234567890',
    topK: 5,
    summary: {
      caseCount: 2,
      fileHitAtK: 0.5,
      expectedFileCoverage: 0.25,
      primaryFileCoverage: 0.5,
      dualTrackFileCoverage: 0.75,
      entryFileCoverage: 1,
      architectureCoverage: 0,
      graphCoverage: 0,
    },
    results: [
      {
        id: 'c1',
        query: 'first query',
        tags: ['entry'],
        expectedFiles: ['src/a.ts'],
        actualTopFiles: ['src/a.ts'],
        actualPrimaryFiles: [],
        actualVisibleFiles: ['src/a.ts'],
        matchedFiles: ['src/a.ts'],
        primaryMatchedFiles: [],
        visibleMatchedFiles: ['src/a.ts'],
        fileHit: true,
        expectedCoverage: 1,
        primaryCoverage: 0,
        dualTrackCoverage: 1,
      },
      {
        id: 'c2',
        query: 'second query',
        tags: ['graph', 'architecture'],
        expectedFiles: ['src/b.ts', 'src/c.ts'],
        actualTopFiles: ['src/x.ts'],
        actualPrimaryFiles: ['src/b.ts'],
        actualVisibleFiles: ['src/x.ts', 'src/b.ts'],
        matchedFiles: [],
        primaryMatchedFiles: ['src/b.ts'],
        visibleMatchedFiles: ['src/b.ts'],
        fileHit: false,
        expectedCoverage: 0,
        primaryCoverage: 0.5,
        dualTrackCoverage: 0.5,
      },
    ],
  });

  assert.match(text, /File Hit@5: 50.0%/);
  assert.match(text, /Expected File Coverage: 25.0%/);
  assert.match(text, /Primary File Coverage: 50.0%/);
  assert.match(text, /Dual-Track File Coverage: 75.0%/);
  assert.match(text, /Graph Coverage: 0.0%/);
  assert.match(text, /\[hit\] c1/);
  assert.match(text, /expected_coverage: 100.0%/);
  assert.match(text, /dual_track_coverage: 50.0%/);
  assert.match(text, /actual_primary_files: src\/b.ts/);
  assert.match(text, /actual_visible_files: src\/x.ts, src\/b.ts/);
  assert.match(text, /expected: src\/a.ts/);
});

test('loadRetrievalBenchmarkFixture 对空 case fixture 抛错', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retrieval-benchmark-'));
  const fixturePath = path.join(tmpDir, 'invalid.json');
  fs.writeFileSync(fixturePath, JSON.stringify({ version: 1, name: 'invalid', cases: [] }), 'utf8');

  assert.throws(
    () => loadRetrievalBenchmarkFixture(fixturePath),
    /at least one case/,
  );
});
