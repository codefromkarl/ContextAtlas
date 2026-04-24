import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildReleaseSmokePlan,
  validateSmokeResult,
} from '../src/release/smoke.ts';

test('buildReleaseSmokePlan includes release regression gates across CLI, daemon, MCP, monitoring, and search', () => {
  const plan = buildReleaseSmokePlan({
    cliEntry: '/repo/dist/index.js',
    fixtureRepoPath: '/tmp/contextatlas-smoke/repo',
  });

  assert.equal(plan.length, 16);
  assert.deepEqual(
    plan.map((step) => step.name),
    [
      'cli-version',
      'start-guide',
      'seed-memory-governance',
      'daemon-help',
      'monitoring-health-full',
      'index-diagnose',
      'mcp-help',
      'health-full',
      'ops-summary',
      'ops-metrics',
      'alert-eval',
      'monitoring-retrieval-help',
      'benchmark-small-noop',
      'parity-benchmark',
      'graph-health',
      'cold-start-search',
    ],
  );
  assert.deepEqual(plan[0].command, ['node', '/repo/dist/index.js', '--version']);
  assert.deepEqual(plan[1].command, [
    'node',
    '/repo/dist/index.js',
    'start',
    '/tmp/contextatlas-smoke/repo',
  ]);
  assert.deepEqual(plan[2].command, [
    'node',
    '--import',
    'tsx',
    'scripts/release-smoke-seed.ts',
    '/tmp/contextatlas-smoke/repo',
  ]);
  assert.deepEqual(plan[3].command, ['node', '/repo/dist/index.js', 'daemon', '--help']);
  assert.deepEqual(plan[4].command, ['node', '/repo/dist/index.js', 'health:full', '--json']);
  assert.deepEqual(plan[5].command, ['node', '/repo/dist/index.js', 'index:diagnose', '--json']);
  assert.deepEqual(plan[6].command, ['node', '/repo/dist/index.js', 'mcp', '--help']);
  assert.deepEqual(plan[7].command, ['node', '/repo/dist/index.js', 'health:full', '--json']);
  assert.deepEqual(plan[8].command, ['node', '/repo/dist/index.js', 'ops:summary', '--json']);
  assert.deepEqual(plan[9].command, ['node', '/repo/dist/index.js', 'ops:metrics', '--json']);
  assert.deepEqual(plan[10].command, ['node', '/repo/dist/index.js', 'alert:eval', '--json']);
  assert.deepEqual(plan[11].command, ['node', '/repo/dist/index.js', 'monitor:retrieval', '--help']);
  assert.deepEqual(plan[12].command, [
    'node',
    '/repo/dist/index.js',
    'perf:benchmark',
    '--size',
    'small',
    '--scenario',
    'noop',
    '--json',
  ]);
  assert.deepEqual(plan[13].command, [
    'node',
    '/repo/dist/index.js',
    'parity:benchmark',
    '--json',
  ]);
  assert.deepEqual(plan[14].command, [
    'node',
    '/repo/dist/index.js',
    'health:graph',
    '--repo-path',
    '/tmp/contextatlas-smoke/repo',
    '--json',
  ]);
  assert.deepEqual(plan[15].command, [
    'node',
    '/repo/dist/index.js',
    'search',
    '--repo-path',
    '/tmp/contextatlas-smoke/repo',
    '--information-request',
    'smoke login flow',
    '--technical-terms',
    'smokeLogin',
  ]);
});

test('buildReleaseSmokePlan keeps governance smoke commands grouped after seeding', () => {
  const plan = buildReleaseSmokePlan({
    cliEntry: '/repo/dist/index.js',
    fixtureRepoPath: '/tmp/contextatlas-smoke/repo',
  });

  const names = plan.map((step) => step.name);
  const seedIndex = names.indexOf('seed-memory-governance');
  const governanceGroup = names.slice(seedIndex + 5, seedIndex + 9);

  assert.equal(seedIndex, 2);
  assert.deepEqual(governanceGroup, [
    'health-full',
    'ops-summary',
    'ops-metrics',
    'alert-eval',
  ]);
  assert.ok(
    plan
      .slice(seedIndex + 5, seedIndex + 9)
      .every((step) => step.command.at(-1) === '--json'),
  );
});

test('buildReleaseSmokePlan requires governance markers across the grouped smoke commands', () => {
  const plan = buildReleaseSmokePlan({
    cliEntry: '/repo/dist/index.js',
    fixtureRepoPath: '/tmp/contextatlas-smoke/repo',
  });

  const healthFullPatterns = plan.find((step) => step.name === 'health-full')?.expectedPatterns || [];
  const opsSummaryPatterns = plan.find((step) => step.name === 'ops-summary')?.expectedPatterns || [];
  const opsMetricsPatterns = plan.find((step) => step.name === 'ops-metrics')?.expectedPatterns || [];
  const alertEvalPatterns = plan.find((step) => step.name === 'alert-eval')?.expectedPatterns || [];

  assert.ok(healthFullPatterns.some((pattern) => /memory-high-stale-rate/.test(pattern.source)));
  assert.ok(opsSummaryPatterns.some((pattern) => /rebuild-memory-catalog/.test(pattern.source)));
  assert.ok(opsSummaryPatterns.some((pattern) => /prune-stale-memory/.test(pattern.source)));
  assert.ok(opsMetricsPatterns.some((pattern) => /projectProfileModes/.test(pattern.source)));
  assert.ok(opsMetricsPatterns.some((pattern) => /sharedMemoryPolicies/.test(pattern.source)));
  assert.ok(alertEvalPatterns.some((pattern) => /memory-catalog-inconsistent/.test(pattern.source)));
  assert.ok(alertEvalPatterns.some((pattern) => /memory-orphaned-features/.test(pattern.source)));
});

test('validateSmokeResult rejects non-zero exits and missing output markers', () => {
  assert.throws(
    () =>
      validateSmokeResult(
        {
          name: 'cli-version',
          command: ['node', 'dist/index.js', '--version'],
          expectedPatterns: [/^\d+\.\d+\.\d+$/m],
        },
        {
          exitCode: 1,
          stdout: '',
          stderr: 'boom',
        },
      ),
    /cli-version failed/,
  );

  assert.throws(
    () =>
      validateSmokeResult(
        {
          name: 'cold-start-search',
          command: ['node', 'dist/index.js', 'search'],
          expectedPatterns: [/词法降级结果/],
        },
        {
          exitCode: 0,
          stdout: 'no marker here',
          stderr: '',
        },
      ),
    /missing expected pattern/,
  );
});

test('validateSmokeResult accepts successful smoke output', () => {
  assert.doesNotThrow(() =>
    validateSmokeResult(
      {
        name: 'start-guide',
        command: ['node', 'dist/index.js', 'start'],
        expectedPatterns: [/ContextAtlas Start/, /Index Status:/],
      },
      {
        exitCode: 0,
        stdout: '## ContextAtlas Start\n- Index Status: Ready\n',
        stderr: '',
      },
    ),
  );
});
