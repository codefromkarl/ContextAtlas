import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { enqueueIndexTask } from '../src/indexing/queue.ts';
import {
  analyzeIndexHealth,
  formatIndexHealthReport,
  type IndexHealthReport,
} from '../src/monitoring/indexHealth.ts';
import {
  buildAlertEvaluationMetrics,
  buildHealthFullReport,
  collectProjectOperationalIssues,
} from '../src/monitoring/healthFull.ts';
import { formatOpsSummaryReport, summarizeOpsSnapshot } from '../src/monitoring/opsSummary.ts';

test('formatIndexHealthReport and ops summary expose index strategy signals', () => {
  const indexHealth: IndexHealthReport = {
    queue: {
      totalTasks: 1,
      queued: 0,
      running: 0,
      done: 1,
      failed: 0,
      canceled: 0,
      oldestQueuedAgeMs: null,
      oldestQueuedAgeHuman: null,
      oldestRunningAgeMs: null,
      oldestRunningAgeHuman: null,
      stuckRunning: [],
      recentFailures: [],
    },
    snapshots: [{
      projectId: 'proj-a',
      hasCurrentSnapshot: true,
      currentSnapshotId: 'snap-1',
      lastSuccessfulAt: '2026-04-09T08:00:00.000Z',
      lastSuccessfulAgeHuman: '5m',
      lastSuccessfulScope: 'incremental',
      totalSnapshots: 1,
      snapshotIds: ['snap-1'],
      hasIndexDb: true,
      hasVectorIndex: true,
      dbSizeBytes: 1024,
      vectorSizeBytes: 4096,
      dbIntegrity: 'ok',
      fileCount: 4,
      hasChunksFts: true,
      chunkFtsCount: 4,
      vectorChunkCount: 4,
      chunkFtsCoverage: 1,
      lastModified: '2026-04-09T08:05:00.000Z',
      latestTaskRepoPath: '/repo/proj-a',
      strategySummary: {
        repoPath: '/repo/proj-a',
        mode: 'full',
        reasons: ['high-churn'],
        signals: {
          changedFiles: 3,
          eligibleForFullRebuildEscalation: true,
          churnRatio: 0.75,
          churnThreshold: 0.35,
          estimatedIncrementalBytes: 120,
          estimatedFullBytes: 160,
          incrementalCostRatio: 0.75,
          costThresholdRatio: 0.65,
          fullRebuildTriggers: ['high-churn'],
        },
      },
    }],
    daemon: {
      isRunning: true,
      pid: 123,
      lockFileAge: '1m',
      queuePollingActive: true,
    },
    overall: {
      status: 'healthy',
      issues: [],
      recommendations: [],
      repairPlan: {
        autoFixable: [],
        manual: [],
      },
    },
  };

  const healthText = formatIndexHealthReport(indexHealth);
  assert.match(healthText, /Strategy: full/);
  assert.match(healthText, /triggers=high-churn/);

  const fullHealthText = buildHealthFullReport({
    indexHealth,
    memoryHealth: {
      overall: { status: 'healthy', issues: [], recommendations: [] },
      longTermFreshness: {
        total: 0,
        active: 0,
        stale: 0,
        expired: 0,
        activeRate: 0,
        staleRate: 0,
        expiredRate: 0,
        byType: {} as any,
        byScope: {} as any,
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
    } as any,
    alerts: {
      triggered: [],
      suppressed: [],
      recommendedActions: [],
    } as any,
  });
  assert.match(fullHealthText, /Strategy: full/);

  const summary = summarizeOpsSnapshot({
    indexHealth,
    memoryHealth: {
      overall: { status: 'healthy', issues: [], recommendations: [] },
      longTermFreshness: { staleRate: 0, expiredRate: 0 },
      catalogConsistency: { isConsistent: true, issues: [] },
      featureMemoryHealth: { orphanedRate: 0 },
      projectScores: [],
    } as any,
    usageReport: {
      summary: {
        indexing: {
          queryBeforeIndexRate: 0.1,
          avgExecutionDurationMs: 123,
        },
      },
      actions: [],
    } as any,
    alertResult: {
      triggered: [],
    } as any,
  });

  assert.equal((summary.projectViews[0] as any).strategySummary.mode, 'full');
  assert.match(summary.sections.index, /plan=full/);

  const opsText = formatOpsSummaryReport(summary);
  assert.match(opsText, /Strategy: full/);
});

test('buildAlertEvaluationMetrics keeps alert:eval and health:full governance inputs aligned', () => {
  const indexHealth = {
    queue: {
      queued: 2,
      running: 0,
      failed: 1,
      oldestRunningAgeMs: null,
      oldestRunningAgeHuman: null,
      stuckRunning: [],
      recentFailures: [],
    },
    daemon: {
      isRunning: false,
      pid: null,
      lockFileAge: null,
      queuePollingActive: false,
    },
    snapshots: [],
    overall: {
      status: 'degraded',
      issues: [],
      recommendations: [],
      repairPlan: {
        autoFixable: [],
        manual: [],
      },
    },
  } as IndexHealthReport;

  const memoryHealth = {
    overall: {
      status: 'degraded',
      issues: [],
      recommendations: [],
    },
    longTermFreshness: {
      total: 10,
      active: 4,
      stale: 5,
      expired: 1,
      activeRate: 0.4,
      staleRate: 0.5,
      expiredRate: 0.1,
      byType: {} as any,
      byScope: {} as any,
    },
    featureMemoryHealth: {
      total: 6,
      withValidPaths: 3,
      withOrphanedPaths: 3,
      orphanedRate: 0.5,
      avgKeyPatterns: 1,
      avgExports: 1,
      emptyResponsibilityCount: 0,
    },
    catalogConsistency: {
      isConsistent: false,
      missingFromCatalog: ['repo:searchservice'],
      staleInCatalog: [],
      totalFeatures: 6,
      totalCatalogEntries: 5,
    },
    projectScores: [],
  } as any;

  assert.deepEqual(buildAlertEvaluationMetrics({
    indexHealth,
    memoryHealth,
    mcpProcessHealth: {
      repoRoot: '/repo',
      processCount: 2,
      duplicateCount: 1,
      processes: [],
      overall: {
        status: 'degraded',
        issues: ['检测到 2 个 ContextAtlas MCP 进程'],
        recommendations: ['contextatlas mcp:cleanup-duplicates --json'],
      },
    },
  }), {
    ...indexHealth,
    memory: {
      staleRate: 0.5,
      expiredRate: 0.1,
      orphanedRate: 0.5,
      catalogInconsistent: true,
    },
    mcp: {
      duplicateCount: 1,
    },
  });
});

test('buildHealthFullReport keeps project-level memory governance issues in the full report', () => {
  const text = buildHealthFullReport({
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
        pid: 321,
        lockFileAge: null,
        queuePollingActive: true,
      },
      snapshots: [
        {
          projectId: 'repo',
          currentSnapshotId: 'snap-1',
          lastSuccessfulAt: '2026-04-09T13:00:00.000Z',
          lastSuccessfulScope: 'incremental',
          latestTaskRepoPath: '/tmp/repo',
          strategySummary: null,
          hasCurrentSnapshot: true,
          dbIntegrity: 'ok',
          hasIndexDb: true,
          hasVectorIndex: true,
          fileCount: 8,
          vectorChunkCount: 10,
          hasChunksFts: false,
          chunkFtsCount: 0,
          chunkFtsCoverage: null,
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
        byScope: {} as any,
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
    alerts: {
      triggered: [],
      resolved: [],
      active: [],
    } as any,
  });

  assert.match(text, /Per-Project Summary/);
  assert.match(text, /missing-chunk-fts/);
  assert.match(text, /功能记忆孤立路径比例: 50%/);
  assert.match(text, /catalog 缺失 1 个模块/);
});

test('collectProjectOperationalIssues provides one deduplicated issue set for summary and full health views', () => {
  assert.deepEqual(
    collectProjectOperationalIssues({
      snapshot: {
        projectId: 'repo',
        currentSnapshotId: 'snap-1',
        lastSuccessfulAt: '2026-04-09T13:00:00.000Z',
        lastSuccessfulScope: 'incremental',
        latestTaskRepoPath: '/tmp/repo',
        strategySummary: null,
        hasCurrentSnapshot: false,
        dbIntegrity: 'corrupted',
        hasIndexDb: true,
        hasVectorIndex: false,
        fileCount: 8,
        vectorChunkCount: 10,
        hasChunksFts: false,
        chunkFtsCount: 0,
        chunkFtsCoverage: 0.4,
      } as any,
      memoryIssues: ['missing-chunk-fts', 'catalog 缺失 1 个模块'],
    }),
    [
      'missing-current-snapshot',
      'corrupted-db',
      'missing-vector-index',
      'missing-chunk-fts',
      'degraded-chunk-fts-coverage',
      'catalog 缺失 1 个模块',
    ],
  );
});

test('analyzeIndexHealth derives strategy summary from the latest known repo path', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextatlas-index-strategy-'));
  const repoPath = path.join(tmpDir, 'repo');
  const baseDir = path.join(tmpDir, 'base');
  const projectId = 'proj-strategy';
  const originalBaseDir = process.env.CONTEXTATLAS_BASE_DIR;

  try {
    fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoPath, 'src', 'a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(repoPath, 'src', 'b.ts'), 'export const b = 2;\n');

    fs.mkdirSync(path.join(baseDir, projectId, 'snapshots'), { recursive: true });
    process.env.CONTEXTATLAS_BASE_DIR = baseDir;

    enqueueIndexTask({
      projectId,
      repoPath,
      scope: 'incremental',
      reason: 'test-strategy-summary',
      requestedBy: 'test',
    });

    const report = await analyzeIndexHealth({
      baseDir,
      projectIds: [projectId],
    });

    const snapshot = report.snapshots[0];
    assert.equal(snapshot.latestTaskRepoPath, repoPath);
    assert.equal(snapshot.strategySummary?.repoPath, repoPath);
    assert.equal(snapshot.strategySummary?.mode, 'full');
    assert.equal(snapshot.strategySummary?.signals.changedFiles, 2);
  } finally {
    if (originalBaseDir === undefined) {
      delete process.env.CONTEXTATLAS_BASE_DIR;
    } else {
      process.env.CONTEXTATLAS_BASE_DIR = originalBaseDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
