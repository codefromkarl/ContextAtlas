import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  evaluateMemoryRetrievalGoldenCases,
  formatParityBenchmarkReport,
  loadParityBenchmarkFixture,
  runParityBenchmark,
} from '../src/monitoring/parityBenchmark.ts';

const FIXTURE_PATH = path.join(
  process.cwd(),
  'tests/fixtures/parity-benchmark/contextatlas-system-boundary.json',
);

test('loadParityBenchmarkFixture validates the system-boundary baseline fixture', () => {
  const fixture = loadParityBenchmarkFixture(FIXTURE_PATH);

  assert.equal(fixture.version, 1);
  assert.equal(fixture.name, 'ContextAtlas System Boundary Baseline');
  assert.equal(fixture.evaluationRepositories?.length, 6);
  assert.ok(fixture.cases.some((testCase) => testCase.track === 'gitnexus-parity'));
  assert.ok(fixture.cases.some((testCase) => testCase.track === 'mem0-parity'));
  assert.ok(fixture.cases.some((testCase) => testCase.track === 'contextatlas-native'));
});

test('runParityBenchmark summarizes cases by track, capability, and status', () => {
  const report = runParityBenchmark({ fixturePath: FIXTURE_PATH });

  assert.equal(report.summary.caseCount, 8);
  assert.equal(report.summary.byTrack['gitnexus-parity'], 4);
  assert.equal(report.summary.byTrack['mem0-parity'], 1);
  assert.equal(report.summary.byTrack['contextatlas-native'], 3);
  assert.equal(report.summary.byCapability.graph, 2);
  assert.equal(report.summary.byCapability.impact, 2);
  assert.equal(report.summary.byCapability.memory, 2);
  assert.equal(report.summary.byStatus.baseline, 2);
  assert.equal(report.summary.byStatus.partial, 3);
  assert.equal(report.summary.byStatus.target, 3);
  assert.equal(report.summary.evaluationRepositoryCount, 6);
  assert.deepEqual(report.summary.evaluationLanguages, [
    'go',
    'java',
    'javascript',
    'python',
    'rust',
    'typescript',
  ]);
  assert.equal(report.summary.byFailureCategory['missing-capability'], 5);
  assert.equal(report.summary.byFailureCategory['parse-error'], 4);
  assert.equal(report.summary.byFailureCategory['ranking-drift'], 3);
  assert.equal(report.summary.byFailureCategory['unstable-output'], 3);
  assert.equal(report.summary.failureCategoryCoverage.complete, true);
  assert.deepEqual(report.summary.failureCategoryCoverage.missing, []);
  assert.deepEqual(report.summary.failureCategoryCoverage.covered, [
    'missing-capability',
    'parse-error',
    'ranking-drift',
    'unstable-output',
  ]);
  assert.equal(report.summary.benchmarkPassed, true);
  assert.equal(report.summary.memoryRetrievalGoldenCasePassCount, 1);
  assert.equal(report.summary.memoryRetrievalGoldenCaseFailCount, 0);
  assert.equal(report.summary.byGoldenCase['symbol-lookup'], 1);
  assert.equal(report.summary.byGoldenCase['call-chain'], 1);
  assert.equal(report.summary.byGoldenCase['impact-analysis'], 1);
  assert.equal(report.summary.byGoldenCase['diff-hit'], 1);
  assert.equal(report.summary.byGoldenCase['memory-recall'], 1);
  assert.equal(report.summary.byGoldenCase['cold-start-fallback'], 1);
  assert.equal(report.summary.byGoldenCase['memory-retrieval'], 1);
  assert.equal(report.summary.memoryRetrievalGoldenCaseCount, 1);
  assert.deepEqual(report.trackLists['gitnexus-parity'], [
    'gitnexus-symbol-lookup',
    'gitnexus-call-chain',
    'gitnexus-impact-analysis',
    'gitnexus-diff-hit',
  ]);
});

test('runParityBenchmark uses built-in default fixture when no fixture path is provided', () => {
  const report = runParityBenchmark();

  assert.equal(report.fixture.path, 'builtin:contextatlas-system-boundary');
  assert.equal(report.summary.caseCount, 8);
  assert.equal(report.summary.byTrack['gitnexus-parity'], 4);
  assert.equal(report.summary.memoryRetrievalGoldenCaseCount, 1);
  assert.equal(report.summary.evaluationRepositoryCount, 6);
});

test('formatParityBenchmarkReport renders stable case details', () => {
  const text = formatParityBenchmarkReport(runParityBenchmark({ fixturePath: FIXTURE_PATH }));

  assert.match(text, /ContextAtlas System Boundary Baseline/);
  assert.match(text, /gitnexus-parity=4/);
  assert.match(text, /mem0-parity=1/);
  assert.match(text, /contextatlas-native=3/);
  assert.match(text, /Golden Cases/);
  assert.match(text, /symbol-lookup=1/);
  assert.match(text, /memory-retrieval=1/);
  assert.match(text, /Failure Categories/);
  assert.match(text, /missing-capability=5/);
  assert.match(text, /Benchmark Passed: true/);
  assert.match(text, /Failure Category Coverage: complete=true covered=missing-capability, parse-error, ranking-drift, unstable-output missing=none/);
  assert.match(text, /Memory Retrieval Golden Cases: 1/);
  assert.match(text, /Memory Retrieval Golden Case Results: pass=1 fail=0/);
  assert.match(text, /contextatlas-long-term-memory-retrieval: passed=true top=active-p7-memory-benchmark expected=active-p7-memory-benchmark/);
  assert.match(text, /embeddingModeDisabled=true/);
  assert.match(text, /activeRanksBeforeStaleOrExpired=true/);
  assert.match(text, /Evaluation Repositories: 6/);
  assert.match(text, /Evaluation Languages: go, java, javascript, python, rust, typescript/);
  assert.match(text, /gitnexus-parity: gitnexus-symbol-lookup, gitnexus-call-chain, gitnexus-impact-analysis, gitnexus-diff-hit/);
  assert.match(text, /polyglot-agent-tool: languages=typescript, python, go/);
  assert.match(text, /\[target\] gitnexus-diff-hit/);
  assert.match(text, /golden_case: diff-hit/);
  assert.match(text, /shape_version: 1/);
  assert.match(text, /required_fields: changedSymbols, affectedRelations, riskLevel/);
  assert.match(text, /structured_fields: changedSymbols:array!/);
  assert.match(text, /failure_categories: missing-capability, parse-error/);
});

test('evaluateMemoryRetrievalGoldenCases validates P7 explainable retrieval constraints', () => {
  const fixture = loadParityBenchmarkFixture(FIXTURE_PATH);
  const [result] = evaluateMemoryRetrievalGoldenCases(fixture.cases);

  assert.ok(result);
  assert.equal(result.caseId, 'contextatlas-long-term-memory-retrieval');
  assert.equal(result.topId, 'active-p7-memory-benchmark');
  assert.equal(result.passed, true);
  assert.deepEqual(result.checks, {
    hasExpectedTopResult: true,
    includesRequiredMatchFields: true,
    includesRequiredScoreBreakdown: true,
    embeddingModeDisabled: true,
    activeRanksBeforeStaleOrExpired: true,
  });
});

test('loadParityBenchmarkFixture rejects unknown tracks', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-parity-benchmark-'));
  const fixturePath = path.join(tempDir, 'invalid.json');
  fs.writeFileSync(
    fixturePath,
    JSON.stringify({
      version: 1,
      name: 'invalid',
      cases: [
        {
          id: 'bad',
          track: 'unknown',
          capability: 'graph',
          status: 'baseline',
          goldenCase: 'symbol-lookup',
          query: 'q',
          expectedOutput: {
            shapeVersion: 1,
            requiredFields: ['x'],
            fields: [{ path: 'x', type: 'string', required: true }],
          },
        },
      ],
    }),
    'utf8',
  );

  try {
    assert.throws(
      () => loadParityBenchmarkFixture(fixturePath),
      /Unsupported parity benchmark track/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('loadParityBenchmarkFixture rejects unknown failure categories', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-parity-benchmark-'));
  const fixturePath = path.join(tempDir, 'invalid-category.json');
  fs.writeFileSync(
    fixturePath,
    JSON.stringify({
      version: 1,
      name: 'invalid',
      cases: [
        {
          id: 'bad',
          track: 'gitnexus-parity',
          capability: 'graph',
          status: 'baseline',
          goldenCase: 'symbol-lookup',
          query: 'q',
          expectedOutput: {
            shapeVersion: 1,
            requiredFields: ['x'],
            fields: [{ path: 'x', type: 'string', required: true }],
            failureCategories: ['unknown'],
          },
        },
      ],
    }),
    'utf8',
  );

  try {
    assert.throws(
      () => loadParityBenchmarkFixture(fixturePath),
      /Unsupported parity benchmark failure category/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('loadParityBenchmarkFixture rejects unknown structured field types', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-parity-benchmark-'));
  const fixturePath = path.join(tempDir, 'invalid-field-type.json');
  fs.writeFileSync(
    fixturePath,
    JSON.stringify({
      version: 1,
      name: 'invalid field type',
      cases: [
        {
          id: 'bad',
          track: 'gitnexus-parity',
          capability: 'graph',
          status: 'baseline',
          goldenCase: 'symbol-lookup',
          query: 'q',
          expectedOutput: {
            shapeVersion: 1,
            requiredFields: ['x'],
            fields: [{ path: 'x', type: 'unknown', required: true }],
          },
        },
      ],
    }),
    'utf8',
  );

  try {
    assert.throws(
      () => loadParityBenchmarkFixture(fixturePath),
      /Unsupported parity benchmark field type/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('loadParityBenchmarkFixture validates evaluation repository matrix size', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-parity-benchmark-'));
  const fixturePath = path.join(tempDir, 'invalid-repositories.json');
  fs.writeFileSync(
    fixturePath,
    JSON.stringify({
      version: 1,
      name: 'invalid',
      evaluationRepositories: [
        {
          id: 'only-one',
          label: 'Only one',
          languages: ['typescript'],
          focus: 'too small',
        },
      ],
      cases: [
        {
          id: 'case',
          track: 'gitnexus-parity',
          capability: 'graph',
          status: 'baseline',
          goldenCase: 'symbol-lookup',
          query: 'q',
          expectedOutput: {
            shapeVersion: 1,
            requiredFields: ['x'],
            fields: [{ path: 'x', type: 'string', required: true }],
          },
        },
      ],
    }),
    'utf8',
  );

  try {
    assert.throws(
      () => loadParityBenchmarkFixture(fixturePath),
      /evaluationRepositories must contain 5 to 8 entries/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('loadParityBenchmarkFixture requires fixed golden case coverage', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-parity-benchmark-'));
  const fixturePath = path.join(tempDir, 'missing-golden-case.json');
  fs.writeFileSync(
    fixturePath,
    JSON.stringify({
      version: 1,
      name: 'missing golden case',
      cases: [
        {
          id: 'case',
          track: 'gitnexus-parity',
          capability: 'graph',
          status: 'baseline',
          goldenCase: 'symbol-lookup',
          query: 'q',
          expectedOutput: {
            shapeVersion: 1,
            requiredFields: ['x'],
            fields: [{ path: 'x', type: 'string', required: true }],
          },
        },
      ],
    }),
    'utf8',
  );

  try {
    assert.throws(
      () => runParityBenchmark({ fixturePath }),
      /missing required golden cases/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
