import fs from 'node:fs';
import path from 'node:path';
import * as lancedb from '@lancedb/lancedb';
import Database from 'better-sqlite3';
import { resolveBaseDir } from '../runtimePaths.js';

const SNAPSHOTS_DIR_NAME = 'snapshots';
const CURRENT_POINTER_FILE = 'current';
const INDEX_DB_FILE = 'index.db';
const VECTOR_DIR_NAME = 'vectors.lance';
const DEFAULT_SNAPSHOT_RETENTION = 5;

type SnapshotSource = 'current' | 'legacy' | 'empty';
export type SnapshotCopyMode = 'copy' | 'reflink';
export type SnapshotCopyStrategy = 'copy' | 'reflink-preferred';

export interface SnapshotPrepareOptions {
  copyStrategy?: SnapshotCopyStrategy;
  fileCopier?: SnapshotFileCopier;
}

export type SnapshotFileCopier = (
  sourcePath: string,
  targetPath: string,
  mode: SnapshotCopyMode,
) => void;

interface IndexPathsOptions {
  baseDir?: string;
  snapshotId?: string | null;
}

export interface IndexPaths {
  projectDir: string;
  snapshotId: string | null;
  dataDir: string;
  dbPath: string;
  vectorPath: string;
}

export interface PreparedSnapshot {
  snapshotId: string;
  snapshotDir: string;
  source: SnapshotSource;
  copyMode: SnapshotCopyMode | null;
}

export interface SnapshotValidationOptions {
  baseDir?: string;
  expectVectorIndex?: boolean;
}

export interface SnapshotPruneResult {
  kept: string[];
  deleted: string[];
}

function effectiveBaseDir(baseDir?: string): string {
  if (baseDir) return baseDir;
  return resolveBaseDir();
}

function projectDir(projectId: string, baseDir?: string): string {
  return path.join(effectiveBaseDir(baseDir), projectId);
}

function snapshotsDir(projectId: string, baseDir?: string): string {
  return path.join(projectDir(projectId, baseDir), SNAPSHOTS_DIR_NAME);
}

function currentPointerPath(projectId: string, baseDir?: string): string {
  return path.join(projectDir(projectId, baseDir), CURRENT_POINTER_FILE);
}

function snapshotDir(projectId: string, snapshotId: string, baseDir?: string): string {
  return path.join(snapshotsDir(projectId, baseDir), snapshotId);
}

function legacyDataDir(projectId: string, baseDir?: string): string {
  return projectDir(projectId, baseDir);
}

function listSnapshotIds(projectId: string, baseDir?: string): string[] {
  const root = snapshotsDir(projectId, baseDir);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function hasIndexDb(dir: string): boolean {
  return fs.existsSync(path.join(dir, INDEX_DB_FILE));
}

function hasVectorDir(dir: string): boolean {
  return fs.existsSync(path.join(dir, VECTOR_DIR_NAME));
}

function defaultFileCopier(sourcePath: string, targetPath: string, mode: SnapshotCopyMode): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  if (mode === 'reflink') {
    fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_FICLONE);
    return;
  }
  fs.copyFileSync(sourcePath, targetPath);
}

function copyDirectoryRecursive(
  sourceDir: string,
  targetDir: string,
  mode: SnapshotCopyMode,
  fileCopier: SnapshotFileCopier,
): void {
  fs.mkdirSync(targetDir, { recursive: true });
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      copyDirectoryRecursive(sourcePath, targetPath, mode, fileCopier);
      continue;
    }

    fileCopier(sourcePath, targetPath, mode);
  }
}

function copyDataArtifacts(
  sourceDir: string,
  targetDir: string,
  options: SnapshotPrepareOptions = {},
): SnapshotCopyMode {
  const preferredMode: SnapshotCopyMode =
    options.copyStrategy === 'copy' ? 'copy' : 'reflink';
  const fallbackMode: SnapshotCopyMode = 'copy';
  const fileCopier = options.fileCopier ?? defaultFileCopier;
  let appliedMode = preferredMode;

  const copyFileWithFallback = (sourcePath: string, targetPath: string): void => {
    try {
      fileCopier(sourcePath, targetPath, preferredMode);
    } catch (error) {
      if (preferredMode !== 'reflink') {
        throw error;
      }
      fileCopier(sourcePath, targetPath, fallbackMode);
      appliedMode = fallbackMode;
    }
  };

  const copyDirWithFallback = (sourcePath: string, targetPath: string): void => {
    try {
      copyDirectoryRecursive(sourcePath, targetPath, preferredMode, fileCopier);
    } catch (error) {
      if (preferredMode !== 'reflink') {
        throw error;
      }
      fs.rmSync(targetPath, { recursive: true, force: true });
      copyDirectoryRecursive(sourcePath, targetPath, fallbackMode, fileCopier);
      appliedMode = fallbackMode;
    }
  };

  const sourceDb = path.join(sourceDir, INDEX_DB_FILE);
  if (fs.existsSync(sourceDb)) {
    copyFileWithFallback(sourceDb, path.join(targetDir, INDEX_DB_FILE));
  }

  const sourceVector = path.join(sourceDir, VECTOR_DIR_NAME);
  if (fs.existsSync(sourceVector)) {
    copyDirWithFallback(sourceVector, path.join(targetDir, VECTOR_DIR_NAME));
  }

  return appliedMode;
}

function makeSnapshotId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `snap-${Date.now()}-${rand}`;
}

export function resolveCurrentSnapshotId(projectId: string, baseDir?: string): string | null {
  const pointer = currentPointerPath(projectId, baseDir);
  if (!fs.existsSync(pointer)) return null;

  try {
    const snapshotId = fs.readFileSync(pointer, 'utf-8').trim();
    if (!snapshotId) return null;
    const dir = snapshotDir(projectId, snapshotId, baseDir);
    if (!fs.existsSync(dir)) return null;
    return snapshotId;
  } catch {
    return null;
  }
}

export function resolveIndexPaths(projectId: string, options: IndexPathsOptions = {}): IndexPaths {
  const baseDir = effectiveBaseDir(options.baseDir);
  const project = projectDir(projectId, baseDir);
  const resolvedSnapshotId =
    options.snapshotId === undefined
      ? resolveCurrentSnapshotId(projectId, baseDir)
      : options.snapshotId;

  const dataDir =
    resolvedSnapshotId === null
      ? legacyDataDir(projectId, baseDir)
      : snapshotDir(projectId, resolvedSnapshotId, baseDir);

  return {
    projectDir: project,
    snapshotId: resolvedSnapshotId,
    dataDir,
    dbPath: path.join(dataDir, INDEX_DB_FILE),
    vectorPath: path.join(dataDir, VECTOR_DIR_NAME),
  };
}

export function hasIndexedData(projectId: string, baseDir?: string): boolean {
  const currentPaths = resolveIndexPaths(projectId, { baseDir });
  if (hasIndexDb(currentPaths.dataDir)) return true;

  const legacyPaths = resolveIndexPaths(projectId, { baseDir, snapshotId: null });
  return hasIndexDb(legacyPaths.dataDir);
}

export function prepareWritableSnapshot(
  projectId: string,
  baseDir?: string,
  options: SnapshotPrepareOptions = {},
): PreparedSnapshot {
  const base = effectiveBaseDir(baseDir);
  const project = projectDir(projectId, base);
  const snapshotRoot = snapshotsDir(projectId, base);
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(snapshotRoot, { recursive: true });

  const snapshotId = makeSnapshotId();
  const targetDir = snapshotDir(projectId, snapshotId, base);
  fs.mkdirSync(targetDir, { recursive: true });

  const currentId = resolveCurrentSnapshotId(projectId, base);
  if (currentId) {
    const copyMode = copyDataArtifacts(snapshotDir(projectId, currentId, base), targetDir, options);
    return { snapshotId, snapshotDir: targetDir, source: 'current', copyMode };
  }

  const legacyDir = legacyDataDir(projectId, base);
  if (hasIndexDb(legacyDir) || hasVectorDir(legacyDir)) {
    const copyMode = copyDataArtifacts(legacyDir, targetDir, options);
    return { snapshotId, snapshotDir: targetDir, source: 'legacy', copyMode };
  }

  return { snapshotId, snapshotDir: targetDir, source: 'empty', copyMode: null };
}

export function commitSnapshot(projectId: string, snapshotId: string, baseDir?: string): void {
  const base = effectiveBaseDir(baseDir);
  const targetDir = snapshotDir(projectId, snapshotId, base);
  if (!fs.existsSync(targetDir)) {
    throw new Error(`快照目录不存在: ${targetDir}`);
  }

  const project = projectDir(projectId, base);
  fs.mkdirSync(project, { recursive: true });

  const pointer = currentPointerPath(projectId, base);
  const tmp = `${pointer}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, snapshotId, 'utf-8');
  fs.renameSync(tmp, pointer);
}

export async function validateSnapshot(
  projectId: string,
  snapshotId: string,
  options: SnapshotValidationOptions = {},
): Promise<void> {
  const expectVectorIndex = options.expectVectorIndex ?? true;
  const { dbPath, vectorPath } = resolveIndexPaths(projectId, {
    baseDir: options.baseDir,
    snapshotId,
  });

  if (!fs.existsSync(dbPath)) {
    throw new Error(`快照缺少 index.db: ${dbPath}`);
  }

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get() as
      | { integrity_check?: string }
      | undefined;
    if (!integrity?.integrity_check || integrity.integrity_check.toLowerCase() !== 'ok') {
      throw new Error(`SQLite integrity_check 失败: ${integrity?.integrity_check ?? 'unknown'}`);
    }

    const filesTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='files'")
      .get() as { name: string } | undefined;
    if (!filesTable) {
      throw new Error('快照缺少 files 表');
    }

    if (!expectVectorIndex) return;

    const fileCount = (db.prepare('SELECT COUNT(*) as c FROM files').get() as { c: number }).c;
    const pendingVectorCount = (
      db
        .prepare(
          'SELECT COUNT(*) as c FROM files WHERE vector_index_hash IS NULL OR vector_index_hash != hash',
        )
        .get() as { c: number }
    ).c;
    if (pendingVectorCount > 0) {
      throw new Error(`快照向量索引未收敛: vector_index_hash 待同步 ${pendingVectorCount} 条`);
    }

    if (fileCount > 0 && !fs.existsSync(vectorPath)) {
      throw new Error(`快照缺少 vectors.lance: ${vectorPath}`);
    }
  } finally {
    db.close();
  }

  if (expectVectorIndex && fs.existsSync(vectorPath)) {
    const conn = await lancedb.connect(vectorPath);
    await conn.tableNames();
  }
}

export function pruneSnapshots(
  projectId: string,
  keepRecent: number = DEFAULT_SNAPSHOT_RETENTION,
  baseDir?: string,
): SnapshotPruneResult {
  const normalizedKeepRecent = Math.max(0, keepRecent);
  const root = snapshotsDir(projectId, baseDir);
  if (!fs.existsSync(root)) return { kept: [], deleted: [] };

  const currentId = resolveCurrentSnapshotId(projectId, baseDir);
  const snapshots = listSnapshotIds(projectId, baseDir).sort((a, b) => {
    const aMtime = fs.statSync(snapshotDir(projectId, a, baseDir)).mtimeMs;
    const bMtime = fs.statSync(snapshotDir(projectId, b, baseDir)).mtimeMs;
    return bMtime - aMtime;
  });

  const keepSet = new Set<string>(snapshots.slice(0, normalizedKeepRecent));
  if (currentId) keepSet.add(currentId);

  const deleted: string[] = [];
  for (const id of snapshots) {
    if (keepSet.has(id)) continue;
    fs.rmSync(snapshotDir(projectId, id, baseDir), { recursive: true, force: true });
    deleted.push(id);
  }

  const kept = snapshots.filter(
    (id) => keepSet.has(id) && fs.existsSync(snapshotDir(projectId, id, baseDir)),
  );
  return { kept, deleted };
}
