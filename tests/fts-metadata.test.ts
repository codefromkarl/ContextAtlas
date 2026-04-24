import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { initChunksFts, searchChunksFts, batchInsertChunkFts } from '../src/search/fts.ts';

test('chunks_fts indexes language and symbols columns alongside content', () => {
  const db = new Database(':memory:');
  try {
    initChunksFts(db);

    batchInsertChunkFts(db, [
      {
        chunkId: 'f1#h1#0',
        filePath: 'src/auth.rs',
        chunkIndex: 0,
        breadcrumb: 'src/auth.rs > login',
        content: 'fn login(user: &str) -> bool',
        language: 'rust',
        symbols: 'login authenticate',
      },
      {
        chunkId: 'f1#h1#1',
        filePath: 'src/auth.rs',
        chunkIndex: 1,
        breadcrumb: 'src/auth.rs > logout',
        content: 'fn logout() -> ()',
        language: 'rust',
        symbols: 'logout',
      },
      {
        chunkId: 'f2#h2#0',
        filePath: 'src/user.ts',
        chunkIndex: 0,
        breadcrumb: 'src/user.ts > UserLogin',
        content: 'class UserLogin {}',
        language: 'typescript',
        symbols: 'UserLogin',
      },
    ]);

    // Search for "login" should match across both files
    const results = searchChunksFts(db, 'login', 10);
    assert.ok(results.length >= 2, 'should find at least 2 results for login');

    // Rust results should be present
    const rustResults = results.filter((r) => r.filePath.endsWith('.rs'));
    assert.ok(rustResults.length >= 1, 'should find Rust files');
  } finally {
    db.close();
  }
});

test('chunks_fts backwards-compatible without language/symbols', () => {
  const db = new Database(':memory:');
  try {
    initChunksFts(db);

    // Old-style insert without language/symbols — should still work
    batchInsertChunkFts(db, [
      {
        chunkId: 'f3#h3#0',
        filePath: 'src/utils.py',
        chunkIndex: 0,
        breadcrumb: 'src/utils.py > helper',
        content: 'def helper(): pass',
      },
    ]);

    const results = searchChunksFts(db, 'helper', 5);
    assert.equal(results.length, 1, 'should find the helper function');
    assert.equal(results[0].filePath, 'src/utils.py');
  } finally {
    db.close();
  }
});

test('initChunksFts rebuilds legacy chunks_fts schema when language/symbols columns are missing', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`
      CREATE VIRTUAL TABLE chunks_fts USING fts5(
        chunk_id UNINDEXED,
        file_path UNINDEXED,
        chunk_index UNINDEXED,
        breadcrumb,
        content,
        tokenize='unicode61'
      );
    `);

    initChunksFts(db);

    batchInsertChunkFts(db, [
      {
        chunkId: 'legacy#0',
        filePath: 'src/auth.rs',
        chunkIndex: 0,
        breadcrumb: 'src/auth.rs > login',
        content: 'fn login(user: &str) -> bool',
        language: 'rust',
        symbols: 'login authenticate',
      },
    ]);

    const columns = db
      .prepare(`SELECT name FROM pragma_table_info('chunks_fts') ORDER BY cid`)
      .all() as Array<{ name: string }>;
    const columnNames = columns.map((row) => row.name);

    assert.ok(columnNames.includes('language'));
    assert.ok(columnNames.includes('symbols'));

    const results = searchChunksFts(db, 'authenticate', 5);
    assert.equal(results.length, 1);
    assert.equal(results[0].filePath, 'src/auth.rs');
  } finally {
    db.close();
  }
});
