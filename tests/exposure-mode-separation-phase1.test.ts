import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const REPO_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
);

test('CLI search command does not depend on MCP tool implementation directly', () => {
  const source = fs.readFileSync(
    path.join(REPO_ROOT, 'src', 'cli', 'commands', 'search.ts'),
    'utf8',
  );

  assert.doesNotMatch(source, /mcp\/tools\/codebaseRetrieval/);
  assert.match(source, /application\/retrieval\/executeRetrieval/);
});
