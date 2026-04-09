import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expandHome, resolveBaseDir, resolveUsageDbPathFromEnv } from '../runtimePaths.js';

const DEFAULT_USAGE_DB_FILE = 'usage-tracker.db';

export interface ToolUsageInput {
  timestamp?: string;
  source: string;
  toolName: string;
  projectId?: string;
  repoPath?: string;
  requestId?: string;
  status: 'success' | 'error';
  durationMs?: number;
  queryLength?: number;
  indexState?: 'missing' | 'ready' | 'unknown';
  indexAction?: 'none' | 'enqueue_full' | 'enqueue_incremental' | 'index_required' | 'queue_error';
  error?: string;
}

export interface IndexUsageInput {
  timestamp?: string;
  projectId?: string;
  repoPath?: string;
  taskId?: string;
  scope?: 'full' | 'incremental';
  phase: 'enqueue' | 'execute';
  status: 'queued' | 'running' | 'done' | 'failed' | 'reused';
  requestedBy?: string;
  reusedExisting?: boolean;
  durationMs?: number;
  error?: string;
}

export interface ToolUsageRecord extends ToolUsageInput {
  eventId: number;
  timestamp: string;
  day: string;
}

export interface IndexUsageRecord extends IndexUsageInput {
  eventId: number;
  timestamp: string;
  day: string;
}

type ToolUsageRow = Record<string, unknown>;
type IndexUsageRow = Record<string, unknown>;

const TOOL_USAGE_STATUS: ToolUsageRecord['status'][] = ['success', 'error'];
const TOOL_INDEX_STATE: NonNullable<ToolUsageRecord['indexState']>[] = ['missing', 'ready', 'unknown'];
const TOOL_INDEX_ACTION: NonNullable<ToolUsageRecord['indexAction']>[] = [
  'none',
  'enqueue_full',
  'enqueue_incremental',
  'index_required',
  'queue_error',
];
const INDEX_USAGE_SCOPE: NonNullable<IndexUsageRecord['scope']>[] = ['full', 'incremental'];
const INDEX_USAGE_PHASE: IndexUsageRecord['phase'][] = ['enqueue', 'execute'];
const INDEX_USAGE_STATUS: IndexUsageRecord['status'][] = ['queued', 'running', 'done', 'failed', 'reused'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function toRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.flatMap((item) => (isRecord(item) ? [item] : [])) : [];
}

function readField(row: Record<string, unknown>, key: string): unknown {
  return Reflect.get(row, key);
}

function readStringField(row: Record<string, unknown>, key: string): string | undefined {
  const value = readField(row, key);
  return typeof value === 'string' ? value : undefined;
}

function readNumberField(row: Record<string, unknown>, key: string): number | undefined {
  const value = readField(row, key);
  return typeof value === 'number' ? value : undefined;
}

function readNullableStringField(row: Record<string, unknown>, key: string): string | undefined {
  const value = readField(row, key);
  return value === null ? undefined : typeof value === 'string' ? value : undefined;
}

function readNullableNumberField(row: Record<string, unknown>, key: string): number | undefined {
  const value = readField(row, key);
  return value === null ? undefined : typeof value === 'number' ? value : undefined;
}

function readEnumField<T extends string>(
  row: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = readField(row, key);
  return typeof value === 'string' && allowed.some((item) => item === value) ? value : undefined;
}

function getBaseDir(): string {
  return resolveBaseDir();
}

export function resolveUsageDbPath(): string {
  const configured = resolveUsageDbPathFromEnv();
  if (configured) return configured;
  return path.join(getBaseDir(), DEFAULT_USAGE_DB_FILE);
}

function openUsageDb(): Database.Database {
  const dbPath = resolveUsageDbPath();
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_usage_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      day TEXT NOT NULL,
      source TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      project_id TEXT,
      repo_path TEXT,
      request_id TEXT,
      status TEXT NOT NULL,
      duration_ms INTEGER,
      query_length INTEGER,
      index_state TEXT,
      index_action TEXT,
      error TEXT
    );

    CREATE INDEX IF NOT EXISTS ix_tool_usage_day ON tool_usage_events(day);
    CREATE INDEX IF NOT EXISTS ix_tool_usage_tool ON tool_usage_events(tool_name, day);
    CREATE INDEX IF NOT EXISTS ix_tool_usage_project ON tool_usage_events(project_id, day);

    CREATE TABLE IF NOT EXISTS index_usage_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      day TEXT NOT NULL,
      project_id TEXT,
      repo_path TEXT,
      task_id TEXT,
      scope TEXT,
      phase TEXT NOT NULL,
      status TEXT NOT NULL,
      requested_by TEXT,
      reused_existing INTEGER,
      duration_ms INTEGER,
      error TEXT
    );

    CREATE INDEX IF NOT EXISTS ix_index_usage_day ON index_usage_events(day);
    CREATE INDEX IF NOT EXISTS ix_index_usage_project ON index_usage_events(project_id, day);
    CREATE INDEX IF NOT EXISTS ix_index_usage_phase ON index_usage_events(phase, status, day);
  `);
  ensureColumn(db, 'tool_usage_events', 'repo_path', 'TEXT');
  ensureColumn(db, 'index_usage_events', 'repo_path', 'TEXT');
  return db;
}

function ensureColumn(db: Database.Database, table: string, column: string, ddl: string): void {
  const rows = toRecordArray(db.prepare(`PRAGMA table_info(${table})`).all());
  if (!rows.some((row) => readStringField(row, 'name') === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

function normalizeTimestamp(timestamp?: string): { timestamp: string; day: string } {
  const value = timestamp || new Date().toISOString();
  return {
    timestamp: value,
    day: value.slice(0, 10),
  };
}

export function recordToolUsage(input: ToolUsageInput): void {
  const db = openUsageDb();
  try {
    const time = normalizeTimestamp(input.timestamp);
    db.prepare(`
      INSERT INTO tool_usage_events (
        timestamp, day, source, tool_name, project_id, request_id,
        repo_path, status, duration_ms, query_length, index_state, index_action, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      time.timestamp,
      time.day,
      input.source,
      input.toolName,
      input.projectId ?? null,
      input.requestId ?? null,
      input.repoPath ?? null,
      input.status,
      input.durationMs ?? null,
      input.queryLength ?? null,
      input.indexState ?? null,
      input.indexAction ?? null,
      input.error ?? null,
    );
  } finally {
    db.close();
  }
}

export function recordIndexUsage(input: IndexUsageInput): void {
  const db = openUsageDb();
  try {
    const time = normalizeTimestamp(input.timestamp);
    db.prepare(`
      INSERT INTO index_usage_events (
        timestamp, day, project_id, task_id, scope, phase, status,
        repo_path, requested_by, reused_existing, duration_ms, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      time.timestamp,
      time.day,
      input.projectId ?? null,
      input.taskId ?? null,
      input.scope ?? null,
      input.phase,
      input.status,
      input.repoPath ?? null,
      input.requestedBy ?? null,
      input.reusedExisting === undefined ? null : input.reusedExisting ? 1 : 0,
      input.durationMs ?? null,
      input.error ?? null,
    );
  } finally {
    db.close();
  }
}

export function listToolUsage(): ToolUsageRecord[] {
  const db = openUsageDb();
  try {
    const rows = toRecordArray(db.prepare('SELECT * FROM tool_usage_events ORDER BY event_id ASC').all());
    return rows.map((row) => ({
      eventId: readNumberField(row, 'event_id') ?? 0,
      timestamp: readStringField(row, 'timestamp') ?? '',
      day: readStringField(row, 'day') ?? '',
      source: readStringField(row, 'source') ?? '',
      toolName: readStringField(row, 'tool_name') ?? '',
      projectId: readNullableStringField(row, 'project_id'),
      repoPath: readNullableStringField(row, 'repo_path'),
      requestId: readNullableStringField(row, 'request_id'),
      status: readEnumField(row, 'status', TOOL_USAGE_STATUS) ?? 'error',
      durationMs: readNullableNumberField(row, 'duration_ms'),
      queryLength: readNullableNumberField(row, 'query_length'),
      indexState: readEnumField(row, 'index_state', TOOL_INDEX_STATE),
      indexAction: readEnumField(row, 'index_action', TOOL_INDEX_ACTION),
      error: readNullableStringField(row, 'error'),
    }));
  } finally {
    db.close();
  }
}

export interface UsageDbStats {
  toolUsageCount: number;
  indexUsageCount: number;
  oldestDay: string | null;
  newestDay: string | null;
}

export interface UsagePurgeResult {
  toolPurged: number;
  indexPurged: number;
  cutoffDay: string;
}

export function getUsageStats(): UsageDbStats {
  const db = openUsageDb();
  try {
    const toolCountRow = toRecord(db.prepare('SELECT COUNT(*) AS c FROM tool_usage_events').get()) ?? {};
    const indexCountRow = toRecord(db.prepare('SELECT COUNT(*) AS c FROM index_usage_events').get()) ?? {};

    const toolDayRange = db.prepare(
      'SELECT MIN(day) AS min_day, MAX(day) AS max_day FROM tool_usage_events',
    ).get();

    const indexDayRange = db.prepare(
      'SELECT MIN(day) AS min_day, MAX(day) AS max_day FROM index_usage_events',
    ).get();

    const allDays = [
      readNullableStringField(toRecord(toolDayRange) ?? {}, 'min_day') ?? null,
      readNullableStringField(toRecord(toolDayRange) ?? {}, 'max_day') ?? null,
      readNullableStringField(toRecord(indexDayRange) ?? {}, 'min_day') ?? null,
      readNullableStringField(toRecord(indexDayRange) ?? {}, 'max_day') ?? null,
    ].filter((d): d is string => d !== null).sort();

    return {
      toolUsageCount: readNumberField(toolCountRow, 'c') ?? 0,
      indexUsageCount: readNumberField(indexCountRow, 'c') ?? 0,
      oldestDay: allDays.length > 0 ? allDays[0] : null,
      newestDay: allDays.length > 0 ? allDays[allDays.length - 1] : null,
    };
  } finally {
    db.close();
  }
}

export function purgeOldUsageEvents(maxAgeDays: number): UsagePurgeResult {
  if (maxAgeDays <= 0) {
    return { toolPurged: 0, indexPurged: 0, cutoffDay: '' };
  }

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - maxAgeDays);
  const cutoffDay = cutoffDate.toISOString().slice(0, 10);

  const db = openUsageDb();
  try {
    const toolResult = db.prepare('DELETE FROM tool_usage_events WHERE day < ?').run(cutoffDay);
    const indexResult = db.prepare('DELETE FROM index_usage_events WHERE day < ?').run(cutoffDay);

    return {
      toolPurged: toolResult.changes,
      indexPurged: indexResult.changes,
      cutoffDay,
    };
  } finally {
    db.close();
  }
}

export function listIndexUsage(): IndexUsageRecord[] {
  const db = openUsageDb();
  try {
    const rows = toRecordArray(db.prepare('SELECT * FROM index_usage_events ORDER BY event_id ASC').all());
    return rows.map((row) => ({
      eventId: readNumberField(row, 'event_id') ?? 0,
      timestamp: readStringField(row, 'timestamp') ?? '',
      day: readStringField(row, 'day') ?? '',
      projectId: readNullableStringField(row, 'project_id'),
      repoPath: readNullableStringField(row, 'repo_path'),
      taskId: readNullableStringField(row, 'task_id'),
      scope: readEnumField(row, 'scope', INDEX_USAGE_SCOPE),
      phase: readEnumField(row, 'phase', INDEX_USAGE_PHASE) ?? 'enqueue',
      status: readEnumField(row, 'status', INDEX_USAGE_STATUS) ?? 'failed',
      requestedBy: readNullableStringField(row, 'requested_by'),
      reusedExisting:
        row.reused_existing === null || row.reused_existing === undefined
          ? undefined
          : Number(row.reused_existing) === 1,
      durationMs: readNullableNumberField(row, 'duration_ms'),
      error: readNullableStringField(row, 'error'),
    }));
  } finally {
    db.close();
  }
}
