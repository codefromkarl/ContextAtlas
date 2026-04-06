import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatOpsSummaryReport,
  summarizeOpsSnapshot,
} from '../src/monitoring/opsSummary.ts';

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
      alerts: 'alert status',
      usage: 'usage status',
    },
  });

  assert.match(text, /Ops Summary/);
  assert.match(text, /Status: DEGRADED/);
  assert.match(text, /Queued Tasks: 2/);
  assert.match(text, /Triggered Alerts: 1/);
  assert.match(text, /Top Actions:/);
  assert.match(text, /contextatlas daemon start/);
  assert.match(text, /Priority Actions:/);
  assert.match(text, /\[high\] Start daemon/);
  assert.match(text, /contextatlas ops:apply start-daemon/);
  assert.match(text, /Per-Project:/);
  assert.match(text, /proj-a/);
  assert.match(text, /incremental/);
});
