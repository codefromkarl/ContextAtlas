import type Database from 'better-sqlite3';
import type {
  ExtractedInvocation,
  ExtractedRelation,
  ExtractedSymbol,
  GraphDirection,
  GraphEdgeType,
  GraphWritePayload,
} from './types.js';

export interface StoredSymbol extends ExtractedSymbol {}

export interface StoredRelation extends ExtractedRelation {
  id: number;
}

export interface StoredInvocation extends ExtractedInvocation {}

export interface GraphImpactEntry {
  symbol: StoredSymbol;
  depth: number;
  direction: Exclude<GraphDirection, 'both'>;
  viaRelationType: GraphEdgeType | null;
}

export interface GraphRelationEntry {
  direction: Exclude<GraphDirection, 'both'>;
  relationType: GraphEdgeType;
  targetId: string;
  targetName: string;
  resolved: boolean;
  symbol: StoredSymbol | null;
}

function parseModifiers(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function mapSymbolRow(row: Record<string, unknown>): StoredSymbol {
  return {
    id: String(row.id),
    name: String(row.name),
    type: row.type as StoredSymbol['type'],
    filePath: String(row.file_path),
    language: String(row.language),
    startLine: Number(row.start_line),
    endLine: Number(row.end_line),
    modifiers: parseModifiers((row.modifiers as string | null) ?? null),
    parentId: (row.parent_id as string | null) ?? null,
    exported: Number(row.exported) === 1,
  };
}

function mapInvocationRow(row: Record<string, unknown>): StoredInvocation {
  return {
    id: String(row.id),
    filePath: String(row.file_path),
    enclosingSymbolId: (row.enclosing_symbol_id as string | null) ?? null,
    calleeName: String(row.callee_name),
    resolvedTargetId: (row.resolved_target_id as string | null) ?? null,
    startLine: Number(row.start_line),
    endLine: Number(row.end_line),
  };
}

function makePlaceholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function buildNameMatchQuery(query: string): string {
  const escaped = query.replace(/"/g, '""').trim();
  return `name:"${escaped}"`;
}

function inferNameFromSymbolId(symbolId: string): string {
  const parts = symbolId.split(':');
  return parts[parts.length - 1] || symbolId;
}

export class GraphStore {
  constructor(private readonly db: Database.Database) {}

  upsertFile(filePath: string, payload: GraphWritePayload): void {
    const insertSymbol = this.db.prepare(`
      INSERT INTO symbols (
        id, name, type, file_path, language, start_line, end_line, modifiers, parent_id, exported
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertRelation = this.db.prepare(`
      INSERT INTO relations (from_id, to_id, type, confidence, reason)
      VALUES (?, ?, ?, ?, ?)
    `);
    const insertInvocation = this.db.prepare(`
      INSERT INTO invocations (
        id, file_path, enclosing_symbol_id, callee_name, resolved_target_id, start_line, end_line
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFts = this.db.prepare(`
      INSERT INTO symbols_fts (symbol_id, name, file_path)
      VALUES (?, ?, ?)
    `);

    const tx = this.db.transaction(() => {
      this.deleteFile(filePath);

      for (const symbol of payload.symbols) {
        insertSymbol.run(
          symbol.id,
          symbol.name,
          symbol.type,
          symbol.filePath,
          symbol.language,
          symbol.startLine,
          symbol.endLine,
          JSON.stringify(symbol.modifiers),
          symbol.parentId,
          symbol.exported ? 1 : 0,
        );
        insertFts.run(symbol.id, symbol.name, symbol.filePath);
      }

      for (const relation of payload.relations) {
        insertRelation.run(
          relation.fromId,
          relation.toId,
          relation.type,
          relation.confidence,
          relation.reason ?? null,
        );
      }

      for (const invocation of payload.invocations ?? []) {
        insertInvocation.run(
          invocation.id,
          invocation.filePath,
          invocation.enclosingSymbolId,
          invocation.calleeName,
          invocation.resolvedTargetId,
          invocation.startLine,
          invocation.endLine,
        );
      }
    });

    tx();
  }

  deleteFile(filePath: string): void {
    const symbolIds = this.db
      .prepare('SELECT id FROM symbols WHERE file_path = ?')
      .all(filePath)
      .map((row) => String((row as Record<string, unknown>).id));

    const tx = this.db.transaction(() => {
      if (symbolIds.length > 0) {
        const placeholders = makePlaceholders(symbolIds.length);
        this.db
          .prepare(`DELETE FROM relations WHERE from_id IN (${placeholders}) OR to_id IN (${placeholders})`)
          .run(...symbolIds, ...symbolIds);
        this.db
          .prepare(`DELETE FROM invocations WHERE enclosing_symbol_id IN (${placeholders}) OR resolved_target_id IN (${placeholders})`)
          .run(...symbolIds, ...symbolIds);
        this.db
          .prepare(`DELETE FROM symbols_fts WHERE symbol_id IN (${placeholders})`)
          .run(...symbolIds);
      } else {
        this.db.prepare('DELETE FROM symbols_fts WHERE file_path = ?').run(filePath);
      }

      this.db.prepare('DELETE FROM invocations WHERE file_path = ?').run(filePath);
      this.db.prepare('DELETE FROM symbols WHERE file_path = ?').run(filePath);
    });

    tx();
  }

  findSymbolsByName(name: string): StoredSymbol[] {
    const rows = this.db
      .prepare(
        `
          SELECT *
          FROM symbols
          WHERE name = ?
          ORDER BY exported DESC, file_path ASC, start_line ASC
        `,
      )
      .all(name) as Record<string, unknown>[];

    return rows.map(mapSymbolRow);
  }

  findSymbolsByFileAndLines(filePath: string, lines: number[]): StoredSymbol[] {
    if (lines.length === 0) return [];

    const uniqueLines = Array.from(new Set(lines)).sort((a, b) => a - b);
    const minLine = uniqueLines[0]!;
    const maxLine = uniqueLines[uniqueLines.length - 1]!;
    const rows = this.db
      .prepare(
        `
          SELECT *
          FROM symbols
          WHERE file_path = ?
            AND end_line >= ?
            AND start_line <= ?
          ORDER BY start_line ASC, end_line ASC
        `,
      )
      .all(filePath, minLine, maxLine) as Record<string, unknown>[];

    return rows
      .map(mapSymbolRow)
      .filter((symbol) => uniqueLines.some((line) => symbol.startLine <= line && symbol.endLine >= line));
  }

  searchSymbols(query: string, limit = 10): StoredSymbol[] {
    const rows = this.db
      .prepare(
        `
          SELECT s.*
          FROM symbols_fts f
          JOIN symbols s ON s.id = f.symbol_id
          WHERE symbols_fts MATCH ?
          ORDER BY rank
          LIMIT ?
        `,
      )
      .all(buildNameMatchQuery(query), limit) as Record<string, unknown>[];

    return rows.map(mapSymbolRow);
  }

  getSymbolById(symbolId: string): StoredSymbol | null {
    const row = this.db.prepare('SELECT * FROM symbols WHERE id = ?').get(symbolId) as
      | Record<string, unknown>
      | undefined;
    return row ? mapSymbolRow(row) : null;
  }

  getInvocationsBySymbol(symbolId: string): StoredInvocation[] {
    const rows = this.db
      .prepare(
        `
          SELECT *
          FROM invocations
          WHERE enclosing_symbol_id = ? OR resolved_target_id = ?
          ORDER BY start_line ASC, end_line ASC, callee_name ASC
        `,
      )
      .all(symbolId, symbolId) as Record<string, unknown>[];

    return rows.map(mapInvocationRow);
  }

  getImpact(symbolId: string, options: { direction?: GraphDirection; maxDepth?: number } = {}): GraphImpactEntry[] {
    const direction = options.direction ?? 'downstream';
    const maxDepth = options.maxDepth ?? 2;

    if (direction === 'both') {
      const downstream = this.getImpact(symbolId, { direction: 'downstream', maxDepth });
      const upstream = this.getImpact(symbolId, { direction: 'upstream', maxDepth });
      const deduped = new Map<string, GraphImpactEntry>();
      for (const entry of [...downstream, ...upstream]) {
        deduped.set(`${entry.direction}:${entry.symbol.id}`, entry);
      }
      return Array.from(deduped.values()).sort((a, b) => a.depth - b.depth || a.symbol.name.localeCompare(b.symbol.name));
    }

    const joinClause =
      direction === 'downstream' ? 'r.from_id = walk.symbol_id' : 'r.to_id = walk.symbol_id';
    const nextSymbolExpr = direction === 'downstream' ? 'r.to_id' : 'r.from_id';

    const rows = this.db
      .prepare(
        `
          WITH RECURSIVE walk(symbol_id, depth, via_relation_type, path) AS (
            SELECT ?, 0, NULL, '|' || ? || '|'
            UNION ALL
            SELECT ${nextSymbolExpr}, walk.depth + 1, r.type, walk.path || ${nextSymbolExpr} || '|'
            FROM walk
            JOIN relations r ON ${joinClause}
            WHERE walk.depth < ?
              AND instr(walk.path, '|' || ${nextSymbolExpr} || '|') = 0
          )
          SELECT s.*, walk.depth, walk.via_relation_type
          FROM walk
          JOIN symbols s ON s.id = walk.symbol_id
          WHERE walk.depth > 0
          ORDER BY walk.depth ASC, s.name ASC, s.file_path ASC, s.start_line ASC
        `,
      )
      .all(symbolId, symbolId, maxDepth) as Array<Record<string, unknown> & {
        depth: number;
        via_relation_type: GraphEdgeType | null;
      }>;

    return rows.map((row) => ({
      symbol: mapSymbolRow(row),
      depth: Number(row.depth),
      direction,
      viaRelationType: (row.via_relation_type as GraphEdgeType | null) ?? null,
    }));
  }

  getDirectRelations(
    symbolId: string,
    direction: GraphDirection = 'both',
  ): GraphRelationEntry[] {
    if (direction === 'both') {
      const downstream = this.getDirectRelations(symbolId, 'downstream');
      const upstream = this.getDirectRelations(symbolId, 'upstream');
      const deduped = new Map<string, GraphRelationEntry>();
      for (const entry of [...downstream, ...upstream]) {
        deduped.set(`${entry.direction}:${entry.relationType}:${entry.targetId}`, entry);
      }
      return Array.from(deduped.values());
    }

    const targetExpr = direction === 'downstream' ? 'r.to_id' : 'r.from_id';
    const joinExpr = direction === 'downstream' ? 's.id = r.to_id' : 's.id = r.from_id';
    const whereExpr = direction === 'downstream' ? 'r.from_id = ?' : 'r.to_id = ?';

    const rows = this.db
      .prepare(
        `
          SELECT
            ${targetExpr} AS target_id,
            r.type AS relation_type,
            s.id,
            s.name,
            s.type,
            s.file_path,
            s.language,
            s.start_line,
            s.end_line,
            s.modifiers,
            s.parent_id,
            s.exported
          FROM relations r
          LEFT JOIN symbols s ON ${joinExpr}
          WHERE ${whereExpr}
          ORDER BY r.type ASC, target_id ASC
        `,
      )
      .all(symbolId) as Array<Record<string, unknown> & { target_id: string; relation_type: GraphEdgeType }>;

    return rows.map((row) => {
      const resolved = typeof row.id === 'string';
      return {
        direction,
        relationType: row.relation_type,
        targetId: String(row.target_id),
        targetName: resolved ? String(row.name) : inferNameFromSymbolId(String(row.target_id)),
        resolved,
        symbol: resolved ? mapSymbolRow(row) : null,
      };
    });
  }
}
