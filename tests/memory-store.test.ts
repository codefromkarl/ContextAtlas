import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MemoryHubDatabase } from '../src/memory/MemoryHubDatabase.ts';
import { MemoryStore } from '../src/memory/MemoryStore.ts';

function withTempProject(
  run: (projectRoot: string, dbPath: string) => Promise<void>,
): Promise<void> {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cw-memory-store-'));
  const projectRoot = path.join(tempDir, 'project');
  const dbPath = path.join(tempDir, 'memory-hub.db');

  return (async () => {
    try {
      await run(projectRoot, dbPath);
    } finally {
      MemoryStore.resetSharedHubForTests();
      rmSync(tempDir, { recursive: true, force: true });
    }
  })();
}

test('read-only MemoryStore operations do not auto-register project rows', async () => {
  await withTempProject(async (projectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));
    const store = new MemoryStore(projectRoot);

    const profile = await store.readProfile();

    assert.equal(profile, null);

    const db = new MemoryHubDatabase(dbPath);
    try {
      assert.equal(db.listProjects().length, 0);
    } finally {
      db.close();
    }
  });
});


test('MemoryStore can save, read, and list task checkpoints', async () => {
  await withTempProject(async (projectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));
    const store = new MemoryStore(projectRoot);

    await store.saveCheckpoint({
      id: 'chk_overview',
      repoPath: projectRoot,
      title: 'Overview checkpoint',
      goal: 'Understand retrieval flow',
      phase: 'overview',
      summary: 'Captured current understanding of retrieval flow',
      activeBlockIds: ['block:1'],
      exploredRefs: ['src/search/SearchService.ts:L1-L20'],
      keyFindings: ['SearchService orchestrates recall and pack'],
      unresolvedQuestions: ['How should expansion candidates be ranked?'],
      nextSteps: ['Inspect GraphExpander'],
      createdAt: '2026-04-07T10:00:00.000Z',
      updatedAt: '2026-04-07T10:00:00.000Z',
    });

    const loaded = await store.readCheckpoint('chk_overview');
    assert.ok(loaded);
    assert.equal(loaded?.title, 'Overview checkpoint');
    assert.equal(loaded?.phase, 'overview');

    const listed = await store.listCheckpoints();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, 'chk_overview');
  });
});
