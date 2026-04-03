import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runIndexDaemonOnce } from '../src/indexing/daemon.ts';
import {
  enqueueIndexTask,
  getTaskById,
  markTaskDone,
  markTaskFailed,
  pickNextQueuedTask,
  requeueStaleRunningTasks,
} from '../src/indexing/queue.ts';

function makeTempBaseDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cw-daemon-test-'));
}

test('runIndexDaemonOnce 成功执行任务后标记 done', async () => {
  const baseDir = makeTempBaseDir();
  process.env.CONTEXTATLAS_BASE_DIR = baseDir;

  const enqueued = enqueueIndexTask({
    projectId: 'p-daemon-ok',
    repoPath: '/tmp/repo-daemon-ok',
    scope: 'full',
  });

  let called = 0;
  await runIndexDaemonOnce(
    async () => {
      called++;
    },
    {
      pickNextQueuedTask,
      markTaskDone,
      markTaskFailed,
      requeueStaleRunningTasks,
    },
  );

  const task = getTaskById(enqueued.task.taskId);
  assert.ok(task);
  assert.equal(called, 1);
  assert.equal(task.status, 'done');
});

test('runIndexDaemonOnce 任务执行失败后标记 failed', async () => {
  const baseDir = makeTempBaseDir();
  process.env.CONTEXTATLAS_BASE_DIR = baseDir;

  const enqueued = enqueueIndexTask({
    projectId: 'p-daemon-fail',
    repoPath: '/tmp/repo-daemon-fail',
    scope: 'incremental',
  });

  await runIndexDaemonOnce(
    async () => {
      throw new Error('boom');
    },
    {
      pickNextQueuedTask,
      markTaskDone,
      markTaskFailed,
      requeueStaleRunningTasks,
    },
  );

  const task = getTaskById(enqueued.task.taskId);
  assert.ok(task);
  assert.equal(task.status, 'failed');
  assert.match(task.lastError || '', /boom/);
});
