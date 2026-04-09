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
