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
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!rows.some((row) => row.name === column)) {
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
    return (
      db.prepare('SELECT * FROM tool_usage_events ORDER BY event_id ASC').all() as ToolUsageRow[]
    ).map((row) => ({
      eventId: Number(row.event_id),
      timestamp: String(row.timestamp),
      day: String(row.day),
      source: String(row.source),
      toolName: String(row.tool_name),
      projectId: (row.project_id as string | null) ?? undefined,
      repoPath: (row.repo_path as string | null) ?? undefined,
      requestId: (row.request_id as string | null) ?? undefined,
      status: row.status as ToolUsageRecord['status'],
      durationMs: (row.duration_ms as number | null) ?? undefined,
      queryLength: (row.query_length as number | null) ?? undefined,
      indexState: (row.index_state as ToolUsageRecord['indexState'] | null) ?? undefined,
      indexAction: (row.index_action as ToolUsageRecord['indexAction'] | null) ?? undefined,
      error: (row.error as string | null) ?? undefined,
    }));
  } finally {
    db.close();
  }
}

export function listIndexUsage(): IndexUsageRecord[] {
  const db = openUsageDb();
  try {
    return (
      db.prepare('SELECT * FROM index_usage_events ORDER BY event_id ASC').all() as IndexUsageRow[]
    ).map((row) => ({
      eventId: Number(row.event_id),
      timestamp: String(row.timestamp),
      day: String(row.day),
      projectId: (row.project_id as string | null) ?? undefined,
      repoPath: (row.repo_path as string | null) ?? undefined,
      taskId: (row.task_id as string | null) ?? undefined,
      scope: (row.scope as IndexUsageRecord['scope'] | null) ?? undefined,
      phase: row.phase as IndexUsageRecord['phase'],
      status: row.status as IndexUsageRecord['status'],
      requestedBy: (row.requested_by as string | null) ?? undefined,
      reusedExisting:
        row.reused_existing === null || row.reused_existing === undefined
          ? undefined
          : Number(row.reused_existing) === 1,
      durationMs: (row.duration_ms as number | null) ?? undefined,
      error: (row.error as string | null) ?? undefined,
    }));
  } finally {
    db.close();
  }
}
