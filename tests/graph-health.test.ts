import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

import { batchUpsert, closeDb, initDb } from '../src/db/index.ts';
import { GraphStore } from '../src/graph/GraphStore.ts';
import type { GraphWritePayload } from '../src/graph/types.ts';
import {
  analyzeGraphHealth,
  formatGraphHealthReport,
} from '../src/monitoring/graphHealth.ts';
import { resolveIndexPaths } from '../src/storage/layout.ts';

function makeBaseDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cw-graph-health-'));
}

function seedFile(projectId: string, filePath: string): void {
  const db = initDb(projectId);
  try {
    batchUpsert(db, [
      {
        path: filePath,
        hash: 'h1',
        mtime: 1,
        size: 120,
        content: 'export class UserService {}',
        language: 'typescript',
        vectorIndexHash: null,
      },
    ]);
  } finally {
    closeDb(db);
  }
}

function payload(filePath: string): GraphWritePayload {
  const classId = `typescript:${filePath}:UserService:1`;
  const methodId = `typescript:${filePath}:updatePassword:2`;
  const localFunctionId = `typescript:${filePath}:hashLocal:8`;
  return {
    symbols: [
      {
        id: classId,
        name: 'UserService',
        type: 'Class',
        filePath,
        language: 'typescript',
        startLine: 1,
        endLine: 7,
        modifiers: ['export'],
        parentId: null,
        exported: true,
      },
      {
        id: methodId,
        name: 'updatePassword',
        type: 'Method',
        filePath,
        language: 'typescript',
        startLine: 2,
        endLine: 6,
        modifiers: [],
        parentId: classId,
        exported: false,
      },
      {
        id: localFunctionId,
        name: 'hashLocal',
        type: 'Function',
        filePath,
        language: 'typescript',
        startLine: 8,
        endLine: 10,
        modifiers: [],
        parentId: null,
        exported: false,
      },
    ],
    relations: [
      { fromId: classId, toId: methodId, type: 'HAS_METHOD', confidence: 1 },
      { fromId: methodId, toId: localFunctionId, type: 'CALLS', confidence: 1 },
      {
        fromId: methodId,
        toId: `typescript:${filePath}:call:hashPassword`,
        type: 'CALLS',
        confidence: 0.5,
        reason: 'call:hashPassword',
      },
    ],
    invocations: [
      {
        id: `${methodId}:call:hashLocal:3`,
        filePath,
        enclosingSymbolId: methodId,
        calleeName: 'hashLocal',
        resolvedTargetId: localFunctionId,
        startLine: 3,
        endLine: 3,
      },
      {
        id: `${methodId}:call:hashPassword:4`,
        filePath,
        enclosingSymbolId: methodId,
        calleeName: 'hashPassword',
        resolvedTargetId: null,
        startLine: 4,
        endLine: 4,
      },
    ],
  };
}

test('analyzeGraphHealth reports relation confidence and unresolved coverage', () => {
  const baseDir = makeBaseDir();
  const previousBaseDir = process.env.CONTEXTATLAS_BASE_DIR;
  process.env.CONTEXTATLAS_BASE_DIR = baseDir;
  const projectId = 'graph-health-project';
  const filePath = 'src/user/UserService.ts';

  try {
    seedFile(projectId, filePath);
    const db = initDb(projectId);
    try {
      new GraphStore(db).upsertFile(filePath, payload(filePath));
    } finally {
      closeDb(db);
    }

    const report = analyzeGraphHealth({ projectId });

    assert.equal(report.overall.status, 'ok');
    assert.equal(report.schemaHealth.status, 'ok');
    assert.deepEqual(report.schemaHealth.missingColumns, []);
    assert.deepEqual(report.schemaHealth.missingIndexes, []);
    assert.deepEqual(report.schemaHealth.missingVirtualTables, []);
    assert.deepEqual(report.schemaHealth.missingMigrations, []);
    assert.equal(report.totals.filesWithGraph, 1);
    assert.equal(report.totals.symbols, 3);
    assert.equal(report.totals.relations, 3);
    assert.equal(report.totals.unresolvedRelations, 1);
    assert.equal(report.totals.invocations, 2);
    assert.equal(report.totals.resolvedInvocations, 1);
    assert.equal(report.unresolvedRatio, 0.333);
    assert.equal(report.invocationResolvedRatio, 0.5);
    assert.equal(report.averageRelationConfidence, 0.833);
    assert.equal(report.symbolTypes.Class, 1);
    assert.equal(report.languageCoverage[0]?.language, 'typescript');
    assert.equal(report.languageCoverage[0]?.relations, 3);
    assert.ok(report.relationHealth.some((entry) => entry.type === 'CALLS' && entry.unresolved === 1));

    const text = formatGraphHealthReport(report);
    assert.match(text, /Graph Health/);
    assert.match(text, /Schema Health: ok/);
    assert.match(text, /Missing Columns: none/);
    assert.match(text, /Unresolved Ratio: 33.3%/);
    assert.match(text, /typescript: files=1 symbols=3 relations=3/);
  } finally {
    if (previousBaseDir === undefined) {
      delete process.env.CONTEXTATLAS_BASE_DIR;
    } else {
      process.env.CONTEXTATLAS_BASE_DIR = previousBaseDir;
    }
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('analyzeGraphHealth reports missing index without creating a database', () => {
  const baseDir = makeBaseDir();
  const projectId = 'missing-graph-project';

  try {
    const report = analyzeGraphHealth({ projectId, baseDir });

    assert.equal(report.overall.status, 'missing');
    assert.equal(report.schemaHealth.status, 'missing');
    assert.ok(report.schemaHealth.missingTables.includes('symbols'));
    assert.equal(report.hasIndexDb, false);
    assert.match(report.overall.issues[0] ?? '', /index database is missing/);
    assert.equal(fs.existsSync(report.dbPath), false);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('analyzeGraphHealth reports degraded schema without mutating legacy databases', () => {
  const baseDir = makeBaseDir();
  const projectId = 'legacy-graph-project';
  const paths = resolveIndexPaths(projectId, { baseDir, snapshotId: null });

  try {
    fs.mkdirSync(paths.dataDir, { recursive: true });
    const db = new Database(paths.dbPath);
    try {
      db.exec(`
        CREATE TABLE files (
          path TEXT PRIMARY KEY,
          hash TEXT NOT NULL,
          mtime INTEGER NOT NULL,
          size INTEGER NOT NULL,
          content TEXT,
          language TEXT NOT NULL
        );
        CREATE TABLE schema_migrations (
          version TEXT PRIMARY KEY,
          applied_at TEXT NOT NULL
        );
        CREATE TABLE symbols (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          type TEXT NOT NULL,
          file_path TEXT NOT NULL,
          language TEXT NOT NULL,
          start_line INTEGER NOT NULL,
          end_line INTEGER NOT NULL,
          modifiers TEXT NOT NULL DEFAULT '[]',
          parent_id TEXT,
          exported INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE relations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          from_id TEXT NOT NULL,
          to_id TEXT NOT NULL,
          type TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 1.0,
          reason TEXT
        );
        CREATE TABLE invocations (
          id TEXT PRIMARY KEY,
          file_path TEXT NOT NULL,
          enclosing_symbol_id TEXT,
          callee_name TEXT NOT NULL,
          start_line INTEGER NOT NULL,
          end_line INTEGER NOT NULL
        );
      `);
    } finally {
      db.close();
    }

    const report = analyzeGraphHealth({ projectId, baseDir, snapshotId: null });

    assert.equal(report.hasIndexDb, true);
    assert.equal(report.hasGraphTables, true);
    assert.equal(report.overall.status, 'degraded');
    assert.equal(report.schemaHealth.status, 'degraded');
    assert.ok(
      report.schemaHealth.missingColumns.some(
        (entry) => entry.table === 'files' && entry.column === 'vector_index_hash',
      ),
    );
    assert.ok(
      report.schemaHealth.missingColumns.some(
        (entry) => entry.table === 'invocations' && entry.column === 'resolved_target_id',
      ),
    );
    assert.equal(fs.existsSync(paths.dbPath), true);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('analyzeGraphHealth reports missing schema when required non-graph tables are absent', () => {
  const baseDir = makeBaseDir();
  const projectId = 'partial-schema-project';
  const paths = resolveIndexPaths(projectId, { baseDir, snapshotId: null });

  try {
    fs.mkdirSync(paths.dataDir, { recursive: true });
    const db = new Database(paths.dbPath);
    try {
      db.exec(`
        CREATE TABLE symbols (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          type TEXT NOT NULL,
          file_path TEXT NOT NULL,
          language TEXT NOT NULL,
          start_line INTEGER NOT NULL,
          end_line INTEGER NOT NULL,
          modifiers TEXT NOT NULL DEFAULT '[]',
          parent_id TEXT,
          exported INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE relations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          from_id TEXT NOT NULL,
          to_id TEXT NOT NULL,
          type TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 1.0,
          reason TEXT
        );
        CREATE TABLE invocations (
          id TEXT PRIMARY KEY,
          file_path TEXT NOT NULL,
          enclosing_symbol_id TEXT,
          callee_name TEXT NOT NULL,
          resolved_target_id TEXT,
          start_line INTEGER NOT NULL,
          end_line INTEGER NOT NULL
        );
      `);
    } finally {
      db.close();
    }

    const report = analyzeGraphHealth({ projectId, baseDir, snapshotId: null });

    assert.equal(report.hasIndexDb, true);
    assert.equal(report.hasGraphTables, true);
    assert.equal(report.schemaHealth.status, 'missing');
    assert.equal(report.overall.status, 'missing');
    assert.ok(report.schemaHealth.missingTables.includes('files'));
    assert.ok(report.schemaHealth.missingTables.includes('schema_migrations'));
    assert.match(report.overall.issues[0] ?? '', /missing required tables/);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});
