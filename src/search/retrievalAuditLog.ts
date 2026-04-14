/**
 * Per-query retrieval audit log
 *
 * Records every retrieval's key metrics for debugging and monitoring.
 * Stored in SQLite for structured queries.
 * Write failures are silently caught — audit logging must never break retrieval.
 */

import type Database from 'better-sqlite3';
import { logger } from '../utils/logger.js';

export interface AuditEntry {
  query: string;
  intent: string;
  lexicalStrategy: string;
  vectorCount: number;
  lexicalCount: number;
  fusedCount: number;
  rerankedCount: number;
  seedCount: number;
  expandedCount: number;
  totalMs: number;
  rerankProvider: string;
  topSeedPaths: string[];
}

export interface AuditRow extends AuditEntry {
  id: number;
  timestamp: string;
}

export function initAuditLog(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS retrieval_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      query TEXT NOT NULL,
      intent TEXT NOT NULL,
      lexical_strategy TEXT NOT NULL,
      vector_count INTEGER NOT NULL,
      lexical_count INTEGER NOT NULL,
      fused_count INTEGER NOT NULL,
      reranked_count INTEGER NOT NULL,
      seed_count INTEGER NOT NULL,
      expanded_count INTEGER NOT NULL,
      total_ms INTEGER NOT NULL,
      rerank_provider TEXT NOT NULL,
      top_seed_paths TEXT NOT NULL DEFAULT '[]'
    )
  `);
}

export function writeAuditEntry(db: Database.Database, entry: AuditEntry): void {
  try {
    const stmt = db.prepare(`
      INSERT INTO retrieval_audit (
        query, intent, lexical_strategy, vector_count, lexical_count,
        fused_count, reranked_count, seed_count, expanded_count,
        total_ms, rerank_provider, top_seed_paths
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      entry.query,
      entry.intent,
      entry.lexicalStrategy,
      entry.vectorCount,
      entry.lexicalCount,
      entry.fusedCount,
      entry.rerankedCount,
      entry.seedCount,
      entry.expandedCount,
      entry.totalMs,
      entry.rerankProvider,
      JSON.stringify(entry.topSeedPaths),
    );
  } catch (err) {
    // Audit log failure should never break retrieval
    logger.debug({ error: err }, 'Failed to write audit entry');
  }
}

export function queryAuditLog(
  db: Database.Database,
  options: { limit?: number; sinceMs?: number } = {},
): AuditRow[] {
  const { limit = 100, sinceMs } = options;

  let sql = 'SELECT * FROM retrieval_audit';
  const params: unknown[] = [];

  if (sinceMs !== undefined) {
    sql += ' WHERE unixepoch(timestamp) * 1000 >= ?';
    params.push(sinceMs);
  }

  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(limit);

  type DbRow = {
    id: number;
    timestamp: string;
    query: string;
    intent: string;
    lexical_strategy: string;
    vector_count: number;
    lexical_count: number;
    fused_count: number;
    reranked_count: number;
    seed_count: number;
    expanded_count: number;
    total_ms: number;
    rerank_provider: string;
    top_seed_paths: string;
  };

  const rows = db.prepare(sql).all(...params) as DbRow[];

  return rows.map((row) => ({
    id: row.id,
    timestamp: row.timestamp,
    query: row.query,
    intent: row.intent,
    lexicalStrategy: row.lexical_strategy,
    vectorCount: row.vector_count,
    lexicalCount: row.lexical_count,
    fusedCount: row.fused_count,
    rerankedCount: row.reranked_count,
    seedCount: row.seed_count,
    expandedCount: row.expanded_count,
    totalMs: row.total_ms,
    rerankProvider: row.rerank_provider,
    topSeedPaths: JSON.parse(row.top_seed_paths || '[]'),
  }));
}
