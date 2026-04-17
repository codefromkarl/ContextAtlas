import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { initDb } from '../src/db/index.ts';
import {
  enqueueIndexTask,
  markTaskDone,
  markTaskFailed,
  pickNextQueuedTask,
  resolveQueueDbPath,
} from '../src/indexing/queue.ts';
import { analyzeIndexHealth, formatIndexHealthReport } from '../src/monitoring/indexHealth.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeBaseDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cw-index-health-'));
}
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
  assert.ok(
    report.overall.repairPlan.autoFixable.some(
      (item) => item.actionId === 'rebuild-chunk-fts' && item.projectId === projectId,
    ),
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
      repairPlan: {
        autoFixable: [
          {
            kind: 'auto',
            actionId: 'start-daemon',
            projectId: null,
            message: '启动守护进程: contextatlas daemon start',
          },
        ],
        manual: [
          {
            kind: 'manual',
            actionId: null,
            projectId: null,
            message: '查看失败详情并修复: contextatlas health:check --json',
          },
        ],
      },
    },
  });

  assert.match(output, /Index Health Panel/);
  assert.match(output, /Overview:/);
  assert.match(output, /Queue Length: 3/);
  assert.match(output, /Recent Failures:/);
  assert.match(output, /Recovery Path:/);
  assert.match(output, /Auto Fixable:/);
  assert.match(output, /Manual Checks:/);
  assert.match(output, /contextatlas daemon start/);
  assert.match(output, /Project Panels:/);
  assert.match(output, /Snapshot Version: snap-20260406/);
  assert.match(output, /Latest Mode: incremental/);
});

test('analyzeIndexHealth exposes stuck running tasks and blocked-on summary', async () => {
  const baseDir = createTempBaseDir();
  process.env.CONTEXTATLAS_BASE_DIR = baseDir;
  const projectId = 'proj-stuck-running';

  const queued = enqueueIndexTask({
    projectId,
    repoPath: '/repos/proj-stuck-running',
    scope: 'full',
    reason: 'queued-test',
    requestedBy: 'test',
    priority: 1,
  });
  enqueueIndexTask({
    projectId,
    repoPath: '/repos/proj-stuck-running',
    scope: 'incremental',
    reason: 'running-test',
    requestedBy: 'test',
    priority: 10,
  });

  const runningTask = pickNextQueuedTask('worker-running');
  assert.ok(runningTask);

  const db = new Database(resolveQueueDbPath());
  db.prepare('UPDATE index_tasks SET started_at = ? WHERE task_id = ?').run(
    Date.now() - 31 * 60 * 1000,
    runningTask!.taskId,
  );
  db.close();

  const failedTask = pickNextQueuedTask('worker-failed');
  assert.ok(failedTask);
  markTaskFailed(failedTask!.taskId, 'vector timeout');

  enqueueIndexTask({
    projectId,
    repoPath: '/repos/proj-stuck-running',
    scope: 'full',
    reason: 'queued-after-fail',
    requestedBy: 'test',
  });

  const report = await analyzeIndexHealth({
    baseDir,
    projectIds: [projectId],
  });

  assert.equal(report.queue.queued, 1);
  assert.ok(report.queue.oldestQueuedAgeHuman);
  assert.ok(report.queue.oldestRunningAgeHuman);
  assert.equal(report.queue.stuckRunning.length, 1);
  assert.equal(report.queue.stuckRunning[0]?.taskId, runningTask!.taskId);
  assert.equal(report.queue.recentFailures[0]?.taskId, failedTask!.taskId);
  assert.ok(report.overall.issues.some((issue) => issue.includes('运行中任务卡住')));
  assert.ok(
    report.overall.recommendations.some((rec) => rec.includes(`contextatlas task:inspect ${runningTask!.taskId}`)),
  );

  const output = formatIndexHealthReport(report);
  assert.match(output, /Blocked On:/);
  assert.match(output, /Stuck Running:/);
  assert.match(output, new RegExp(runningTask!.taskId));
  assert.match(output, /最老排队任务已等待/);
  assert.match(output, /daemon 未运行/);
});

test('health:check --project-id scopes queue noise to the requested project', () => {
  const baseDir = makeBaseDir();
  const previousBaseDir = process.env.CONTEXTATLAS_BASE_DIR;
  process.env.CONTEXTATLAS_BASE_DIR = baseDir;

  try {
    const targetProjectId = 'proj-target';
    const noiseProjectId = 'proj-noise';

    enqueueIndexTask({
      projectId: noiseProjectId,
      repoPath: '/repos/proj-noise',
      scope: 'full',
      reason: 'noise-test',
      requestedBy: 'test',
    });

    const noiseTask = pickNextQueuedTask('worker-noise');
    assert.ok(noiseTask);
    markTaskFailed(noiseTask!.taskId, 'historical noise failure');

    enqueueIndexTask({
      projectId: targetProjectId,
      repoPath: '/repos/proj-target',
      scope: 'incremental',
      reason: 'target-test',
      requestedBy: 'test',
    });

    const result = spawnSync(
      'node',
      ['--import', 'tsx', 'src/index.ts', 'health:check', '--json', '--project-id', targetProjectId],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          CONTEXTATLAS_BASE_DIR: baseDir,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.queue.queued, 1);
    assert.equal(payload.queue.failed, 0);
    assert.deepEqual(payload.queue.recentFailures, []);
    assert.ok(
      payload.overall.issues.every((issue: string) => !issue.includes('执行失败')),
      JSON.stringify(payload.overall.issues),
    );
  } finally {
    if (previousBaseDir === undefined) {
      delete process.env.CONTEXTATLAS_BASE_DIR;
    } else {
      process.env.CONTEXTATLAS_BASE_DIR = previousBaseDir;
    }
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('analyzeIndexHealth quick mode skips VectorStore and strategy analysis', async () => {
  const baseDir = createTempBaseDir();
  process.env.CONTEXTATLAS_BASE_DIR = baseDir;
  const projectId = 'proj-quick-mode';

  // 创建完整快照（含向量索引）
  const prepared = prepareWritableSnapshot(projectId, baseDir);
  const db = initDb(projectId, prepared.snapshotId);
  db.prepare(
    'INSERT INTO files(path, hash, mtime, size, content, language, vector_index_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run('src/a.ts', 'h1', Date.now(), 10, 'export const a = 1;', 'typescript', 'h1');
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

  // 记录一个已完成的任务（使 strategySummary 有数据）
  enqueueIndexTask({
    projectId,
    repoPath: '/repos/proj-quick-mode',
    scope: 'full',
    reason: 'test',
    requestedBy: 'test',
  });
  const task = pickNextQueuedTask();
  markTaskDone(task!.taskId);

  // quick mode 应跳过重操作
  const report = await analyzeIndexHealth({
    baseDir,
    projectIds: [projectId],
    quick: true,
  });

  const snap = report.snapshots[0];

  // 基本信息仍完整
  assert.equal(snap.hasCurrentSnapshot, true);
  assert.equal(snap.hasIndexDb, true);
  assert.equal(snap.hasVectorIndex, true);
  assert.equal(snap.fileCount, 1);
  assert.equal(snap.dbIntegrity, 'ok');
  assert.equal(snap.lastSuccessfulScope, 'full');

  // quick 模式跳过的字段
  assert.equal(snap.vectorChunkCount, 0, 'vectorChunkCount should be 0 in quick mode');
  assert.equal(snap.chunkFtsCoverage, null, 'chunkFtsCoverage should be null in quick mode');
  assert.equal(snap.strategySummary, null, 'strategySummary should be null in quick mode');

  // chunk FTS 相关：quick 模式仍查 SQLite（轻量），但不因 vectorCount=0 误报
  assert.ok(
    !report.overall.issues.some((i) => i.includes('chunk FTS 覆盖不足')),
    'quick mode should not report chunk FTS coverage issues',
  );
});

test('health:check --quick CLI flag skips snapshot scan and returns fast', () => {
  const baseDir = makeBaseDir();
  const previousBaseDir = process.env.CONTEXTATLAS_BASE_DIR;
  process.env.CONTEXTATLAS_BASE_DIR = baseDir;

  try {
    const start = Date.now();
    const result = spawnSync(
      'node',
      ['--import', 'tsx', 'src/index.ts', 'health:check', '--json', '--quick'],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          CONTEXTATLAS_BASE_DIR: baseDir,
        },
      },
    );
    const elapsed = Date.now() - start;

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.ok(payload.overall);
    assert.ok(payload.queue);
    assert.ok(payload.daemon);
    // quick + 无显式 projectIds → 跳过 snapshot 扫描
    assert.ok(Array.isArray(payload.snapshots));
    assert.equal(payload.snapshots.length, 0);
    // 应在 3 秒内完成（无文件系统扫描）
    assert.ok(elapsed < 3000, `Expected <3s but took ${elapsed}ms`);
  } finally {
    if (previousBaseDir === undefined) {
      delete process.env.CONTEXTATLAS_BASE_DIR;
    } else {
      process.env.CONTEXTATLAS_BASE_DIR = previousBaseDir;
    }
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('health:check --project-id --quick only inspects the target project with no vector overhead', async () => {
  const baseDir = createTempBaseDir();
  process.env.CONTEXTATLAS_BASE_DIR = baseDir;
  const projectId = 'proj-fast-path';

  // 创建目标项目
  const prepared = prepareWritableSnapshot(projectId, baseDir);
  const db = initDb(projectId, prepared.snapshotId);
  db.prepare(
    'INSERT INTO files(path, hash, mtime, size, content, language, vector_index_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run('src/b.ts', 'h2', Date.now(), 20, 'export const b = 2;', 'typescript', 'h2');
  db.close();
  commitSnapshot(projectId, prepared.snapshotId, baseDir);

  // 用 CLI 验证 --project-id + --quick 组合
  const start = Date.now();
  const result = spawnSync(
    'node',
    ['--import', 'tsx', 'src/index.ts', 'health:check', '--json', '--project-id', projectId, '--quick'],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        CONTEXTATLAS_BASE_DIR: baseDir,
      },
    },
  );
  const elapsed = Date.now() - start;

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);

  // 只检查目标项目
  assert.equal(payload.snapshots.length, 1);
  assert.equal(payload.snapshots[0].projectId, projectId);

  // quick 模式跳过 vector/strategy
  assert.equal(payload.snapshots[0].vectorChunkCount, 0);
  assert.equal(payload.snapshots[0].strategySummary, null);

  // 基本信息仍完整
  assert.equal(payload.snapshots[0].hasCurrentSnapshot, true);
  assert.equal(payload.snapshots[0].fileCount, 1);

  // 应该在 5 秒内完成（无 VectorStore 开销）
  assert.ok(elapsed < 5000, `Expected <5s but took ${elapsed}ms`);
});

test('health:full CLI 输出稳定 JSON 结构', () => {
  const baseDir = makeBaseDir();
  const previousBaseDir = process.env.CONTEXTATLAS_BASE_DIR;
  process.env.CONTEXTATLAS_BASE_DIR = baseDir;

  try {
    const result = spawnSync(
      'node',
      ['--import', 'tsx', 'src/index.ts', 'health:full', '--json'],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          CONTEXTATLAS_BASE_DIR: baseDir,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.ok(payload.indexHealth);
    assert.ok(payload.memoryHealth);
    assert.ok(payload.mcpProcessHealth);
    assert.ok(payload.alerts);
    assert.equal(typeof payload.indexHealth.overall.status, 'string');
    assert.equal(typeof payload.mcpProcessHealth.overall.status, 'string');
    assert.ok(Array.isArray(payload.alerts.triggered));
  } finally {
    if (previousBaseDir === undefined) {
      delete process.env.CONTEXTATLAS_BASE_DIR;
    } else {
      process.env.CONTEXTATLAS_BASE_DIR = previousBaseDir;
    }
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});
