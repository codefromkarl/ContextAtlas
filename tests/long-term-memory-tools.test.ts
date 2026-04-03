import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { handleSessionEnd } from '../src/mcp/tools/autoRecord.ts';
import {
  handleDeleteLongTermMemory,
  handleFindLongTermMemory,
  handleListLongTermMemories,
  handleRecordLongTermMemory,
} from '../src/mcp/tools/longTermMemory.ts';
import { MemoryHubDatabase } from '../src/memory/MemoryHubDatabase.ts';
import { MemoryStore } from '../src/memory/MemoryStore.ts';

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

    const findResponse = await handleFindLongTermMemory(
      {
        query: 'lint',
        types: ['feedback'],
        format: 'json',
      },
      projectRoot,
    );
    const findPayload = JSON.parse(findResponse.content[0].text);
    assert.equal(findPayload.tool, 'find_long_term_memory');
    assert.equal(findPayload.result_count, 1);
    assert.equal(findPayload.results[0].title, '提交前先跑 lint');

    const listResponse = await handleListLongTermMemories(
      {
        types: ['feedback'],
        format: 'json',
      },
      projectRoot,
    );
    const listPayload = JSON.parse(listResponse.content[0].text);
    assert.equal(listPayload.tool, 'list_long_term_memories');
    assert.equal(listPayload.result_count, 1);

    const deleteResponse = await handleDeleteLongTermMemory(
      {
        id: recordPayload.memory.id,
        type: 'feedback',
        scope: 'project',
        format: 'json',
      },
      projectRoot,
    );
    const deletePayload = JSON.parse(deleteResponse.content[0].text);
    assert.equal(deletePayload.tool, 'delete_long_term_memory');
    assert.equal(deletePayload.status, 'deleted');

    const afterDeleteResponse = await handleFindLongTermMemory(
      {
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

    const response = await handleFindLongTermMemory(
      {
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

    const defaultFindResponse = await handleFindLongTermMemory(
      {
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

    const includeExpiredResponse = await handleFindLongTermMemory(
      {
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

    const listResponse = await handleListLongTermMemories(
      {
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

    const longTermMemoryModule = await import('../src/mcp/tools/longTermMemory.ts');
    assert.equal(typeof longTermMemoryModule.handlePruneLongTermMemories, 'function');

    const pruneResponse = await longTermMemoryModule.handlePruneLongTermMemories(
      {
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
    assert.equal(prunePayload.tool, 'prune_long_term_memories');
    assert.equal(prunePayload.pruned_count, 1);
    assert.deepEqual(prunePayload.pruned_ids, [staleRecordPayload.memory.id]);

    const afterPruneResponse = await handleListLongTermMemories(
      {
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
