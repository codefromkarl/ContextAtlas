import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initDb } from '../src/db/index.ts';
import { analyzeIndexHealth } from '../src/monitoring/indexHealth.ts';
import { commitSnapshot, prepareWritableSnapshot } from '../src/storage/layout.ts';
import { VectorStore } from '../src/vectorStore/index.ts';

function createTempBaseDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cw-index-health-test-'));
}

test('analyzeIndexHealth reports degraded chunk FTS coverage when vector chunks exist but chunks_fts is empty', async () => {
  const baseDir = createTempBaseDir();
  process.env.CONTEXTATLAS_BASE_DIR = baseDir;
  const projectId = 'proj-chunk-fts-gap';

  const prepared = prepareWritableSnapshot(projectId, baseDir);
  const db = initDb(projectId, prepared.snapshotId);
  db.prepare(
    'INSERT INTO files(path, hash, mtime, size, content, language, vector_index_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run('src/a.ts', 'h1', Date.now(), 10, 'export const a = 1;', 'typescript', 'h1');
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
          display_code: 'export const a = 1;',
          vector_text: '// Context: src/a.ts\nexport const a = 1;',
          language: 'typescript',
          breadcrumb: 'src/a.ts',
          start_index: 0,
          end_index: 10,
          raw_start: 0,
          raw_end: 10,
          vec_start: 0,
          vec_end: 10,
        },
      ],
    },
  ]);
  await vectorStore.close();

  commitSnapshot(projectId, prepared.snapshotId, baseDir);

  const report = await analyzeIndexHealth({
    baseDir,
    projectIds: [projectId],
  });

  assert.equal(report.snapshots[0].hasChunksFts, true);
  assert.equal(report.snapshots[0].chunkFtsCount, 0);
  assert.equal(report.snapshots[0].vectorChunkCount, 1);
  assert.equal(report.snapshots[0].chunkFtsCoverage, 0);
  assert.equal(report.overall.status, 'degraded');
  assert.ok(report.overall.issues.some((issue) => issue.includes('chunk FTS 覆盖不足')));
  assert.ok(report.overall.recommendations.some((rec) => rec.includes('重新索引')));
});
