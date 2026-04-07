import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  enqueueIndexTask,
  formatTaskInspectReport,
  formatTaskStatusReport,
  getTaskById,
  getTaskStatusReport,
  markTaskFailed,
  pickNextQueuedTask,
  resolveQueueDbPath,
} from '../src/indexing/queue.ts';

function makeTempBaseDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cw-queue-test-'));
}

test('enqueueIndexTask 对同一 project/scope 去重', () => {
  const baseDir = makeTempBaseDir();
  process.env.CONTEXTATLAS_BASE_DIR = baseDir;

  const first = enqueueIndexTask({
    projectId: 'p1',
    repoPath: '/tmp/repo-a',
    scope: 'incremental',
    reason: 'test',
  });
  const second = enqueueIndexTask({
    projectId: 'p1',
    repoPath: '/tmp/repo-a',
    scope: 'incremental',
    reason: 'test-dup',
  });

  assert.equal(first.reusedExisting, false);
  assert.equal(second.reusedExisting, true);
  assert.equal(first.task.taskId, second.task.taskId);
});

test('pickNextQueuedTask 按优先级与创建时间取任务，并切换为 running', () => {
  const baseDir = makeTempBaseDir();
  process.env.CONTEXTATLAS_BASE_DIR = baseDir;

  const low = enqueueIndexTask({
    projectId: 'p-low',
    repoPath: '/tmp/repo-low',
    scope: 'full',
    priority: 1,
  });
  const high = enqueueIndexTask({
    projectId: 'p-high',
    repoPath: '/tmp/repo-high',
    scope: 'full',
    priority: 10,
  });

  const picked = pickNextQueuedTask('worker-1');
  assert.ok(picked);
  assert.equal(picked.taskId, high.task.taskId);
  assert.equal(picked.status, 'running');

  const lowTask = getTaskById(low.task.taskId);
  assert.ok(lowTask);
  assert.equal(lowTask.status, 'queued');
});

test('getTaskStatusReport 汇总队列、卡住任务与最近失败摘要', () => {
  const baseDir = makeTempBaseDir();
  process.env.CONTEXTATLAS_BASE_DIR = baseDir;

  enqueueIndexTask({
    projectId: 'p-status',
    repoPath: '/tmp/repo-status',
    scope: 'full',
  });
  enqueueIndexTask({
    projectId: 'p-status',
    repoPath: '/tmp/repo-status',
    scope: 'incremental',
    priority: 10,
  });

  const pickedRunning = pickNextQueuedTask('worker-running');
  assert.ok(pickedRunning);

  const db = new Database(resolveQueueDbPath());
  db.prepare('UPDATE index_tasks SET started_at = ? WHERE task_id = ?').run(
    Date.now() - 45_000,
    pickedRunning!.taskId,
  );
  db.close();

  const pickedFailed = pickNextQueuedTask('worker-failed');
  assert.ok(pickedFailed);
  markTaskFailed(pickedFailed!.taskId, 'boom');

  const queued = enqueueIndexTask({
    projectId: 'p-status',
    repoPath: '/tmp/repo-status',
    scope: 'full',
  });

  const report = getTaskStatusReport({
    projectId: 'p-status',
    staleRunningMs: 30_000,
  });

  assert.equal(report.projectId, 'p-status');
  assert.equal(report.counts.queued, 1);
  assert.equal(report.counts.running, 1);
  assert.equal(report.counts.failed, 1);
  assert.equal(report.stuckRunning.length, 1);
  assert.equal(report.stuckRunning[0]?.taskId, pickedRunning!.taskId);
  assert.equal(report.recentFailures[0]?.taskId, pickedFailed!.taskId);
  assert.ok(report.oldestQueuedAgeHuman);
  assert.ok(report.oldestRunningAgeHuman);

  const text = formatTaskStatusReport(report);
  assert.match(text, /Task Status/);
  assert.match(text, /Stuck Running:/);
  assert.match(text, /Recent Failures:/);
  assert.match(text, /task:inspect/);
  assert.match(text, new RegExp(queued.task.taskId));
});

test('formatTaskInspectReport 输出任务详情与 execution hint 摘要', () => {
  const baseDir = makeTempBaseDir();
  process.env.CONTEXTATLAS_BASE_DIR = baseDir;

  const enqueued = enqueueIndexTask({
    projectId: 'p-inspect',
    repoPath: '/tmp/repo-inspect',
    scope: 'incremental',
    reason: 'files-modified',
    requestedBy: 'test',
    executionHint: {
      generatedAt: 1_700_000_000_000,
      ttlMs: 600_000,
      changeSummary: {
        added: 1,
        modified: 2,
        deleted: 0,
        unchangedNeedingVectorRepair: 1,
        unchanged: 10,
        skipped: 0,
        errors: 0,
        totalFiles: 14,
      },
      candidates: [{ relPath: 'src/a.ts', mtime: 1, size: 2 }],
      deletedPaths: [],
      healingPaths: [{ relPath: 'src/b.ts', mtime: 3, size: 4 }],
    },
  });

  const task = getTaskById(enqueued.task.taskId);
  assert.ok(task);

  const text = formatTaskInspectReport(task!);
  assert.match(text, /Task Inspect/);
  assert.match(text, /files-modified/);
  assert.match(text, /Requested By: test/);
  assert.match(text, /Execution Hint:/);
  assert.match(text, /Candidates: 1/);
  assert.match(text, /Healing Paths: 1/);
});
