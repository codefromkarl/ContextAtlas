import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { initDb } from '../src/db/index.ts';
import { prepareWritableSnapshot, commitSnapshot } from '../src/storage/layout.ts';
import { VectorStore } from '../src/vectorStore/index.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function createTempBaseDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cw-fts-rebuild-test-'));
}

test('fts:rebuild-chunks rebuilds chunk FTS entries from vector index', async () => {
  const baseDir = createTempBaseDir();
  process.env.CONTEXTATLAS_BASE_DIR = baseDir;
  const projectRoot = path.join(baseDir, 'repo');
  fs.mkdirSync(projectRoot, { recursive: true });

  const projectId = 'proj-fts-rebuild';
  const prepared = prepareWritableSnapshot(projectId, baseDir);
  const db = initDb(projectId, prepared.snapshotId);
  db.prepare(
    'INSERT INTO files(path, hash, mtime, size, content, language, vector_index_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run('src/a.ts', 'h1', Date.now(), 20, 'export const alpha = 1;', 'typescript', 'h1');
  db.exec('DELETE FROM chunks_fts');
  db.close();

  const vectorStore = new VectorStore(projectId, 1024, prepared.snapshotId);
  await vectorStore.init();
  await vectorStore.batchUpsertFiles([
    {
      path: 'src/a.ts',
      hash: 'h1',
      records: [
        {
          chunk_id: 'src/a.ts#h1#0',
          file_path: 'src/a.ts',
          file_hash: 'h1',
          chunk_index: 0,
          vector: Array.from({ length: 1024 }, () => 0),
          display_code: 'export const alpha = 1;',
          vector_text: '// Context: src/a.ts\nexport const alpha = 1;',
          language: 'typescript',
          breadcrumb: 'src/a.ts',
          start_index: 0,
          end_index: 20,
          raw_start: 0,
          raw_end: 20,
          vec_start: 0,
          vec_end: 20,
        },
      ],
    },
  ]);
  await vectorStore.close();
  commitSnapshot(projectId, prepared.snapshotId, baseDir);

  const result = spawnSync(
    'node',
    [path.join(REPO_ROOT, 'dist/index.js'), 'fts:rebuild-chunks', '--project-id', projectId],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        CONTEXTATLAS_BASE_DIR: baseDir,
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout + result.stderr, /chunks_fts 已重建|chunk FTS/);

  const verifyDb = initDb(projectId, prepared.snapshotId);
  const count = (verifyDb.prepare('SELECT COUNT(*) as c FROM chunks_fts').get() as { c: number }).c;
  const row = verifyDb
    .prepare('SELECT file_path, chunk_index, breadcrumb, content FROM chunks_fts LIMIT 1')
    .get() as {
    file_path: string;
    chunk_index: number;
    breadcrumb: string;
    content: string;
  };
  verifyDb.close();

  assert.equal(count, 1);
  assert.equal(row.file_path, 'src/a.ts');
  assert.equal(row.chunk_index, 0);
  assert.match(row.content, /alpha/);
});
