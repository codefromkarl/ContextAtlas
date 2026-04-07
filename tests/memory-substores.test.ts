import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DecisionStore } from '../src/memory/DecisionStore.ts';
import { MemoryHubDatabase } from '../src/memory/MemoryHubDatabase.ts';
import { MemoryStoreBootstrap } from '../src/memory/MemoryStoreBootstrap.ts';
import { LongTermMemoryService } from '../src/memory/LongTermMemoryService.ts';
import { ProjectMetaStore } from '../src/memory/ProjectMetaStore.ts';
import type { MemoryCatalog } from '../src/memory/types.ts';

function withTempHub(
  run: (input: {
    tempDir: string;
    projectRoot: string;
    projectId: string;
    globalProjectId: string;
    hub: MemoryHubDatabase;
  }) => Promise<void>,
): Promise<void> {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cw-memory-substores-'));
  const projectRoot = path.join(tempDir, 'project');
  const dbPath = path.join(tempDir, 'memory-hub.db');
  mkdirSync(projectRoot, { recursive: true });
  const hub = new MemoryHubDatabase(dbPath);
  const projectId = hub.ensureProject({ path: projectRoot, name: 'project' }).id;
  const globalProjectId = hub.ensureProject({
    path: 'contextatlas://agent-memory/global-user',
    name: 'ContextAtlas Global User Memory',
  }).id;

  return (async () => {
    try {
      await run({ tempDir, projectRoot, projectId, globalProjectId, hub });
    } finally {
      hub.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  })();
}

test('ProjectMetaStore can save and load catalog, globals, and checkpoints', async () => {
  await withTempHub(async ({ projectRoot, projectId, hub }) => {
    const store = new ProjectMetaStore({
      hub,
      projectId,
      projectRoot,
    });

    const catalog: MemoryCatalog = {
      version: 1,
      globalMemoryFiles: ['profile'],
      modules: {},
      scopes: {},
    };

    await store.saveCatalog(catalog);
    const loadedCatalog = await store.readCatalog();
    assert.deepEqual(loadedCatalog, catalog);

    await store.saveGlobal('profile', {
      name: 'ContextAtlas',
      description: 'Semantic retrieval',
    });
    const profile = await store.readGlobal('profile');
    assert.equal(profile?.type, 'profile');
    assert.equal((profile?.data as { name: string }).name, 'ContextAtlas');

    await store.saveCheckpoint({
      id: 'chk_meta',
      repoPath: projectRoot,
      title: 'Meta checkpoint',
      goal: 'Verify project meta extraction',
      phase: 'overview',
      summary: 'ProjectMetaStore persists project-level metadata',
      activeBlockIds: ['block:meta'],
      exploredRefs: ['src/memory/ProjectMetaStore.ts:L1-L20'],
      keyFindings: ['Catalog and checkpoints share meta storage'],
      unresolvedQuestions: [],
      nextSteps: ['Extract long-term memory service'],
      createdAt: '2026-04-07T10:00:00.000Z',
      updatedAt: '2026-04-07T10:00:00.000Z',
    });

    const checkpoint = await store.readCheckpoint('chk_meta');
    assert.ok(checkpoint);
    assert.equal(checkpoint?.title, 'Meta checkpoint');

    const listed = await store.listCheckpoints();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, 'chk_meta');
  });
});

test('LongTermMemoryService can merge project and global-user memories and prune stale items', async () => {
  await withTempHub(async ({ projectId, globalProjectId, hub }) => {
    const service = new LongTermMemoryService({
      hub,
      resolveScopeProjectId: async (scope) => (scope === 'project' ? projectId : globalProjectId),
    });

    const created = await service.append({
      type: 'feedback',
      title: '提交前先跑测试',
      summary: '提交代码前先运行完整测试',
      tags: ['test'],
      scope: 'project',
      source: 'user-explicit',
      confidence: 1,
      lastVerifiedAt: '2020-01-01',
    });
    assert.equal(created.action, 'created');

    const merged = await service.append({
      type: 'feedback',
      title: '提交前先跑测试',
      summary: '提交代码前先运行完整测试',
      tags: ['ci'],
      scope: 'project',
      source: 'tool-result',
      confidence: 0.6,
    });
    assert.equal(merged.action, 'merged');
    assert.deepEqual(merged.memory.tags.sort(), ['ci', 'test']);

    await service.append({
      type: 'user',
      title: '偏好简短解释',
      summary: '用户更偏好简短直接的解释',
      tags: ['style'],
      scope: 'global-user',
      source: 'user-explicit',
      confidence: 1,
      lastVerifiedAt: '2099-01-01',
    });

    const found = await service.find('简短', {
      types: ['user'],
      scope: 'global-user',
    });
    assert.equal(found.length, 1);
    assert.equal(found[0]?.memory.scope, 'global-user');

    const pruned = await service.prune({
      types: ['feedback'],
      scope: 'project',
      includeStale: true,
      staleDays: 30,
      dryRun: false,
    });
    assert.equal(pruned.prunedCount, 1);

    const remaining = await service.list({
      types: ['feedback'],
      scope: 'project',
      includeExpired: true,
    });
    assert.equal(remaining.length, 0);
  });
});

test('DecisionStore can save, read, and list decisions with reviewer metadata', async () => {
  await withTempHub(async ({ projectId, hub }) => {
    const store = new DecisionStore({
      hub,
      projectId,
    });

    const savedTo = await store.save({
      id: '2026-04-split-memory-store',
      date: '2026-04-07',
      reviewer: 'search-lead',
      title: 'Extract DecisionStore',
      context: 'MemoryStore still owns decision CRUD and JSON mapping logic',
      decision: 'Move decision persistence into a dedicated sub-store',
      alternatives: [
        {
          name: 'keep in MemoryStore',
          pros: ['fewer files'],
          cons: ['facade stays too fat'],
        },
      ],
      rationale: 'Decision CRUD is a stable project-level boundary',
      consequences: ['MemoryStore becomes a thinner facade'],
      status: 'accepted',
    });
    assert.match(savedTo, /decision=2026-04-split-memory-store/);

    const loaded = await store.read('2026-04-split-memory-store');
    assert.equal(loaded?.reviewer, 'search-lead');
    assert.equal(loaded?.alternatives[0]?.name, 'keep in MemoryStore');

    await store.save({
      id: '2026-04-search-pipeline',
      date: '2026-04-06',
      title: 'Keep SearchService as facade',
      context: 'SearchService already delegates recall and rerank helpers',
      decision: 'Do not split orchestration further for now',
      alternatives: [],
      rationale: 'Current seams are good enough',
      consequences: ['Prefer stability over more file splits'],
      status: 'accepted',
    });

    const listed = await store.list();
    assert.equal(listed.length, 2);
    assert.equal(listed[0]?.id, '2026-04-split-memory-store');
    assert.equal(listed[1]?.id, '2026-04-search-pipeline');
  });
});

test('MemoryStoreBootstrap keeps read-only init side-effect free and writable init registers the project', async () => {
  await withTempHub(async ({ tempDir, hub }) => {
    const projectRoot = path.join(tempDir, 'unregistered-project');
    const bootstrap = new MemoryStoreBootstrap({
      hub,
      projectRoot,
      projectName: 'project',
      initialProjectId: 'temp-project-id',
      catalogMetaKey: 'catalog',
      globalMetaPrefix: 'global:',
    });

    await bootstrap.initializeReadOnly();
    assert.equal(hub.listProjects().length, 2);
    assert.equal(hub.getProjectByPath(projectRoot)?.id, undefined);

    await bootstrap.initializeWritable();
    assert.equal(hub.listProjects().length, 3);
    const registered = hub.getProjectByPath(projectRoot);
    assert.ok(registered);
    assert.equal(bootstrap.getProjectId(), registered?.id);
  });
});
