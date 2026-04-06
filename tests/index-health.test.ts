import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initDb } from '../src/db/index.ts';
import {
  enqueueIndexTask,
  markTaskDone,
  pickNextQueuedTask,
} from '../src/indexing/queue.ts';
import { analyzeIndexHealth, formatIndexHealthReport } from '../src/monitoring/indexHealth.ts';
import { commitSnapshot, prepareWritableSnapshot } from '../src/storage/layout.ts';
import { VectorStore } from '../src/vectorStore/index.ts';

function createTempBaseDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cw-index-health-test-'));
}

test('analyzeIndexHealth reports degraded chunk FTS coverage when vector chunks exist but chunks_fts is empty', async () => {
  const baseDir = createTempBaseDir();
  process.env.CONTEXTATLAS_BASE_DIR = baseDir;
  const projectId = 'proj-chunk-fts-gap';

  const prepared = prepareWritableSnapshot(projectId, baseDir);
  const db = initDb(projectId, prepared.snapshotId);
  db.prepare(
    'INSERT INTO files(path, hash, mtime, size, content, language, vector_index_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run('src/a.ts', 'h1', Date.now(), 10, 'export const a = 1;', 'typescript', 'h1');
  db.exec('DELETE FROM chunks_fts');
  db.close();

  const vectorStore = new VectorStore(projectId, 1024, prepared.snapshotId);
  await vectorStore.init();
  await vectorStore.batchUpsertFiles([
    {
      path: 'src/a.ts',
      hash: 'h1',
      records: [
        {
          chunk_id: 'src/a.ts#h1#0',
          file_path: 'src/a.ts',
          file_hash: 'h1',
          chunk_index: 0,
          vector: Array.from({ length: 1024 }, () => 0),
          display_code: 'export const a = 1;',
          vector_text: '// Context: src/a.ts\nexport const a = 1;',
          language: 'typescript',
          breadcrumb: 'src/a.ts',
          start_index: 0,
          end_index: 10,
          raw_start: 0,
          raw_end: 10,
          vec_start: 0,
          vec_end: 10,
        },
      ],
    },
  ]);
  await vectorStore.close();

  commitSnapshot(projectId, prepared.snapshotId, baseDir);

  const report = await analyzeIndexHealth({
    baseDir,
    projectIds: [projectId],
  });

  assert.equal(report.snapshots[0].hasChunksFts, true);
  assert.equal(report.snapshots[0].chunkFtsCount, 0);
  assert.equal(report.snapshots[0].vectorChunkCount, 1);
  assert.equal(report.snapshots[0].chunkFtsCoverage, 0);
  assert.equal(report.overall.status, 'degraded');
  assert.ok(report.overall.issues.some((issue) => issue.includes('chunk FTS 覆盖不足')));
  assert.ok(
    report.overall.recommendations.some((rec) => rec.includes('fts:rebuild-chunks')),
  );
});

test('analyzeIndexHealth reports last successful index time and latest scope per project', async () => {
  const baseDir = createTempBaseDir();
  process.env.CONTEXTATLAS_BASE_DIR = baseDir;
  const projectId = 'proj-last-success';

  const prepared = prepareWritableSnapshot(projectId, baseDir);
  const db = initDb(projectId, prepared.snapshotId);
  db.exec('DELETE FROM files');
  db.close();
  commitSnapshot(projectId, prepared.snapshotId, baseDir);

  enqueueIndexTask({
    projectId,
    repoPath: '/repos/proj-last-success',
    scope: 'full',
    reason: 'initial',
    requestedBy: 'test',
  });
  const first = pickNextQueuedTask();
  assert.ok(first);
  markTaskDone(first!.taskId);

  await new Promise((resolve) => setTimeout(resolve, 5));

  enqueueIndexTask({
    projectId,
    repoPath: '/repos/proj-last-success',
    scope: 'incremental',
    reason: 'follow-up',
    requestedBy: 'test',
  });
  const second = pickNextQueuedTask();
  assert.ok(second);
  markTaskDone(second!.taskId);

  const report = await analyzeIndexHealth({
    baseDir,
    projectIds: [projectId],
  });

  assert.equal(report.snapshots[0].lastSuccessfulScope, 'incremental');
  assert.ok(report.snapshots[0].lastSuccessfulAt);
  assert.match(report.snapshots[0].lastSuccessfulAt!, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(report.snapshots[0].lastSuccessfulAgeHuman);
});

test('formatIndexHealthReport exposes panel-style overview and recovery path', () => {
  const output = formatIndexHealthReport({
    queue: {
      totalTasks: 8,
      queued: 3,
      running: 1,
      done: 3,
      failed: 1,
      canceled: 0,
      oldestQueuedAgeMs: 12_000,
      oldestQueuedAgeHuman: '12s',
      recentFailures: [
        {
          taskId: 'task-1',
          projectId: 'proj-a',
          lastError: 'vector index missing',
          finishedAt: Date.now(),
        },
      ],
    },
    daemon: {
      isRunning: false,
      pid: null,
      lockFileAge: '2m',
      queuePollingActive: false,
    },
    snapshots: [
      {
        projectId: 'proj-a',
        hasCurrentSnapshot: true,
        currentSnapshotId: 'snap-20260406',
        lastSuccessfulAt: '2026-04-06T10:00:00.000Z',
        lastSuccessfulAgeHuman: '5m',
        lastSuccessfulScope: 'incremental',
        totalSnapshots: 2,
        snapshotIds: ['snap-20260405', 'snap-20260406'],
        hasIndexDb: true,
        hasVectorIndex: true,
        dbSizeBytes: 1024,
        vectorSizeBytes: 2048,
        dbIntegrity: 'ok',
        fileCount: 10,
        hasChunksFts: true,
        chunkFtsCount: 90,
        vectorChunkCount: 100,
        chunkFtsCoverage: 0.9,
        lastModified: '2026-04-06T10:01:00.000Z',
      },
    ],
    overall: {
      status: 'degraded',
      issues: ['1 个索引任务执行失败'],
      recommendations: [
        '启动守护进程: contextatlas daemon start',
        '查看失败详情并修复: contextatlas health:check --json',
      ],
    },
  });

  assert.match(output, /Index Health Panel/);
  assert.match(output, /Overview:/);
  assert.match(output, /Queue Length: 3/);
  assert.match(output, /Recent Failures:/);
  assert.match(output, /Recovery Path:/);
  assert.match(output, /contextatlas daemon start/);
  assert.match(output, /Project Panels:/);
  assert.match(output, /Snapshot Version: snap-20260406/);
  assert.match(output, /Latest Mode: incremental/);
});
