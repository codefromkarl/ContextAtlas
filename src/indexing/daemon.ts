import type { IndexTask } from './types.js';

const DEFAULT_POLL_MS = 1000;
const DEFAULT_STALE_RUNNING_MS = 30 * 60 * 1000;

export type IndexTaskExecutor = (task: IndexTask) => Promise<void>;

interface QueueRuntime {
  pickNextQueuedTask: (workerId?: string) => IndexTask | null;
  markTaskDone: (taskId: string) => void;
  markTaskFailed: (taskId: string, errorMessage: string) => void;
  requeueStaleRunningTasks: (staleMs: number) => number;
}

async function loadQueueRuntime(): Promise<QueueRuntime> {
  const mod = await import('./queue.js');
  return {
    pickNextQueuedTask: mod.pickNextQueuedTask,
    markTaskDone: mod.markTaskDone,
    markTaskFailed: mod.markTaskFailed,
    requeueStaleRunningTasks: mod.requeueStaleRunningTasks,
  };
}

async function logWarn(message: string, payload?: Record<string, unknown>): Promise<void> {
  try {
    const { logger } = await import('../utils/logger.js');
    logger.warn(payload || {}, message);
  } catch {
    // noop
  }
}

async function logError(message: string, payload?: Record<string, unknown>): Promise<void> {
  try {
    const { logger } = await import('../utils/logger.js');
    logger.error(payload || {}, message);
  } catch {
    // noop
  }
}

async function recordIndexExecution(input: {
  projectId?: string;
  repoPath?: string;
  taskId?: string;
  scope?: 'full' | 'incremental';
  status: 'done' | 'failed';
  durationMs: number;
  error?: string;
}): Promise<void> {
  try {
    const { recordIndexUsage } = await import('../usage/usageTracker.js');
    recordIndexUsage({
      projectId: input.projectId,
      repoPath: input.repoPath,
      taskId: input.taskId,
      scope: input.scope,
      phase: 'execute',
      status: input.status,
      requestedBy: 'daemon',
      durationMs: input.durationMs,
      error: input.error,
    });
  } catch {
    // noop
  }
}

function resolvePollMs(): number {
  const raw = Number.parseInt(process.env.INDEX_QUEUE_POLL_MS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_POLL_MS;
}

function resolveStaleRunningMs(): number {
  const raw = Number.parseInt(process.env.INDEX_DAEMON_STALE_RUNNING_MS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STALE_RUNNING_MS;
}

async function defaultExecutor(task: IndexTask): Promise<void> {
  const { withLock } = await import('../utils/lock.js');
  const { scanWithSnapshotSwap } = await import('../scanner/index.js');
  await withLock(task.projectId, 'index', async () => scanWithSnapshotSwap(task.repoPath, { vectorIndex: true }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runIndexDaemonOnce(
  executor: IndexTaskExecutor = defaultExecutor,
  queue?: QueueRuntime,
): Promise<boolean> {
  const runtime = queue || (await loadQueueRuntime());
  const task = runtime.pickNextQueuedTask('daemon-once');
  if (!task) {
    return false;
  }

  const startedAt = Date.now();
  try {
    await executor(task);
    runtime.markTaskDone(task.taskId);
    await recordIndexExecution({
      projectId: task.projectId,
      repoPath: task.repoPath,
      taskId: task.taskId,
      scope: task.scope,
      status: 'done',
      durationMs: Date.now() - startedAt,
    });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    runtime.markTaskFailed(task.taskId, message);
    await recordIndexExecution({
      projectId: task.projectId,
      repoPath: task.repoPath,
      taskId: task.taskId,
      scope: task.scope,
      status: 'failed',
      durationMs: Date.now() - startedAt,
      error: message,
    });
    await logError('索引任务执行失败', { taskId: task.taskId, error: message });
    return false;
  }
}

export async function runIndexDaemon(executor: IndexTaskExecutor = defaultExecutor): Promise<void> {
  const queue = await loadQueueRuntime();
  const pollMs = resolvePollMs();
  const staleRunningMs = resolveStaleRunningMs();
  const recovered = queue.requeueStaleRunningTasks(staleRunningMs);
  if (recovered > 0) {
    await logWarn('恢复僵死运行中的索引任务', { recovered });
  }

  let shouldStop = false;

  const onSignal = (signal: NodeJS.Signals) => {
    shouldStop = true;
    void logWarn('收到停止信号，索引守护进程将在当前任务后退出', { signal });
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    while (!shouldStop) {
      const didWork = await runIndexDaemonOnce(executor, queue);
      if (!didWork) {
        await sleep(pollMs);
      }
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}
