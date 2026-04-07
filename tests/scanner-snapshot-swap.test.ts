import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { generateProjectId } from '../src/db/index.ts';
import { type ScanStats, scanWithSnapshotSwap } from '../src/scanner/index.ts';
import { resolveCurrentSnapshotId } from '../src/storage/layout.ts';

function createTempBaseDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cw-scan-swap-'));
}

function snapshotRoot(baseDir: string, projectId: string): string {
  return path.join(baseDir, projectId, 'snapshots');
}

test('scanWithSnapshotSwap 在 noop 计划下不创建新快照', async () => {
  const baseDir = createTempBaseDir();
  const repoRoot = path.join(baseDir, 'repo');
  fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'src', 'auth.ts'), 'export function login() { return 1; }\n');

  const previousBaseDir = process.env.CONTEXTATLAS_BASE_DIR;
  process.env.CONTEXTATLAS_BASE_DIR = baseDir;

  try {
    await scanWithSnapshotSwap(repoRoot, { vectorIndex: false });

    const projectId = generateProjectId(repoRoot);
    const currentSnapshotId = resolveCurrentSnapshotId(projectId, baseDir);
    assert.ok(currentSnapshotId);

    const beforeSnapshots = fs.readdirSync(snapshotRoot(baseDir, projectId)).sort();
    const noopStats: ScanStats = {
      totalFiles: 1,
      added: 0,
      modified: 0,
      unchanged: 1,
      deleted: 0,
      skipped: 0,
      errors: 0,
    };

    const stats = await scanWithSnapshotSwap(repoRoot, {
      vectorIndex: false,
      noopStats,
    });

    assert.equal(resolveCurrentSnapshotId(projectId, baseDir), currentSnapshotId);
    assert.deepEqual(fs.readdirSync(snapshotRoot(baseDir, projectId)).sort(), beforeSnapshots);
    assert.deepEqual(stats, noopStats);
  } finally {
    if (previousBaseDir === undefined) {
      delete process.env.CONTEXTATLAS_BASE_DIR;
    } else {
      process.env.CONTEXTATLAS_BASE_DIR = previousBaseDir;
    }
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});
