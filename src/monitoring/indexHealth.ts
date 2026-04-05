import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { resolveQueueDbPath } from '../indexing/queue.js';
import { resolveBaseDir } from '../runtimePaths.js';
import { VectorStore } from '../vectorStore/index.js';

export interface QueueHealth {
  totalTasks: number;
  queued: number;
  running: number;
  done: number;
  failed: number;
  canceled: number;
  oldestQueuedAgeMs: number | null;
  oldestQueuedAgeHuman: string | null;
  recentFailures: Array<{
    taskId: string;
    projectId: string;
    lastError: string | null;
    finishedAt: number;
  }>;
}

export interface SnapshotHealth {
  projectId: string;
  hasCurrentSnapshot: boolean;
  currentSnapshotId: string | null;
  totalSnapshots: number;
  snapshotIds: string[];
  hasIndexDb: boolean;
  hasVectorIndex: boolean;
  dbSizeBytes: number;
  vectorSizeBytes: number;
  dbIntegrity: 'ok' | 'corrupted' | 'missing';
  fileCount: number;
  hasChunksFts: boolean;
  chunkFtsCount: number;
  vectorChunkCount: number;
  chunkFtsCoverage: number | null;
  lastModified: string | null;
}

export interface DaemonHealth {
  isRunning: boolean;
  pid: number | null;
  lockFileAge: string | null;
  queuePollingActive: boolean;
}

export interface IndexHealthReport {
  queue: QueueHealth;
  snapshots: SnapshotHealth[];
  daemon: DaemonHealth;
  overall: {
    status: 'healthy' | 'degraded' | 'unhealthy';
    issues: string[];
    recommendations: string[];
  };
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

function analyzeQueueHealth(): QueueHealth {
  const dbPath = resolveQueueDbPath();
  if (!fs.existsSync(dbPath)) {
    return {
      totalTasks: 0,
      queued: 0,
      running: 0,
      done: 0,
      failed: 0,
      canceled: 0,
      oldestQueuedAgeMs: null,
      oldestQueuedAgeHuman: null,
      recentFailures: [],
    };
  }

  const db = new Database(dbPath, { readonly: true });
  try {
    const statusCounts = db
      .prepare('SELECT status, COUNT(*) as cnt FROM index_tasks GROUP BY status')
      .all() as Array<{ status: string; cnt: number }>;

    const counts: Record<string, number> = {};
    for (const row of statusCounts) {
      counts[row.status] = row.cnt;
    }

    const oldestQueued = db
      .prepare(
        'SELECT created_at FROM index_tasks WHERE status = ? ORDER BY created_at ASC LIMIT 1',
      )
      .get('queued') as { created_at: number } | undefined;

    const oldestQueuedAgeMs = oldestQueued ? Date.now() - oldestQueued.created_at : null;

    const recentFailures = db
      .prepare(
        'SELECT task_id, project_id, last_error, finished_at FROM index_tasks WHERE status = ? ORDER BY finished_at DESC LIMIT 5',
      )
      .all('failed') as Array<{
      task_id: string;
      project_id: string;
      last_error: string | null;
      finished_at: number;
    }>;

    return {
      totalTasks: Object.values(counts).reduce((a, b) => a + b, 0),
      queued: counts.queued || 0,
      running: counts.running || 0,
      done: counts.done || 0,
      failed: counts.failed || 0,
      canceled: counts.canceled || 0,
      oldestQueuedAgeMs,
      oldestQueuedAgeHuman: oldestQueuedAgeMs !== null ? formatAge(oldestQueuedAgeMs) : null,
      recentFailures: recentFailures.map((r) => ({
        taskId: r.task_id,
        projectId: r.project_id,
        lastError: r.last_error,
        finishedAt: r.finished_at,
      })),
    };
  } finally {
    db.close();
  }
}

async function analyzeSnapshotHealth(projectId: string, baseDir?: string): Promise<SnapshotHealth> {
  const projectDir = path.join(baseDir || resolveBaseDir(), projectId);
  const snapshotsDir = path.join(projectDir, 'snapshots');
  const currentPointer = path.join(projectDir, 'current');

  let currentSnapshotId: string | null = null;
  if (fs.existsSync(currentPointer)) {
    try {
      currentSnapshotId = fs.readFileSync(currentPointer, 'utf-8').trim() || null;
    } catch {
      currentSnapshotId = null;
    }
  }

  const snapshotIds: string[] = [];
  if (fs.existsSync(snapshotsDir)) {
    for (const entry of fs.readdirSync(snapshotsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        snapshotIds.push(entry.name);
      }
    }
  }

  const currentDir =
    currentSnapshotId && fs.existsSync(path.join(snapshotsDir, currentSnapshotId))
      ? path.join(snapshotsDir, currentSnapshotId)
      : projectDir;

  const dbPath = path.join(currentDir, 'index.db');
  const vectorDir = path.join(currentDir, 'vectors.lance');

  const hasIndexDb = fs.existsSync(dbPath);
  const hasVectorIndex = fs.existsSync(vectorDir);

  let dbIntegrity: 'ok' | 'corrupted' | 'missing' = hasIndexDb ? 'ok' : 'missing';
  let fileCount = 0;
  let hasChunksFts = false;
  let chunkFtsCount = 0;

  if (hasIndexDb) {
    try {
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        const integrity = db.prepare('PRAGMA integrity_check').get() as
          | { integrity_check?: string }
          | undefined;
        if (integrity?.integrity_check?.toLowerCase() !== 'ok') {
          dbIntegrity = 'corrupted';
        }

        const filesTable = db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='files'")
          .get() as { name: string } | undefined;
        if (filesTable) {
          fileCount = (db.prepare('SELECT COUNT(*) as c FROM files').get() as { c: number }).c;
        }

        const chunksFtsTable = db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chunks_fts'")
          .get() as { name: string } | undefined;
        if (chunksFtsTable) {
          hasChunksFts = true;
          chunkFtsCount = (db.prepare('SELECT COUNT(*) as c FROM chunks_fts').get() as { c: number }).c;
        }
      } finally {
        db.close();
      }
    } catch {
      dbIntegrity = 'corrupted';
    }
  }

  let dbSizeBytes = 0;
  let vectorSizeBytes = 0;
  if (hasIndexDb) {
    dbSizeBytes = fs.statSync(dbPath).size;
  }
  if (hasVectorIndex) {
    const stat = fs.statSync(vectorDir);
    vectorSizeBytes = stat.isDirectory() ? dirSize(vectorDir) : stat.size;
  }

  let lastModified: string | null = null;
  if (fs.existsSync(currentDir)) {
    const stat = fs.statSync(currentDir);
    lastModified = stat.mtime.toISOString();
  }

  let vectorChunkCount = 0;
  if (hasVectorIndex) {
    try {
      const store = new VectorStore(projectId, 1024, currentSnapshotId);
      await store.init();
      vectorChunkCount = await store.count();
      await store.close();
    } catch {
      vectorChunkCount = 0;
    }
  }

  const chunkFtsCoverage =
    vectorChunkCount > 0 ? Number((chunkFtsCount / vectorChunkCount).toFixed(3)) : null;

  return {
    projectId,
    hasCurrentSnapshot: currentSnapshotId !== null,
    currentSnapshotId,
    totalSnapshots: snapshotIds.length,
    snapshotIds,
    hasIndexDb,
    hasVectorIndex,
    dbSizeBytes,
    vectorSizeBytes,
    dbIntegrity,
    fileCount,
    hasChunksFts,
    chunkFtsCount,
    vectorChunkCount,
    chunkFtsCoverage,
    lastModified,
  };
}

function dirSize(dir: string): number {
  let size = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        size += dirSize(full);
      } else {
        size += fs.statSync(full).size;
      }
    }
  } catch {
    // ignore
  }
  return size;
}

function analyzeDaemonHealth(): DaemonHealth {
  const baseDir = resolveBaseDir();
  const lockFile = path.join(baseDir, 'daemon.lock');
  const pidFile = path.join(baseDir, 'daemon.pid');

  let pid: number | null = null;
  let isRunning = false;
  let lockFileAge: string | null = null;

  if (fs.existsSync(pidFile)) {
    try {
      const pidStr = fs.readFileSync(pidFile, 'utf-8').trim();
      pid = Number.parseInt(pidStr, 10);
      if (Number.isFinite(pid)) {
        try {
          process.kill(pid, 0);
          isRunning = true;
        } catch {
          isRunning = false;
        }
      }
    } catch {
      // ignore
    }
  }

  if (fs.existsSync(lockFile)) {
    const stat = fs.statSync(lockFile);
    lockFileAge = formatAge(Date.now() - stat.mtimeMs);
  }

  return {
    isRunning,
    pid,
    lockFileAge,
    queuePollingActive: isRunning,
  };
}

function discoverProjectIds(baseDir?: string): string[] {
  const dir = baseDir || resolveBaseDir();
  if (!fs.existsSync(dir)) return [];

  const ids: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && !['logs', 'snapshots'].includes(entry.name)) {
      const projectDir = path.join(dir, entry.name);
      if (
        fs.existsSync(path.join(projectDir, 'index.db')) ||
        fs.existsSync(path.join(projectDir, 'current')) ||
        fs.existsSync(path.join(projectDir, 'snapshots'))
      ) {
        ids.push(entry.name);
      }
    }
  }
  return ids;
}

export async function analyzeIndexHealth(
  options: { baseDir?: string; projectIds?: string[] } = {},
): Promise<IndexHealthReport> {
  const baseDir = options.baseDir || resolveBaseDir();
  const queue = analyzeQueueHealth();

  const projectIds =
    options.projectIds && options.projectIds.length > 0
      ? options.projectIds
      : discoverProjectIds(baseDir);

  const snapshots = await Promise.all(projectIds.map((id) => analyzeSnapshotHealth(id, baseDir)));
  const daemon = analyzeDaemonHealth();

  const issues: string[] = [];
  const recommendations: string[] = [];

  if (queue.queued > 5) {
    issues.push(`队列积压: ${queue.queued} 个任务等待中`);
    recommendations.push('启动或检查守护进程: contextatlas daemon start');
  }

  if (queue.oldestQueuedAgeMs && queue.oldestQueuedAgeMs > 30 * 60 * 1000) {
    issues.push(`最老排队任务已等待 ${queue.oldestQueuedAgeHuman}`);
    recommendations.push('检查守护进程是否正常运行');
  }

  if (queue.failed > 0) {
    issues.push(`${queue.failed} 个索引任务执行失败`);
    recommendations.push('查看失败详情并修复: contextatlas health:check --json');
  }

  for (const snap of snapshots) {
    if (!snap.hasCurrentSnapshot) {
      issues.push(`项目 ${snap.projectId}: 无当前快照`);
      recommendations.push(`重新索引: contextatlas index ${snap.projectId}`);
    }

    if (snap.dbIntegrity === 'corrupted') {
      issues.push(`项目 ${snap.projectId}: 索引数据库损坏`);
      recommendations.push(`强制重建索引: contextatlas index ${snap.projectId} --force`);
    }

    if (snap.hasIndexDb && !snap.hasVectorIndex && snap.fileCount > 0) {
      issues.push(`项目 ${snap.projectId}: 缺少向量索引`);
      recommendations.push(`重新索引以生成向量: contextatlas index ${snap.projectId} --force`);
    }

    if (snap.vectorChunkCount > 0 && (!snap.hasChunksFts || snap.chunkFtsCount === 0)) {
      issues.push(`项目 ${snap.projectId}: chunk FTS 覆盖不足 (0/${snap.vectorChunkCount})`);
      recommendations.push(
        `重建 chunk FTS: contextatlas fts:rebuild-chunks --project-id ${snap.projectId}`,
      );
    } else if (
      snap.vectorChunkCount > 0 &&
      snap.chunkFtsCoverage !== null &&
      snap.chunkFtsCoverage < 0.95
    ) {
      issues.push(
        `项目 ${snap.projectId}: chunk FTS 覆盖不足 (${snap.chunkFtsCount}/${snap.vectorChunkCount})`,
      );
      recommendations.push(
        `重建 chunk FTS: contextatlas fts:rebuild-chunks --project-id ${snap.projectId}`,
      );
    }
  }

  if (!daemon.isRunning && queue.queued > 0) {
    issues.push('守护进程未运行但有排队任务');
    recommendations.push('启动守护进程: contextatlas daemon start');
  }

  const status: 'healthy' | 'degraded' | 'unhealthy' =
    issues.length === 0
      ? 'healthy'
      : issues.some((i) => i.includes('损坏') || i.includes('失败'))
        ? 'unhealthy'
        : 'degraded';

  return {
    queue,
    snapshots,
    daemon,
    overall: { status, issues, recommendations },
  };
}

export function formatIndexHealthReport(report: IndexHealthReport): string {
  const lines: string[] = [];

  lines.push('Index Health Report');
  lines.push(`Status: ${report.overall.status.toUpperCase()}`);
  lines.push('');

  lines.push('Queue:');
  lines.push(
    `  Total: ${report.queue.totalTasks} | Queued: ${report.queue.queued} | Running: ${report.queue.running}`,
  );
  lines.push(
    `  Done: ${report.queue.done} | Failed: ${report.queue.failed} | Canceled: ${report.queue.canceled}`,
  );
  if (report.queue.oldestQueuedAgeHuman) {
    lines.push(`  Oldest Queued: ${report.queue.oldestQueuedAgeHuman}`);
  }
  if (report.queue.recentFailures.length > 0) {
    lines.push('  Recent Failures:');
    for (const f of report.queue.recentFailures) {
      lines.push(`    - ${f.projectId}/${f.taskId}: ${f.lastError || 'unknown'}`);
    }
  }
  lines.push('');

  lines.push('Daemon:');
  lines.push(
    `  Running: ${report.daemon.isRunning}${report.daemon.pid ? ` (PID ${report.daemon.pid})` : ''}`,
  );
  if (report.daemon.lockFileAge) {
    lines.push(`  Lock File Age: ${report.daemon.lockFileAge}`);
  }
  lines.push('');

  lines.push('Snapshots:');
  for (const snap of report.snapshots) {
    lines.push(`  ${snap.projectId}:`);
    lines.push(`    Current: ${snap.currentSnapshotId || 'none'}`);
    lines.push(`    Snapshots: ${snap.totalSnapshots}`);
    lines.push(
      `    DB: ${snap.hasIndexDb ? `${(snap.dbSizeBytes / 1024).toFixed(1)}KB` : 'missing'} (${snap.dbIntegrity})`,
    );
    lines.push(
      `    Vector: ${snap.hasVectorIndex ? `${(snap.vectorSizeBytes / 1024 / 1024).toFixed(1)}MB` : 'missing'}`,
    );
    lines.push(`    Files: ${snap.fileCount}`);
    lines.push(
      `    Chunk FTS: ${snap.hasChunksFts ? `${snap.chunkFtsCount} / ${snap.vectorChunkCount}${snap.chunkFtsCoverage !== null ? ` (${(snap.chunkFtsCoverage * 100).toFixed(1)}%)` : ''}` : 'missing'}`,
    );
    if (snap.lastModified) {
      lines.push(`    Updated: ${snap.lastModified}`);
    }
  }
  lines.push('');

  if (report.overall.issues.length > 0) {
    lines.push('Issues:');
    for (const issue of report.overall.issues) {
      lines.push(`  - ${issue}`);
    }
    lines.push('');
  }

  if (report.overall.recommendations.length > 0) {
    lines.push('Recommendations:');
    for (const rec of report.overall.recommendations) {
      lines.push(`  - ${rec}`);
    }
  } else {
    lines.push('No issues detected. All systems healthy.');
  }

  return lines.join('\n');
}
