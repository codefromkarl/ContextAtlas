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
