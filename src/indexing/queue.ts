import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expandHome, resolveBaseDir } from '../runtimePaths.js';
import type {
  EnqueueIndexTaskInput,
  EnqueueIndexTaskResult,
  IndexTask,
  IndexTaskScope,
} from './types.js';

const INDEX_QUEUE_DB_PATH_ENV = 'INDEX_QUEUE_DB_PATH';
const DEFAULT_QUEUE_DB_FILE = 'index-queue.db';
const TASK_STATUS_QUEUED = 'queued';
const TASK_STATUS_RUNNING = 'running';
const TASK_STATUS_DONE = 'done';
const TASK_STATUS_FAILED = 'failed';
const TASK_STATUS_CANCELED = 'canceled';
const require = createRequire(import.meta.url);

function getBaseDir(): string {
  return resolveBaseDir();
}

export function resolveQueueDbPath(): string {
  const configured = process.env[INDEX_QUEUE_DB_PATH_ENV];
  if (configured && configured.trim()) {
    return path.resolve(expandHome(configured.trim()));
  }
  return path.join(getBaseDir(), DEFAULT_QUEUE_DB_FILE);
}

function openQueueDb(): Database.Database {
  const dbPath = resolveQueueDbPath();
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS index_tasks (
      task_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      repo_path TEXT NOT NULL,
      scope TEXT NOT NULL CHECK(scope IN ('full','incremental')),
      status TEXT NOT NULL CHECK(status IN ('queued','running','done','failed','canceled')),
      priority INTEGER NOT NULL DEFAULT 0,
      dedupe_key TEXT NOT NULL,
      reason TEXT,
      requested_by TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS ux_index_tasks_dedupe_active
    ON index_tasks(dedupe_key)
    WHERE status IN ('queued','running');

    CREATE INDEX IF NOT EXISTS ix_index_tasks_pick
    ON index_tasks(status, priority DESC, created_at ASC);
  `);

  return db;
}

function toTask(row: Record<string, unknown>): IndexTask {
  return {
    taskId: String(row.task_id),
    projectId: String(row.project_id),
    repoPath: String(row.repo_path),
    scope: row.scope as IndexTaskScope,
    status: row.status as IndexTask['status'],
    priority: Number(row.priority),
    dedupeKey: String(row.dedupe_key),
    reason: (row.reason as string | null) ?? null,
    requestedBy: (row.requested_by as string | null) ?? null,
    createdAt: Number(row.created_at),
    startedAt: (row.started_at as number | null) ?? null,
    finishedAt: (row.finished_at as number | null) ?? null,
    attempts: Number(row.attempts),
    lastError: (row.last_error as string | null) ?? null,
  };
}

export function computeDedupeKey(projectId: string, scope: IndexTaskScope): string {
  return `${projectId}:${scope}`;
}

function getTaskByDedupeKey(db: Database.Database, dedupeKey: string): IndexTask | null {
  const row = db
    .prepare(
      `
      SELECT *
      FROM index_tasks
      WHERE dedupe_key = ?
        AND status IN ('queued','running')
      ORDER BY created_at ASC
      LIMIT 1
    `,
    )
    .get(dedupeKey) as Record<string, unknown> | undefined;

  return row ? toTask(row) : null;
}

function safeRecordIndexUsage(input: IndexUsageInputLike): void {
  try {
    const { recordIndexUsage } = requireUsageTracker();
    recordIndexUsage(input);
  } catch {
    // noop
  }
}

type IndexUsageInputLike = {
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
};

function requireUsageTracker(): { recordIndexUsage: (input: IndexUsageInputLike) => void } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../usage/usageTracker.js');
}

export function enqueueIndexTask(input: EnqueueIndexTaskInput): EnqueueIndexTaskResult {
  const db = openQueueDb();
  try {
    const dedupeKey = computeDedupeKey(input.projectId, input.scope);
    const existing = getTaskByDedupeKey(db, dedupeKey);
    if (existing) {
      safeRecordIndexUsage({
        projectId: input.projectId,
        repoPath: input.repoPath,
        taskId: existing.taskId,
        scope: input.scope,
        phase: 'enqueue',
        status: 'reused',
        requestedBy: input.requestedBy,
        reusedExisting: true,
      });
      return { task: existing, reusedExisting: true };
    }

    const now = Date.now();
    const taskId = crypto.randomUUID();
    db.prepare(
      `
      INSERT INTO index_tasks (
        task_id, project_id, repo_path, scope, status,
        priority, dedupe_key, reason, requested_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      taskId,
      input.projectId,
      input.repoPath,
      input.scope,
      TASK_STATUS_QUEUED,
      input.priority ?? 0,
      dedupeKey,
      input.reason ?? null,
      input.requestedBy ?? null,
      now,
    );

    const task = getTaskById(taskId);
    if (!task) {
      throw new Error(`任务写入成功但读取失败: ${taskId}`);
    }
    safeRecordIndexUsage({
      projectId: input.projectId,
      repoPath: input.repoPath,
      taskId,
      scope: input.scope,
      phase: 'enqueue',
      status: 'queued',
      requestedBy: input.requestedBy,
      reusedExisting: false,
    });
    return { task, reusedExisting: false };
  } finally {
    db.close();
  }
}

export function getTaskById(taskId: string): IndexTask | null {
  const db = openQueueDb();
  try {
    const row = db
      .prepare(
        `
      SELECT *
      FROM index_tasks
      WHERE task_id = ?
      LIMIT 1
    `,
      )
      .get(taskId) as Record<string, unknown> | undefined;
    return row ? toTask(row) : null;
  } finally {
    db.close();
  }
}

export function getActiveTask(projectId: string): IndexTask | null {
  const db = openQueueDb();
  try {
    const row = db
      .prepare(
        `
      SELECT *
      FROM index_tasks
      WHERE project_id = ?
        AND status IN ('running','queued')
      ORDER BY
        CASE status WHEN 'running' THEN 0 ELSE 1 END,
        priority DESC,
        created_at ASC
      LIMIT 1
    `,
      )
      .get(projectId) as Record<string, unknown> | undefined;
    return row ? toTask(row) : null;
  } finally {
    db.close();
  }
}

export function pickNextQueuedTask(_workerId?: string): IndexTask | null {
  const db = openQueueDb();
  try {
    const transaction = db.transaction((): IndexTask | null => {
      const candidate = db
        .prepare(
          `
        SELECT task_id
        FROM index_tasks
        WHERE status = 'queued'
        ORDER BY priority DESC, created_at ASC
        LIMIT 1
      `,
        )
        .get() as { task_id: string } | undefined;

      if (!candidate) return null;

      const now = Date.now();
      const updated = db
        .prepare(
          `
        UPDATE index_tasks
        SET status = '${TASK_STATUS_RUNNING}',
            started_at = ?,
            attempts = attempts + 1,
            last_error = NULL
        WHERE task_id = ?
          AND status = '${TASK_STATUS_QUEUED}'
      `,
        )
        .run(now, candidate.task_id);

      if (updated.changes === 0) return null;

      const row = db
        .prepare(
          `
        SELECT *
        FROM index_tasks
        WHERE task_id = ?
      `,
        )
        .get(candidate.task_id) as Record<string, unknown> | undefined;

      return row ? toTask(row) : null;
    });

    return transaction();
  } finally {
    db.close();
  }
}

export function markTaskDone(taskId: string): void {
  const db = openQueueDb();
  try {
    db.prepare(
      `
      UPDATE index_tasks
      SET status = '${TASK_STATUS_DONE}',
          finished_at = ?,
          last_error = NULL
      WHERE task_id = ?
        AND status = '${TASK_STATUS_RUNNING}'
    `,
    ).run(Date.now(), taskId);
  } finally {
    db.close();
  }
}

export function markTaskFailed(taskId: string, errorMessage: string): void {
  const db = openQueueDb();
  try {
    db.prepare(
      `
      UPDATE index_tasks
      SET status = '${TASK_STATUS_FAILED}',
          finished_at = ?,
          last_error = ?
      WHERE task_id = ?
        AND status = '${TASK_STATUS_RUNNING}'
    `,
    ).run(Date.now(), errorMessage, taskId);
  } finally {
    db.close();
  }
}

export function markTaskCanceled(taskId: string, reason: string): void {
  const db = openQueueDb();
  try {
    db.prepare(
      `
      UPDATE index_tasks
      SET status = '${TASK_STATUS_CANCELED}',
          finished_at = ?,
          last_error = ?
      WHERE task_id = ?
        AND status IN ('${TASK_STATUS_QUEUED}','${TASK_STATUS_RUNNING}')
    `,
    ).run(Date.now(), reason, taskId);
  } finally {
    db.close();
  }
}

export function requeueStaleRunningTasks(staleMs: number): number {
  if (staleMs <= 0) return 0;

  const db = openQueueDb();
  try {
    const threshold = Date.now() - staleMs;
    const result = db
      .prepare(
        `
      UPDATE index_tasks
      SET status = '${TASK_STATUS_QUEUED}',
          started_at = NULL,
          last_error = 'stale running task requeued'
      WHERE status = '${TASK_STATUS_RUNNING}'
        AND started_at IS NOT NULL
        AND started_at < ?
    `,
      )
      .run(threshold);
    return result.changes;
  } finally {
    db.close();
  }
}
