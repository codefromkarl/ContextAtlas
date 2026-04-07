import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildBenchmarkMatrix,
  formatIndexBenchmarkReport,
  runIndexBenchmark,
} from '../src/monitoring/indexBenchmark.ts';

test('buildBenchmarkMatrix covers small/medium/large across full/incremental/repair/noop', () => {
  const matrix = buildBenchmarkMatrix();

  assert.equal(matrix.length, 12);
  assert.deepEqual(matrix[0], { size: 'small', scenario: 'full' });
  assert.ok(matrix.some((item) => item.size === 'medium' && item.scenario === 'repair'));
  assert.ok(matrix.some((item) => item.size === 'large' && item.scenario === 'noop'));
});

test('runIndexBenchmark reports deterministic noop benchmark metrics for small repos', async () => {
  const report = await runIndexBenchmark({
    size: 'small',
    scenario: 'noop',
  });

  assert.equal(report.size, 'small');
  assert.equal(report.scenario, 'noop');
  assert.equal(report.vectorIndex, false);
  assert.ok(report.durationMs >= 0);
  assert.ok(report.stats.totalFiles > 0);
  assert.equal(report.stats.added, 0);
  assert.equal(report.stats.modified, 0);
  assert.equal(report.stats.deleted, 0);

  const text = formatIndexBenchmarkReport(report);
  assert.match(text, /Index Benchmark Report/);
  assert.match(text, /Scenario: noop/);
  assert.match(text, /Size: small/);
});

test('runIndexBenchmark reports repair scenario through plan metrics', async () => {
  const report = await runIndexBenchmark({
    size: 'small',
    scenario: 'repair',
  });

  assert.equal(report.scenario, 'repair');
  assert.ok(report.plan);
  assert.equal(report.plan?.mode, 'incremental');
  assert.ok((report.plan?.changeSummary.unchangedNeedingVectorRepair || 0) > 0);
});
