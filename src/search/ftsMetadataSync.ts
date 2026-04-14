/**
 * Sync symbol metadata from graph module into FTS index
 *
 * During indexing, the scanner extracts function/class names via Tree-sitter.
 * This module ensures those symbols are written into the `symbols` column
 * of chunks_fts for enriched lexical search.
 */

import type Database from 'better-sqlite3';
import { logger } from '../utils/logger.js';

export interface ChunkSymbolMetadata {
  chunkId: string;
  language: string;
  symbols: string;
}

/**
 * Update language and symbols for existing chunks in chunks_fts.
 *
 * FTS5 virtual tables don't support UPDATE, so we use DELETE + re-insert.
 * Only updates chunks that already exist in the index.
 */
export function updateChunksFtsMetadata(
  db: Database.Database,
  metadata: ChunkSymbolMetadata[],
): void {
  if (metadata.length === 0) return;

  const selectStmt = db.prepare(
    'SELECT chunk_id, file_path, chunk_index, breadcrumb, content FROM chunks_fts WHERE chunk_id = ?',
  );
  const deleteStmt = db.prepare('DELETE FROM chunks_fts WHERE chunk_id = ?');
  const insertStmt = db.prepare(
    'INSERT INTO chunks_fts(chunk_id, file_path, chunk_index, breadcrumb, content, language, symbols) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );

  const transaction = db.transaction((items: ChunkSymbolMetadata[]) => {
    let updated = 0;
    for (const item of items) {
      const existing = selectStmt.get(item.chunkId) as {
        chunk_id: string;
        file_path: string;
        chunk_index: number;
        breadcrumb: string;
        content: string;
      } | undefined;

      if (!existing) continue;

      deleteStmt.run(item.chunkId);
      insertStmt.run(
        existing.chunk_id,
        existing.file_path,
        existing.chunk_index,
        existing.breadcrumb,
        existing.content,
        item.language,
        item.symbols,
      );
      updated++;
    }

    logger.debug({ total: items.length, updated }, 'FTS metadata sync completed');
  });

  transaction(metadata);
}
