import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expandHome, resolveBaseDir } from '../runtimePaths.js';
import type {
  EnqueueIndexTaskInput,
  EnqueueIndexTaskResult,
  IncrementalHintEntry,
  IncrementalExecutionHint,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function toIncrementalHintEntry(row: unknown): IncrementalHintEntry | null {
  const relPath = readStringField(row, 'relPath');
  const mtime = readNumberField(row, 'mtime');
  const size = readNumberField(row, 'size');
  if (!relPath || mtime === undefined || size === undefined) {
    return null;
  }
  return { relPath, mtime, size };
}

function normalizeExecutionHint(parsed: unknown): IncrementalExecutionHint | null {
  if (!isRecord(parsed)) {
    return null;
  }

  const generatedAt = readNumberField(parsed, 'generatedAt');
  const ttlMs = readNumberField(parsed, 'ttlMs');
  const changeSummary = Reflect.get(parsed, 'changeSummary');
  const candidates = Reflect.get(parsed, 'candidates');
  const deletedPaths = Reflect.get(parsed, 'deletedPaths');
  const healingPaths = Reflect.get(parsed, 'healingPaths');

  if (!isRecord(changeSummary) || generatedAt === undefined || ttlMs === undefined) {
    return null;
  }

  const normalizedCandidates = Array.isArray(candidates)
    ? candidates.map(toIncrementalHintEntry).filter((item): item is IncrementalHintEntry => item !== null)
    : [];
  const normalizedHealingPaths = Array.isArray(healingPaths)
    ? healingPaths.map(toIncrementalHintEntry).filter((item): item is IncrementalHintEntry => item !== null)
    : [];
  const normalizedDeletedPaths = Array.isArray(deletedPaths)
    ? deletedPaths.filter((item): item is string => typeof item === 'string')
    : [];

  return {
    generatedAt,
    ttlMs,
    changeSummary: {
      added: readNumberField(changeSummary, 'added') ?? 0,
      modified: readNumberField(changeSummary, 'modified') ?? 0,
      deleted: readNumberField(changeSummary, 'deleted') ?? 0,
      unchangedNeedingVectorRepair: readNumberField(changeSummary, 'unchangedNeedingVectorRepair') ?? 0,
      unchanged: readNumberField(changeSummary, 'unchanged') ?? 0,
      skipped: readNumberField(changeSummary, 'skipped') ?? 0,
      errors: readNumberField(changeSummary, 'errors') ?? 0,
      totalFiles: readNumberField(changeSummary, 'totalFiles') ?? 0,
    },
    candidates: normalizedCandidates,
    deletedPaths: normalizedDeletedPaths,
    healingPaths: normalizedHealingPaths,
  };
}

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
      execution_hint_json TEXT,
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

  try {
    db.exec('ALTER TABLE index_tasks ADD COLUMN execution_hint_json TEXT');
  } catch {
    // ignore when column already exists
  }

  return db;
}

function parseExecutionHint(raw: unknown): IncrementalExecutionHint | null {
  if (typeof raw !== 'string' || !raw.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    return normalizeExecutionHint(parsed);
  } catch {
    return null;
  }
}

function toTask(row: unknown): IndexTask {
  const scope = readStringField(row, 'scope');
  const status = readStringField(row, 'status');
  const normalizedScope: IndexTaskScope = scope === 'full' || scope === 'incremental' ? scope : 'incremental';
  const normalizedStatus: IndexTask['status'] =
    status === TASK_STATUS_QUEUED
    || status === TASK_STATUS_RUNNING
    || status === TASK_STATUS_DONE
    || status === TASK_STATUS_FAILED
    || status === TASK_STATUS_CANCELED
      ? status
      : TASK_STATUS_FAILED;
  return {
    taskId: readStringField(row, 'task_id') ?? '',
    projectId: readStringField(row, 'project_id') ?? '',
    repoPath: readStringField(row, 'repo_path') ?? '',
    scope: normalizedScope,
    status: normalizedStatus,
    priority: readNumberField(row, 'priority') ?? 0,
    dedupeKey: readStringField(row, 'dedupe_key') ?? '',
    reason: readStringField(row, 'reason') ?? null,
    requestedBy: readStringField(row, 'requested_by') ?? null,
    createdAt: readNumberField(row, 'created_at') ?? 0,
    startedAt: readNumberField(row, 'started_at') ?? null,
    finishedAt: readNumberField(row, 'finished_at') ?? null,
    attempts: readNumberField(row, 'attempts') ?? 0,
    lastError: readStringField(row, 'last_error') ?? null,
    executionHint: parseExecutionHint((row as Record<string, unknown>).execution_hint_json),
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
    .get(dedupeKey);

  return isRecord(row) ? toTask(row) : null;
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

export interface TaskStatusEntry {
  taskId: string;
  projectId: string;
  repoPath: string;
  scope: IndexTaskScope;
  status: IndexTask['status'];
  priority: number;
  attempts: number;
  reason: string | null;
  requestedBy: string | null;
  lastError: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  ageMs: number | null;
  ageHuman: string | null;
  executionHint: IncrementalExecutionHint | null;
}

export interface TaskStatusReport {
  projectId?: string;
  counts: {
    total: number;
    queued: number;
    running: number;
    done: number;
    failed: number;
    canceled: number;
  };
  oldestQueuedAgeMs: number | null;
  oldestQueuedAgeHuman: string | null;
  oldestRunningAgeMs: number | null;
  oldestRunningAgeHuman: string | null;
  queued: TaskStatusEntry[];
  running: TaskStatusEntry[];
  stuckRunning: TaskStatusEntry[];
  recentFailures: TaskStatusEntry[];
}

function requireUsageTracker(): { recordIndexUsage: (input: IndexUsageInputLike) => void } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../usage/usageTracker.js');
}

function formatAge(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function formatTimestamp(timestamp: number | null): string {
  return timestamp ? new Date(timestamp).toISOString() : 'n/a';
}

function toTaskStatusEntry(task: IndexTask, ageMs: number | null): TaskStatusEntry {
  return {
    taskId: task.taskId,
    projectId: task.projectId,
    repoPath: task.repoPath,
    scope: task.scope,
    status: task.status,
    priority: task.priority,
    attempts: task.attempts,
    reason: task.reason,
    requestedBy: task.requestedBy,
    lastError: task.lastError,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    ageMs,
    ageHuman: ageMs !== null ? formatAge(ageMs) : null,
    executionHint: task.executionHint,
  };
}

function listTasksByStatus(
  db: Database.Database,
  status: IndexTask['status'],
  options: {
    projectId?: string;
    limit?: number;
    orderBy: string;
  },
): TaskStatusEntry[] {
  const params: Array<string | number> = [];
  const projectFilter = options.projectId ? ' AND project_id = ?' : '';
  if (options.projectId) {
    params.push(options.projectId);
  }
  params.push(options.limit ?? 5);

  const rows = db.prepare(
    `
      SELECT *
      FROM index_tasks
      WHERE status = ?${projectFilter}
      ORDER BY ${options.orderBy}
      LIMIT ?
    `,
  ).all(status, ...params);

  return rows
    .filter((row): row is Record<string, unknown> => Boolean(row && typeof row === 'object'))
    .map((row) => {
      const task = toTask(row);
    const ageBase =
      task.status === TASK_STATUS_RUNNING
        ? task.startedAt
        : task.status === TASK_STATUS_FAILED
          ? task.finishedAt
          : task.createdAt;
    return toTaskStatusEntry(task, ageBase ? Math.max(0, Date.now() - ageBase) : null);
    });
}

export function getTaskStatusReport(
  options: {
    projectId?: string;
    staleRunningMs?: number;
    limit?: number;
  } = {},
): TaskStatusReport {
  const db = openQueueDb();
  try {
    const params: Array<string> = [];
    const projectWhere = options.projectId ? 'WHERE project_id = ?' : '';
    if (options.projectId) {
      params.push(options.projectId);
    }

    const statusCounts = db
      .prepare(`SELECT status, COUNT(*) AS cnt FROM index_tasks ${projectWhere} GROUP BY status`)
      .all(...params);

    const counts: TaskStatusReport['counts'] = {
      total: 0,
      queued: 0,
      running: 0,
      done: 0,
      failed: 0,
      canceled: 0,
    };

    for (const row of statusCounts) {
      const status = readStringField(row, 'status');
      const count = readNumberField(row, 'cnt') ?? 0;
      if (
        status === TASK_STATUS_QUEUED
        || status === TASK_STATUS_RUNNING
        || status === TASK_STATUS_DONE
        || status === TASK_STATUS_FAILED
        || status === TASK_STATUS_CANCELED
      ) {
        counts[status] = count;
      }
      counts.total += count;
    }

    const oldestQueued = db
      .prepare(
        `
          SELECT created_at
          FROM index_tasks
          WHERE status = 'queued'${options.projectId ? ' AND project_id = ?' : ''}
          ORDER BY created_at ASC
          LIMIT 1
        `,
      )
      .get(...params);

    const oldestRunning = db
      .prepare(
        `
          SELECT started_at
          FROM index_tasks
          WHERE status = 'running'
            AND started_at IS NOT NULL${options.projectId ? ' AND project_id = ?' : ''}
          ORDER BY started_at ASC
          LIMIT 1
        `,
      )
      .get(...params);

    const oldestQueuedAt = readNumberField(oldestQueued, 'created_at');
    const oldestRunningAt = readNumberField(oldestRunning, 'started_at');
    const oldestQueuedAgeMs = oldestQueuedAt !== undefined ? Math.max(0, Date.now() - oldestQueuedAt) : null;
    const oldestRunningAgeMs = oldestRunningAt !== undefined ? Math.max(0, Date.now() - oldestRunningAt) : null;
    const queued = listTasksByStatus(db, TASK_STATUS_QUEUED, {
      projectId: options.projectId,
      limit: options.limit,
      orderBy: 'priority DESC, created_at ASC',
    });
    const running = listTasksByStatus(db, TASK_STATUS_RUNNING, {
      projectId: options.projectId,
      limit: options.limit,
      orderBy: 'started_at ASC',
    });
    const recentFailures = listTasksByStatus(db, TASK_STATUS_FAILED, {
      projectId: options.projectId,
      limit: options.limit,
      orderBy: 'finished_at DESC',
    });
    const staleRunningMs = options.staleRunningMs ?? 30 * 60 * 1000;
    const stuckRunning = running.filter(
      (task) => task.ageMs !== null && task.ageMs >= staleRunningMs,
    );

    return {
      projectId: options.projectId,
      counts,
      oldestQueuedAgeMs,
      oldestQueuedAgeHuman: oldestQueuedAgeMs !== null ? formatAge(oldestQueuedAgeMs) : null,
      oldestRunningAgeMs,
      oldestRunningAgeHuman: oldestRunningAgeMs !== null ? formatAge(oldestRunningAgeMs) : null,
      queued,
      running,
      stuckRunning,
      recentFailures,
    };
  } finally {
    db.close();
  }
}

export function formatTaskStatusReport(report: TaskStatusReport): string {
  const lines: string[] = [];
  lines.push('Task Status');
  if (report.projectId) {
    lines.push(`Project: ${report.projectId}`);
  }
  lines.push(
    `Counts: queued=${report.counts.queued} running=${report.counts.running} failed=${report.counts.failed} done=${report.counts.done} canceled=${report.counts.canceled}`,
  );
  if (report.oldestQueuedAgeHuman) {
    lines.push(`Oldest Queued: ${report.oldestQueuedAgeHuman}`);
  }
  if (report.oldestRunningAgeHuman) {
    lines.push(`Oldest Running: ${report.oldestRunningAgeHuman}`);
  }
  lines.push('');

  lines.push('Queued:');
  if (report.queued.length === 0) {
    lines.push('  - none');
  } else {
    for (const task of report.queued) {
      lines.push(
        `  - ${task.projectId}/${task.taskId} ${task.scope} age=${task.ageHuman || 'n/a'} inspect=contextatlas task:inspect ${task.taskId}`,
      );
    }
  }
  lines.push('');

  lines.push('Running:');
  if (report.running.length === 0) {
    lines.push('  - none');
  } else {
    for (const task of report.running) {
      lines.push(
        `  - ${task.projectId}/${task.taskId} ${task.scope} running=${task.ageHuman || 'n/a'} attempts=${task.attempts}`,
      );
    }
  }
  lines.push('');

  lines.push('Stuck Running:');
  if (report.stuckRunning.length === 0) {
    lines.push('  - none');
  } else {
    for (const task of report.stuckRunning) {
      lines.push(
        `  - ${task.projectId}/${task.taskId} running=${task.ageHuman || 'n/a'} inspect=contextatlas task:inspect ${task.taskId}`,
      );
    }
  }
  lines.push('');

  lines.push('Recent Failures:');
  if (report.recentFailures.length === 0) {
    lines.push('  - none');
  } else {
    for (const task of report.recentFailures) {
      lines.push(
        `  - ${task.projectId}/${task.taskId} failed=${task.ageHuman || 'n/a'} error=${task.lastError || 'unknown'}`,
      );
    }
  }

  return lines.join('\n');
}

export function formatTaskInspectReport(task: IndexTask): string {
  const lines: string[] = [];
  lines.push('Task Inspect');
  lines.push(`Task ID: ${task.taskId}`);
  lines.push(`Project ID: ${task.projectId}`);
  lines.push(`Repo Path: ${task.repoPath}`);
  lines.push(`Scope: ${task.scope}`);
  lines.push(`Status: ${task.status}`);
  lines.push(`Priority: ${task.priority}`);
  lines.push(`Attempts: ${task.attempts}`);
  lines.push(`Created At: ${formatTimestamp(task.createdAt)}`);
  lines.push(`Started At: ${formatTimestamp(task.startedAt)}`);
  lines.push(`Finished At: ${formatTimestamp(task.finishedAt)}`);
  lines.push(`Requested By: ${task.requestedBy || 'n/a'}`);
  lines.push(`Reason: ${task.reason || 'n/a'}`);
  lines.push(`Last Error: ${task.lastError || 'n/a'}`);

  if (task.executionHint) {
    lines.push('Execution Hint:');
    lines.push(`  Generated At: ${formatTimestamp(task.executionHint.generatedAt)}`);
    lines.push(`  TTL: ${task.executionHint.ttlMs}ms`);
    lines.push(
      `  Change Summary: added=${task.executionHint.changeSummary.added} modified=${task.executionHint.changeSummary.modified} deleted=${task.executionHint.changeSummary.deleted} repair=${task.executionHint.changeSummary.unchangedNeedingVectorRepair}`,
    );
    lines.push(`  Candidates: ${task.executionHint.candidates.length}`);
    lines.push(`  Deleted Paths: ${task.executionHint.deletedPaths.length}`);
    lines.push(`  Healing Paths: ${task.executionHint.healingPaths.length}`);
  }

  return lines.join('\n');
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
        priority, dedupe_key, reason, requested_by, execution_hint_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      input.executionHint ? JSON.stringify(input.executionHint) : null,
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
      .get(taskId);
    return isRecord(row) ? toTask(row) : null;
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
      .get(projectId);
    return isRecord(row) ? toTask(row) : null;
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
        .get();

      const candidateTaskId = readStringField(candidate, 'task_id');
      if (!candidateTaskId) return null;

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
        .run(now, candidateTaskId);

      if (updated.changes === 0) return null;

      const row = db
        .prepare(
          `
        SELECT *
        FROM index_tasks
        WHERE task_id = ?
      `,
        )
        .get(candidateTaskId);

      return isRecord(row) ? toTask(row) : null;
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
