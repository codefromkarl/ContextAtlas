import assert from 'node:assert/strict';
import test from 'node:test';
import { TOOLS } from '../src/mcp/server.ts';
import {
  assertToolAllowed,
  filterToolsForToolset,
  resolveMcpToolsetMode,
} from '../src/mcp/registry/toolset.ts';

test('resolveMcpToolsetMode falls back to full for unknown values', () => {
  assert.equal(resolveMcpToolsetMode(undefined), 'full');
  assert.equal(resolveMcpToolsetMode('retrieval-only'), 'retrieval-only');
  assert.equal(resolveMcpToolsetMode('full'), 'full');
  assert.equal(resolveMcpToolsetMode('unexpected'), 'full');
});

test('retrieval-only toolset exposes read-only retrieval tools only', () => {
  const tools = filterToolsForToolset(TOOLS, 'retrieval-only');
  const toolNames = tools.map((tool) => tool.name);

  assert.deepEqual(toolNames, [
    'codebase-retrieval',
    'contract_analysis',
    'detect_changes',
    'graph_query',
    'graph_impact',
    'graph_context',
    'find_memory',
    'get_project_profile',
    'load_module_memory',
    'list_memory_catalog',
    'query_shared_memories',
    'get_dependency_chain',
  ]);
  assert.ok(!toolNames.includes('record_memory'));
  assert.ok(!toolNames.includes('manage_projects'));
});

test('assertToolAllowed rejects hidden tools in retrieval-only mode', () => {
  assert.doesNotThrow(() => assertToolAllowed('codebase-retrieval', 'retrieval-only'));
  assert.throws(
    () => assertToolAllowed('record_memory', 'retrieval-only'),
    /disabled in MCP toolset mode retrieval-only/,
  );
});
