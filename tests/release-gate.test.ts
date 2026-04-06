import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReleaseSmokePlan } from '../src/release/smoke.ts';
import { formatReleaseGateReport } from '../src/release/gate.ts';

test('buildReleaseSmokePlan covers daemon, monitoring, MCP, and search regression gates', () => {
  const plan = buildReleaseSmokePlan({
    cliEntry: '/repo/dist/index.js',
    fixtureRepoPath: '/tmp/contextatlas-smoke/repo',
  });

  assert.deepEqual(
    plan.map((step) => step.name),
    [
      'cli-version',
      'start-guide',
      'daemon-help',
      'monitoring-health-full',
      'mcp-help',
      'health-full',
      'monitoring-retrieval-help',
      'cold-start-search',
    ],
  );
});

test('formatReleaseGateReport makes failing stage and smoke step explicit', () => {
  const text = formatReleaseGateReport({
    ok: false,
    stages: [
      {
        stage: 'build',
        ok: true,
        durationMs: 120,
        command: ['pnpm', 'build'],
      },
      {
        stage: 'test',
        ok: true,
        durationMs: 900,
        command: ['pnpm', 'test'],
      },
      {
        stage: 'smoke',
        ok: false,
        durationMs: 300,
        command: ['node', 'dist/index.js', 'mcp', '--help'],
        failedStep: 'mcp-help',
        error: 'missing expected pattern',
      },
    ],
  });

  assert.match(text, /Release Gate Report/);
  assert.match(text, /Status: FAIL/);
  assert.match(text, /smoke: failed/);
  assert.match(text, /step=mcp-help/);
  assert.match(text, /missing expected pattern/);
});
