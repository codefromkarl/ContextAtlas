import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

function createTempBaseDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cw-cleanup-stale-'));
}

async function waitForAsyncLogWrites(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

test('cleanupStaleIndexes removes directories without current or snapshots', async () => {
  const baseDir = createTempBaseDir();
  process.env.CONTEXTATLAS_BASE_DIR = baseDir;

  try {
    // 活跃项目：有 current 指针
    const activeId = 'proj-active';
    fs.mkdirSync(path.join(baseDir, activeId, 'snapshots', 'snap-1'), { recursive: true });
    fs.writeFileSync(path.join(baseDir, activeId, 'current'), 'snap-1');
    fs.writeFileSync(path.join(baseDir, activeId, 'snapshots', 'snap-1', 'index.db'), '');

    // 幽灵项目：只有 index.db，无 current 和 snapshots
    const stale1 = 'proj-stale-1';
    fs.mkdirSync(path.join(baseDir, stale1), { recursive: true });
    fs.writeFileSync(path.join(baseDir, stale1, 'index.db'), 'old data');

    const stale2 = 'proj-stale-2';
    fs.mkdirSync(path.join(baseDir, stale2), { recursive: true });
    fs.writeFileSync(path.join(baseDir, stale2, 'index.db'), 'old data');
    fs.writeFileSync(path.join(baseDir, stale2, 'index.db-shm'), '');

    // 空目录（不是项目）
    fs.mkdirSync(path.join(baseDir, 'not-a-project'), { recursive: true });

    const { cleanupStaleIndexes } = await import('../src/monitoring/indexHealth.js');
    const result = cleanupStaleIndexes({ baseDir });

    assert.equal(result.scanned, 4); // active + stale1 + stale2 + not-a-project
    assert.equal(result.staleCount, 2);
    assert.equal(result.removedCount, 2);
    assert.ok(result.freedBytes > 0);
    assert.ok(fs.existsSync(path.join(baseDir, activeId)), 'active project should be preserved');
    assert.ok(!fs.existsSync(path.join(baseDir, stale1)), 'stale1 should be removed');
    assert.ok(!fs.existsSync(path.join(baseDir, stale2)), 'stale2 should be removed');
    assert.ok(fs.existsSync(path.join(baseDir, 'not-a-project')), 'empty dir should be preserved');
  } finally {
    delete process.env.CONTEXTATLAS_BASE_DIR;
    await waitForAsyncLogWrites();
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('cleanupStaleIndexes dry-run does not delete anything', async () => {
  const baseDir = createTempBaseDir();
  process.env.CONTEXTATLAS_BASE_DIR = baseDir;

  try {
    const staleId = 'proj-stale-dry';
    fs.mkdirSync(path.join(baseDir, staleId), { recursive: true });
    fs.writeFileSync(path.join(baseDir, staleId, 'index.db'), 'old data');

    const { cleanupStaleIndexes } = await import('../src/monitoring/indexHealth.js');
    const result = cleanupStaleIndexes({ baseDir, dryRun: true });

    assert.equal(result.staleCount, 1);
    assert.equal(result.removedCount, 0);
    assert.equal(result.freedBytes, 0);
    assert.ok(fs.existsSync(path.join(baseDir, staleId)), 'dry-run should not delete');
  } finally {
    delete process.env.CONTEXTATLAS_BASE_DIR;
    await waitForAsyncLogWrites();
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('cleanupStaleIndexes preserves projects with snapshots directory', async () => {
  const baseDir = createTempBaseDir();
  process.env.CONTEXTATLAS_BASE_DIR = baseDir;

  try {
    // 有 snapshots 但没有 current（例如 snapshot 刚删除但目录还在）
    const snapOnly = 'proj-snap-only';
    fs.mkdirSync(path.join(baseDir, snapOnly, 'snapshots'), { recursive: true });
    fs.writeFileSync(path.join(baseDir, snapOnly, 'index.db'), 'data');

    const { cleanupStaleIndexes } = await import('../src/monitoring/indexHealth.js');
    const result = cleanupStaleIndexes({ baseDir });

    assert.equal(result.staleCount, 0);
    assert.equal(result.removedCount, 0);
    assert.ok(fs.existsSync(path.join(baseDir, snapOnly)), 'project with snapshots should be preserved');
  } finally {
    delete process.env.CONTEXTATLAS_BASE_DIR;
    await waitForAsyncLogWrites();
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});
