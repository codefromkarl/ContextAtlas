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

function applySchemaMigrations(db: Database.Database): void {
  if (!hasAppliedMigration(db, SCHEMA_MIGRATION_ADD_VECTOR_INDEX_HASH)) {
    if (!hasColumn(db, 'files', 'vector_index_hash')) {
      db.exec(`ALTER TABLE files ADD COLUMN ${'vector_index_hash'} TEXT`);
    }
    recordSchemaMigration(db, SCHEMA_MIGRATION_ADD_VECTOR_INDEX_HASH);
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
      insert.run(item.path, item.hash, item.mtime, item.size, item.content, item.language);
    }
  });

  transaction(files);

  // 同步 FTS 索引
  // 使用类型守卫过滤 null，TypeScript 可以正确推断类型
  const ftsFiles: Array<{ path: string; content: string }> = [];
  for (const f of files) {
    if (f.content !== null) {
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
 * 批量删除文件
 */
export function batchDelete(db: Database.Database, paths: string[]): void {
  const stmt = db.prepare('DELETE FROM files WHERE path = ?');

  const transaction = db.transaction((items: string[]) => {
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
  db.exec('DELETE FROM files');
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
