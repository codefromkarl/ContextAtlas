import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHealthFullReport } from '../src/monitoring/healthFull.ts';

test('buildHealthFullReport renders per-project operational summary before detailed sections', () => {
  const text = buildHealthFullReport({
    indexHealth: {
      queue: {
        totalTasks: 3,
        queued: 1,
        running: 0,
        done: 2,
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
          currentSnapshotId: 'snap-1',
          lastSuccessfulAt: '2026-04-05T10:00:00.000Z',
          lastSuccessfulAgeHuman: '5m 0s',
          lastSuccessfulScope: 'incremental',
          totalSnapshots: 2,
          snapshotIds: ['snap-1', 'snap-0'],
          hasIndexDb: true,
          hasVectorIndex: true,
          dbSizeBytes: 2048,
          vectorSizeBytes: 1024,
          dbIntegrity: 'ok',
          fileCount: 10,
          hasChunksFts: true,
          chunkFtsCount: 9,
          vectorChunkCount: 10,
          chunkFtsCoverage: 0.9,
          lastModified: '2026-04-05T10:00:00.000Z',
        },
      ],
      daemon: {
        isRunning: true,
        pid: 1234,
        lockFileAge: null,
        queuePollingActive: true,
      },
      overall: {
        status: 'degraded',
        issues: ['项目 proj-a: chunk FTS 覆盖不足 (9/10)'],
        recommendations: ['重建 chunk FTS: contextatlas fts:rebuild-chunks --project-id proj-a'],
      },
    },
    memoryHealth: {
      longTermFreshness: {
        total: 1,
        active: 1,
        stale: 0,
        expired: 0,
        activeRate: 1,
        staleRate: 0,
        expiredRate: 0,
        byType: {} as never,
        byScope: {} as never,
      },
      featureMemoryHealth: {
        total: 1,
        withValidPaths: 1,
        withOrphanedPaths: 0,
        orphanedRate: 0,
        avgKeyPatterns: 2,
        avgExports: 1,
        emptyResponsibilityCount: 0,
      },
      catalogConsistency: {
        isConsistent: true,
        missingFromCatalog: [],
        staleInCatalog: [],
        totalFeatures: 1,
        totalCatalogEntries: 1,
      },
      projectScores: [
        {
          projectId: 'proj-a',
          projectName: 'Repo A',
          featureCount: 1,
          longTermCount: 1,
          freshnessScore: 82,
          catalogConsistent: true,
          issues: [],
        },
      ],
      overall: {
        status: 'healthy',
        issues: [],
        recommendations: [],
      },
    },
    alerts: {
      triggered: [],
      resolved: [],
      active: [],
    },
  });

  assert.match(text, /Full System Health Report/);
  assert.match(text, /Per-Project Summary/);
  assert.match(text, /proj-a/);
  assert.match(text, /incremental/);
  assert.match(text, /FTS=90.0%/);
  assert.match(text, /Memory Score=82/);
  assert.match(text, /Index Health Panel/);
});
