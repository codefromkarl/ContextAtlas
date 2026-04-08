import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeOpsMetrics, buildOpsMetricsReport } from '../src/monitoring/opsMetrics.ts';
import { MemoryStore } from '../src/memory/MemoryStore.ts';
import type { RetrievalMonitorReport } from '../src/monitoring/retrievalMonitor.ts';
import { recordIndexUsage, recordToolUsage } from '../src/usage/usageTracker.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeBaseDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cw-ops-metrics-'));
}

test('buildOpsMetricsReport 聚合核心团队指标与仓库质量分布', () => {
  const report = buildOpsMetricsReport({
    querySuccessRate: 0.9,
    emptyResultRate: 0.2,
    staleMemoryRate: 0.25,
    indexFailureRate: 0.1,
    retrievalLatencyMs: 420,
    correctionRate: 0.05,
    repos: [
      {
        projectId: 'proj-a',
        projectName: 'Repo A',
        querySuccessRate: 0.95,
        emptyResultRate: 0.1,
        staleMemoryRate: 0.1,
        indexFailureRate: 0.05,
      },
      {
        projectId: 'proj-b',
        projectName: 'Repo B',
        querySuccessRate: 0.5,
        emptyResultRate: 0.4,
        staleMemoryRate: 0.5,
        indexFailureRate: 0.4,
      },
    ],
    modules: [
      {
        projectId: 'proj-a',
        projectName: 'Repo A',
        moduleName: 'SearchService',
        reviewStatus: 'verified',
        staleSignalRate: 0,
        correctionSignalRate: 0,
        score: 100,
        band: 'healthy',
      },
      {
        projectId: 'proj-b',
        projectName: 'Repo B',
        moduleName: 'LegacyRouter',
        reviewStatus: 'needs-review',
        staleSignalRate: 0.5,
        correctionSignalRate: 0.5,
        score: 40,
        band: 'risky',
      },
    ],
  });

  assert.equal(report.summary.querySuccessRate, 0.9);
  assert.equal(report.summary.emptyResultRate, 0.2);
  assert.equal(report.repoQualityDistribution.length, 2);
  assert.equal(report.repoQualityDistribution[0].projectId, 'proj-a');
  assert.equal(report.repoQualityDistribution[0].band, 'healthy');
  assert.equal(report.repoQualityDistribution[1].band, 'risky');
  assert.equal(report.moduleQualityDistribution.length, 2);
  assert.equal(report.moduleQualityDistribution[0].moduleName, 'SearchService');
  assert.equal(report.moduleQualityDistribution[1].band, 'risky');
});

test('ops:metrics CLI 输出稳定指标 JSON', () => {
  const baseDir = makeBaseDir();
  const previousBaseDir = process.env.CONTEXTATLAS_BASE_DIR;
  process.env.CONTEXTATLAS_BASE_DIR = baseDir;

  try {
    recordToolUsage({
      timestamp: '2026-04-05T09:00:00.000Z',
      source: 'mcp',
      toolName: 'codebase-retrieval',
      projectId: 'proj-metrics',
      repoPath: '/repos/proj-metrics',
      requestId: 'req-1',
      status: 'success',
      durationMs: 120,
      queryLength: 20,
      indexState: 'ready',
      indexAction: 'none',
    });

    recordIndexUsage({
      timestamp: '2026-04-05T09:01:00.000Z',
      projectId: 'proj-metrics',
      repoPath: '/repos/proj-metrics',
      taskId: 'task-1',
      scope: 'incremental',
      phase: 'execute',
      status: 'done',
      requestedBy: 'daemon',
      durationMs: 500,
    });

    const result = spawnSync(
      'node',
      ['--import', 'tsx', 'src/index.ts', 'ops:metrics', '--json'],
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
    assert.equal(payload.summary.querySuccessRate, 1);
    assert.equal(payload.summary.indexFailureRate, 0);
    assert.ok(Array.isArray(payload.repoQualityDistribution));
    assert.ok(Array.isArray(payload.moduleQualityDistribution));
  } finally {
    if (previousBaseDir === undefined) {
      delete process.env.CONTEXTATLAS_BASE_DIR;
    } else {
      process.env.CONTEXTATLAS_BASE_DIR = previousBaseDir;
    }
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('ops:metrics CLI 在未显式传 log-dir 时默认读取 baseDir/logs', () => {
  const baseDir = makeBaseDir();
  const previousBaseDir = process.env.CONTEXTATLAS_BASE_DIR;
  process.env.CONTEXTATLAS_BASE_DIR = baseDir;

  try {
    recordToolUsage({
      timestamp: '2026-04-05T09:00:00.000Z',
      source: 'mcp',
      toolName: 'codebase-retrieval',
      projectId: 'proj-metrics-default-log',
      repoPath: '/repos/proj-metrics-default-log',
      requestId: 'req-default-log',
      status: 'success',
      durationMs: 120,
      queryLength: 20,
      indexState: 'ready',
      indexAction: 'none',
    });

    const logsDir = path.join(baseDir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(
      path.join(logsDir, 'app.2026-04-05.log'),
      `2026-04-05 09:00:00 [INFO] MCP codebase-retrieval 完成 ${JSON.stringify({
        requestId: 'req-default-log',
        projectId: 'proj-metrics-default-log',
        totalMs: 321,
        seedCount: 1,
        expandedCount: 0,
        totalChars: 1200,
        timingMs: {
          init: 10,
          retrieve: 100,
          rerank: 50,
          expand: 20,
          pack: 10,
        },
        retrievalStats: {
          lexicalStrategy: 'chunks_fts',
          lexicalCount: 2,
        },
        resultStats: {
          totalChars: 1200,
          budgetExhausted: false,
        },
        rerankUsage: {
          inputTokens: 123,
        },
      })}\n`,
    );

    const result = spawnSync(
      'node',
      ['--import', 'tsx', 'src/index.ts', 'ops:metrics', '--json'],
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
    assert.equal(payload.summary.querySuccessRate, 1);
    assert.equal(payload.summary.retrievalLatencyMs, 321);
  } finally {
    if (previousBaseDir === undefined) {
      delete process.env.CONTEXTATLAS_BASE_DIR;
    } else {
      process.env.CONTEXTATLAS_BASE_DIR = previousBaseDir;
    }
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('analyzeOpsMetrics builds module quality distribution from review status and feedback signals', async () => {
  const baseDir = makeBaseDir();
  const previousBaseDir = process.env.CONTEXTATLAS_BASE_DIR;
  MemoryStore.resetSharedHubForTests();
  process.env.CONTEXTATLAS_BASE_DIR = baseDir;

  try {
    const repoPath = path.join(baseDir, 'repo-a');
    fs.mkdirSync(repoPath, { recursive: true });

    const store = new MemoryStore(repoPath);

    await store.saveFeature({
      name: 'SearchService',
      responsibility: 'search orchestration',
      location: { dir: 'src/search', files: ['SearchService.ts'] },
      api: { exports: ['search'], endpoints: [] },
      dependencies: { imports: [], external: [] },
      dataFlow: 'query -> search',
      keyPatterns: ['search'],
      lastUpdated: new Date().toISOString(),
      confirmationStatus: 'human-confirmed',
      reviewStatus: 'verified',
    });

    await store.saveFeature({
      name: 'LegacyRouter',
      responsibility: 'legacy routing',
      location: { dir: 'src/router', files: ['LegacyRouter.ts'] },
      api: { exports: ['route'], endpoints: [] },
      dependencies: { imports: [], external: [] },
      dataFlow: 'request -> route',
      keyPatterns: ['router'],
      lastUpdated: new Date().toISOString(),
      confirmationStatus: 'human-confirmed',
      reviewStatus: 'needs-review',
      reviewReason: 'wrong module mapping',
    });

    await store.appendLongTermMemoryItem({
      id: 'fb-1',
      type: 'feedback',
      title: 'legacy stale',
      scope: 'project',
      summary: 'outcome=memory-stale | targetId=LegacyRouter',
      source: 'tool-result',
      confidence: 0.9,
      tags: ['feedback'],
      createdAt: '2026-04-06T10:00:00.000Z',
      updatedAt: '2026-04-06T10:00:00.000Z',
    });

    await store.appendLongTermMemoryItem({
      id: 'fb-2',
      type: 'feedback',
      title: 'legacy wrong module',
      scope: 'project',
      summary: 'outcome=wrong-module | targetId=LegacyRouter',
      source: 'tool-result',
      confidence: 0.9,
      tags: ['feedback'],
      createdAt: '2026-04-06T10:05:00.000Z',
      updatedAt: '2026-04-06T10:05:00.000Z',
    });

    const report = await analyzeOpsMetrics({
      staleDays: 30,
      retrievalFallbackReport: {
        filters: {},
        summary: {
          requestCount: 0,
          stageStats: {},
          stageShares: {},
          lexicalStrategyBreakdown: {},
          averages: {
            totalMs: 0,
            rerankInputTokens: 0,
            totalChars: 0,
            seedCount: 0,
            expandedCount: 0,
          },
          rates: {
            noSeedRate: 0,
            budgetExhaustedRate: 0,
            noLexicalRate: 0,
            noExpansionRate: 0,
          },
        },
        timeSeries: { daily: [] },
        recommendations: [],
      },
      memoryHealthFactory: async () => ({
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
      }),
    });

    const legacy = report.moduleQualityDistribution.find((item) => item.moduleName === 'LegacyRouter');
    const search = report.moduleQualityDistribution.find((item) => item.moduleName === 'SearchService');
    assert.ok(legacy);
    assert.ok(search);
    assert.equal(legacy?.reviewStatus, 'needs-review');
    assert.equal(legacy?.staleSignalRate, 0.5);
    assert.equal(legacy?.correctionSignalRate, 0.5);
    assert.equal(legacy?.band, 'risky');
    assert.equal(search?.band, 'healthy');
  } finally {
    if (previousBaseDir === undefined) {
      delete process.env.CONTEXTATLAS_BASE_DIR;
    } else {
      process.env.CONTEXTATLAS_BASE_DIR = previousBaseDir;
    }
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('analyzeOpsMetrics 在日志缺失时保持可用', async () => {
  const baseDir = makeBaseDir();
  const previousBaseDir = process.env.CONTEXTATLAS_BASE_DIR;
  process.env.CONTEXTATLAS_BASE_DIR = baseDir;

  try {
    const report = await analyzeOpsMetrics({
      days: 7,
      staleDays: 30,
      retrievalReportFactory: () => {
        throw new Error('日志目录不存在');
      },
      memoryHealthFactory: async () => ({
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
      }),
      retrievalFallbackReport: {
        filters: {},
        summary: {
          requestCount: 0,
          stageStats: {},
          stageShares: {},
          lexicalStrategyBreakdown: {},
          averages: {
            totalMs: 0,
            rerankInputTokens: 0,
            totalChars: 0,
            seedCount: 0,
            expandedCount: 0,
          },
          rates: {
            noSeedRate: 0,
            budgetExhaustedRate: 0,
            noLexicalRate: 0,
            noExpansionRate: 0,
          },
        },
        timeSeries: { daily: [] },
        recommendations: [],
      } satisfies RetrievalMonitorReport,
    });

    assert.equal(report.summary.emptyResultRate, 0);
    assert.equal(report.summary.retrievalLatencyMs, 0);
  } finally {
    if (previousBaseDir === undefined) {
      delete process.env.CONTEXTATLAS_BASE_DIR;
    } else {
      process.env.CONTEXTATLAS_BASE_DIR = previousBaseDir;
    }
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});
