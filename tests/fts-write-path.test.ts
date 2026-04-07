import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { generateProjectId, initDb } from '../src/db/index.ts';
import { replaceChunksFtsForFiles, replaceFileFtsEntries } from '../src/search/fts.ts';

function withTempDb(run: (db: ReturnType<typeof initDb>) => void): void {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-fts-write-'));
  const previousBaseDir = process.env.CONTEXTATLAS_BASE_DIR;
  process.env.CONTEXTATLAS_BASE_DIR = baseDir;

  try {
    const projectRoot = path.join(baseDir, 'repo');
    fs.mkdirSync(projectRoot, { recursive: true });
    const db = initDb(generateProjectId(projectRoot));
    try {
      run(db);
    } finally {
      db.close();
    }
  } finally {
    if (previousBaseDir === undefined) {
      delete process.env.CONTEXTATLAS_BASE_DIR;
    } else {
      process.env.CONTEXTATLAS_BASE_DIR = previousBaseDir;
    }
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

test('replaceFileFtsEntries 先删旧 path 再写入新内容，不保留重复记录', () => {
  withTempDb((db) => {
    db.prepare('INSERT INTO files_fts(path, content) VALUES (?, ?)').run('src/a.ts', 'old alpha');
    db.prepare('INSERT INTO files_fts(path, content) VALUES (?, ?)').run('src/b.ts', 'beta');

    replaceFileFtsEntries(db, [{ path: 'src/a.ts', content: 'new alpha' }]);

    const rows = db
      .prepare('SELECT path, content FROM files_fts ORDER BY path, rowid')
      .all() as Array<{ path: string; content: string }>;

    assert.deepEqual(rows, [
      { path: 'src/a.ts', content: 'new alpha' },
      { path: 'src/b.ts', content: 'beta' },
    ]);
  });
});

test('replaceChunksFtsForFiles 按文件替换 chunk 记录，不保留被替换文件的旧 chunk', () => {
  withTempDb((db) => {
    db.prepare(
      'INSERT INTO chunks_fts(chunk_id, file_path, chunk_index, breadcrumb, content) VALUES (?, ?, ?, ?, ?)',
    ).run('src/a.ts#old#0', 'src/a.ts', 0, 'src/a.ts', 'old alpha');
    db.prepare(
      'INSERT INTO chunks_fts(chunk_id, file_path, chunk_index, breadcrumb, content) VALUES (?, ?, ?, ?, ?)',
    ).run('src/b.ts#keep#0', 'src/b.ts', 0, 'src/b.ts', 'beta');

    replaceChunksFtsForFiles(db, ['src/a.ts'], [
      {
        chunkId: 'src/a.ts#new#0',
        filePath: 'src/a.ts',
        chunkIndex: 0,
        breadcrumb: 'src/a.ts',
        content: 'new alpha',
      },
    ]);

    const rows = db
      .prepare('SELECT chunk_id, file_path, content FROM chunks_fts ORDER BY file_path, rowid')
      .all() as Array<{ chunk_id: string; file_path: string; content: string }>;

    assert.deepEqual(rows, [
      { chunk_id: 'src/a.ts#new#0', file_path: 'src/a.ts', content: 'new alpha' },
      { chunk_id: 'src/b.ts#keep#0', file_path: 'src/b.ts', content: 'beta' },
    ]);
  });
});
