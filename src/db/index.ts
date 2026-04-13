import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  batchDeleteFileFts,
  initChunksFts,
  initFilesFts,
  replaceFileFtsEntries,
} from '../search/fts.js';
import { resolveIndexPaths } from '../storage/layout.js';

/** 单文件 content 最大存储字节数 (512KB) */
const MAX_CONTENT_BYTES = 512 * 1024;

/**
 * 文件元数据接口
 */
export interface FileMeta {
  path: string;
  hash: string;
  mtime: number;
  size: number;
  content: string | null;
  language: string;
  /** 已成功写入向量索引的 hash（自愈机制核心字段） */
  vectorIndexHash: string | null;
}

const URI_SCHEME_RE = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//;

export function normalizeProjectPath(projectPath: string): string {
  const trimmed = projectPath.trim();

  if (URI_SCHEME_RE.test(trimmed)) {
    return trimmed.replace(/\/+$/, '');
  }

  const resolved = path.resolve(trimmed);
  try {
    return fs.realpathSync.native(resolved).replace(/\/+$/, '');
  } catch {
    return resolved.replace(/\/+$/, '');
  }
}

export function deriveStableProjectId(projectPath: string): string {
  return crypto.createHash('md5').update(projectPath).digest('hex').slice(0, 10);
}

/**
 * 生成项目唯一 ID
 * 基于路径 + 目录创建时间生成，确保删除后重建的同路径代码库会生成不同的 ID
 * @param projectPath 项目根路径
 * @returns 项目 ID (MD5 hash)
 */
export function generateProjectId(projectPath: string): string {
  return deriveStableProjectId(normalizeProjectPath(projectPath));
}

const SCHEMA_MIGRATION_ADD_VECTOR_INDEX_HASH = '20260409_add_vector_index_hash_to_files';
const SCHEMA_MIGRATION_RESERVE_CODE_GRAPH = '20260410_reserve_code_graph_hooks';
const SCHEMA_MIGRATION_ADD_CODE_GRAPH_TABLES = '20260410_add_code_graph_tables';
const SCHEMA_MIGRATION_RELATIONS_ALLOW_UNRESOLVED = '20260410_relations_allow_unresolved_targets';

function readStringField(row: unknown, key: string): string | undefined {
  if (!row || typeof row !== 'object') {
    return undefined;
  }
  const value = Reflect.get(row, key);
  return typeof value === 'string' ? value : undefined;
}

function readNumberField(row: unknown, key: string): number | undefined {
  if (!row || typeof row !== 'object') {
    return undefined;
  }
  const value = Reflect.get(row, key);
  return typeof value === 'number' ? value : undefined;
}

function ensureBaseSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      hash TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL,
      content TEXT,
      language TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_files_hash ON files(hash);
    CREATE INDEX IF NOT EXISTS idx_files_mtime ON files(mtime);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((row) => readStringField(row, 'name') === column);
}

function hasAppliedMigration(db: Database.Database, version: string): boolean {
  const row = db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(version);
  return readNumberField(row, '1') === 1;
}

function recordSchemaMigration(db: Database.Database, version: string): void {
  db.prepare(
    `
      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
      VALUES (?, ?)
    `,
  ).run(version, new Date().toISOString());
}

function getCreateTableSql(db: Database.Database, table: string): string | null {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
  return readStringField(row, 'sql') ?? null;
}

function rebuildRelationsTableWithoutForeignKeys(db: Database.Database): void {
  db.exec(`
    CREATE TABLE relations_next (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      type TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 1.0,
      reason TEXT
    );

    INSERT INTO relations_next (id, from_id, to_id, type, confidence, reason)
    SELECT id, from_id, to_id, type, confidence, reason
    FROM relations;

    DROP TABLE relations;
    ALTER TABLE relations_next RENAME TO relations;

    CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_id);
    CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_id);
    CREATE INDEX IF NOT EXISTS idx_relations_type ON relations(type);
  `);
}

function applySchemaMigrations(db: Database.Database): void {
  if (!hasAppliedMigration(db, SCHEMA_MIGRATION_ADD_VECTOR_INDEX_HASH)) {
    if (!hasColumn(db, 'files', 'vector_index_hash')) {
      db.exec(`ALTER TABLE files ADD COLUMN ${'vector_index_hash'} TEXT`);
    }
    recordSchemaMigration(db, SCHEMA_MIGRATION_ADD_VECTOR_INDEX_HASH);
  }

  if (!hasAppliedMigration(db, SCHEMA_MIGRATION_RESERVE_CODE_GRAPH)) {
    // Phase 0: 仅预留 code graph migration 钩子，不创建任何新表。
    recordSchemaMigration(db, SCHEMA_MIGRATION_RESERVE_CODE_GRAPH);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS symbols (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      file_path TEXT NOT NULL,
      language TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      modifiers TEXT NOT NULL DEFAULT '[]',
      parent_id TEXT,
      exported INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (file_path) REFERENCES files(path)
    );

    CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_path);
    CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
    CREATE INDEX IF NOT EXISTS idx_symbols_type ON symbols(type);
    CREATE INDEX IF NOT EXISTS idx_symbols_parent ON symbols(parent_id);

    CREATE TABLE IF NOT EXISTS relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      type TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 1.0,
      reason TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_id);
    CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_id);
    CREATE INDEX IF NOT EXISTS idx_relations_type ON relations(type);

    CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts
    USING fts5(symbol_id UNINDEXED, name, file_path);
  `);

  if (!hasAppliedMigration(db, SCHEMA_MIGRATION_ADD_CODE_GRAPH_TABLES)) {
    recordSchemaMigration(db, SCHEMA_MIGRATION_ADD_CODE_GRAPH_TABLES);
  }

  const relationsSql = getCreateTableSql(db, 'relations') ?? '';
  const relationsNeedRebuild = /FOREIGN KEY/i.test(relationsSql);
  if (relationsNeedRebuild) {
    rebuildRelationsTableWithoutForeignKeys(db);
  }
  if (!hasAppliedMigration(db, SCHEMA_MIGRATION_RELATIONS_ALLOW_UNRESOLVED)) {
    recordSchemaMigration(db, SCHEMA_MIGRATION_RELATIONS_ALLOW_UNRESOLVED);
  }
}

/**
 * 初始化数据库连接
 * @param projectId 项目 ID
 * @returns 数据库实例
 */
export function initDb(projectId: string, snapshotId?: string | null): Database.Database {
  const { dbPath } = resolveIndexPaths(projectId, { snapshotId });
  const dbDir = path.dirname(dbPath);

  // 确保目录存在
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');

  ensureBaseSchema(db);
  applySchemaMigrations(db);

  // 初始化 FTS 表（词法搜索支持）
  initFilesFts(db);
  initChunksFts(db);

  return db;
}

/**
 * 关闭数据库连接
 */
export function closeDb(db: Database.Database): void {
  db.close();
}

/**
 * 获取所有文件元数据
 */
export function getAllFileMeta(
  db: Database.Database,
): Map<string, Pick<FileMeta, 'mtime' | 'hash' | 'size' | 'vectorIndexHash'>> {
  const rows = db.prepare('SELECT path, hash, mtime, size, vector_index_hash FROM files').all();

  const map = new Map();
  for (const row of rows) {
    const filePath = readStringField(row, 'path');
    const hash = readStringField(row, 'hash');
    const mtime = readNumberField(row, 'mtime');
    const size = readNumberField(row, 'size');

    if (!filePath || !hash || mtime === undefined || size === undefined) {
      continue;
    }

    const vectorIndexHash = row && typeof row === 'object' ? Reflect.get(row, 'vector_index_hash') : undefined;
    map.set(filePath, {
      mtime,
      hash,
      size,
      vectorIndexHash: typeof vectorIndexHash === 'string' ? vectorIndexHash : null,
    });
  }
  return map;
}

/**
 * 获取需要向量索引的文件路径
 * 自愈机制：返回 vector_index_hash != hash 的文件
 */
export function getFilesNeedingVectorIndex(db: Database.Database): string[] {
  const rows = db
    .prepare('SELECT path FROM files WHERE vector_index_hash IS NULL OR vector_index_hash != hash')
    .all();
  return rows
    .map((row) => readStringField(row, 'path'))
    .filter((path): path is string => Boolean(path));
}

/**
 * 批量更新 vector_index_hash
 * 只有当向量完整写入成功后才调用
 */
export function batchUpdateVectorIndexHash(
  db: Database.Database,
  items: Array<{ path: string; hash: string }>,
): void {
  const update = db.prepare('UPDATE files SET vector_index_hash = ? WHERE path = ?');

  const transaction = db.transaction((data: Array<{ path: string; hash: string }>) => {
    for (const item of data) {
      update.run(item.hash, item.path);
    }
  });

  transaction(items);
}

/**
 * 清除文件的 vector_index_hash（用于标记需要重新索引）
 */
export function clearVectorIndexHash(db: Database.Database, paths: string[]): void {
  const update = db.prepare('UPDATE files SET vector_index_hash = NULL WHERE path = ?');

  const transaction = db.transaction((items: string[]) => {
    for (const item of items) {
      update.run(item);
    }
  });

  transaction(paths);
}

/**
 * 批量插入/更新文件记录
 */
export function batchUpsert(db: Database.Database, files: FileMeta[]): void {
  const insert = db.prepare(`
    INSERT INTO files (path, hash, mtime, size, content, language)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      hash = excluded.hash,
      mtime = excluded.mtime,
      size = excluded.size,
      content = excluded.content,
      language = excluded.language
  `);

  const transaction = db.transaction((items: FileMeta[]) => {
    for (const item of items) {
      // 超大文件不存储 content，仅存元数据
      const content = item.content && Buffer.byteLength(item.content, 'utf8') > MAX_CONTENT_BYTES
        ? null
        : item.content;
      insert.run(item.path, item.hash, item.mtime, item.size, content, item.language);
    }
  });

  transaction(files);

  // 同步 FTS 索引 - 大文件 content 已置 null，自然跳过
  // 重新检查：只有 content 非空且不超过大小限制才加入 FTS
  const ftsFiles: Array<{ path: string; content: string }> = [];
  for (const f of files) {
    if (f.content !== null && Buffer.byteLength(f.content, 'utf8') <= MAX_CONTENT_BYTES) {
      ftsFiles.push({ path: f.path, content: f.content });
    }
  }
  if (ftsFiles.length > 0) {
    replaceFileFtsEntries(db, ftsFiles);
  }
}

/**
 * 批量更新 mtime
 */
export function batchUpdateMtime(
  db: Database.Database,
  items: Array<{ path: string; mtime: number }>,
): void {
  const update = db.prepare('UPDATE files SET mtime = ? WHERE path = ?');

  const transaction = db.transaction((data: Array<{ path: string; mtime: number }>) => {
    for (const item of data) {
      update.run(item.mtime, item.path);
    }
  });

  transaction(items);
}

/**
 * 获取所有已索引的文件路径
 */
export function getAllPaths(db: Database.Database): string[] {
  const rows = db.prepare('SELECT path FROM files').all();
  return rows
    .map((row) => readStringField(row, 'path'))
    .filter((path): path is string => Boolean(path));
}

/**
 * 获取单个文件的内容
 * 用于需要按需加载 content 的场景（GraphExpander import 解析等）
 */
export function getFileContent(db: Database.Database, filePath: string): string | null {
  const row = db.prepare('SELECT content FROM files WHERE path = ?').get(filePath) as
    | { content: string | null }
    | undefined;
  return row?.content ?? null;
}

/**
 * 清理超大 content 数据（维护工具）
 * 供 ops 命令调用，回收 DB 空间
 * @returns 被清理的文件数
 */
export function pruneLargeContent(db: Database.Database, maxBytes = MAX_CONTENT_BYTES): number {
  const rows = db
    .prepare('SELECT path, content FROM files WHERE content IS NOT NULL')
    .all() as Array<{ path: string; content: string }>;

  const toPrune: string[] = [];
  for (const row of rows) {
    if (Buffer.byteLength(row.content, 'utf8') > maxBytes) {
      toPrune.push(row.path);
    }
  }

  if (toPrune.length > 0) {
    const stmt = db.prepare('UPDATE files SET content = NULL WHERE path = ?');
    const transaction = db.transaction((paths: string[]) => {
      for (const p of paths) {
        stmt.run(p);
      }
    });
    transaction(toPrune);
  }

  return toPrune.length;
}

/**
 * 批量删除文件
 */
export function batchDelete(db: Database.Database, paths: string[]): void {
  const stmt = db.prepare('DELETE FROM files WHERE path = ?');

  const transaction = db.transaction((items: string[]) => {
    for (const item of items) {
      const symbolIds = db
        .prepare('SELECT id FROM symbols WHERE file_path = ?')
        .all(item)
        .map((row) => readStringField(row, 'id'))
        .filter((id): id is string => Boolean(id));

      if (symbolIds.length > 0) {
        const placeholders = symbolIds.map(() => '?').join(', ');
        db.prepare(`DELETE FROM relations WHERE from_id IN (${placeholders}) OR to_id IN (${placeholders})`).run(
          ...symbolIds,
          ...symbolIds,
        );
        db.prepare(`DELETE FROM symbols_fts WHERE symbol_id IN (${placeholders})`).run(...symbolIds);
      } else {
        db.prepare('DELETE FROM symbols_fts WHERE file_path = ?').run(item);
      }

      db.prepare('DELETE FROM symbols WHERE file_path = ?').run(item);
    }

    for (const item of items) {
      stmt.run(item);
    }
  });

  transaction(paths);

  // 同步删除 FTS 索引
  if (paths.length > 0) {
    batchDeleteFileFts(db, paths);
  }
}

/**
 * 清空数据库
 */
export function clear(db: Database.Database): void {
  db.exec(`
    DELETE FROM relations;
    DELETE FROM symbols_fts;
    DELETE FROM symbols;
    DELETE FROM files;
  `);
}

// ===========================================
// Metadata 操作
// ===========================================

const METADATA_KEY_EMBEDDING_DIMENSIONS = 'embedding_dimensions';
const METADATA_KEY_INDEX_CONTENT_SCHEMA_VERSION = 'index_content_schema_version';

/**
 * 获取 metadata 值
 */
function getMetadata(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get(key);
  return readStringField(row, 'value') ?? null;
}

/**
 * 设置 metadata 值
 */
function setMetadata(db: Database.Database, key: string, value: string): void {
  db.prepare(`
    INSERT INTO metadata (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

/**
 * 获取存储的 embedding dimensions
 * @returns 存储的维度值，如果没有存储则返回 null
 */
export function getStoredEmbeddingDimensions(db: Database.Database): number | null {
  const value = getMetadata(db, METADATA_KEY_EMBEDDING_DIMENSIONS);
  if (value === null) return null;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * 设置 embedding dimensions
 */
export function setStoredEmbeddingDimensions(db: Database.Database, dimensions: number): void {
  setMetadata(db, METADATA_KEY_EMBEDDING_DIMENSIONS, String(dimensions));
}

export function getStoredIndexContentSchemaVersion(db: Database.Database): number | null {
  const value = getMetadata(db, METADATA_KEY_INDEX_CONTENT_SCHEMA_VERSION);
  if (value === null) return null;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

export function setStoredIndexContentSchemaVersion(
  db: Database.Database,
  version: number,
): void {
  setMetadata(db, METADATA_KEY_INDEX_CONTENT_SCHEMA_VERSION, String(version));
}
