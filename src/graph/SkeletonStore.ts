import type Database from 'better-sqlite3';
import type { SkeletonWritePayload } from './types.js';

export class SkeletonStore {
  constructor(private readonly db: Database.Database) {}

  upsertFile(filePath: string, payload: SkeletonWritePayload): void {
    const insertFile = this.db.prepare(`
      INSERT INTO file_skeleton (path, language, summary, imports, exports, top_symbols, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(path) DO UPDATE SET
        language = excluded.language,
        summary = excluded.summary,
        imports = excluded.imports,
        exports = excluded.exports,
        top_symbols = excluded.top_symbols,
        updated_at = datetime('now')
    `);
    const insertFileFts = this.db.prepare(`
      INSERT INTO file_skeleton_fts (path, summary, imports, exports, top_symbols)
      VALUES (?, ?, ?, ?, ?)
    `);
    const insertSymbol = this.db.prepare(`
      INSERT INTO symbol_skeleton (
        symbol_id, file_path, name, type, signature, parent_name, exported, start_line, end_line
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(symbol_id) DO UPDATE SET
        file_path = excluded.file_path,
        name = excluded.name,
        type = excluded.type,
        signature = excluded.signature,
        parent_name = excluded.parent_name,
        exported = excluded.exported,
        start_line = excluded.start_line,
        end_line = excluded.end_line
    `);
    const insertSymbolFts = this.db.prepare(`
      INSERT INTO symbol_skeleton_fts (symbol_id, file_path, name, signature, parent_name)
      VALUES (?, ?, ?, ?, ?)
    `);

    const tx = this.db.transaction(() => {
      this.deleteFile(filePath);

      insertFile.run(
        payload.file.path,
        payload.file.language,
        payload.file.summary,
        JSON.stringify(payload.file.imports),
        JSON.stringify(payload.file.exports),
        JSON.stringify(payload.file.topSymbols),
      );
      insertFileFts.run(
        payload.file.path,
        payload.file.summary,
        payload.file.imports.join(' '),
        payload.file.exports.join(' '),
        payload.file.topSymbols.join(' '),
      );

      for (const symbol of payload.symbols) {
        insertSymbol.run(
          symbol.symbolId,
          symbol.filePath,
          symbol.name,
          symbol.type,
          symbol.signature,
          symbol.parentName,
          symbol.exported ? 1 : 0,
          symbol.startLine,
          symbol.endLine,
        );
        insertSymbolFts.run(
          symbol.symbolId,
          symbol.filePath,
          symbol.name,
          symbol.signature,
          symbol.parentName ?? '',
        );
      }
    });

    tx();
  }

  deleteFile(filePath: string): void {
    const tx = this.db.transaction(() => {
      const symbolIds = this.db
        .prepare('SELECT symbol_id FROM symbol_skeleton WHERE file_path = ?')
        .all(filePath)
        .map((row) => (row && typeof row === 'object' ? Reflect.get(row, 'symbol_id') : null))
        .filter((value): value is string => typeof value === 'string');

      if (symbolIds.length > 0) {
        const placeholders = symbolIds.map(() => '?').join(', ');
        this.db.prepare(`DELETE FROM symbol_skeleton_fts WHERE symbol_id IN (${placeholders})`).run(...symbolIds);
      }

      this.db.prepare('DELETE FROM symbol_skeleton WHERE file_path = ?').run(filePath);
      this.db.prepare('DELETE FROM file_skeleton_fts WHERE path = ?').run(filePath);
      this.db.prepare('DELETE FROM file_skeleton WHERE path = ?').run(filePath);
    });

    tx();
  }
}
