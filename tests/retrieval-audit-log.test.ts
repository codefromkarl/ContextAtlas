import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { initAuditLog, writeAuditEntry, queryAuditLog } from '../src/search/retrievalAuditLog.ts';

test('should write and read audit entries', () => {
  const db = new Database(':memory:');
  try {
    initAuditLog(db);

    writeAuditEntry(db, {
      query: 'user authentication',
      intent: 'conceptual',
      lexicalStrategy: 'chunks_fts',
      vectorCount: 60,
      lexicalCount: 25,
      fusedCount: 75,
      rerankedCount: 8,
      seedCount: 5,
      expandedCount: 12,
      totalMs: 340,
      rerankProvider: 'api',
      topSeedPaths: ['src/auth.ts', 'src/login.ts'],
    });

    const entries = queryAuditLog(db, { limit: 10 });
    assert.equal(entries.length, 1, 'should have 1 entry');
    assert.equal(entries[0].query, 'user authentication');
    assert.equal(entries[0].intent, 'conceptual');
    assert.equal(entries[0].vectorCount, 60);
    assert.deepEqual(entries[0].topSeedPaths, ['src/auth.ts', 'src/login.ts']);
  } finally {
    db.close();
  }
});

test('should filter by time window', () => {
  const db = new Database(':memory:');
  try {
    initAuditLog(db);

    writeAuditEntry(db, {
      query: 'test1',
      intent: 'balanced',
      lexicalStrategy: 'chunks_fts',
      vectorCount: 10,
      lexicalCount: 5,
      fusedCount: 12,
      rerankedCount: 3,
      seedCount: 2,
      expandedCount: 5,
      totalMs: 100,
      rerankProvider: 'ollama',
      topSeedPaths: [],
    });

    const recent = queryAuditLog(db, { limit: 10 });
    assert.equal(recent.length, 1, 'recent entries should exist');

    // Query with future cutoff should return empty
    const future = queryAuditLog(db, { sinceMs: Date.now() + 10000 });
    assert.equal(future.length, 0, 'future cutoff should return empty');
  } finally {
    db.close();
  }
});

test('should handle multiple entries and return in reverse order', () => {
  const db = new Database(':memory:');
  try {
    initAuditLog(db);

    writeAuditEntry(db, {
      query: 'first query',
      intent: 'balanced',
      lexicalStrategy: 'chunks_fts',
      vectorCount: 10,
      lexicalCount: 5,
      fusedCount: 12,
      rerankedCount: 3,
      seedCount: 2,
      expandedCount: 5,
      totalMs: 100,
      rerankProvider: 'api',
      topSeedPaths: [],
    });

    writeAuditEntry(db, {
      query: 'second query',
      intent: 'symbol_lookup',
      lexicalStrategy: 'files_fts',
      vectorCount: 20,
      lexicalCount: 10,
      fusedCount: 25,
      rerankedCount: 5,
      seedCount: 3,
      expandedCount: 8,
      totalMs: 200,
      rerankProvider: 'ollama',
      topSeedPaths: ['src/main.ts'],
    });

    const entries = queryAuditLog(db, { limit: 10 });
    assert.equal(entries.length, 2);
    // Most recent first
    assert.equal(entries[0].query, 'second query');
    assert.equal(entries[1].query, 'first query');
  } finally {
    db.close();
  }
});
