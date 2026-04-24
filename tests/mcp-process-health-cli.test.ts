import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('mcp:cleanup-duplicates CLI 在伪造 ps 输出下返回 dry-run 结果', () => {
  const psOutput = [
    '100 1 120 /usr/bin/node /home/yuanzhi/Develop/tools/ContextAtlas/dist/index.js mcp',
    '120 1 5 /usr/bin/node /home/yuanzhi/Develop/tools/ContextAtlas/dist/index.js mcp',
  ].join('\n');

  const result = spawnSync(
    'node',
    ['--import', 'tsx', 'src/index.ts', 'mcp:cleanup-duplicates', '--json'],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        CONTEXTATLAS_PS_OUTPUT: psOutput,
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 'dry-run');
  assert.equal(payload.suggestedKeepPid, 120);
  assert.deepEqual(payload.duplicatePids, [100]);
});

test('mcp:cleanup-duplicates CLI 在 apply 无 keep-pid 时返回 requires-keep-pid', () => {
  const psOutput = [
    '100 1 120 /usr/bin/node /home/yuanzhi/Develop/tools/ContextAtlas/dist/index.js mcp',
    '120 1 5 /usr/bin/node /home/yuanzhi/Develop/tools/ContextAtlas/dist/index.js mcp',
  ].join('\n');

  const result = spawnSync(
    'node',
    ['--import', 'tsx', 'src/index.ts', 'mcp:cleanup-duplicates', '--apply', '--json'],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        CONTEXTATLAS_PS_OUTPUT: psOutput,
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 'requires-keep-pid');
  assert.equal(payload.suggestedKeepPid, 120);
});
