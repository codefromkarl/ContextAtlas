import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  commitSnapshot,
  hasIndexedData,
  pruneSnapshots,
  prepareWritableSnapshot,
  type SnapshotCopyMode,
  resolveCurrentSnapshotId,
  resolveIndexPaths,
  validateSnapshot,
} from '../src/storage/layout.ts';

function createTempBaseDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cw-layout-test-'));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('空项目可创建 staging 快照并原子切换为 current', () => {
  const baseDir = createTempBaseDir();
  const projectId = 'proj-empty';

  assert.equal(hasIndexedData(projectId, baseDir), false);

  const prepared = prepareWritableSnapshot(projectId, baseDir);
  assert.equal(prepared.source, 'empty');
  assert.ok(fs.existsSync(prepared.snapshotDir));

  commitSnapshot(projectId, prepared.snapshotId, baseDir);
  assert.equal(resolveCurrentSnapshotId(projectId, baseDir), prepared.snapshotId);
  assert.equal(hasIndexedData(projectId, baseDir), false);
});

test('存在 legacy 索引时，staging 快照会复制 legacy 数据', () => {
  const baseDir = createTempBaseDir();
  const projectId = 'proj-legacy';
  const legacyPaths = resolveIndexPaths(projectId, { baseDir, snapshotId: null });

  fs.mkdirSync(path.dirname(legacyPaths.dbPath), { recursive: true });
  fs.writeFileSync(legacyPaths.dbPath, 'legacy-db');
  fs.mkdirSync(legacyPaths.vectorPath, { recursive: true });
  fs.writeFileSync(path.join(legacyPaths.vectorPath, 'marker.txt'), 'legacy-vector');

  assert.equal(hasIndexedData(projectId, baseDir), true);

  const prepared = prepareWritableSnapshot(projectId, baseDir);
  assert.equal(prepared.source, 'legacy');
  assert.equal(fs.readFileSync(path.join(prepared.snapshotDir, 'index.db'), 'utf-8'), 'legacy-db');
  assert.equal(
    fs.readFileSync(path.join(prepared.snapshotDir, 'vectors.lance', 'marker.txt'), 'utf-8'),
    'legacy-vector',
  );
  assert.ok(prepared.copyMode === 'copy' || prepared.copyMode === 'reflink');
});

test('存在 current 快照时，新的 staging 快照从 current 复制', () => {
  const baseDir = createTempBaseDir();
  const projectId = 'proj-current';

  const first = prepareWritableSnapshot(projectId, baseDir);
  fs.writeFileSync(path.join(first.snapshotDir, 'index.db'), 'current-db');
  fs.mkdirSync(path.join(first.snapshotDir, 'vectors.lance'), { recursive: true });
  fs.writeFileSync(path.join(first.snapshotDir, 'vectors.lance', 'seed.txt'), 'seed');
  commitSnapshot(projectId, first.snapshotId, baseDir);

  const second = prepareWritableSnapshot(projectId, baseDir);
  assert.equal(second.source, 'current');
  assert.equal(fs.readFileSync(path.join(second.snapshotDir, 'index.db'), 'utf-8'), 'current-db');
  assert.equal(
    fs.readFileSync(path.join(second.snapshotDir, 'vectors.lance', 'seed.txt'), 'utf-8'),
    'seed',
  );
  assert.ok(second.copyMode === 'copy' || second.copyMode === 'reflink');
});

test('reflink-preferred 在文件复制失败时回退到普通复制', () => {
  const baseDir = createTempBaseDir();
  const projectId = 'proj-reflink-fallback';
  const legacyPaths = resolveIndexPaths(projectId, { baseDir, snapshotId: null });

  fs.mkdirSync(path.dirname(legacyPaths.dbPath), { recursive: true });
  fs.writeFileSync(legacyPaths.dbPath, 'legacy-db');
  fs.mkdirSync(legacyPaths.vectorPath, { recursive: true });
  fs.writeFileSync(path.join(legacyPaths.vectorPath, 'marker.txt'), 'legacy-vector');

  const calls: SnapshotCopyMode[] = [];
  const prepared = prepareWritableSnapshot(projectId, baseDir, {
    copyStrategy: 'reflink-preferred',
    fileCopier: (source, target, mode) => {
      calls.push(mode);
      if (mode === 'reflink') {
        throw new Error(`reflink unsupported for ${path.basename(source)}`);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    },
  });

  assert.equal(prepared.source, 'legacy');
  assert.equal(prepared.copyMode, 'copy');
  assert.deepEqual(calls, ['reflink', 'copy', 'reflink', 'copy']);
  assert.equal(fs.readFileSync(path.join(prepared.snapshotDir, 'index.db'), 'utf-8'), 'legacy-db');
  assert.equal(
    fs.readFileSync(path.join(prepared.snapshotDir, 'vectors.lance', 'marker.txt'), 'utf-8'),
    'legacy-vector',
  );
});

test('健康检查：向量索引未收敛时阻止提交', async () => {
  const baseDir = createTempBaseDir();
  const projectId = 'proj-health';

  const prepared = prepareWritableSnapshot(projectId, baseDir);
  const dbPath = path.join(prepared.snapshotDir, 'index.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE files (
      path TEXT PRIMARY KEY,
      hash TEXT NOT NULL,
      vector_index_hash TEXT
    );
    INSERT INTO files(path, hash, vector_index_hash) VALUES ('a.ts', 'h1', NULL);
  `);
  db.close();
  fs.mkdirSync(path.join(prepared.snapshotDir, 'vectors.lance'), { recursive: true });

  await assert.rejects(
    () => validateSnapshot(projectId, prepared.snapshotId, { baseDir, expectVectorIndex: true }),
    /vector_index_hash/,
  );
});

test('健康检查：索引收敛且可读取时通过', async () => {
  const baseDir = createTempBaseDir();
  const projectId = 'proj-health-ok';

  const prepared = prepareWritableSnapshot(projectId, baseDir);
  const dbPath = path.join(prepared.snapshotDir, 'index.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE files (
      path TEXT PRIMARY KEY,
      hash TEXT NOT NULL,
      vector_index_hash TEXT
    );
    INSERT INTO files(path, hash, vector_index_hash) VALUES ('a.ts', 'h1', 'h1');
  `);
  db.close();
  fs.mkdirSync(path.join(prepared.snapshotDir, 'vectors.lance'), { recursive: true });

  await validateSnapshot(projectId, prepared.snapshotId, { baseDir, expectVectorIndex: true });
});

test('快照清理：保留 current 与最近 N 个快照', () => {
  const baseDir = createTempBaseDir();
  const projectId = 'proj-prune';

  const first = prepareWritableSnapshot(projectId, baseDir);
  fs.writeFileSync(path.join(first.snapshotDir, 'index.db'), 'v1');
  fs.utimesSync(first.snapshotDir, new Date('2023-01-01T00:00:00.000Z'), new Date('2023-01-01T00:00:00.000Z'));
  commitSnapshot(projectId, first.snapshotId, baseDir);

  const second = prepareWritableSnapshot(projectId, baseDir);
  fs.writeFileSync(path.join(second.snapshotDir, 'index.db'), 'v2');
  fs.utimesSync(second.snapshotDir, new Date('2024-01-01T00:00:00.000Z'), new Date('2024-01-01T00:00:00.000Z'));
  const third = prepareWritableSnapshot(projectId, baseDir);
  fs.writeFileSync(path.join(third.snapshotDir, 'index.db'), 'v3');
  fs.utimesSync(third.snapshotDir, new Date('2025-01-02T00:00:00.000Z'), new Date('2025-01-02T00:00:00.000Z'));

  const result = pruneSnapshots(projectId, 1, baseDir);
  assert.equal(resolveCurrentSnapshotId(projectId, baseDir), first.snapshotId);
  assert.ok(result.kept.includes(first.snapshotId));
  assert.ok(result.kept.includes(third.snapshotId));
  assert.ok(result.deleted.includes(second.snapshotId));
});

test('并发语义：写 staging 时读者持续读 current，切换后读到新版本', async () => {
  const baseDir = createTempBaseDir();
  const projectId = 'proj-concurrent';

  const first = prepareWritableSnapshot(projectId, baseDir);
  fs.writeFileSync(path.join(first.snapshotDir, 'index.db'), 'v1');
  commitSnapshot(projectId, first.snapshotId, baseDir);

  const next = prepareWritableSnapshot(projectId, baseDir);
  fs.writeFileSync(path.join(next.snapshotDir, 'index.db'), 'v2');

  let committed = false;
  const observations: Array<{ value: string; committed: boolean }> = [];

  const writer = (async () => {
    await sleep(80);
    commitSnapshot(projectId, next.snapshotId, baseDir);
    committed = true;
  })();

  const reader = (async () => {
    for (let i = 0; i < 10; i++) {
      const current = resolveIndexPaths(projectId, { baseDir });
      observations.push({
        value: fs.readFileSync(current.dbPath, 'utf-8'),
        committed,
      });
      await sleep(20);
    }
  })();

  await Promise.all([writer, reader]);
  assert.ok(observations.some((o) => o.committed && o.value === 'v2'));
  assert.ok(observations.filter((o) => !o.committed).every((o) => o.value === 'v1'));
});
