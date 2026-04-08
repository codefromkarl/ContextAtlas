import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getDependencyChainSchema,
  manageProjectsSchema,
  querySharedMemoriesSchema,
} from '../src/mcp/tools/memoryHub.ts';
import { listMemoryCatalogSchema } from '../src/mcp/tools/listMemoryCatalog.ts';
import { loadModuleMemorySchema } from '../src/mcp/tools/loadModuleMemory.ts';
import { assembleContextSchema } from '../src/mcp/tools/assembleContext.ts';
import { prepareHandoffSchema } from '../src/mcp/tools/prepareHandoff.ts';
import { suggestPhaseBoundarySchema } from '../src/mcp/tools/suggestPhaseBoundary.ts';
import {
  manageLongTermMemorySchema,
  recordLongTermMemorySchema,
} from '../src/mcp/tools/longTermMemory.ts';
import {
  deleteMemorySchema,
  findMemorySchema,
  getProjectProfileSchema,
  maintainMemoryCatalogSchema,
} from '../src/mcp/tools/projectMemory.ts';
import { TOOLS } from '../src/mcp/server.ts';

const FORMAT_SCHEMAS = [
  ['find_memory', findMemorySchema, { query: 'auth', format: 'markdown' }],
  ['manage_long_term_memory', manageLongTermMemorySchema, { action: 'list', format: 'markdown' }],
  [
    'record_long_term_memory',
    recordLongTermMemorySchema,
    { type: 'reference', title: 't', summary: 's', format: 'markdown' },
  ],
  ['get_project_profile', getProjectProfileSchema, { format: 'markdown' }],
  ['delete_memory', deleteMemorySchema, { name: 'auth', format: 'markdown' }],
  ['maintain_memory_catalog', maintainMemoryCatalogSchema, { action: 'check', format: 'markdown' }],
  ['load_module_memory', loadModuleMemorySchema, { query: 'auth', format: 'markdown' }],
  ['prepare_handoff', prepareHandoffSchema, { repo_path: '/tmp/repo', checkpoint_id: 'chk', format: 'markdown' }],
  ['assemble_context', assembleContextSchema, { repo_path: '/tmp/repo', moduleName: 'AuthService', format: 'markdown' }],
  ['suggest_phase_boundary', suggestPhaseBoundarySchema, { repo_path: '/tmp/repo', current_phase: 'overview', format: 'markdown' }],
  ['list_memory_catalog', listMemoryCatalogSchema, { format: 'markdown' }],
  ['query_shared_memories', querySharedMemoriesSchema, { query: 'auth', format: 'markdown' }],
  [
    'get_dependency_chain',
    getDependencyChainSchema,
    { project: 'proj', module: 'AuthService', format: 'markdown' },
  ],
  ['manage_projects', manageProjectsSchema, { action: 'list', format: 'markdown' }],
] as const;

test('all MCP response format schemas accept markdown alias as text', () => {
  for (const [name, schema, input] of FORMAT_SCHEMAS) {
    const parsed = schema.parse(input);
    assert.equal(parsed.format, 'text', `${name} should normalize markdown to text`);
  }
});

test('MCP tool metadata advertises markdown alias for all format-enabled tools', async () => {
  assert.ok(Array.isArray(TOOLS), 'TOOLS should be exported for metadata assertions');

  const expectedToolNames = new Set(FORMAT_SCHEMAS.map(([name]) => name));
  for (const tool of TOOLS) {
    if (!expectedToolNames.has(tool.name)) continue;
    const format = tool.inputSchema?.properties?.format;
    assert.ok(format, `${tool.name} should expose format property`);
    assert.deepEqual(
      format.enum,
      ['text', 'markdown', 'json'],
      `${tool.name} should advertise markdown alias`,
    );
  }
});

test('assemble_context metadata stays aligned with the public schema', () => {
  const tool = TOOLS.find((entry) => entry.name === 'assemble_context');
  assert.ok(tool, 'assemble_context tool should be registered');

  const properties = tool.inputSchema?.properties ?? {};
  assert.deepEqual(
    Object.keys(properties).sort(),
    ['checkpoint_id', 'filePaths', 'format', 'moduleName', 'phase', 'profile', 'query', 'repo_path'],
  );
  assert.deepEqual(properties.profile?.enum, ['overview', 'debug', 'implementation', 'verification', 'handoff']);
  assert.equal(properties.scope, undefined);
  assert.equal(properties.information_request, undefined);
  assert.equal(properties.technical_terms, undefined);
  assert.equal(properties.response_mode, undefined);
});
