import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const REPO_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
);

test('implicit MCP stdio is gated by exposure mode', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'src', 'config.ts'), 'utf8');

  assert.match(source, /CONTEXTATLAS_EXPOSURE_MODE/);
  assert.match(source, /exposureMode === 'mcp'/);
});
