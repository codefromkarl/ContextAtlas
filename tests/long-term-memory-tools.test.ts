import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { handleSessionEnd } from '../src/mcp/tools/autoRecord.ts';
import {
  handleManageLongTermMemory,
  handleRecordLongTermMemory,
} from '../src/mcp/tools/longTermMemory.ts';
import { MemoryHubDatabase } from '../src/memory/MemoryHubDatabase.ts';
import { MemoryStore } from '../src/memory/MemoryStore.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function withTempProjects(
  run: (projectA: string, projectB: string, dbPath: string) => Promise<void>,
): Promise<void> {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cw-long-term-memory-'));
  const projectA = path.join(tempDir, 'project-a');
  const projectB = path.join(tempDir, 'project-b');
  const dbPath = path.join(tempDir, 'memory-hub.db');
  mkdirSync(projectA, { recursive: true });
  mkdirSync(projectB, { recursive: true });

  try {
    await run(projectA, projectB, dbPath);
  } finally {
    MemoryStore.resetSharedHubForTests();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

test('long-term memory tools can record, find, list, and delete project-scoped memories', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const recordResponse = await handleRecordLongTermMemory(
      {
        type: 'feedback',
        title: '提交前先跑 lint',
        summary: '提交代码前必须运行 lint',
        why: '避免低级问题进入主分支',
        howToApply: '在 git commit 之前先运行 lint',
        tags: ['lint', 'workflow'],
        scope: 'project',
        source: 'user-explicit',
        confidence: 1,
        format: 'json',
      },
      projectRoot,
    );

    const recordPayload = JSON.parse(recordResponse.content[0].text);
    assert.equal(recordPayload.tool, 'record_long_term_memory');
    assert.equal(recordPayload.memory.type, 'feedback');

    const findResponse = await handleManageLongTermMemory(
      {
        action: 'find',
        query: 'lint',
        types: ['feedback'],
        format: 'json',
      },
      projectRoot,
    );
    const findPayload = JSON.parse(findResponse.content[0].text);
    assert.equal(findPayload.tool, 'manage_long_term_memory');
    assert.equal(findPayload.action, 'find');
    assert.equal(findPayload.result_count, 1);
    assert.equal(findPayload.results[0].title, '提交前先跑 lint');

    const listResponse = await handleManageLongTermMemory(
      {
        action: 'list',
        types: ['feedback'],
        format: 'json',
      },
      projectRoot,
    );
    const listPayload = JSON.parse(listResponse.content[0].text);
    assert.equal(listPayload.tool, 'manage_long_term_memory');
    assert.equal(listPayload.action, 'list');
    assert.equal(listPayload.result_count, 1);

    const deleteResponse = await handleManageLongTermMemory(
      {
        action: 'delete',
        id: recordPayload.memory.id,
        types: ['feedback'],
        scope: 'project',
        format: 'json',
      },
      projectRoot,
    );
    const deletePayload = JSON.parse(deleteResponse.content[0].text);
    assert.equal(deletePayload.tool, 'manage_long_term_memory');
    assert.equal(deletePayload.action, 'delete');
    assert.equal(deletePayload.status, 'deleted');

    const afterDeleteResponse = await handleManageLongTermMemory(
      {
        action: 'find',
        query: 'lint',
        types: ['feedback'],
        format: 'json',
      },
      projectRoot,
    );
    const afterDeletePayload = JSON.parse(afterDeleteResponse.content[0].text);
    assert.equal(afterDeletePayload.result_count, 0);
  });
});

test('global-user long-term memories are visible across projects in the same hub', async () => {
  await withTempProjects(async (projectA, projectB, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    await handleRecordLongTermMemory(
      {
        type: 'user',
        title: '偏好简短解释',
        summary: '用户更偏好简短、直接的解释',
        howToApply: '默认先给结论，必要时再展开',
        tags: ['style'],
        scope: 'global-user',
        source: 'user-explicit',
        confidence: 1,
        format: 'json',
      },
      projectA,
    );

    const response = await handleManageLongTermMemory(
      {
        action: 'find',
        query: '简短',
        types: ['user'],
        scope: 'global-user',
        format: 'json',
      },
      projectB,
    );
    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.result_count, 1);
    assert.equal(payload.results[0].scope, 'global-user');
  });
});

test('session_end can extract long-term memory candidates and auto-record them', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const summary = [
      '提交代码前必须运行 lint，因为之前多次把格式问题带进主分支。',
      '生产环境 Grafana 仪表盘在 https://grafana.example.com/d/abc123 。',
      '用户模块迁移截止日期是 2026-04-07，目前完成了查询部分，接下来做变更部分。',
    ].join(' ');

    const response = await handleSessionEnd({
      summary,
      project: projectRoot,
      autoRecord: true,
    });

    const text = response.content[0].text;
    assert.match(text, /长期记忆/);
    assert.match(text, /feedback/);
    assert.match(text, /reference/);
    assert.match(text, /project-state/);

    const store = new MemoryStore(projectRoot);
    const memories = await store.listLongTermMemories({
      types: ['feedback', 'reference', 'project-state'],
    });
    assert.equal(memories.length, 3);
    assert.ok(memories.some((memory) => memory.type === 'feedback'));
    assert.ok(memories.some((memory) => memory.type === 'reference'));
    assert.ok(memories.some((memory) => memory.type === 'project-state'));
  });
});

test('session_end autoRecord saves inferred feature memory with agent-inferred confirmation status', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const summary = [
      '实现了 SearchService 模块，文件位于 src/search/SearchService.ts。',
      '这个模块负责处理检索流程和上下文打包，后续还会继续扩展。',
    ].join(' ');

    const response = await handleSessionEnd({
      summary,
      project: projectRoot,
      autoRecord: true,
    });

    assert.match(response.content[0].text, /模块记忆/);
    assert.match(response.content[0].text, /SearchService/);

    const store = new MemoryStore(projectRoot);
    const memory = await store.readFeature('SearchService');
    assert.ok(memory);
    assert.equal(memory?.confirmationStatus, 'agent-inferred');

    const checkpoints = await store.listCheckpoints();
    assert.equal(checkpoints.length, 1);
    assert.equal(checkpoints[0]?.phase, 'handoff');
    assert.match(response.content[0].text, /任务检查点/);
  });
});

test('session_end autoRecord adds provenance/confidence and supersedes prior project-state snapshots', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    await handleSessionEnd({
      summary: '用户模块迁移截止日期是 2026-04-07，目前完成了查询部分，接下来做变更部分。',
      project: projectRoot,
      autoRecord: true,
    });

    await handleSessionEnd({
      summary: '用户模块迁移截止日期是 2026-04-08，目前完成了变更部分，接下来做回归验证。',
      project: projectRoot,
      autoRecord: true,
    });

    const store = new MemoryStore(projectRoot);
    const projectStates = await store.listLongTermMemories({
      types: ['project-state'],
      includeExpired: true,
    });

    assert.equal(projectStates.length, 2);
    assert.ok(projectStates.some((memory) => memory.status === 'superseded'));
    assert.ok(projectStates.some((memory) => memory.status === 'active'));

    const latest = projectStates.find((memory) => memory.status === 'active');
    const previous = projectStates.find((memory) => memory.status === 'superseded');
    assert.ok(latest);
    assert.ok(previous);
    assert.ok(latest?.provenance?.some((item) => item.startsWith('session-summary:')));
    assert.ok(latest?.provenance?.some((item) => item.startsWith('supersedes:')));
    assert.equal(latest?.durability, 'ephemeral');
    assert.equal(latest?.confidence, 0.84);
    assert.ok(previous?.provenance?.some((item) => item.startsWith('superseded-by:')));
  });
});

test('memory:create-checkpoint CLI records a checkpoint and load-checkpoint returns bundles', async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cw-checkpoint-cli-'));
  const projectRoot = path.join(tempDir, 'project');
  mkdirSync(projectRoot, { recursive: true });

  const previousBaseDir = process.env.CONTEXTATLAS_BASE_DIR;
  process.env.CONTEXTATLAS_BASE_DIR = tempDir;

  try {
    const createResult = spawnSync(
      'node',
      [
        '--import',
        'tsx',
        'src/index.ts',
        'memory:create-checkpoint',
        '--repo',
        projectRoot,
        '--title',
        'CLI Handoff',
        '--goal',
        'Capture session state',
        '--phase',
        'handoff',
        '--summary',
        'Captured CLI checkpoint state',
        '--active-block-ids',
        'block:a,block:b',
        '--explored-refs',
        'src/a.ts,src/b.ts',
        '--key-findings',
        'A,B',
        '--next-steps',
        'Inspect resume bundle',
        '--json',
      ],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          CONTEXTATLAS_BASE_DIR: tempDir,
        },
      },
    );

    assert.equal(createResult.status, 0, createResult.stderr);
    const created = JSON.parse(createResult.stdout);
    assert.equal(created.tool, 'create_checkpoint');
    assert.equal(created.handoffBundle.kind, 'handoff-bundle');
    assert.equal(created.resumeBundle.kind, 'resume-bundle');

    const loadResult = spawnSync(
      'node',
      [
        '--import',
        'tsx',
        'src/index.ts',
        'memory:load-checkpoint',
        created.checkpoint.id,
        '--repo',
        projectRoot,
        '--json',
      ],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          CONTEXTATLAS_BASE_DIR: tempDir,
        },
      },
    );

    assert.equal(loadResult.status, 0, loadResult.stderr);
    const loaded = JSON.parse(loadResult.stdout);
    assert.equal(loaded.tool, 'load_checkpoint');
    assert.equal(loaded.handoffBundle.kind, 'handoff-bundle');
    assert.equal(loaded.resumeBundle.kind, 'resume-bundle');

    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(path.join(tempDir, 'memory-hub.db')));
    const store = new MemoryStore(projectRoot);
    const checkpoints = await store.listCheckpoints();
    assert.equal(checkpoints.length, 1);
    assert.equal(checkpoints[0]?.title, 'CLI Handoff');
  } finally {
    if (previousBaseDir === undefined) {
      delete process.env.CONTEXTATLAS_BASE_DIR;
    } else {
      process.env.CONTEXTATLAS_BASE_DIR = previousBaseDir;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('expired long-term memories are excluded by default and returned with status when explicitly included', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    await handleRecordLongTermMemory(
      {
        type: 'reference',
        title: '旧 Grafana 仪表盘',
        summary: '旧 dashboard 地址 https://grafana.example.com/old',
        links: ['https://grafana.example.com/old'],
        validUntil: '2020-01-01',
        scope: 'project',
        source: 'user-explicit',
        confidence: 1,
        format: 'json',
      },
      projectRoot,
    );

    await handleRecordLongTermMemory(
      {
        type: 'reference',
        title: '当前 Grafana 仪表盘',
        summary: '当前 dashboard 地址 https://grafana.example.com/current',
        links: ['https://grafana.example.com/current'],
        validUntil: '2099-01-01',
        scope: 'project',
        source: 'user-explicit',
        confidence: 1,
        format: 'json',
      },
      projectRoot,
    );

    const defaultFindResponse = await handleManageLongTermMemory(
      {
        action: 'find',
        query: 'dashboard',
        types: ['reference'],
        format: 'json',
      },
      projectRoot,
    );
    const defaultFindPayload = JSON.parse(defaultFindResponse.content[0].text);
    assert.equal(defaultFindPayload.result_count, 1);
    assert.equal(defaultFindPayload.results[0].title, '当前 Grafana 仪表盘');
    assert.equal(defaultFindPayload.results[0].status, 'active');

    const includeExpiredResponse = await handleManageLongTermMemory(
      {
        action: 'find',
        query: 'dashboard',
        types: ['reference'],
        includeExpired: true,
        format: 'json',
      } as never,
      projectRoot,
    );
    const includeExpiredPayload = JSON.parse(includeExpiredResponse.content[0].text);
    assert.equal(includeExpiredPayload.result_count, 2);
    assert.ok(
      includeExpiredPayload.results.some(
        (memory: { status: string }) => memory.status === 'expired',
      ),
    );
  });
});

test('stale long-term memories can be listed with status and pruned in batch', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const staleRecordResponse = await handleRecordLongTermMemory(
      {
        type: 'feedback',
        title: '老的协作约束',
        summary: '接口变更前先同步给客户端',
        lastVerifiedAt: '2020-01-01',
        scope: 'project',
        source: 'user-explicit',
        confidence: 1,
        format: 'json',
      },
      projectRoot,
    );
    const staleRecordPayload = JSON.parse(staleRecordResponse.content[0].text);

    await handleRecordLongTermMemory(
      {
        type: 'feedback',
        title: '当前协作约束',
        summary: '提交前跑完整测试',
        lastVerifiedAt: '2099-01-01',
        scope: 'project',
        source: 'user-explicit',
        confidence: 1,
        format: 'json',
      },
      projectRoot,
    );

    const listResponse = await handleManageLongTermMemory(
      {
        action: 'list',
        types: ['feedback'],
        includeExpired: true,
        format: 'json',
      } as never,
      projectRoot,
    );
    const listPayload = JSON.parse(listResponse.content[0].text);
    assert.equal(listPayload.result_count, 2);
    assert.ok(
      listPayload.results.some(
        (memory: { title: string; status: string }) =>
          memory.title === '老的协作约束' && memory.status === 'stale',
      ),
    );

    const pruneResponse = await handleManageLongTermMemory(
      {
        action: 'prune',
        types: ['feedback'],
        scope: 'project',
        includeStale: true,
        staleDays: 30,
        dryRun: false,
        format: 'json',
      },
      projectRoot,
    );
    const prunePayload = JSON.parse(pruneResponse.content[0].text);
    assert.equal(prunePayload.tool, 'manage_long_term_memory');
    assert.equal(prunePayload.action, 'prune');
    assert.equal(prunePayload.pruned_count, 1);
    assert.deepEqual(prunePayload.pruned_ids, [staleRecordPayload.memory.id]);

    const afterPruneResponse = await handleManageLongTermMemory(
      {
        action: 'list',
        types: ['feedback'],
        includeExpired: true,
        format: 'json',
      } as never,
      projectRoot,
    );
    const afterPrunePayload = JSON.parse(afterPruneResponse.content[0].text);
    assert.equal(afterPrunePayload.result_count, 1);
    assert.equal(afterPrunePayload.results[0].title, '当前协作约束');
  });
});

test('memory:record-long-term CLI records explicit reference memories', async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cw-long-term-cli-'));
  const projectRoot = path.join(tempDir, 'project');
  mkdirSync(projectRoot, { recursive: true });

  const previousBaseDir = process.env.CONTEXTATLAS_BASE_DIR;
  process.env.CONTEXTATLAS_BASE_DIR = tempDir;

  try {
    const result = spawnSync(
      'node',
      [
        '--import',
        'tsx',
        'src/index.ts',
        'memory:record-long-term',
        '--repo',
        projectRoot,
        '--type',
        'reference',
        '--title',
        'Grafana Dashboard',
        '--summary',
        'Dashboard URL https://grafana.example.com/d/abc123',
        '--links',
        'https://grafana.example.com/d/abc123',
        '--tags',
        'grafana,ops',
        '--json',
      ],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          CONTEXTATLAS_BASE_DIR: tempDir,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.tool, 'record_long_term_memory');
    assert.equal(payload.memory.type, 'reference');

    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(path.join(tempDir, 'memory-hub.db')));
    const store = new MemoryStore(projectRoot);
    const memories = await store.listLongTermMemories({ types: ['reference'], scope: 'project' });
    assert.equal(memories.length, 1);
    assert.equal(memories[0]?.title, 'Grafana Dashboard');
  } finally {
    if (previousBaseDir === undefined) {
      delete process.env.CONTEXTATLAS_BASE_DIR;
    } else {
      process.env.CONTEXTATLAS_BASE_DIR = previousBaseDir;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
});


test('record_long_term_memory merges duplicate entries and preserves provenance', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const first = await handleRecordLongTermMemory(
      {
        type: 'feedback',
        title: '提交前先跑 lint',
        summary: '提交代码前必须运行 lint',
        provenance: ['guide:v1'],
        durability: 'stable',
        scope: 'project',
        source: 'agent-inferred',
        confidence: 0.6,
        format: 'json',
      },
      projectRoot,
    );
    const firstPayload = JSON.parse(first.content[0].text);
    assert.equal(firstPayload.write_action, 'created');

    const second = await handleRecordLongTermMemory(
      {
        type: 'feedback',
        title: '提交前先跑 lint',
        summary: '提交代码前必须运行 lint',
        provenance: ['guide:v2'],
        durability: 'stable',
        scope: 'project',
        source: 'user-explicit',
        confidence: 1,
        format: 'json',
      },
      projectRoot,
    );
    const secondPayload = JSON.parse(second.content[0].text);
    assert.equal(secondPayload.write_action, 'merged');

    const listResponse = await handleManageLongTermMemory(
      {
        action: 'list',
        types: ['feedback'],
        format: 'json',
      },
      projectRoot,
    );
    const listPayload = JSON.parse(listResponse.content[0].text);
    assert.equal(listPayload.result_count, 1);
    assert.deepEqual(listPayload.results[0].provenance.sort(), ['guide:v1', 'guide:v2']);
    assert.equal(listPayload.results[0].confidence, 1);
    assert.equal(listPayload.results[0].source, 'user-explicit');
    assert.equal(listPayload.results[0].durability, 'stable');
  });
});

test('record_result_feedback merges duplicate feedback and returns write_action', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const { handleRecordResultFeedback } = await import('../src/mcp/tools/feedbackLoop.ts');

    const first = await handleRecordResultFeedback(
      {
        outcome: 'memory-stale',
        targetType: 'feature-memory',
        query: 'Trace retrieval flow',
        targetId: 'SearchService',
        details: 'legacy path',
        format: 'json',
      },
      projectRoot,
    );
    const firstPayload = JSON.parse(first.content[0].text);
    assert.equal(firstPayload.write_action, 'created');

    const second = await handleRecordResultFeedback(
      {
        outcome: 'memory-stale',
        targetType: 'feature-memory',
        query: 'Trace retrieval flow',
        targetId: 'SearchService',
        details: 'legacy path',
        format: 'json',
      },
      projectRoot,
    );
    const secondPayload = JSON.parse(second.content[0].text);
    assert.equal(secondPayload.write_action, 'merged');

    const store = new MemoryStore(projectRoot);
    const feedback = await store.findLongTermMemories('SearchService', {
      types: ['feedback'],
      scope: 'project',
      staleDays: 30,
    });
    assert.equal(feedback.length, 1);
    assert.ok(feedback[0].memory.provenance?.includes('Trace retrieval flow'));
    assert.ok(feedback[0].memory.provenance?.includes('SearchService'));
  });
});
