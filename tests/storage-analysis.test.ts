import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initDb } from '../src/db/index.ts';
import { Indexer } from '../src/indexer/index.ts';
import {
  analyzeStorageRedundancy,
  formatStorageRedundancyReport,
} from '../src/monitoring/storageAnalysis.ts';
import { closeAllVectorStores, VectorStore } from '../src/vectorStore/index.ts';

function createTempBaseDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cw-storage-analysis-test-'));
}

test('analyzeStorageRedundancy quantifies sqlite/fts/vector text payloads', async () => {
  const baseDir = createTempBaseDir();
  process.env.CONTEXTATLAS_BASE_DIR = baseDir;
  const projectId = 'proj-storage-report';
  const db = initDb(projectId);

  db.prepare(
    'INSERT INTO files(path, hash, mtime, size, content, language, vector_index_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run('src/a.ts', 'h1', 1, 12, 'export const a = 1;', 'typescript', 'h1');
  db.prepare('INSERT INTO files_fts(path, content) VALUES (?, ?)').run(
    'src/a.ts',
    'export const a = 1;',
  );
  db.prepare(
    'INSERT INTO chunks_fts(chunk_id, file_path, chunk_index, breadcrumb, content) VALUES (?, ?, ?, ?, ?)',
  ).run('src/a.ts#h1#0', 'src/a.ts', 0, 'src/a.ts', 'src/a.ts\nexport const a = 1;');

  const store = new VectorStore(projectId, 3);
  await store.init();
  await store.batchUpsertFiles([
    {
      path: 'src/a.ts',
      hash: 'h1',
      records: [
        {
          chunk_id: 'src/a.ts#h1#0',
          file_path: 'src/a.ts',
          file_hash: 'h1',
          chunk_index: 0,
          vector: [0, 0, 0],
          display_code: 'export const a = 1;',
          vector_text: '// Context: src/a.ts\nexport const a = 1;',
          language: 'typescript',
          breadcrumb: 'src/a.ts',
          start_index: 0,
          end_index: 18,
          raw_start: 0,
          raw_end: 18,
          vec_start: 0,
          vec_end: 18,
        },
      ],
    },
  ]);

  const report = await analyzeStorageRedundancy({ projectId, baseDir });

  assert.equal(report.projectId, projectId);
  assert.equal(report.sqlite.files.rows, 1);
  assert.equal(report.sqlite.filesFts.rows, 1);
  assert.equal(report.sqlite.chunksFts.rows, 1);
  assert.equal(report.vectorStore.rows, 1);
  assert.ok(report.sqlite.files.contentBytes > 0);
  assert.ok(report.sqlite.filesFts.contentBytes > 0);
  assert.ok(report.sqlite.chunksFts.contentBytes > 0);
  assert.ok(report.vectorStore.displayCodeBytes > 0);
  assert.ok(report.vectorStore.vectorTextBytes > 0);
  assert.ok(report.recommendations.some((item) => item.id === 'trim-vector-text'));

  const text = formatStorageRedundancyReport(report);
  assert.match(text, /Storage Redundancy Report/);
  assert.match(text, /vector_text/);
  assert.match(text, /display_code/);
  assert.match(text, /trim-vector-text/);

  db.close();
  await closeAllVectorStores();
});

test('Indexer 写入 LanceDB 时裁掉 vector_text，仅保留 display_code', async () => {
  const baseDir = createTempBaseDir();
  process.env.CONTEXTATLAS_BASE_DIR = baseDir;
  const projectId = 'proj-trim-vector-text';
  const db = initDb(projectId);

  db.prepare(
    'INSERT INTO files(path, hash, mtime, size, content, language, vector_index_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run('src/a.ts', 'h1', 1, 12, 'export const a = 1;', 'typescript', null);

  const indexer = new Indexer(projectId, 3);
  (indexer as unknown as { embeddingClient: { getConfig: () => { batchSize: number; maxConcurrency: number }; embedBatch: () => Promise<Array<{ embedding: number[] }>> } }).embeddingClient = {
    getConfig: () => ({ batchSize: 10, maxConcurrency: 1 }),
    embedBatch: async () => [{ embedding: [0, 0, 0] }],
  };

  const stats = await indexer.indexFiles(db, [
    {
      absPath: '/tmp/src/a.ts',
      relPath: 'src/a.ts',
      hash: 'h1',
      content: 'export const a = 1;',
      chunks: [
        {
          displayCode: 'export const a = 1;',
          vectorText: '// Context: src/a.ts\nexport const a = 1;',
          nwsSize: 18,
          metadata: {
            startIndex: 0,
            endIndex: 18,
            rawSpan: { start: 0, end: 18 },
            vectorSpan: { start: 0, end: 18 },
            filePath: 'src/a.ts',
            language: 'typescript',
            contextPath: ['src/a.ts'],
          },
        },
      ],
      language: 'typescript',
      mtime: 1,
      size: 12,
      status: 'added',
      chunking: {
        strategy: 'ast',
        astFailed: false,
        settleNoChunks: false,
      },
    },
  ]);

  assert.equal(stats.indexed, 1);

  const store = new VectorStore(projectId, 3);
  await store.init();
  const chunks = await store.getFileChunks('src/a.ts');

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]?.display_code, 'export const a = 1;');
  assert.equal(chunks[0]?.vector_text, '');

  db.close();
  await closeAllVectorStores();
});
