import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MemoryHubDatabase } from '../src/memory/MemoryHubDatabase.js';
import { MemoryStore } from '../src/memory/MemoryStore.js';
import {
  executeManageLongTermMemory,
  executeRecordLongTermMemory,
  type RecordLongTermMemoryInput,
  type ManageLongTermMemoryInput,
} from '../src/application/memory/executeLongTermMemory.js';

async function withTempProjects(
  run: (projectA: string, projectB: string, dbPath: string) => Promise<void>,
): Promise<void> {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cw-execute-long-term-memory-'));
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

test('executeRecordLongTermMemory records different types of long-term memories', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const userMemory: RecordLongTermMemoryInput = {
      type: 'user',
      title: '用户偏好简短解释',
      summary: '用户更偏好简短、直接的解释',
      howToApply: '默认先给结论，必要时再展开',
      tags: ['style'],
      scope: 'project',
      source: 'user-explicit',
      confidence: 1,
      format: 'json',
    };

    const userResponse = await executeRecordLongTermMemory(userMemory, projectRoot);
    const userPayload = JSON.parse(userResponse.content[0].text);
    assert.equal(userPayload.tool, 'record_long_term_memory');
    assert.equal(userPayload.memory.type, 'user');
    assert.equal(userPayload.memory.title, '用户偏好简短解释');

    const feedbackMemory: RecordLongTermMemoryInput = {
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
    };

    const feedbackResponse = await executeRecordLongTermMemory(feedbackMemory, projectRoot);
    const feedbackPayload = JSON.parse(feedbackResponse.content[0].text);
    assert.equal(feedbackPayload.memory.type, 'feedback');
    assert.equal(feedbackPayload.memory.why, '避免低级问题进入主分支');

    const projectStateMemory: RecordLongTermMemoryInput = {
      type: 'project-state',
      title: '用户模块迁移进度',
      summary: '用户模块迁移截止日期是 2099-04-07，目前完成了查询部分，接下来做变更部分。',
      tags: ['migration', 'user-module'],
      scope: 'project',
      source: 'agent-inferred',
      confidence: 0.8,
      durability: 'ephemeral',
      format: 'json',
    };

    const projectStateResponse = await executeRecordLongTermMemory(projectStateMemory, projectRoot);
    const projectStatePayload = JSON.parse(projectStateResponse.content[0].text);
    assert.equal(projectStatePayload.memory.type, 'project-state');
    assert.equal(projectStatePayload.memory.durability, 'ephemeral');

    const referenceMemory: RecordLongTermMemoryInput = {
      type: 'reference',
      title: 'Grafana 仪表盘',
      summary: '生产环境 Grafana 仪表盘在 https://grafana.example.com/d/abc123',
      links: ['https://grafana.example.com/d/abc123'],
      tags: ['ops', 'grafana'],
      scope: 'project',
      source: 'user-explicit',
      confidence: 1,
      format: 'json',
    };

    const referenceResponse = await executeRecordLongTermMemory(referenceMemory, projectRoot);
    const referencePayload = JSON.parse(referenceResponse.content[0].text);
    assert.equal(referencePayload.memory.type, 'reference');
    assert.deepEqual(referencePayload.memory.links, ['https://grafana.example.com/d/abc123']);
  });
});

test('executeManageLongTermMemory can find, list, and delete long-term memories', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const recordResponse = await executeRecordLongTermMemory({
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
    }, projectRoot);

    const recordPayload = JSON.parse(recordResponse.content[0].text);

    const findArgs: ManageLongTermMemoryInput = {
      action: 'find',
      query: 'lint',
      types: ['feedback'],
      format: 'json',
    };

    const findResponse = await executeManageLongTermMemory(findArgs, projectRoot);
    const findPayload = JSON.parse(findResponse.content[0].text);
    assert.equal(findPayload.tool, 'manage_long_term_memory');
    assert.equal(findPayload.action, 'find');
    assert.equal(findPayload.result_count, 1);
    assert.equal(findPayload.results[0].title, '提交前先跑 lint');

    const listArgs: ManageLongTermMemoryInput = {
      action: 'list',
      types: ['feedback'],
      format: 'json',
    };

    const listResponse = await executeManageLongTermMemory(listArgs, projectRoot);
    const listPayload = JSON.parse(listResponse.content[0].text);
    assert.equal(listPayload.action, 'list');
    assert.equal(listPayload.result_count, 1);

    const deleteArgs: ManageLongTermMemoryInput = {
      action: 'delete',
      id: recordPayload.memory.id,
      types: ['feedback'],
      scope: 'project',
      format: 'json',
    };

    const deleteResponse = await executeManageLongTermMemory(deleteArgs, projectRoot);
    const deletePayload = JSON.parse(deleteResponse.content[0].text);
    assert.equal(deletePayload.action, 'delete');
    assert.equal(deletePayload.status, 'deleted');

    const afterDeleteFindResponse = await executeManageLongTermMemory(findArgs, projectRoot);
    const afterDeleteFindPayload = JSON.parse(afterDeleteFindResponse.content[0].text);
    assert.equal(afterDeleteFindPayload.result_count, 0);
  });
});

test('executeManageLongTermMemory suggests long-term memories without writing by default and explains scores', async () => {
  await withTempProjects(async (projectRoot, _projectB, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));
    const suggestResponse = await executeManageLongTermMemory(
      {
        action: 'suggest',
        transcript: 'Always reply in Chinese. Project migration is blocked until external approval.',
        scope: 'project',
        format: 'json',
      },
      projectRoot,
    );
    const suggestPayload = JSON.parse(suggestResponse.content[0]?.text ?? '{}');
    assert.equal(suggestPayload.action, 'suggest');
    assert.equal(suggestPayload.suggestOnly, true);
    assert.ok(suggestPayload.result_count >= 1);

    const emptyFindResponse = await executeManageLongTermMemory(
      {
        action: 'find',
        query: 'Chinese',
        scope: 'project',
        format: 'json',
      },
      projectRoot,
    );
    const emptyFindPayload = JSON.parse(emptyFindResponse.content[0]?.text ?? '{}');
    assert.equal(emptyFindPayload.result_count, 0);

    await executeManageLongTermMemory(
      {
        action: 'suggest',
        transcript: 'Always reply in Chinese.',
        scope: 'project',
        apply: true,
        format: 'json',
      },
      projectRoot,
    );
    const findResponse = await executeManageLongTermMemory(
      {
        action: 'find',
        query: 'Chinese preference',
        scope: 'project',
        format: 'json',
      },
      projectRoot,
    );
    const findPayload = JSON.parse(findResponse.content[0]?.text ?? '{}');
    assert.equal(findPayload.result_count, 1);
    assert.ok(findPayload.results[0].matchFields.includes('summary'));
    assert.equal(typeof findPayload.results[0].scoreBreakdown.confidence, 'number');
    assert.equal(findPayload.results[0].scoreBreakdown.embedding, 'disabled');
  });
});

test('executeManageLongTermMemory can invalidate temporal facts by factKey', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const recordResponse = await executeRecordLongTermMemory({
      type: 'temporal-fact',
      title: 'User module migration status',
      summary: 'User module migration is blocked on data backfill.',
      tags: ['migration'],
      scope: 'project',
      source: 'user-explicit',
      confidence: 1,
      validFrom: '2026-04-08',
      format: 'json',
      factKey: 'migration:user-module',
    }, projectRoot);

    const recordPayload = JSON.parse(recordResponse.content[0].text);
    assert.equal(recordPayload.memory.status, undefined);
    assert.equal(recordPayload.memory.factKey, 'migration:user-module');

    const invalidateArgs: ManageLongTermMemoryInput = {
      action: 'invalidate',
      types: ['temporal-fact'],
      scope: 'project',
      factKey: 'migration:user-module',
      ended: '2020-01-01',
      format: 'json',
    };

    const invalidateResponse = await executeManageLongTermMemory(invalidateArgs, projectRoot);
    const invalidatePayload = JSON.parse(invalidateResponse.content[0].text);
    assert.equal(invalidatePayload.action, 'invalidate');
    assert.equal(invalidatePayload.invalidated_count, 1);
    assert.equal(invalidatePayload.memory.factKey, 'migration:user-module');
    assert.equal(invalidatePayload.memory.validUntil, '2020-01-01');

    const listArgs: ManageLongTermMemoryInput = {
      action: 'list',
      types: ['temporal-fact'],
      includeExpired: true,
      format: 'json',
    };

    const listResponse = await executeManageLongTermMemory(listArgs, projectRoot);
    const listPayload = JSON.parse(listResponse.content[0].text);
    assert.equal(listPayload.result_count, 1);
    assert.equal(listPayload.results[0].status, 'expired');
  });
});

test('executeManageLongTermMemory can prune stale long-term memories', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const staleResponse = await executeRecordLongTermMemory({
      type: 'feedback',
      title: '老的协作约束',
      summary: '接口变更前先同步给客户端',
      lastVerifiedAt: '2020-01-01',
      scope: 'project',
      source: 'user-explicit',
      confidence: 1,
      format: 'json',
    }, projectRoot);

    const stalePayload = JSON.parse(staleResponse.content[0].text);

    await executeRecordLongTermMemory({
      type: 'feedback',
      title: '当前协作约束',
      summary: '提交前跑完整测试',
      lastVerifiedAt: '2099-01-01',
      scope: 'project',
      source: 'user-explicit',
      confidence: 1,
      format: 'json',
    }, projectRoot);

    const pruneArgs: ManageLongTermMemoryInput = {
      action: 'prune',
      types: ['feedback'],
      scope: 'project',
      includeStale: true,
      staleDays: 30,
      dryRun: false,
      format: 'json',
    };

    const pruneResponse = await executeManageLongTermMemory(pruneArgs, projectRoot);
    const prunePayload = JSON.parse(pruneResponse.content[0].text);
    assert.equal(prunePayload.action, 'prune');
    assert.equal(prunePayload.pruned_count, 1);
    assert.deepEqual(prunePayload.pruned_ids, [stalePayload.memory.id]);

    const afterPruneListResponse = await executeManageLongTermMemory({
      action: 'list',
      types: ['feedback'],
      includeExpired: true,
      format: 'json',
    }, projectRoot);

    const afterPruneListPayload = JSON.parse(afterPruneListResponse.content[0].text);
    assert.equal(afterPruneListPayload.result_count, 1);
    assert.equal(afterPruneListPayload.results[0].title, '当前协作约束');
  });
});

test('executeRecordLongTermMemory returns duplicate hints for similar memories', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    await executeRecordLongTermMemory({
      type: 'feedback',
      title: '提交前先跑 lint',
      summary: '提交代码前必须运行 lint',
      tags: ['lint'],
      scope: 'project',
      source: 'user-explicit',
      confidence: 1,
      format: 'json',
    }, projectRoot);

    const duplicateResponse = await executeRecordLongTermMemory({
      type: 'feedback',
      title: '提交前先跑 lint',
      summary: '提交代码前必须运行 lint',
      tags: ['lint', 'workflow'],
      scope: 'project',
      source: 'user-explicit',
      confidence: 1,
      format: 'json',
    }, projectRoot);

    const duplicatePayload = JSON.parse(duplicateResponse.content[0].text);
    assert.equal(duplicatePayload.write_action, 'merged');
    assert.ok(Array.isArray(duplicatePayload.duplicateHints));
    assert.ok(duplicatePayload.duplicateHints.length > 0);
  });
});

test('executeManageLongTermMemory handles error cases gracefully', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const deleteWithoutIdArgs: ManageLongTermMemoryInput = {
      action: 'delete',
      types: ['feedback'],
      scope: 'project',
      format: 'json',
    };

    const deleteWithoutIdResponse = await executeManageLongTermMemory(deleteWithoutIdArgs, projectRoot);
    assert.equal(deleteWithoutIdResponse.isError, true);
    assert.match(deleteWithoutIdResponse.content[0].text, /Error/);

    const invalidateWithoutTargetArgs: ManageLongTermMemoryInput = {
      action: 'invalidate',
      types: ['feedback'],
      scope: 'project',
      format: 'json',
    };

    const invalidateWithoutTargetResponse = await executeManageLongTermMemory(invalidateWithoutTargetArgs, projectRoot);
    assert.equal(invalidateWithoutTargetResponse.isError, true);
    assert.match(invalidateWithoutTargetResponse.content[0].text, /Error/);
  });
});
