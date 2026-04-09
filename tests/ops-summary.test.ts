import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  formatOpsSummaryReport,
  summarizeOpsSnapshot,
} from '../src/monitoring/opsSummary.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeBaseDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cw-ops-summary-'));
}

test('summarizeOpsSnapshot aggregates health, alerts, and usage into one snapshot', () => {
  const summary = summarizeOpsSnapshot({
    indexHealth: {
      queue: {
        totalTasks: 12,
        queued: 3,
        running: 1,
        done: 7,
        failed: 1,
        canceled: 0,
        oldestQueuedAgeMs: 600000,
        oldestQueuedAgeHuman: '10m 0s',
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
        status: 'unhealthy',
        issues: ['1 个索引任务执行失败', '守护进程未运行但有排队任务'],
        recommendations: ['启动守护进程: contextatlas daemon start'],
      },
    },
    memoryHealth: {
      longTermFreshness: {
        total: 10,
        active: 5,
        stale: 4,
        expired: 1,
        activeRate: 0.5,
        staleRate: 0.4,
        expiredRate: 0.1,
        byType: {} as never,
        byScope: {} as never,
      },
      featureMemoryHealth: {
        total: 12,
        withValidPaths: 10,
        withOrphanedPaths: 2,
        orphanedRate: 0.167,
        avgKeyPatterns: 3,
        avgExports: 2,
        emptyResponsibilityCount: 0,
      },
      catalogConsistency: {
        isConsistent: false,
        missingFromCatalog: ['search-service'],
        staleInCatalog: [],
        totalFeatures: 12,
        totalCatalogEntries: 11,
      },
      projectScores: [],
      overall: {
        status: 'degraded',
        issues: ['40% 的长期记忆陈旧'],
        recommendations: ['核验或清理陈旧记忆'],
      },
    },
    usageReport: {
      filters: { days: 7 },
      summary: {
        totalToolCalls: 50,
        toolBreakdown: {},
        hotProjects: [],
        indexing: {
          queryBeforeIndexRate: 0.22,
          reusedQueueRate: 0.4,
          fullIndexRate: 0.5,
          failedExecutionRate: 0.1,
          avgExecutionDurationMs: 3200,
        },
      },
      timeSeries: { daily: [] },
      actions: [
        {
          id: 'start-daemon',
          title: '启动守护进程',
          command: 'contextatlas daemon start',
          reason: '当前有排队任务',
        },
      ],
      recommendations: [],
    },
    alertResult: {
      triggered: [
        {
          id: 'queue-backlog-1',
          ruleId: 'queue-backlog',
          ruleName: '队列积压',
          severity: 'warning',
          status: 'active',
          metric: 'queue.queued',
          value: 3,
          threshold: 2,
          message: '索引队列积压超过阈值',
          triggeredAt: '2026-04-05T00:00:00.000Z',
        },
      ],
      resolved: [],
      active: [],
    },
  });

  assert.equal(summary.status, 'unhealthy');
  assert.equal(summary.metrics.queuedTasks, 3);
  assert.equal(summary.metrics.triggeredAlerts, 1);
  assert.equal(summary.metrics.staleMemoryRate, 0.4);
  assert.equal(summary.metrics.queryBeforeIndexRate, 0.22);
  assert.ok(summary.topIssues.some((issue) => issue.includes('索引任务执行失败')));
  assert.ok(summary.topActions.some((action) => action.includes('contextatlas daemon start')));
  assert.ok(summary.prioritizedActions.some((action) => action.command === 'contextatlas daemon start'));
  assert.ok(
    summary.prioritizedActions.some(
      (action) => action.command === 'contextatlas memory:rebuild-catalog',
    ),
  );
  assert.ok(Array.isArray(summary.projectViews));
});

test('formatOpsSummaryReport renders a compact team-facing overview', () => {
  const text = formatOpsSummaryReport({
    status: 'degraded',
    metrics: {
      queuedTasks: 2,
      failedTasks: 0,
      triggeredAlerts: 1,
      staleMemoryRate: 0.25,
      expiredMemoryRate: 0.05,
      queryBeforeIndexRate: 0.18,
      avgIndexExecutionDurationMs: 2400,
    },
    topIssues: ['守护进程未运行但有排队任务'],
    topActions: ['启动守护进程: contextatlas daemon start'],
    prioritizedActions: [
      {
        id: 'start-daemon',
        title: 'Start daemon',
        command: 'contextatlas daemon start',
        severity: 'high',
        reason: '当前存在排队任务',
      },
    ],
    projectViews: [
      {
        projectId: 'proj-a',
        currentSnapshotId: 'snap-1',
        lastSuccessfulAt: '2026-04-05T10:00:00.000Z',
        lastSuccessfulScope: 'incremental',
        issues: ['chunk FTS 覆盖不足'],
      },
    ],
    sections: {
      index: 'index status',
      memory: 'memory status',
      governance: 'governance status',
      alerts: 'alert status',
      usage: 'usage status',
    },
  });

  assert.match(text, /Ops Summary/);
  assert.match(text, /Status: DEGRADED/);
  assert.match(text, /Queued Tasks: 2/);
  assert.match(text, /Triggered Alerts: 1/);
  assert.match(text, /Top Actions:/);
  assert.match(text, /Governance:/);
  assert.match(text, /contextatlas daemon start/);
  assert.match(text, /Priority Actions:/);
  assert.match(text, /\[high\] Start daemon/);
  assert.match(text, /contextatlas ops:apply start-daemon/);
  assert.match(text, /Per-Project:/);
  assert.match(text, /proj-a/);
  assert.match(text, /incremental/);
});

test('ops:summary CLI 输出包含 governance section', () => {
  const baseDir = makeBaseDir();
  const previousBaseDir = process.env.CONTEXTATLAS_BASE_DIR;
  process.env.CONTEXTATLAS_BASE_DIR = baseDir;

  try {
    const result = spawnSync(
      'node',
      ['--import', 'tsx', 'src/index.ts', 'ops:summary', '--json'],
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
    assert.equal(typeof payload.sections.governance, 'string');
    assert.match(payload.sections.governance, /^catalog=/);
    assert.match(payload.sections.index, /^status=/);
  } finally {
    if (previousBaseDir === undefined) {
      delete process.env.CONTEXTATLAS_BASE_DIR;
    } else {
      process.env.CONTEXTATLAS_BASE_DIR = previousBaseDir;
    }
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('ops:summary prioritizes catalog rebuild before stale memory pruning when both governance signals are present', () => {
  const summary = summarizeOpsSnapshot({
    indexHealth: {
      queue: {
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
      },
      daemon: {
        isRunning: true,
        pid: 123,
        lockFileAge: null,
        queuePollingActive: true,
      },
      snapshots: [],
      overall: {
        status: 'healthy',
        issues: [],
        recommendations: [],
        repairPlan: {
          autoFixable: [],
          manual: [],
        },
      },
    } as any,
    memoryHealth: {
      overall: {
        status: 'unhealthy',
        issues: ['功能记忆与 catalog 不一致', '100% 的长期记忆陈旧'],
        recommendations: [
          '重建 catalog: contextatlas memory:rebuild-catalog',
          '核验或清理陈旧记忆: contextatlas memory:prune-long-term --include-stale --apply',
        ],
      },
      longTermFreshness: {
        total: 1,
        active: 0,
        stale: 1,
        expired: 0,
        activeRate: 0,
        staleRate: 1,
        expiredRate: 0,
        byType: {} as any,
        byScope: {
          project: { total: 1, active: 0, stale: 1, expired: 0 },
          'global-user': { total: 0, active: 0, stale: 0, expired: 0 },
        },
      },
      featureMemoryHealth: {
        total: 2,
        withValidPaths: 1,
        withOrphanedPaths: 1,
        orphanedRate: 0.5,
        avgKeyPatterns: 1,
        avgExports: 1,
        emptyResponsibilityCount: 0,
      },
      catalogConsistency: {
        isConsistent: false,
        missingFromCatalog: ['repo:searchservice'],
        staleInCatalog: [],
        totalFeatures: 2,
        totalCatalogEntries: 0,
      },
      projectScores: [
        {
          projectId: 'repo',
          projectName: 'repo',
          featureCount: 2,
          longTermCount: 1,
          freshnessScore: 40,
          catalogConsistent: false,
          issues: ['功能记忆孤立路径比例: 50%', 'catalog 缺失 1 个模块'],
        },
      ],
    } as any,
    usageReport: {
      summary: {
        indexing: {
          queryBeforeIndexRate: 0,
          avgExecutionDurationMs: 0,
        },
      },
      actions: [],
    } as any,
    alertResult: {
      triggered: [],
      resolved: [],
      active: [],
    } as any,
  });

  assert.equal(summary.prioritizedActions[0]?.id, 'rebuild-memory-catalog');
  assert.equal(summary.prioritizedActions[1]?.id, 'prune-stale-memory');

  const text = formatOpsSummaryReport(summary);
  assert.match(text, /contextatlas memory:rebuild-catalog/);
  assert.match(text, /contextatlas memory:prune-long-term --include-stale --apply/);
  assert.match(text, /contextatlas ops:apply rebuild-memory-catalog/);
});

test('summarizeOpsSnapshot carries project-level memory governance issues into project views', () => {
  const summary = summarizeOpsSnapshot({
    indexHealth: {
      queue: {
        queued: 0,
        running: 0,
        failed: 0,
        oldestRunningAgeMs: null,
        oldestRunningAgeHuman: null,
        stuckRunning: [],
        recentFailures: [],
      },
      daemon: {
        isRunning: true,
        pid: 123,
        lockFileAge: null,
        queuePollingActive: true,
      },
      snapshots: [
        {
          projectId: 'repo',
          currentSnapshotId: 'snap-1',
          lastSuccessfulAt: '2026-04-09T12:00:00.000Z',
          lastSuccessfulScope: 'incremental',
          latestTaskRepoPath: '/tmp/repo',
          strategySummary: null,
          hasCurrentSnapshot: true,
          dbIntegrity: 'ok',
          hasIndexDb: true,
          hasVectorIndex: true,
          fileCount: 10,
          vectorChunkCount: 12,
          hasChunksFts: false,
          chunkFtsCount: 0,
          chunkFtsCoverage: 0,
        },
      ],
      overall: {
        status: 'degraded',
        issues: [],
        recommendations: [],
        repairPlan: {
          autoFixable: [],
          manual: [],
        },
      },
    } as any,
    memoryHealth: {
      overall: {
        status: 'degraded',
        issues: [],
        recommendations: [],
      },
      longTermFreshness: {
        total: 1,
        active: 1,
        stale: 0,
        expired: 0,
        activeRate: 1,
        staleRate: 0,
        expiredRate: 0,
        byType: {} as any,
        byScope: {
          project: { total: 1, active: 1, stale: 0, expired: 0 },
          'global-user': { total: 0, active: 0, stale: 0, expired: 0 },
        },
      },
      featureMemoryHealth: {
        total: 2,
        withValidPaths: 1,
        withOrphanedPaths: 1,
        orphanedRate: 0.5,
        avgKeyPatterns: 1,
        avgExports: 1,
        emptyResponsibilityCount: 0,
      },
      catalogConsistency: {
        isConsistent: false,
        missingFromCatalog: ['repo:searchservice'],
        staleInCatalog: [],
        totalFeatures: 2,
        totalCatalogEntries: 1,
      },
      projectScores: [
        {
          projectId: 'repo',
          projectName: 'repo',
          featureCount: 2,
          longTermCount: 1,
          freshnessScore: 40,
          catalogConsistent: false,
          issues: ['功能记忆孤立路径比例: 50%', 'catalog 缺失 1 个模块'],
        },
      ],
    } as any,
    usageReport: {
      summary: {
        indexing: {
          queryBeforeIndexRate: 0,
          avgExecutionDurationMs: 0,
        },
      },
      actions: [],
    } as any,
    alertResult: {
      triggered: [],
      resolved: [],
      active: [],
    } as any,
  });

  assert.ok(summary.projectViews[0]?.issues.includes('missing-chunk-fts'));
  assert.ok(summary.projectViews[0]?.issues.includes('degraded-chunk-fts-coverage'));
  assert.ok(summary.projectViews[0]?.issues.includes('功能记忆孤立路径比例: 50%'));
  assert.ok(summary.projectViews[0]?.issues.includes('catalog 缺失 1 个模块'));

  const text = formatOpsSummaryReport(summary);
  assert.match(text, /missing-chunk-fts/);
  assert.match(text, /degraded-chunk-fts-coverage/);
  assert.match(text, /功能记忆孤立路径比例: 50%/);
  assert.match(text, /catalog 缺失 1 个模块/);
});
