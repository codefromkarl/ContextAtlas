import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MemoryHubDatabase } from '../src/memory/MemoryHubDatabase.js';
import { MemoryStore } from '../src/memory/MemoryStore.js';
import {
  executeFindMemory,
  executeRecordMemory,
  executeRecordDecision,
  type FindMemoryInput,
  type RecordMemoryInput,
  type RecordDecisionInput,
} from '../src/application/memory/executeProjectMemory.js';

async function withTempProjects(
  run: (projectRoot: string, dbPath: string) => Promise<void>,
): Promise<void> {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cw-execute-project-memory-'));
  const projectRoot = path.join(tempDir, 'project');
  const dbPath = path.join(tempDir, 'memory-hub.db');
  mkdirSync(projectRoot, { recursive: true });

  try {
    await run(projectRoot, dbPath);
  } finally {
    MemoryStore.resetSharedHubForTests();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

test('executeRecordMemory records feature memory with all required fields', async () => {
  await withTempProjects(async (projectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const recordArgs: RecordMemoryInput = {
      name: 'SearchService',
      responsibility: '处理检索流程和上下文打包',
      dir: 'src/search/',
      files: ['SearchService.ts', 'SearchContext.ts'],
      exports: ['SearchService', 'SearchContext'],
      imports: ['lodash', 'axios'],
      external: ['@types/node'],
      dataFlow: '接收查询请求 → 构建上下文 → 调用检索接口 → 返回结果',
      keyPatterns: ['builder pattern', 'async/await'],
      confirmationStatus: 'human-confirmed',
      reviewStatus: 'verified',
    };

    const response = await executeRecordMemory(recordArgs, projectRoot);
    assert.equal(response.content[0].type, 'text');
    assert.match(response.content[0].text, /Feature Memory Recorded/);
    assert.match(response.content[0].text, /SearchService/);
    assert.match(response.content[0].text, /处理检索流程和上下文打包/);
    assert.match(response.content[0].text, /human-confirmed/);
    assert.match(response.content[0].text, /verified/);

    const store = new MemoryStore(projectRoot);
    const memory = await store.readFeature('SearchService');
    assert.ok(memory);
    assert.equal(memory?.name, 'SearchService');
    assert.equal(memory?.responsibility, '处理检索流程和上下文打包');
    assert.equal(memory?.confirmationStatus, 'human-confirmed');
    assert.equal(memory?.reviewStatus, 'verified');
  });
});

test('executeRecordMemory records feature memory with minimal fields', async () => {
  await withTempProjects(async (projectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const recordArgs: RecordMemoryInput = {
      name: 'AuthService',
      responsibility: '用户认证和授权',
      dir: 'src/auth/',
    };

    const response = await executeRecordMemory(recordArgs, projectRoot);
    assert.equal(response.content[0].type, 'text');
    assert.match(response.content[0].text, /Feature Memory Recorded/);
    assert.match(response.content[0].text, /AuthService/);

    const store = new MemoryStore(projectRoot);
    const memory = await store.readFeature('AuthService');
    assert.ok(memory);
    assert.equal(memory?.name, 'AuthService');
    assert.equal(memory?.responsibility, '用户认证和授权');
    assert.equal(memory?.confirmationStatus, 'human-confirmed');
    assert.equal(memory?.reviewStatus, 'verified');
  });
});

test('executeRecordMemory records feature memory with API endpoints', async () => {
  await withTempProjects(async (projectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const recordArgs: RecordMemoryInput = {
      name: 'UserController',
      responsibility: '处理用户相关的 HTTP 请求',
      dir: 'src/controllers/',
      files: ['UserController.ts'],
      exports: ['UserController'],
      endpoints: [
        { method: 'GET', path: '/api/users/:id', handler: 'getUserById' },
        { method: 'POST', path: '/api/users', handler: 'createUser', description: '创建新用户' },
        { method: 'PUT', path: '/api/users/:id', handler: 'updateUser' },
      ],
    };

    const response = await executeRecordMemory(recordArgs, projectRoot);
    assert.equal(response.content[0].type, 'text');
    assert.match(response.content[0].text, /Feature Memory Recorded/);
    assert.match(response.content[0].text, /UserController/);

    const store = new MemoryStore(projectRoot);
    const memory = await store.readFeature('UserController');
    assert.ok(memory);
    assert.equal(memory?.api.endpoints?.length, 3);
    assert.equal(memory?.api.endpoints?.[0].method, 'GET');
    assert.equal(memory?.api.endpoints?.[0].path, '/api/users/:id');
  });
});

test('executeRecordMemory handles different confirmation and review statuses', async () => {
  await withTempProjects(async (projectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const recordArgs: RecordMemoryInput = {
      name: 'LegacyModule',
      responsibility: '旧系统兼容模块',
      dir: 'src/legacy/',
      confirmationStatus: 'agent-inferred',
      reviewStatus: 'needs-review',
      reviewReason: '需要确认是否可以废弃',
      reviewMarkedAt: '2026-04-14T10:00:00Z',
    };

    const response = await executeRecordMemory(recordArgs, projectRoot);
    assert.equal(response.content[0].type, 'text');
    assert.match(response.content[0].text, /agent-inferred/);
    assert.match(response.content[0].text, /needs-review/);
    assert.match(response.content[0].text, /需要确认是否可以废弃/);

    const store = new MemoryStore(projectRoot);
    const memory = await store.readFeature('LegacyModule');
    assert.ok(memory);
    assert.equal(memory?.confirmationStatus, 'agent-inferred');
    assert.equal(memory?.reviewStatus, 'needs-review');
    assert.equal(memory?.reviewReason, '需要确认是否可以废弃');
  });
});

test('executeFindMemory finds existing feature memories', async () => {
  await withTempProjects(async (projectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    // First record a memory
    await executeRecordMemory({
      name: 'SearchService',
      responsibility: '处理检索流程和上下文打包',
      dir: 'src/search/',
      files: ['SearchService.ts'],
      exports: ['SearchService'],
    }, projectRoot);

    // Then find it
    const findArgs: FindMemoryInput = {
      query: 'SearchService',
      format: 'json',
    };

    const response = await executeFindMemory(findArgs, projectRoot);
    assert.equal(response.content[0].type, 'text');

    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.tool, 'find_memory');
    assert.equal(payload.result_count, 1);
    assert.equal(payload.results[0].memory.name, 'SearchService');
  });
});

test('executeFindMemory returns suggestions when no memories found', async () => {
  await withTempProjects(async (projectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const findArgs: FindMemoryInput = {
      query: 'NonExistentModule',
      format: 'json',
    };

    const response = await executeFindMemory(findArgs, projectRoot);
    assert.equal(response.content[0].type, 'text');
    assert.match(response.content[0].text, /未找到.*NonExistentModule/);
    assert.match(response.content[0].text, /suggest_memory/);
    assert.match(response.content[0].text, /record_memory/);
  });
});

test('executeFindMemory handles text format responses', async () => {
  await withTempProjects(async (projectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    await executeRecordMemory({
      name: 'AuthService',
      responsibility: '用户认证和授权',
      dir: 'src/auth/',
      files: ['AuthService.ts'],
      exports: ['AuthService'],
    }, projectRoot);

    const findArgs: FindMemoryInput = {
      query: 'AuthService',
      format: 'text',
    };

    const response = await executeFindMemory(findArgs, projectRoot);
    assert.equal(response.content[0].type, 'text');
    assert.match(response.content[0].text, /Found 1 feature memories/);
    assert.match(response.content[0].text, /AuthService/);
    assert.match(response.content[0].text, /用户认证和授权/);
  });
});

test('executeRecordDecision records decision with all fields', async () => {
  await withTempProjects(async (projectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const decisionArgs: RecordDecisionInput = {
      id: 'DEC-2026-001',
      title: '采用 TypeScript 重构前端代码',
      context: '现有 JavaScript 代码缺乏类型检查，维护困难',
      decision: '使用 TypeScript 逐步重构所有前端模块',
      owner: '前端团队',
      reviewer: '技术委员会',
      alternatives: [
        {
          name: '继续使用 JavaScript',
          pros: ['无需重构', '团队熟悉'],
          cons: ['缺乏类型检查', '维护成本高'],
        },
        {
          name: '使用 Flow',
          pros: ['渐进式类型检查'],
          cons: ['生态较小', '学习成本'],
        },
      ],
      rationale: 'TypeScript 提供更好的类型安全和开发体验，生态成熟',
      consequences: [
        '开发效率提升',
        '运行时错误减少',
        '需要团队培训',
      ],
    };

    const response = await executeRecordDecision(decisionArgs, projectRoot);
    assert.equal(response.content[0].type, 'text');
    assert.match(response.content[0].text, /Decision Recorded/);
    assert.match(response.content[0].text, /DEC-2026-001/);
    assert.match(response.content[0].text, /采用 TypeScript 重构前端代码/);

    const store = new MemoryStore(projectRoot);
    const decision = await store.readDecision('DEC-2026-001');
    assert.ok(decision);
    assert.equal(decision?.id, 'DEC-2026-001');
    assert.equal(decision?.title, '采用 TypeScript 重构前端代码');
    assert.equal(decision?.owner, '前端团队');
    assert.equal(decision?.reviewer, '技术委员会');
    assert.equal(decision?.alternatives?.length, 2);
  });
});

test('executeRecordDecision records decision with minimal fields', async () => {
  await withTempProjects(async (projectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const decisionArgs: RecordDecisionInput = {
      id: 'DEC-2026-002',
      title: '使用 PostgreSQL 作为主数据库',
      context: '需要支持复杂查询和事务',
      decision: '部署 PostgreSQL 集群',
      rationale: 'PostgreSQL 提供强大的 SQL 支持和 ACID 事务',
    };

    const response = await executeRecordDecision(decisionArgs, projectRoot);
    assert.equal(response.content[0].type, 'text');
    assert.match(response.content[0].text, /Decision Recorded/);
    assert.match(response.content[0].text, /DEC-2026-002/);
    assert.match(response.content[0].text, /PostgreSQL/);

    const store = new MemoryStore(projectRoot);
    const decision = await store.readDecision('DEC-2026-002');
    assert.ok(decision);
    assert.equal(decision?.id, 'DEC-2026-002');
    assert.equal(decision?.title, '使用 PostgreSQL 作为主数据库');
    assert.equal(decision?.status, 'accepted');
  });
});

test('executeRecordDecision includes evidence references when provided', async () => {
  await withTempProjects(async (projectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const decisionArgs: RecordDecisionInput = {
      id: 'DEC-2026-003',
      title: '采用微服务架构',
      context: '单体应用难以扩展',
      decision: '拆分为多个微服务',
      rationale: '提高系统可扩展性和团队自治',
      evidenceRefs: ['ARCH-001', 'PERF-042'],
    };

    const response = await executeRecordDecision(decisionArgs, projectRoot);
    assert.equal(response.content[0].type, 'text');
    assert.match(response.content[0].text, /Decision Recorded/);

    const store = new MemoryStore(projectRoot);
    const decision = await store.readDecision('DEC-2026-003');
    assert.ok(decision);
    assert.deepEqual(decision?.evidenceRefs, ['ARCH-001', 'PERF-042']);
  });
});