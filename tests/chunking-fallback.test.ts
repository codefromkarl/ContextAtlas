import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { closeAllVectorStores } from '../src/vectorStore/index.ts';
import { initDb } from '../src/db/index.ts';
import { Indexer } from '../src/indexer/index.ts';
import { processFiles } from '../src/scanner/processor.ts';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cw-chunking-fallback-test-'));
}

test('processFiles 为非 AST 语言使用 fallback split，避免留下空 chunk', async () => {
  const repoRoot = createTempDir();
  const scriptPath = path.join(repoRoot, 'script.sh');
  fs.writeFileSync(scriptPath, '#!/usr/bin/env bash\necho "hello"\n');

  const [result] = await processFiles(repoRoot, [scriptPath], new Map());

  assert.ok(result);
  assert.equal(result.status, 'added');
  assert.equal(result.language, 'shell');
  assert.ok(result.chunks.length > 0);
  assert.equal(result.chunking?.strategy, 'fallback');
});

test('indexFiles 只把真实空内容标记为已收敛，parse-failed 空 chunk 保持待修复', async () => {
  const baseDir = createTempDir();
  process.env.CONTEXTATLAS_BASE_DIR = baseDir;
  const projectId = 'proj-empty-vs-parse-failed';
  const db = initDb(projectId);

  db.prepare(
    'INSERT INTO files(path, hash, mtime, size, content, language, vector_index_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run('src/empty.ts', 'hash-empty', 1, 0, '', 'typescript', null);
  db.prepare(
    'INSERT INTO files(path, hash, mtime, size, content, language, vector_index_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run('src/bad.ts', 'hash-bad', 2, 32, 'export const bad = ;', 'typescript', null);

  const indexer = new Indexer(projectId, 1024);
  await indexer.indexFiles(db, [
    {
      absPath: '/tmp/src/empty.ts',
      relPath: 'src/empty.ts',
      hash: 'hash-empty',
      content: '',
      chunks: [],
      language: 'typescript',
      mtime: 1,
      size: 0,
      status: 'added',
      chunking: {
        strategy: 'empty',
        astFailed: false,
        settleNoChunks: true,
        emptyReason: 'empty-content',
      },
    },
    {
      absPath: '/tmp/src/bad.ts',
      relPath: 'src/bad.ts',
      hash: 'hash-bad',
      content: 'export const bad = ;',
      chunks: [],
      language: 'typescript',
      mtime: 2,
      size: 32,
      status: 'added',
      chunking: {
        strategy: 'empty',
        astFailed: true,
        settleNoChunks: false,
        emptyReason: 'parse-failed',
      },
    },
  ]);

  const rows = db
    .prepare('SELECT path, vector_index_hash FROM files ORDER BY path ASC')
    .all() as Array<{ path: string; vector_index_hash: string | null }>;

  assert.deepEqual(rows, [
    { path: 'src/bad.ts', vector_index_hash: null },
    { path: 'src/empty.ts', vector_index_hash: 'hash-empty' },
  ]);

  db.close();
  await closeAllVectorStores();
});
