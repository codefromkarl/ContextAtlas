import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { getEmbeddingConfig } from '../src/config.ts';
import { generateProjectId, initDb } from '../src/db/index.ts';
import { enqueueIndexTask } from '../src/indexing/queue.ts';
import {
  applyOpsActionPlan,
  applyOpsActionWithVerification,
  planOpsAction,
  type OpsApplyInput,
} from '../src/monitoring/opsApply.ts';
import { MemoryHubDatabase } from '../src/memory/MemoryHubDatabase.ts';
import { MemoryStore } from '../src/memory/MemoryStore.ts';
import { prepareWritableSnapshot, commitSnapshot } from '../src/storage/layout.ts';
import { VectorStore } from '../src/vectorStore/index.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeOpsApplyInput(overrides: Partial<OpsApplyInput> = {}): OpsApplyInput {
  return {
    indexHealth: {
      queue: {
        totalTasks: 1,
        queued: 1,
        running: 0,
        done: 0,
        failed: 0,
        canceled: 0,
        oldestQueuedAgeMs: 60_000,
        oldestQueuedAgeHuman: '1m 0s',
        recentFailures: [],
      },
      snapshots: [],
      daemon: {
        isRunning: false,
        pid: null,
        lockFileAge: null,
        queuePollingActive: false,
      },
      overall: {
        status: 'degraded',
        issues: ['守护进程未运行但有排队任务'],
        recommendations: ['启动守护进程: contextatlas daemon start'],
      },
    },
    memoryHealth: {
      longTermFreshness: {
        total: 0,
        active: 0,
        stale: 0,
        expired: 0,
        activeRate: 0,
        staleRate: 0,
        expiredRate: 0,
        byType: {} as never,
        byScope: {} as never,
      },
      featureMemoryHealth: {
        total: 0,
        withValidPaths: 0,
        withOrphanedPaths: 0,
        orphanedRate: 0,
        avgKeyPatterns: 0,
        avgExports: 0,
        emptyResponsibilityCount: 0,
      },
      catalogConsistency: {
        isConsistent: true,
        missingFromCatalog: [],
        staleInCatalog: [],
        totalFeatures: 0,
        totalCatalogEntries: 0,
      },
      projectScores: [],
      overall: {
        status: 'healthy',
        issues: [],
        recommendations: [],
      },
    },
    usageReport: {
      filters: { days: 7 },
      summary: {
        totalToolCalls: 0,
        toolBreakdown: {},
        hotProjects: [],
        indexing: {
          queryBeforeIndexRate: 0,
          reusedQueueRate: 0,
          fullIndexRate: 0,
          failedExecutionRate: 0,
          avgExecutionDurationMs: 0,
        },
      },
      timeSeries: { daily: [] },
      actions: [],
      recommendations: [],
    },
    alertResult: {
      triggered: [],
      resolved: [],
      active: [],
    },
    ...overrides,
  };
}

function createTempBaseDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('planOpsAction 为可执行低风险动作生成 daemon 启动计划', () => {
  const plan = planOpsAction(makeOpsApplyInput(), {
    actionId: 'start-daemon',
    repoPath: '/repo',
  });

  assert.equal(plan.actionId, 'start-daemon');
  assert.equal(plan.kind, 'daemon-start');
  assert.equal(plan.command, 'contextatlas daemon start');
});

test('planOpsAction 在多个 chunk FTS 候选项目时要求显式 projectId', () => {
  const input = makeOpsApplyInput({
    indexHealth: {
      ...makeOpsApplyInput().indexHealth,
      queue: {
        totalTasks: 0,
        queued: 0,
        running: 0,
        done: 0,
        failed: 0,
        canceled: 0,
        oldestQueuedAgeMs: null,
        oldestQueuedAgeHuman: null,
        recentFailures: [],
      },
      snapshots: [
        {
          projectId: 'proj-a',
          hasCurrentSnapshot: true,
          currentSnapshotId: 'snap-a',
          totalSnapshots: 1,
          snapshotIds: ['snap-a'],
          hasIndexDb: true,
          hasVectorIndex: true,
          dbSizeBytes: 1,
          vectorSizeBytes: 1,
          dbIntegrity: 'ok',
          fileCount: 1,
          hasChunksFts: false,
          chunkFtsCount: 0,
          vectorChunkCount: 2,
          chunkFtsCoverage: 0,
          lastModified: new Date().toISOString(),
        },
        {
          projectId: 'proj-b',
          hasCurrentSnapshot: true,
          currentSnapshotId: 'snap-b',
          totalSnapshots: 1,
          snapshotIds: ['snap-b'],
          hasIndexDb: true,
          hasVectorIndex: true,
          dbSizeBytes: 1,
          vectorSizeBytes: 1,
          dbIntegrity: 'ok',
          fileCount: 1,
          hasChunksFts: false,
          chunkFtsCount: 0,
          vectorChunkCount: 3,
          chunkFtsCoverage: 0,
          lastModified: new Date().toISOString(),
        },
      ],
      overall: {
        status: 'degraded',
        issues: ['chunk FTS 缺失'],
        recommendations: ['重建 chunk FTS'],
      },
      daemon: {
        isRunning: true,
        pid: 123,
        lockFileAge: '1m',
        queuePollingActive: true,
      },
    },
  });

  assert.throws(
    () => planOpsAction(input, { actionId: 'rebuild-chunk-fts', repoPath: '/repo' }),
    /projectId/i,
  );

  const selected = planOpsAction(input, {
    actionId: 'rebuild-chunk-fts',
    repoPath: '/repo',
    projectId: 'proj-b',
  });
  assert.equal(selected.kind, 'fts-rebuild-chunks');
  assert.equal(selected.projectId, 'proj-b');
});

test('applyOpsActionPlan 可以重建当前仓库的 memory catalog', async () => {
  const baseDir = createTempBaseDir('cw-ops-apply-memory-');
  const repoRoot = path.join(baseDir, 'repo');
  fs.mkdirSync(path.join(repoRoot, 'src', 'search'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'src', 'search', 'SearchService.ts'), 'export const x = 1;\n');

  const hub = new MemoryHubDatabase(path.join(baseDir, 'memory-hub.db'));
  MemoryStore.setSharedHubForTests(hub);
  try {
    const store = new MemoryStore(repoRoot);
    await store.saveFeature({
      name: 'SearchService',
      responsibility: 'search pipeline',
      location: { dir: 'src/search', files: ['SearchService.ts'] },
      api: { exports: ['x'], endpoints: [] },
      dependencies: { imports: [], external: [] },
      dataFlow: 'query -> result',
      keyPatterns: ['search'],
      lastUpdated: new Date().toISOString(),
      confirmationStatus: 'human-confirmed',
    });

    const result = await applyOpsActionPlan({
      actionId: 'rebuild-memory-catalog',
      title: 'Rebuild memory catalog',
      command: 'contextatlas memory:rebuild-catalog',
      severity: 'medium',
      reason: 'catalog 不一致',
      kind: 'memory-rebuild-catalog',
      repoPath: repoRoot,
    });

    const catalog = await store.readCatalog();
    assert.equal(result.status, 'applied');
    assert.ok(catalog);
    assert.ok(catalog?.modules['searchservice']);
  } finally {
    MemoryStore.resetSharedHubForTests();
    hub.close();
  }
});

test('applyOpsActionPlan 可以按 projectId 重建 chunk FTS', async () => {
  const baseDir = createTempBaseDir('cw-ops-apply-fts-');
  const previousBaseDir = process.env.CONTEXTATLAS_BASE_DIR;
  process.env.CONTEXTATLAS_BASE_DIR = baseDir;
  MemoryStore.setSharedHubForTests(new MemoryHubDatabase());

  try {
    const repoRoot = path.join(baseDir, 'repo');
    fs.mkdirSync(repoRoot, { recursive: true });

    const projectId = generateProjectId(repoRoot);
    const prepared = prepareWritableSnapshot(projectId, baseDir);
    const db = initDb(projectId, prepared.snapshotId);
    db.prepare(
      'INSERT INTO files(path, hash, mtime, size, content, language, vector_index_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('src/a.ts', 'h1', Date.now(), 20, 'export const alpha = 1;', 'typescript', 'h1');
    db.exec('DELETE FROM chunks_fts');
    db.close();

    const vectorStore = new VectorStore(projectId, getEmbeddingConfig().dimensions, prepared.snapshotId);
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
            vector: Array.from({ length: getEmbeddingConfig().dimensions }, () => 0),
            display_code: 'export const alpha = 1;',
            vector_text: '// Context: src/a.ts\nexport const alpha = 1;',
            language: 'typescript',
            breadcrumb: 'src/a.ts',
            start_index: 0,
            end_index: 20,
            raw_start: 0,
            raw_end: 20,
            vec_start: 0,
            vec_end: 20,
          },
        ],
      },
    ]);
    await vectorStore.close();
    commitSnapshot(projectId, prepared.snapshotId, baseDir);

    const result = await applyOpsActionPlan({
      actionId: 'rebuild-chunk-fts',
      title: 'Rebuild chunk FTS',
      command: `contextatlas fts:rebuild-chunks --project-id ${projectId}`,
      severity: 'medium',
      reason: 'chunk FTS 缺失',
      kind: 'fts-rebuild-chunks',
      projectId,
    });

    const verifyDb = initDb(projectId, prepared.snapshotId);
    const count = (verifyDb.prepare('SELECT COUNT(*) as c FROM chunks_fts').get() as { c: number }).c;
    verifyDb.close();

    assert.equal(result.status, 'applied');
    assert.equal(count, 1);
  } finally {
    if (previousBaseDir === undefined) {
      delete process.env.CONTEXTATLAS_BASE_DIR;
    } else {
      process.env.CONTEXTATLAS_BASE_DIR = previousBaseDir;
    }
    MemoryStore.resetSharedHubForTests();
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('applyOpsActionPlan 通过注入依赖以非阻塞方式启动 daemon', async () => {
  let started = false;

  const result = await applyOpsActionPlan(
    {
      actionId: 'start-daemon',
      title: 'Start daemon',
      command: 'contextatlas daemon start',
      severity: 'high',
      reason: '存在排队任务',
      kind: 'daemon-start',
    },
    {
      startDaemon: async () => {
        started = true;
        return { pid: 4321 };
      },
    },
  );

  assert.equal(result.status, 'applied');
  assert.equal(started, true);
  assert.equal(result.pid, 4321);
});

test('applyOpsActionWithVerification 会执行后复检并记录恢复结果', async () => {
  const beforeInput = makeOpsApplyInput();
  const afterInput = makeOpsApplyInput({
    indexHealth: {
      ...makeOpsApplyInput().indexHealth,
      queue: {
        totalTasks: 0,
        queued: 0,
        running: 0,
        done: 1,
        failed: 0,
        canceled: 0,
        oldestQueuedAgeMs: null,
        oldestQueuedAgeHuman: null,
        recentFailures: [],
      },
      daemon: {
        isRunning: true,
        pid: 999,
        lockFileAge: '1s',
        queuePollingActive: true,
      },
      overall: {
        status: 'healthy',
        issues: [],
        recommendations: [],
      },
    },
  });

  const recorded: Array<{ restored: boolean; actionId: string }> = [];
  let snapshotCalls = 0;
  const result = await applyOpsActionWithVerification(
    {
      actionId: 'start-daemon',
      title: 'Start daemon',
      command: 'contextatlas daemon start',
      severity: 'high',
      reason: '存在排队任务',
      kind: 'daemon-start',
      repoPath: '/repo',
    },
    {
      verificationDelayMs: 0,
      verificationRetries: 0,
    },
    {
      applyPlan: async (plan) => ({
        ...plan,
        status: 'applied',
        pid: 999,
      }),
      collectSnapshot: async () => ({
        input: snapshotCalls++ === 0 ? beforeInput : afterInput,
        summary:
          snapshotCalls === 1
            ? {
                status: 'degraded',
                metrics: {
                  queuedTasks: 1,
                  failedTasks: 0,
                  triggeredAlerts: 0,
                  staleMemoryRate: 0,
                  expiredMemoryRate: 0,
                  queryBeforeIndexRate: 0,
                  avgIndexExecutionDurationMs: 0,
                },
                topIssues: ['守护进程未运行但有排队任务'],
                topActions: ['启动守护进程: contextatlas daemon start'],
                prioritizedActions: [
                  {
                    id: 'start-daemon',
                    title: 'Start daemon',
                    command: 'contextatlas daemon start',
                    severity: 'high',
                    reason: '存在排队任务',
                  },
                ],
                sections: {
                  index: 'before',
                  memory: 'before',
                  alerts: 'before',
                  usage: 'before',
                },
              }
            : {
                status: 'healthy',
                metrics: {
                  queuedTasks: 0,
                  failedTasks: 0,
                  triggeredAlerts: 0,
                  staleMemoryRate: 0,
                  expiredMemoryRate: 0,
                  queryBeforeIndexRate: 0,
                  avgIndexExecutionDurationMs: 0,
                },
                topIssues: [],
                topActions: [],
                prioritizedActions: [],
                sections: {
                  index: 'after',
                  memory: 'after',
                  alerts: 'after',
                  usage: 'after',
                },
              },
      }),
      recordOutcome: async (entry) => {
        recorded.push({ restored: entry.restored, actionId: entry.actionId });
        return { id: 'ltm-1' };
      },
    },
  );

  assert.equal(result.restored, true);
  assert.equal(result.before.status, 'degraded');
  assert.equal(result.after.status, 'healthy');
  assert.equal(result.recordedMemoryId, 'ltm-1');
  assert.deepEqual(recorded, [{ restored: true, actionId: 'start-daemon' }]);
});

test('ops:apply CLI 支持 dry-run 预览 start-daemon 动作', () => {
  const baseDir = createTempBaseDir('cw-ops-apply-cli-');
  const previousBaseDir = process.env.CONTEXTATLAS_BASE_DIR;
  process.env.CONTEXTATLAS_BASE_DIR = baseDir;
  MemoryStore.setSharedHubForTests(new MemoryHubDatabase());

  try {
    const repoRoot = path.join(baseDir, 'repo');
    fs.mkdirSync(repoRoot, { recursive: true });
    const projectId = generateProjectId(repoRoot);

    enqueueIndexTask({
      projectId,
      repoPath: repoRoot,
      scope: 'full',
    });

    const result = spawnSync(
      'node',
      ['--import', 'tsx', 'src/index.ts', 'ops:apply', 'start-daemon', '--dry-run', '--json'],
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
    assert.equal(payload.actionId, 'start-daemon');
    assert.equal(payload.status, 'planned');
    assert.equal(payload.kind, 'daemon-start');
  } finally {
    if (previousBaseDir === undefined) {
      delete process.env.CONTEXTATLAS_BASE_DIR;
    } else {
      process.env.CONTEXTATLAS_BASE_DIR = previousBaseDir;
    }
    MemoryStore.resetSharedHubForTests();
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});
