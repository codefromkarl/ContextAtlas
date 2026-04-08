import assert from 'node:assert/strict';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id?: number;
  result?: any;
  error?: any;
  method?: string;
  params?: any;
};

function createTempEnv(): { baseDir: string; projectDir: string; homeDir: string } {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-mcp-stdio-test-'));
  const projectDir = path.join(baseDir, 'project');
  const homeDir = path.join(baseDir, 'home');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.contextatlas'), { recursive: true });
  return { baseDir, projectDir, homeDir };
}

class McpStdIoClient {
  private readonly proc: ChildProcessWithoutNullStreams;
  private buffer = '';
  private readonly pending = new Map<number, (value: JsonRpcResponse) => void>();

  constructor(projectDir: string, homeDir: string) {
    this.proc = spawn('node', [path.join(REPO_ROOT, 'dist/index.js'), 'mcp'], {
      cwd: projectDir,
      env: {
        ...process.env,
        HOME: homeDir,
        CONTEXTATLAS_BASE_DIR: path.join(homeDir, '.contextatlas'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let idx = this.buffer.indexOf('\n');
      while (idx >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (line) {
          const message = JSON.parse(line) as JsonRpcResponse;
          if (typeof message.id === 'number') {
            const resolve = this.pending.get(message.id);
            if (resolve) {
              this.pending.delete(message.id);
              resolve(message);
            }
          }
        }
        idx = this.buffer.indexOf('\n');
      }
    });
  }

  async call(
    id: number,
    method: string,
    params: Record<string, unknown>,
  ): Promise<JsonRpcResponse> {
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const result = new Promise<JsonRpcResponse>((resolve) => {
      this.pending.set(id, resolve);
    });
    this.proc.stdin.write(`${payload}\n`);
    return result;
  }

  async initialize(): Promise<void> {
    const init = await this.call(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'contextatlas-test', version: '1.0' },
    });
    assert.ok(init.result);
    this.proc.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`,
    );
  }

  async close(): Promise<void> {
    if (this.proc.exitCode !== null || this.proc.killed) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.proc.once('exit', () => resolve());
      this.proc.kill('SIGTERM');
    });
  }
}

test('MCP stdio exposes JSON-enabled memory tools with parseable payloads', async () => {
  const { baseDir, projectDir, homeDir } = createTempEnv();
  const client = new McpStdIoClient(projectDir, homeDir);

  try {
    await client.initialize();

    const tools = await client.call(2, 'tools/list', {});
    const toolNames = tools.result.tools.map((tool: { name: string }) => tool.name);
    assert.ok(toolNames.includes('find_memory'));
    assert.ok(toolNames.includes('maintain_memory_catalog'));
    assert.ok(toolNames.includes('manage_long_term_memory'));
    assert.ok(toolNames.includes('prepare_handoff'));
    assert.ok(toolNames.includes('assemble_context'));
    assert.ok(toolNames.includes('suggest_phase_boundary'));

    await client.call(3, 'tools/call', {
      name: 'record_memory',
      arguments: {
        name: 'proto-module',
        responsibility: 'proto responsibility',
        dir: 'src/proto',
        files: ['proto.ts'],
        exports: ['proto-module'],
        endpoints: [],
        imports: [],
        external: [],
        dataFlow: 'proto flow',
        keyPatterns: ['proto'],
      },
    });

    const find = await client.call(4, 'tools/call', {
      name: 'find_memory',
      arguments: { query: 'proto-module', format: 'json' },
    });
    const findPayload = JSON.parse(find.result.content[0].text);
    assert.equal(findPayload.tool, 'find_memory');
    assert.equal(findPayload.result_count, 1);

    const check = await client.call(5, 'tools/call', {
      name: 'maintain_memory_catalog',
      arguments: { action: 'check', format: 'json' },
    });
    const checkPayload = JSON.parse(check.result.content[0].text);
    assert.equal(checkPayload.tool, 'check_memory_consistency');
    assert.equal(checkPayload.status, 'ok');

    const profile = await client.call(6, 'tools/call', {
      name: 'get_project_profile',
      arguments: { format: 'json' },
    });
    const profilePayload = JSON.parse(profile.result.content[0].text);
    assert.equal(profilePayload.tool, 'get_project_profile');
    assert.equal(profilePayload.status, 'not_found');
    assert.equal(profilePayload.profile, null);

    const loaded = await client.call(7, 'tools/call', {
      name: 'load_module_memory',
      arguments: { moduleName: 'proto-module', format: 'json' },
    });
    const loadedPayload = JSON.parse(loaded.result.content[0].text);
    assert.equal(loadedPayload.tool, 'load_module_memory');
    assert.equal(loadedPayload.result_count, 1);

    const checkpoint = await client.call(8, 'tools/call', {
      name: 'create_checkpoint',
      arguments: {
        repo_path: projectDir,
        title: 'proto handoff',
        goal: 'package context',
        phase: 'handoff',
        summary: 'checkpoint summary',
        activeBlockIds: ['memory:proto-module'],
        exploredRefs: ['src/proto.ts'],
        keyFindings: ['proto ready'],
        nextSteps: ['prepare handoff'],
        format: 'json',
      },
    });
    const checkpointPayload = JSON.parse(checkpoint.result.content[0].text);
    assert.equal(checkpointPayload.tool, 'create_checkpoint');

    const handoff = await client.call(9, 'tools/call', {
      name: 'prepare_handoff',
      arguments: {
        repo_path: projectDir,
        checkpoint_id: checkpointPayload.checkpoint.id,
        format: 'json',
      },
    });
    const handoffPayload = JSON.parse(handoff.result.content[0].text);
    assert.equal(handoffPayload.tool, 'prepare_handoff');
    assert.equal(handoffPayload.handoffBundle.kind, 'handoff-bundle');
    assert.equal(handoffPayload.handoffSummary.phase, 'handoff');
    assert.ok(Array.isArray(handoffPayload.handoffSummary.referencedBlockIds));

    const assembled = await client.call(10, 'tools/call', {
      name: 'assemble_context',
      arguments: {
        repo_path: projectDir,
        profile: 'handoff',
        moduleName: 'proto-module',
        checkpoint_id: checkpointPayload.checkpoint.id,
        format: 'json',
      },
    });
    const assembledPayload = JSON.parse(assembled.result.content[0].text);
    assert.equal(assembledPayload.tool, 'assemble_context');
    assert.equal(assembledPayload.assemblyProfile.resolvedProfile, 'handoff');
    assert.equal(assembledPayload.source.checkpoint.tool, 'load_checkpoint');
    assert.equal(assembledPayload.source.moduleMemory.tool, 'load_module_memory');
    assert.ok(Array.isArray(assembledPayload.selectedContext.contextBlocks));

    const phaseBoundary = await client.call(11, 'tools/call', {
      name: 'suggest_phase_boundary',
      arguments: {
        repo_path: projectDir,
        current_phase: 'handoff',
        checkpoint_id: checkpointPayload.checkpoint.id,
        format: 'json',
      },
    });
    const phaseBoundaryPayload = JSON.parse(phaseBoundary.result.content[0].text);
    assert.equal(phaseBoundaryPayload.tool, 'suggest_phase_boundary');
    assert.equal(phaseBoundaryPayload.recommendedPhase, 'handoff');
    assert.equal(phaseBoundaryPayload.transition, 'stay');
    assert.equal(phaseBoundaryPayload.shouldTransition, false);

    const catalog = await client.call(12, 'tools/call', {
      name: 'list_memory_catalog',
      arguments: { includeDetails: true, format: 'json' },
    });
    const catalogPayload = JSON.parse(catalog.result.content[0].text);
    assert.equal(catalogPayload.tool, 'list_memory_catalog');
    assert.ok(catalogPayload.catalog.modules['proto-module']);

    const deleted = await client.call(13, 'tools/call', {
      name: 'delete_memory',
      arguments: { name: 'proto-module', format: 'json' },
    });
    const deletedPayload = JSON.parse(deleted.result.content[0].text);
    assert.equal(deletedPayload.tool, 'delete_memory');
    assert.equal(deletedPayload.status, 'deleted');

    const rebuilt = await client.call(14, 'tools/call', {
      name: 'maintain_memory_catalog',
      arguments: { action: 'rebuild', format: 'json' },
    });
    const rebuiltPayload = JSON.parse(rebuilt.result.content[0].text);
    assert.equal(rebuiltPayload.tool, 'rebuild_memory_catalog');
    assert.equal(rebuiltPayload.status, 'rebuilt');

    await client.call(15, 'tools/call', {
      name: 'record_long_term_memory',
      arguments: {
        type: 'reference',
        title: '过期监控面板',
        summary: '旧 dashboard https://grafana.example.com/legacy',
        links: ['https://grafana.example.com/legacy'],
        validUntil: '2020-01-01',
        format: 'json',
      },
    });

    const longTermList = await client.call(16, 'tools/call', {
      name: 'manage_long_term_memory',
      arguments: { action: 'list', types: ['reference'], format: 'json' },
    });
    const longTermListPayload = JSON.parse(longTermList.result.content[0].text);
    assert.equal(longTermListPayload.tool, 'manage_long_term_memory');
    assert.equal(longTermListPayload.action, 'list');
    assert.equal(longTermListPayload.result_count, 1);

    const pruned = await client.call(17, 'tools/call', {
      name: 'manage_long_term_memory',
      arguments: {
        action: 'prune',
        types: ['reference'],
        includeExpired: true,
        dryRun: false,
        format: 'json',
      },
    });
    const prunedPayload = JSON.parse(pruned.result.content[0].text);
    assert.equal(prunedPayload.tool, 'manage_long_term_memory');
    assert.equal(prunedPayload.action, 'prune');
    assert.equal(prunedPayload.pruned_count, 1);
  } finally {
    await client.close();
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('MCP stdio accepts markdown alias for text find_memory responses', async () => {
  const { baseDir, projectDir, homeDir } = createTempEnv();
  const client = new McpStdIoClient(projectDir, homeDir);

  try {
    await client.initialize();

    await client.call(20, 'tools/call', {
      name: 'record_memory',
      arguments: {
        name: 'markdown-memory',
        responsibility: 'markdown alias compatibility',
        dir: 'src/markdown',
        files: ['markdown.ts'],
        exports: ['markdown-memory'],
        endpoints: [],
        imports: [],
        external: [],
        dataFlow: 'markdown flow',
        keyPatterns: ['markdown'],
      },
    });

    const result = await client.call(21, 'tools/call', {
      name: 'find_memory',
      arguments: { query: 'markdown-memory', format: 'markdown' },
    });

    assert.ok(result.result);
    assert.equal(result.result.isError, undefined);
    assert.equal(result.result.content[0].type, 'text');
    assert.match(result.result.content[0].text, /markdown-memory/);
  } finally {
    await client.close();
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('MCP stdio returns structured tool errors for invalid arguments', async () => {
  const { baseDir, projectDir, homeDir } = createTempEnv();
  const client = new McpStdIoClient(projectDir, homeDir);

  try {
    await client.initialize();

    const invalid = await client.call(22, 'tools/call', {
      name: 'find_memory',
      arguments: { query: 'ContextAtlas', format: 'yaml' },
    });

    assert.ok(invalid.result);
    assert.equal(invalid.result.isError, true);
    assert.equal(invalid.result.content[0].type, 'text');
    assert.match(invalid.result.content[0].text, /Invalid arguments for find_memory/);
    assert.match(invalid.result.content[0].text, /text/);
    assert.match(invalid.result.content[0].text, /json/);
  } finally {
    await client.close();
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('MCP stdio exposes JSON-enabled hub tools with parseable payloads', async () => {
  const { baseDir, projectDir, homeDir } = createTempEnv();
  const client = new McpStdIoClient(projectDir, homeDir);

  try {
    await client.initialize();

    await client.call(2, 'tools/call', {
      name: 'record_memory',
      arguments: {
        name: 'hub-batch-module',
        responsibility: 'hub batch responsibility',
        dir: 'src/hub-batch',
        files: ['hub.ts'],
        exports: ['hub-batch-module'],
        endpoints: [],
        imports: [],
        external: [],
        dataFlow: 'hub batch flow',
        keyPatterns: ['hub-batch'],
      },
    });

    const projects = await client.call(3, 'tools/call', {
      name: 'manage_projects',
      arguments: { action: 'list', format: 'json' },
    });
    const projectsPayload = JSON.parse(projects.result.content[0].text);
    assert.equal(projectsPayload.tool, 'manage_projects');
    assert.equal(projectsPayload.action, 'list');
    assert.equal(projectsPayload.result_count, 1);
    const projectId = projectsPayload.projects[0].id;

    const shared = await client.call(4, 'tools/call', {
      name: 'query_shared_memories',
      arguments: { queryText: 'hub-batch-module', mode: 'fts', format: 'json' },
    });
    const sharedPayload = JSON.parse(shared.result.content[0].text);
    assert.equal(sharedPayload.tool, 'query_shared_memories');
    assert.equal(sharedPayload.result_count, 1);

    const deps = await client.call(5, 'tools/call', {
      name: 'get_dependency_chain',
      arguments: {
        project: projectId,
        module: 'hub-batch-module',
        recursive: true,
        format: 'json',
      },
    });
    const depsPayload = JSON.parse(deps.result.content[0].text);
    assert.equal(depsPayload.tool, 'get_dependency_chain');
    assert.equal(depsPayload.result_count, 0);

    const fts = await client.call(6, 'tools/call', {
      name: 'query_shared_memories',
      arguments: { queryText: 'hub-batch-module', mode: 'fts', format: 'json' },
    });
    const ftsPayload = JSON.parse(fts.result.content[0].text);
    assert.equal(ftsPayload.tool, 'query_shared_memories');
    assert.equal(ftsPayload.result_count, 1);

    const stats = await client.call(7, 'tools/call', {
      name: 'manage_projects',
      arguments: { action: 'stats', format: 'json' },
    });
    const statsPayload = JSON.parse(stats.result.content[0].text);
    assert.equal(statsPayload.tool, 'manage_projects');
    assert.equal(statsPayload.action, 'stats');
    assert.ok(statsPayload.stats);
  } finally {
    await client.close();
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});
