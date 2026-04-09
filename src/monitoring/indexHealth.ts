import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getTaskStatusReport, resolveQueueDbPath } from '../indexing/queue.js';
import type { IndexPlanStrategySignals } from '../indexing/updateStrategy.js';
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
  oldestRunningAgeMs: number | null;
  oldestRunningAgeHuman: string | null;
  stuckRunning: Array<{
    taskId: string;
    projectId: string;
    scope: 'full' | 'incremental';
    attempts: number;
    runningAgeMs: number | null;
    runningAgeHuman: string | null;
  }>;
  recentFailures: Array<{
    taskId: string;
    projectId: string;
    scope: 'full' | 'incremental';
    lastError: string | null;
    finishedAt: number;
    finishedAgeMs: number | null;
    finishedAgeHuman: string | null;
  }>;
}

export interface SnapshotHealth {
  projectId: string;
  hasCurrentSnapshot: boolean;
  currentSnapshotId: string | null;
  lastSuccessfulAt: string | null;
  lastSuccessfulAgeHuman: string | null;
  lastSuccessfulScope: 'full' | 'incremental' | null;
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
  latestTaskRepoPath: string | null;
  strategySummary: IndexStrategySummary | null;
}

export interface IndexStrategySummary {
  repoPath: string;
  mode: 'none' | 'incremental' | 'full';
  reasons: string[];
  signals: IndexPlanStrategySignals;
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
    repairPlan: {
      autoFixable: Array<{
        kind: 'auto';
        actionId: string;
        projectId: string | null;
        message: string;
      }>;
      manual: Array<{
        kind: 'manual';
        actionId: null;
        projectId: string | null;
        message: string;
      }>;
    };
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

function analyzeQueueHealth(projectId?: string): QueueHealth {
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
      oldestRunningAgeMs: null,
      oldestRunningAgeHuman: null,
      stuckRunning: [],
      recentFailures: [],
    };
  }

  const report = getTaskStatusReport({ projectId });
  return {
    totalTasks: report.counts.total,
    queued: report.counts.queued,
    running: report.counts.running,
    done: report.counts.done,
    failed: report.counts.failed,
    canceled: report.counts.canceled,
    oldestQueuedAgeMs: report.oldestQueuedAgeMs,
    oldestQueuedAgeHuman: report.oldestQueuedAgeHuman,
    oldestRunningAgeMs: report.oldestRunningAgeMs,
    oldestRunningAgeHuman: report.oldestRunningAgeHuman,
    stuckRunning: report.stuckRunning.map((task) => ({
      taskId: task.taskId,
      projectId: task.projectId,
      scope: task.scope,
      attempts: task.attempts,
      runningAgeMs: task.ageMs,
      runningAgeHuman: task.ageHuman,
    })),
    recentFailures: report.recentFailures.map((task) => ({
      taskId: task.taskId,
      projectId: task.projectId,
      scope: task.scope,
      lastError: task.lastError,
      finishedAt: task.finishedAt || 0,
      finishedAgeMs: task.ageMs,
      finishedAgeHuman: task.ageHuman,
    })),
  };
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
  const lastSuccessfulExecution = resolveLastSuccessfulExecution(projectId);
  const latestTaskContext = resolveLatestTaskContext(projectId);

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
  const strategySummary = await resolveStrategySummary(latestTaskContext?.repoPath ?? null);

  return {
    projectId,
    hasCurrentSnapshot: currentSnapshotId !== null,
    currentSnapshotId,
    lastSuccessfulAt: lastSuccessfulExecution?.finishedAtIso || null,
    lastSuccessfulAgeHuman: lastSuccessfulExecution?.ageHuman || null,
    lastSuccessfulScope: lastSuccessfulExecution?.scope || null,
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
    latestTaskRepoPath: latestTaskContext?.repoPath ?? null,
    strategySummary,
  };
}

function resolveLastSuccessfulExecution(projectId: string): {
  finishedAtIso: string;
  ageHuman: string;
  scope: 'full' | 'incremental';
} | null {
  const dbPath = resolveQueueDbPath();
  if (!fs.existsSync(dbPath)) {
    return null;
  }

  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        `
        SELECT scope, finished_at
        FROM index_tasks
        WHERE project_id = ?
          AND status = 'done'
          AND finished_at IS NOT NULL
        ORDER BY finished_at DESC
        LIMIT 1
      `,
      )
      .get(projectId) as { scope: 'full' | 'incremental'; finished_at: number } | undefined;

    if (!row?.finished_at) {
      return null;
    }

    const finishedAt = new Date(row.finished_at);
    return {
      finishedAtIso: finishedAt.toISOString(),
      ageHuman: formatAge(Date.now() - row.finished_at),
      scope: row.scope,
    };
  } finally {
    db.close();
  }
}

function resolveLatestTaskContext(projectId: string): { repoPath: string } | null {
  const dbPath = resolveQueueDbPath();
  if (!fs.existsSync(dbPath)) {
    return null;
  }

  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        `
        SELECT repo_path
        FROM index_tasks
        WHERE project_id = ?
        ORDER BY COALESCE(finished_at, started_at, created_at) DESC
        LIMIT 1
      `,
      )
      .get(projectId) as { repo_path: string } | undefined;

    if (!row?.repo_path) {
      return null;
    }

    return {
      repoPath: row.repo_path,
    };
  } finally {
    db.close();
  }
}

async function resolveStrategySummary(repoPath: string | null): Promise<IndexStrategySummary | null> {
  if (!repoPath || !fs.existsSync(repoPath)) {
    return null;
  }

  try {
    const { analyzeIndexUpdatePlan } = await import('../indexing/updateStrategy.js');
    const plan = await analyzeIndexUpdatePlan(repoPath);
    return {
      repoPath,
      mode: plan.mode,
      reasons: plan.reasons.map((reason) => reason.code),
      signals: plan.strategySignals,
    };
  } catch {
    return null;
  }
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
  const projectIds =
    options.projectIds && options.projectIds.length > 0
      ? options.projectIds
      : discoverProjectIds(baseDir);
  const queue = analyzeQueueHealth(projectIds.length === 1 ? projectIds[0] : undefined);

  const snapshots = await Promise.all(projectIds.map((id) => analyzeSnapshotHealth(id, baseDir)));
  const daemon = analyzeDaemonHealth();

  const issues: string[] = [];
  const recommendations: string[] = [];
  const autoFixable: IndexHealthReport['overall']['repairPlan']['autoFixable'] = [];
  const manual: IndexHealthReport['overall']['repairPlan']['manual'] = [];

  if (queue.queued > 5) {
    issues.push(`队列积压: ${queue.queued} 个任务等待中`);
    const message = '启动或检查守护进程: contextatlas daemon start';
    recommendations.push(message);
    autoFixable.push({
      kind: 'auto',
      actionId: 'start-daemon',
      projectId: null,
      message,
    });
  }

  if (queue.oldestQueuedAgeMs && queue.oldestQueuedAgeMs > 30 * 60 * 1000) {
    issues.push(`最老排队任务已等待 ${queue.oldestQueuedAgeHuman}`);
    manual.push({
      kind: 'manual',
      actionId: null,
      projectId: null,
      message: '检查守护进程是否正常运行',
    });
    recommendations.push('检查守护进程是否正常运行');
  }

  if (queue.stuckRunning.length > 0) {
    const firstStuck = queue.stuckRunning[0];
    issues.push(
      `运行中任务卡住: ${firstStuck.projectId}/${firstStuck.taskId} 已运行 ${firstStuck.runningAgeHuman || 'unknown'}`,
    );
    const message = `检查卡住任务: contextatlas task:inspect ${firstStuck.taskId}`;
    recommendations.push(message);
    manual.push({
      kind: 'manual',
      actionId: null,
      projectId: firstStuck.projectId,
      message,
    });
  }

  if (queue.failed > 0) {
    issues.push(`${queue.failed} 个索引任务执行失败`);
    const message = '查看失败详情并修复: contextatlas health:check --json';
    recommendations.push(message);
    manual.push({
      kind: 'manual',
      actionId: null,
      projectId: null,
      message,
    });
  }

  for (const snap of snapshots) {
    if (!snap.hasCurrentSnapshot) {
      issues.push(`项目 ${snap.projectId}: 无当前快照`);
      const message = `重新索引: contextatlas index ${snap.projectId}`;
      recommendations.push(message);
      manual.push({
        kind: 'manual',
        actionId: null,
        projectId: snap.projectId,
        message,
      });
    }

    if (snap.dbIntegrity === 'corrupted') {
      issues.push(`项目 ${snap.projectId}: 索引数据库损坏`);
      const message = `强制重建索引: contextatlas index ${snap.projectId} --force`;
      recommendations.push(message);
      manual.push({
        kind: 'manual',
        actionId: null,
        projectId: snap.projectId,
        message,
      });
    }

    if (snap.hasIndexDb && !snap.hasVectorIndex && snap.fileCount > 0) {
      issues.push(`项目 ${snap.projectId}: 缺少向量索引`);
      const message = `重新索引以生成向量: contextatlas index ${snap.projectId} --force`;
      recommendations.push(message);
      manual.push({
        kind: 'manual',
        actionId: null,
        projectId: snap.projectId,
        message,
      });
    }

    if (snap.vectorChunkCount > 0 && (!snap.hasChunksFts || snap.chunkFtsCount === 0)) {
      issues.push(`项目 ${snap.projectId}: chunk FTS 覆盖不足 (0/${snap.vectorChunkCount})`);
      const message = `重建 chunk FTS: contextatlas fts:rebuild-chunks --project-id ${snap.projectId}`;
      recommendations.push(message);
      autoFixable.push({
        kind: 'auto',
        actionId: 'rebuild-chunk-fts',
        projectId: snap.projectId,
        message,
      });
    } else if (
      snap.vectorChunkCount > 0 &&
      snap.chunkFtsCoverage !== null &&
      snap.chunkFtsCoverage < 0.95
    ) {
      issues.push(
        `项目 ${snap.projectId}: chunk FTS 覆盖不足 (${snap.chunkFtsCount}/${snap.vectorChunkCount})`,
      );
      const message = `重建 chunk FTS: contextatlas fts:rebuild-chunks --project-id ${snap.projectId}`;
      recommendations.push(message);
      autoFixable.push({
        kind: 'auto',
        actionId: 'rebuild-chunk-fts',
        projectId: snap.projectId,
        message,
      });
    }
  }

  if (!daemon.isRunning && queue.queued > 0) {
    issues.push('守护进程未运行但有排队任务');
    const message = '启动守护进程: contextatlas daemon start';
    recommendations.push(message);
    autoFixable.push({
      kind: 'auto',
      actionId: 'start-daemon',
      projectId: null,
      message,
    });
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
    overall: {
      status,
      issues,
      recommendations,
      repairPlan: {
        autoFixable: dedupeRepairEntries(autoFixable),
        manual: dedupeRepairEntries(manual),
      },
    },
  };
}

export function formatIndexHealthReport(report: IndexHealthReport): string {
  const lines: string[] = [];
  const latestSuccessSnapshot = report.snapshots.find((snap) => snap.lastSuccessfulAt) || null;
  const repairPlan = report.overall.repairPlan || {
    autoFixable: [],
    manual: [],
  };
  const stuckRunning = report.queue.stuckRunning || [];
  const recentFailures = report.queue.recentFailures || [];

  lines.push('Index Health Panel');
  lines.push(`Status: ${report.overall.status.toUpperCase()}`);
  lines.push('');

  lines.push('Overview:');
  lines.push(`  Queue Length: ${report.queue.queued}`);
  lines.push(`  Running Tasks: ${report.queue.running}`);
  lines.push(`  Failed Tasks: ${report.queue.failed}`);
  lines.push(
    `  Latest Success: ${latestSuccessSnapshot?.lastSuccessfulAt || 'n/a'}${latestSuccessSnapshot?.lastSuccessfulScope ? ` (${latestSuccessSnapshot.lastSuccessfulScope})` : ''}`,
  );
  if (report.queue.oldestQueuedAgeHuman) {
    lines.push(`  Oldest Queued: ${report.queue.oldestQueuedAgeHuman}`);
  }
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
  if (report.queue.oldestRunningAgeHuman) {
    lines.push(`  Oldest Running: ${report.queue.oldestRunningAgeHuman}`);
  }
  if (stuckRunning.length > 0) {
    lines.push('  Stuck Running:');
    for (const task of stuckRunning) {
      lines.push(
        `    - ${task.projectId}/${task.taskId} ${task.scope} running=${task.runningAgeHuman || 'unknown'} attempts=${task.attempts}`,
      );
    }
  }
  if (recentFailures.length > 0) {
    lines.push('  Recent Failures:');
    for (const f of recentFailures) {
      lines.push(
        `    - ${f.projectId}/${f.taskId} (${f.scope}, ${f.finishedAgeHuman || 'unknown'}): ${f.lastError || 'unknown'}`,
      );
    }
  }
  lines.push('');

  lines.push('Blocked On:');
  const blockers = buildBlockedOnLines(report);
  if (blockers.length > 0) {
    for (const blocker of blockers) {
      lines.push(`  - ${blocker}`);
    }
  } else {
    lines.push('  - No current blocker');
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

  lines.push('Recovery Path:');
  if (report.overall.recommendations.length > 0) {
    for (const rec of report.overall.recommendations) {
      lines.push(`  - ${rec}`);
    }
  } else {
    lines.push('  - No recovery action needed');
  }
  lines.push('');

  lines.push('Auto Fixable:');
  if (repairPlan.autoFixable.length > 0) {
    for (const item of repairPlan.autoFixable) {
      lines.push(
        `  - ${item.message}${item.actionId ? ` [action=${item.actionId}]` : ''}${item.projectId ? ` [project=${item.projectId}]` : ''}`,
      );
    }
  } else {
    lines.push('  - No automatic repair action');
  }
  lines.push('');

  lines.push('Manual Checks:');
  if (repairPlan.manual.length > 0) {
    for (const item of repairPlan.manual) {
      lines.push(`  - ${item.message}${item.projectId ? ` [project=${item.projectId}]` : ''}`);
    }
  } else {
    lines.push('  - No manual follow-up needed');
  }
  lines.push('');

  lines.push('Project Panels:');
  for (const snap of report.snapshots) {
    lines.push(`  ${snap.projectId}:`);
    lines.push(`    Current Status: ${snap.dbIntegrity === 'corrupted' ? 'corrupted' : 'ready'}`);
    lines.push(`    Snapshot Version: ${snap.currentSnapshotId || 'none'}`);
    if (snap.lastSuccessfulAt) {
      lines.push(
        `    Last Success: ${snap.lastSuccessfulAt} (${snap.lastSuccessfulScope || 'unknown'}, ${snap.lastSuccessfulAgeHuman})`,
      );
    }
    lines.push(`    Latest Mode: ${snap.lastSuccessfulScope || 'unknown'}`);
    lines.push(`    Snapshot Count: ${snap.totalSnapshots}`);
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
    if (snap.latestTaskRepoPath) {
      lines.push(`    Repo: ${snap.latestTaskRepoPath}`);
    }
    if (snap.strategySummary) {
      lines.push(
        `    Strategy: ${snap.strategySummary.mode} changed=${snap.strategySummary.signals.changedFiles} churn=${(snap.strategySummary.signals.churnRatio * 100).toFixed(1)}% incrCost=${(snap.strategySummary.signals.incrementalCostRatio * 100).toFixed(1)}% triggers=${snap.strategySummary.signals.fullRebuildTriggers.join(',') || 'none'}`,
      );
    }
    if (snap.lastModified) {
      lines.push(`    Updated: ${snap.lastModified}`);
    }
    const recoveryHints = buildSnapshotRecoveryHints(snap);
    if (recoveryHints.length > 0) {
      lines.push('    Recovery:');
      for (const hint of recoveryHints) {
        lines.push(`      - ${hint}`);
      }
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

  if (report.overall.recommendations.length === 0) {
    lines.push('No issues detected. All systems healthy.');
  }

  return lines.join('\n');
}

function dedupeRepairEntries<T extends { message: string; projectId: string | null }>(entries: T[]): T[] {
  return entries.filter(
    (entry, index, array) =>
      array.findIndex(
        (candidate) => candidate.message === entry.message && candidate.projectId === entry.projectId,
      ) === index,
  );
}

function buildBlockedOnLines(report: IndexHealthReport): string[] {
  const blockers: string[] = [];
  const stuckRunning = report.queue.stuckRunning || [];
  const recentFailures = report.queue.recentFailures || [];

  if (!report.daemon.isRunning && report.queue.queued > 0) {
    blockers.push(`daemon 未运行，${report.queue.queued} 个任务仍在队列中`);
  }
  if (report.queue.oldestQueuedAgeHuman) {
    blockers.push(`最老排队任务已等待 ${report.queue.oldestQueuedAgeHuman}`);
  }
  for (const task of stuckRunning) {
    blockers.push(
      `${task.projectId}/${task.taskId} 运行 ${task.runningAgeHuman || 'unknown'}，可用 contextatlas task:inspect ${task.taskId}`,
    );
  }
  for (const failure of recentFailures.slice(0, 2)) {
    blockers.push(
      `最近失败 ${failure.projectId}/${failure.taskId}: ${failure.lastError || 'unknown'}`,
    );
  }

  return blockers;
}

function buildSnapshotRecoveryHints(snap: SnapshotHealth): string[] {
  const hints: string[] = [];

  if (!snap.hasCurrentSnapshot) {
    hints.push(`Run full index: contextatlas index ${snap.projectId} --force`);
  }
  if (snap.dbIntegrity === 'corrupted') {
    hints.push(`Rebuild corrupted index: contextatlas index ${snap.projectId} --force`);
  }
  if (snap.hasIndexDb && !snap.hasVectorIndex && snap.fileCount > 0) {
    hints.push(`Regenerate vector index: contextatlas index ${snap.projectId} --force`);
  }
  if (snap.vectorChunkCount > 0 && (!snap.hasChunksFts || snap.chunkFtsCount === 0)) {
    hints.push(`Rebuild chunk FTS: contextatlas fts:rebuild-chunks --project-id ${snap.projectId}`);
  } else if (
    snap.vectorChunkCount > 0
    && snap.chunkFtsCoverage !== null
    && snap.chunkFtsCoverage < 0.95
  ) {
    hints.push(`Repair chunk FTS coverage: contextatlas fts:rebuild-chunks --project-id ${snap.projectId}`);
  }

  return hints;
}
