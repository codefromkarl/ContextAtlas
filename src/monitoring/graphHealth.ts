import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { generateProjectId } from '../db/index.js';
import { resolveCurrentSnapshotId, resolveIndexPaths } from '../storage/layout.js';
import type { GraphEdgeType, GraphSymbolType } from '../graph/types.js';

export type GraphHealthStatus = 'ok' | 'degraded' | 'missing';

export interface GraphLanguageCoverage {
  language: string;
  files: number;
  symbols: number;
  relations: number;
}

export interface GraphRelationHealth {
  type: GraphEdgeType;
  count: number;
  resolved: number;
  unresolved: number;
  averageConfidence: number;
}

export interface GraphMissingColumn {
  table: string;
  column: string;
}

export interface GraphSchemaHealth {
  status: GraphHealthStatus;
  missingTables: string[];
  missingColumns: GraphMissingColumn[];
  missingIndexes: string[];
  missingVirtualTables: string[];
  appliedMigrations: string[];
  missingMigrations: string[];
}

export interface GraphHealthReport {
  projectId: string;
  repoPath: string | null;
  snapshotId: string | null;
  dbPath: string;
  hasIndexDb: boolean;
  hasGraphTables: boolean;
  totals: {
    filesWithGraph: number;
    symbols: number;
    relations: number;
    invocations: number;
    unresolvedRelations: number;
    resolvedInvocations: number;
  };
  symbolTypes: Record<GraphSymbolType, number>;
  schemaHealth: GraphSchemaHealth;
  languageCoverage: GraphLanguageCoverage[];
  relationHealth: GraphRelationHealth[];
  unresolvedRatio: number;
  invocationResolvedRatio: number;
  averageRelationConfidence: number;
  overall: {
    status: GraphHealthStatus;
    issues: string[];
    recommendations: string[];
  };
}

const SYMBOL_TYPES: GraphSymbolType[] = [
  'Function',
  'Class',
  'Method',
  'Interface',
  'Variable',
  'Enum',
  'Struct',
  'Trait',
];

const EXPECTED_TABLE_COLUMNS: Record<string, string[]> = {
  files: ['path', 'hash', 'mtime', 'size', 'content', 'language', 'vector_index_hash'],
  symbols: [
    'id',
    'name',
    'type',
    'file_path',
    'language',
    'start_line',
    'end_line',
    'modifiers',
    'parent_id',
    'exported',
  ],
  relations: ['id', 'from_id', 'to_id', 'type', 'confidence', 'reason'],
  invocations: [
    'id',
    'file_path',
    'enclosing_symbol_id',
    'callee_name',
    'resolved_target_id',
    'start_line',
    'end_line',
  ],
  schema_migrations: ['version', 'applied_at'],
};

const EXPECTED_INDEXES: Record<string, string[]> = {
  symbols: ['idx_symbols_file', 'idx_symbols_name', 'idx_symbols_type', 'idx_symbols_parent'],
  relations: ['idx_relations_from', 'idx_relations_to', 'idx_relations_type'],
  invocations: ['idx_invocations_file', 'idx_invocations_enclosing', 'idx_invocations_target'],
};

const EXPECTED_VIRTUAL_TABLES = ['symbols_fts', 'file_skeleton_fts', 'symbol_skeleton_fts'];

const EXPECTED_MIGRATIONS = [
  '20260409_add_vector_index_hash_to_files',
  '20260410_reserve_code_graph_hooks',
  '20260410_add_code_graph_tables',
  '20260410_relations_allow_unresolved_targets',
  '20260416_add_skeleton_tables',
  '20260417_add_invocations_table',
];

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function ratio(value: number, total: number): number {
  if (total === 0) return 0;
  return round(value / total);
}

function countRows(db: Database.Database, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as
    | { count: number }
    | undefined;
  return row?.count ?? 0;
}

function hasTable(db: Database.Database, table: string): boolean {
  const row = db
    .prepare("SELECT 1 AS found FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?")
    .get(table) as { found: number } | undefined;
  return row?.found === 1;
}

function listColumns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (row) => row.name,
  );
}

function listIndexes(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>).map(
    (row) => row.name,
  );
}

function readAverage(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? round(value) : 0;
}

function buildEmptySchemaHealth(status: GraphHealthStatus, missingTables: string[] = []): GraphSchemaHealth {
  return {
    status,
    missingTables,
    missingColumns: [],
    missingIndexes: [],
    missingVirtualTables: [],
    appliedMigrations: [],
    missingMigrations: status === 'missing' ? EXPECTED_MIGRATIONS : [],
  };
}

function analyzeGraphSchemaHealth(db: Database.Database): GraphSchemaHealth {
  const expectedTables = Object.keys(EXPECTED_TABLE_COLUMNS);
  const missingTables = expectedTables.filter((table) => !hasTable(db, table));
  const missingColumns: GraphMissingColumn[] = [];
  const missingIndexes: string[] = [];
  const missingVirtualTables = EXPECTED_VIRTUAL_TABLES.filter((table) => !hasTable(db, table));

  for (const [table, expectedColumns] of Object.entries(EXPECTED_TABLE_COLUMNS)) {
    if (missingTables.includes(table)) {
      continue;
    }
    const columns = new Set(listColumns(db, table));
    for (const column of expectedColumns) {
      if (!columns.has(column)) {
        missingColumns.push({ table, column });
      }
    }
  }

  for (const [table, expectedIndexes] of Object.entries(EXPECTED_INDEXES)) {
    if (missingTables.includes(table)) {
      continue;
    }
    const indexes = new Set(listIndexes(db, table));
    for (const index of expectedIndexes) {
      if (!indexes.has(index)) {
        missingIndexes.push(index);
      }
    }
  }

  const appliedMigrations = hasTable(db, 'schema_migrations')
    ? (db
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all() as Array<{ version: string }>).map((row) => row.version)
    : [];
  const appliedSet = new Set(appliedMigrations);
  const missingMigrations = EXPECTED_MIGRATIONS.filter((migration) => !appliedSet.has(migration));
  const status =
    missingTables.length > 0
      ? 'missing'
      : missingColumns.length > 0
        || missingIndexes.length > 0
        || missingVirtualTables.length > 0
        || missingMigrations.length > 0
        ? 'degraded'
        : 'ok';

  return {
    status,
    missingTables,
    missingColumns,
    missingIndexes,
    missingVirtualTables,
    appliedMigrations,
    missingMigrations,
  };
}

function buildMissingReport(input: {
  projectId: string;
  repoPath: string | null;
  snapshotId: string | null;
  dbPath: string;
  hasIndexDb: boolean;
  hasGraphTables: boolean;
  schemaHealth?: GraphSchemaHealth;
  status?: GraphHealthStatus;
  issue: string;
  recommendation: string;
}): GraphHealthReport {
  return {
    projectId: input.projectId,
    repoPath: input.repoPath,
    snapshotId: input.snapshotId,
    dbPath: input.dbPath,
    hasIndexDb: input.hasIndexDb,
    hasGraphTables: input.hasGraphTables,
    totals: {
      filesWithGraph: 0,
      symbols: 0,
      relations: 0,
      invocations: 0,
      unresolvedRelations: 0,
      resolvedInvocations: 0,
    },
    symbolTypes: Object.fromEntries(SYMBOL_TYPES.map((type) => [type, 0])) as Record<GraphSymbolType, number>,
    schemaHealth: input.schemaHealth ?? buildEmptySchemaHealth(input.status ?? 'missing'),
    languageCoverage: [],
    relationHealth: [],
    unresolvedRatio: 0,
    invocationResolvedRatio: 0,
    averageRelationConfidence: 0,
    overall: {
      status: input.status ?? 'missing',
      issues: [input.issue],
      recommendations: [input.recommendation],
    },
  };
}

export function analyzeGraphHealth(input: {
  repoPath?: string;
  projectId?: string;
  snapshotId?: string | null;
  baseDir?: string;
} = {}): GraphHealthReport {
  const repoPath = input.repoPath ? path.resolve(input.repoPath) : null;
  const projectId = input.projectId ?? generateProjectId(repoPath ?? process.cwd());
  const snapshotId =
    input.snapshotId === undefined
      ? resolveCurrentSnapshotId(projectId, input.baseDir)
      : input.snapshotId;
  const paths = resolveIndexPaths(projectId, { baseDir: input.baseDir, snapshotId });

  if (!fs.existsSync(paths.dbPath)) {
    return buildMissingReport({
      projectId,
      repoPath,
      snapshotId: paths.snapshotId,
      dbPath: paths.dbPath,
      hasIndexDb: false,
      hasGraphTables: false,
      schemaHealth: buildEmptySchemaHealth('missing', Object.keys(EXPECTED_TABLE_COLUMNS)),
      issue: 'index database is missing',
      recommendation: 'Run contextatlas index before graph health checks',
    });
  }

  const db = new Database(paths.dbPath, { readonly: true, fileMustExist: true });
  try {
    const hasGraphTables = ['symbols', 'relations', 'invocations'].every((table) =>
      hasTable(db, table),
    );
    const schemaHealth = analyzeGraphSchemaHealth(db);
    if (!hasGraphTables) {
      return buildMissingReport({
        projectId,
        repoPath,
        snapshotId: paths.snapshotId,
        dbPath: paths.dbPath,
        hasIndexDb: true,
        hasGraphTables: false,
        schemaHealth,
        issue: 'graph tables are missing',
        recommendation: 'Rebuild the index with graph extraction enabled',
      });
    }
    if (schemaHealth.missingTables.length > 0) {
      return buildMissingReport({
        projectId,
        repoPath,
        snapshotId: paths.snapshotId,
        dbPath: paths.dbPath,
        hasIndexDb: true,
        hasGraphTables: true,
        schemaHealth,
        status: 'missing',
        issue: `graph schema is missing required tables: ${schemaHealth.missingTables.join(', ')}`,
        recommendation: 'Rebuild the index or run schema migrations before graph health checks',
      });
    }
    if (schemaHealth.missingColumns.length > 0) {
      return buildMissingReport({
        projectId,
        repoPath,
        snapshotId: paths.snapshotId,
        dbPath: paths.dbPath,
        hasIndexDb: true,
        hasGraphTables: true,
        schemaHealth,
        status: 'degraded',
        issue: 'graph schema is missing required columns',
        recommendation: 'Rebuild the index or run schema migrations before graph health checks',
      });
    }

    const symbols = countRows(db, 'symbols');
    const relations = countRows(db, 'relations');
    const invocations = countRows(db, 'invocations');
    const filesWithGraph = (db
      .prepare('SELECT COUNT(DISTINCT file_path) AS count FROM symbols')
      .get() as { count: number } | undefined)?.count ?? 0;
    const unresolvedRelations = (db
      .prepare(`
        SELECT COUNT(*) AS count
        FROM relations r
        LEFT JOIN symbols target ON target.id = r.to_id
        WHERE target.id IS NULL
      `)
      .get() as { count: number } | undefined)?.count ?? 0;
    const resolvedInvocations = (db
      .prepare('SELECT COUNT(*) AS count FROM invocations WHERE resolved_target_id IS NOT NULL')
      .get() as { count: number } | undefined)?.count ?? 0;
    const averageRelationConfidence = readAverage(
      (db.prepare('SELECT AVG(confidence) AS average FROM relations').get() as
        | { average: number | null }
        | undefined)?.average,
    );

    const symbolTypes = Object.fromEntries(SYMBOL_TYPES.map((type) => [type, 0])) as Record<GraphSymbolType, number>;
    for (const row of db
      .prepare('SELECT type, COUNT(*) AS count FROM symbols GROUP BY type ORDER BY type')
      .all() as Array<{ type: GraphSymbolType; count: number }>) {
      symbolTypes[row.type] = row.count;
    }

    const relationRows = db
      .prepare(`
        SELECT
          r.type AS type,
          COUNT(*) AS count,
          SUM(CASE WHEN target.id IS NULL THEN 1 ELSE 0 END) AS unresolved,
          AVG(r.confidence) AS averageConfidence
        FROM relations r
        LEFT JOIN symbols target ON target.id = r.to_id
        GROUP BY r.type
        ORDER BY r.type
      `)
      .all() as Array<{
        type: GraphEdgeType;
        count: number;
        unresolved: number;
        averageConfidence: number | null;
      }>;

    const relationHealth = relationRows.map((row) => ({
      type: row.type,
      count: row.count,
      resolved: row.count - row.unresolved,
      unresolved: row.unresolved,
      averageConfidence: readAverage(row.averageConfidence),
    }));

    const relationCountsByLanguage = new Map<string, number>();
    for (const row of db
      .prepare(`
        SELECT source.language AS language, COUNT(*) AS count
        FROM relations r
        JOIN symbols source ON source.id = r.from_id
        GROUP BY source.language
      `)
      .all() as Array<{ language: string; count: number }>) {
      relationCountsByLanguage.set(row.language, row.count);
    }

    const languageCoverage = (db
      .prepare(`
        SELECT language, COUNT(DISTINCT file_path) AS files, COUNT(*) AS symbols
        FROM symbols
        GROUP BY language
        ORDER BY language
      `)
      .all() as Array<{ language: string; files: number; symbols: number }>).map((row) => ({
        ...row,
        relations: relationCountsByLanguage.get(row.language) ?? 0,
      }));

    const unresolvedRatio = ratio(unresolvedRelations, relations);
    const invocationResolvedRatio = ratio(resolvedInvocations, invocations);
    const issues: string[] = [];
    const recommendations: string[] = [];

    if (symbols === 0) {
      issues.push('graph contains no symbols');
      recommendations.push('Rebuild the index and verify language support for graph extraction');
    }
    if (relations > 0 && unresolvedRatio > 0.5) {
      issues.push(`high unresolved relation ratio: ${(unresolvedRatio * 100).toFixed(1)}%`);
      recommendations.push('Review import and call resolution coverage for indexed languages');
    }
    if (relations > 0 && averageRelationConfidence < 0.75) {
      issues.push(`low average relation confidence: ${averageRelationConfidence.toFixed(3)}`);
      recommendations.push('Prefer exact symbol resolution before using graph impact results');
    }
    if (schemaHealth.status === 'degraded') {
      if (schemaHealth.missingIndexes.length > 0) {
        issues.push(`missing graph indexes: ${schemaHealth.missingIndexes.join(', ')}`);
        recommendations.push('Run schema migrations to restore graph indexes');
      }
      if (schemaHealth.missingVirtualTables.length > 0) {
        issues.push(`missing graph virtual tables: ${schemaHealth.missingVirtualTables.join(', ')}`);
        recommendations.push('Rebuild the index to restore graph FTS tables');
      }
      if (schemaHealth.missingMigrations.length > 0) {
        issues.push(`missing schema migrations: ${schemaHealth.missingMigrations.join(', ')}`);
        recommendations.push('Run index initialization to record expected schema migrations');
      }
    }

    return {
      projectId,
      repoPath,
      snapshotId: paths.snapshotId,
      dbPath: paths.dbPath,
      hasIndexDb: true,
      hasGraphTables: true,
      totals: {
        filesWithGraph,
        symbols,
        relations,
        invocations,
        unresolvedRelations,
        resolvedInvocations,
      },
      symbolTypes,
      schemaHealth,
      languageCoverage,
      relationHealth,
      unresolvedRatio,
      invocationResolvedRatio,
      averageRelationConfidence,
      overall: {
        status: issues.length > 0 ? 'degraded' : 'ok',
        issues,
        recommendations,
      },
    };
  } finally {
    db.close();
  }
}

export function formatGraphHealthReport(report: GraphHealthReport): string {
  const lines: string[] = [];
  lines.push('Graph Health');
  lines.push(`Status: ${report.overall.status.toUpperCase()}`);
  lines.push(`Project ID: ${report.projectId}`);
  lines.push(`Snapshot: ${report.snapshotId ?? 'legacy'}`);
  lines.push(`Index DB: ${report.hasIndexDb ? 'present' : 'missing'}`);
  lines.push(`Graph Tables: ${report.hasGraphTables ? 'present' : 'missing'}`);
  lines.push(`Schema Health: ${report.schemaHealth.status}`);
  lines.push('');
  lines.push('Totals:');
  lines.push(`- Files With Graph: ${report.totals.filesWithGraph}`);
  lines.push(`- Symbols: ${report.totals.symbols}`);
  lines.push(`- Relations: ${report.totals.relations}`);
  lines.push(`- Invocations: ${report.totals.invocations}`);
  lines.push(`- Unresolved Relations: ${report.totals.unresolvedRelations}`);
  lines.push(`- Unresolved Ratio: ${(report.unresolvedRatio * 100).toFixed(1)}%`);
  lines.push(`- Invocation Resolved Ratio: ${(report.invocationResolvedRatio * 100).toFixed(1)}%`);
  lines.push(`- Average Relation Confidence: ${report.averageRelationConfidence.toFixed(3)}`);

  lines.push('', 'Language Coverage:');
  if (report.languageCoverage.length === 0) {
    lines.push('- none');
  } else {
    for (const entry of report.languageCoverage) {
      lines.push(
        `- ${entry.language}: files=${entry.files} symbols=${entry.symbols} relations=${entry.relations}`,
      );
    }
  }

  lines.push('', 'Relation Health:');
  if (report.relationHealth.length === 0) {
    lines.push('- none');
  } else {
    for (const entry of report.relationHealth) {
      lines.push(
        `- ${entry.type}: count=${entry.count} resolved=${entry.resolved} unresolved=${entry.unresolved} avg_confidence=${entry.averageConfidence.toFixed(3)}`,
      );
    }
  }

  lines.push('', 'Schema Health:');
  lines.push(`- Missing Tables: ${report.schemaHealth.missingTables.join(', ') || 'none'}`);
  lines.push(
    `- Missing Columns: ${report.schemaHealth.missingColumns.map((entry) => `${entry.table}.${entry.column}`).join(', ') || 'none'}`,
  );
  lines.push(`- Missing Indexes: ${report.schemaHealth.missingIndexes.join(', ') || 'none'}`);
  lines.push(`- Missing Virtual Tables: ${report.schemaHealth.missingVirtualTables.join(', ') || 'none'}`);
  lines.push(`- Missing Migrations: ${report.schemaHealth.missingMigrations.join(', ') || 'none'}`);

  if (report.overall.issues.length > 0) {
    lines.push('', 'Issues:');
    lines.push(...report.overall.issues.map((issue) => `- ${issue}`));
  }

  if (report.overall.recommendations.length > 0) {
    lines.push('', 'Recommendations:');
    lines.push(...report.overall.recommendations.map((recommendation) => `- ${recommendation}`));
  }

  return lines.join('\n');
}
