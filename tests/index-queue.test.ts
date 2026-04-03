import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { enqueueIndexTask, getTaskById, pickNextQueuedTask } from '../src/indexing/queue.ts';

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
