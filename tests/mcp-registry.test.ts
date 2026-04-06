import assert from 'node:assert/strict';
import test from 'node:test';

import { createToolDispatcher, TOOLS } from '../src/mcp/registry/index.js';

test('mcp registry exposes tool definitions via dedicated module', () => {
  const toolNames = TOOLS.map((tool) => tool.name);

  assert.ok(toolNames.includes('codebase-retrieval'));
  assert.ok(toolNames.includes('find_memory'));
  assert.ok(toolNames.includes('record_memory'));
  assert.ok(toolNames.includes('manage_projects'));
  assert.ok(toolNames.includes('suggest_memory'));
});

test('createToolDispatcher returns unknown tool error for unmapped tools', async () => {
  const dispatcher = createToolDispatcher(process.cwd());

  await assert.rejects(
    () => dispatcher('definitely-missing-tool', {}, undefined),
    /Unknown tool: definitely-missing-tool/,
  );
});
