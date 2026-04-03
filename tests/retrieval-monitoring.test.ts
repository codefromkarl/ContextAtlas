import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST_DIR = path.join(REPO_ROOT, 'dist');

function findDistModule(prefix: string): string {
  const fileName = fs
    .readdirSync(DIST_DIR)
    .find((name) => name.startsWith(prefix) && name.endsWith('.js'));
  if (!fileName) {
    throw new Error(`Missing dist module with prefix: ${prefix}`);
  }
  return path.join(DIST_DIR, fileName);
}

const retrievalMonitorModule = await import(findDistModule('retrievalMonitor-'));
const { analyzeRetrievalLogText, analyzeRetrievalLogDirectory } = retrievalMonitorModule;

function createLogLine(payload: Record<string, unknown>): string {
  return `2026-04-02 12:00:00 [INFO] MCP codebase-retrieval 完成 ${JSON.stringify(payload)}`;
}

function createSampleLogText(): string {
  return [
    createLogLine({
      requestId: 'req-1',
      projectId: 'proj1234567',
      totalMs: 220,
      seedCount: 0,
      expandedCount: 0,
      totalChars: 0,
      timingMs: {
        init: 80,
        retrieve: 40,
        rerank: 70,
        expand: 20,
        pack: 10,
      },
      retrievalStats: {
        lexicalStrategy: 'files_fts',
        vectorCount: 20,
        lexicalCount: 1,
        fusedCount: 20,
        topMCount: 20,
        rerankedCount: 10,
      },
      resultStats: {
        seedCount: 0,
        expandedCount: 0,
        fileCount: 0,
        segmentCount: 0,
        totalChars: 0,
        budgetLimitChars: 48000,
        budgetUsedChars: 0,
        budgetExhausted: false,
        filesConsidered: 0,
        filesIncluded: 0,
      },
      rerankUsage: {
        inputTokens: 1800,
        billedSearchUnits: 6,
      },
    }),
    createLogLine({
      requestId: 'req-2',
      projectId: 'proj1234567',
      totalMs: 260,
      seedCount: 2,
      expandedCount: 1,
      totalChars: 47000,
      timingMs: {
        init: 70,
        retrieve: 50,
        rerank: 90,
        expand: 25,
        pack: 25,
      },
      retrievalStats: {
        lexicalStrategy: 'files_fts',
        vectorCount: 22,
        lexicalCount: 2,
        fusedCount: 22,
        topMCount: 20,
        rerankedCount: 10,
      },
      resultStats: {
        seedCount: 2,
        expandedCount: 1,
        fileCount: 3,
        segmentCount: 4,
        totalChars: 47000,
        budgetLimitChars: 48000,
        budgetUsedChars: 47000,
        budgetExhausted: true,
        filesConsidered: 9,
        filesIncluded: 3,
      },
      rerankUsage: {
        inputTokens: 2100,
        billedSearchUnits: 7,
      },
    }),
    createLogLine({
      requestId: 'req-3',
      projectId: 'proj1234567',
      totalMs: 180,
      seedCount: 1,
      expandedCount: 0,
      totalChars: 1200,
      timingMs: {
        init: 60,
        retrieve: 35,
        rerank: 55,
        expand: 10,
        pack: 20,
      },
      retrievalStats: {
        lexicalStrategy: 'none',
        vectorCount: 18,
        lexicalCount: 0,
        fusedCount: 18,
        topMCount: 18,
        rerankedCount: 8,
      },
      resultStats: {
        seedCount: 1,
        expandedCount: 0,
        fileCount: 1,
        segmentCount: 1,
        totalChars: 1200,
        budgetLimitChars: 48000,
        budgetUsedChars: 1200,
        budgetExhausted: false,
        filesConsidered: 3,
        filesIncluded: 1,
      },
      rerankUsage: {
        inputTokens: 1600,
        billedSearchUnits: 5,
      },
    }),
  ].join('\n');
}

function createTrendLogText(
  day: string,
  totalMs: number,
  noSeed = false,
  projectId = 'proj1234567',
): string {
  return createLogLine({
    requestId: `req-${day}`,
    projectId,
    totalMs,
    seedCount: noSeed ? 0 : 2,
    expandedCount: 1,
    totalChars: 2000,
    timingMs: {
      init: 40,
      retrieve: 50,
      rerank: 60,
      expand: 20,
      pack: 10,
    },
    retrievalStats: {
      lexicalStrategy: 'chunks_fts',
      vectorCount: 20,
      lexicalCount: 4,
      fusedCount: 21,
      topMCount: 18,
      rerankedCount: 8,
    },
    resultStats: {
      seedCount: noSeed ? 0 : 2,
      expandedCount: 1,
      fileCount: 2,
      segmentCount: 2,
      totalChars: 2000,
      budgetLimitChars: 48000,
      budgetUsedChars: 2000,
      budgetExhausted: false,
      filesConsidered: 3,
      filesIncluded: 2,
    },
    rerankUsage: {
      inputTokens: 1400,
      billedSearchUnits: 4,
    },
  });
}

test('analyzeRetrievalLogText 聚合查询效果并给出优化建议', () => {
  const report = analyzeRetrievalLogText(createSampleLogText());

  assert.equal(report.summary.requestCount, 3);
  assert.equal(report.summary.rates.noSeedRate, 0.333);
  assert.equal(report.summary.rates.budgetExhaustedRate, 0.333);
  assert.equal(report.summary.lexicalStrategyBreakdown.files_fts, 2);
  assert.equal(report.summary.lexicalStrategyBreakdown.none, 1);
  assert.ok(report.summary.stageShares.init > 0.25);
  assert.ok(report.summary.stageShares.rerank > 0.3);

  const recommendationIds = report.recommendations.map((item: { id: string }) => item.id);
  assert.ok(recommendationIds.includes('reduce-init-overhead'));
  assert.ok(recommendationIds.includes('promote-chunks-fts'));
  assert.ok(recommendationIds.includes('trim-rerank-cost'));
  assert.ok(recommendationIds.includes('reduce-pack-budget-pressure'));
  assert.ok(recommendationIds.includes('inspect-zero-seed-queries'));
});

test('monitor:retrieval CLI 输出 JSON 报告', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-monitor-cli-'));
  const logPath = path.join(tmpDir, 'app.2026-04-02.log');
  fs.writeFileSync(logPath, createSampleLogText());

  try {
    const result = spawnSync(
      'node',
      [path.join(REPO_ROOT, 'dist/index.js'), 'monitor:retrieval', '--file', logPath, '--json'],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.summary.requestCount, 3);
    assert.ok(Array.isArray(payload.recommendations));
    assert.ok(payload.recommendations.length > 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('analyzeRetrievalLogDirectory 支持按天聚合并识别趋势回归', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-monitor-dir-'));
  fs.writeFileSync(
    path.join(tmpDir, 'app.2026-04-01.log'),
    [createTrendLogText('2026-04-01-a', 120), createTrendLogText('2026-04-01-b', 130)].join('\n'),
  );
  fs.writeFileSync(
    path.join(tmpDir, 'app.2026-04-02.log'),
    [createTrendLogText('2026-04-02-a', 240, true), createTrendLogText('2026-04-02-b', 260)].join(
      '\n',
    ),
  );
  fs.writeFileSync(
    path.join(tmpDir, 'app.2026-04-02-other.log'),
    createTrendLogText('2026-04-02-c', 999, false, 'otherproj9'),
  );

  try {
    const report = analyzeRetrievalLogDirectory({
      dirPath: tmpDir,
      days: 2,
      projectId: 'proj1234567',
    });

    assert.equal(report.summary.requestCount, 4);
    assert.equal(report.timeSeries.daily.length, 2);
    assert.equal(report.filters.days, 2);
    assert.equal(report.filters.projectId, 'proj1234567');
    assert.equal(report.timeSeries.daily[0].date, '2026-04-01');
    assert.equal(report.timeSeries.daily[1].date, '2026-04-02');
    assert.ok(report.timeSeries.daily[1].avgTotalMs > report.timeSeries.daily[0].avgTotalMs);

    const recommendationIds = report.recommendations.map((item: { id: string }) => item.id);
    assert.ok(recommendationIds.includes('latency-regression-trend'));
    assert.ok(recommendationIds.includes('quality-regression-trend'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('monitor:retrieval CLI 支持目录趋势分析与过滤', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-monitor-trend-cli-'));
  fs.writeFileSync(
    path.join(tmpDir, 'app.2026-04-01.log'),
    createTrendLogText('2026-04-01-a', 120),
  );
  fs.writeFileSync(
    path.join(tmpDir, 'app.2026-04-02.log'),
    createTrendLogText('2026-04-02-a', 220),
  );

  try {
    const result = spawnSync(
      'node',
      [
        path.join(REPO_ROOT, 'dist/index.js'),
        'monitor:retrieval',
        '--dir',
        tmpDir,
        '--days',
        '2',
        '--project-id',
        'proj1234567',
        '--json',
      ],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.filters.days, 2);
    assert.equal(payload.filters.projectId, 'proj1234567');
    assert.equal(payload.timeSeries.daily.length, 2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
