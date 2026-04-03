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

const usageTrackerModule = await import(findDistModule('usageTracker-'));
const usageAnalysisModule = await import(findDistModule('usageAnalysis-'));

const { recordToolUsage, recordIndexUsage, listToolUsage, listIndexUsage, resolveUsageDbPath } =
  usageTrackerModule;
const { analyzeIndexOptimization, formatIndexOptimizationReport } = usageAnalysisModule;

function makeBaseDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cw-usage-test-'));
}

test('usage tracker 能记录工具使用与索引事件', () => {
  const baseDir = makeBaseDir();
  process.env.CONTEXTATLAS_BASE_DIR = baseDir;

  recordToolUsage({
    timestamp: '2026-04-02T10:00:00.000Z',
    source: 'mcp',
    toolName: 'codebase-retrieval',
    projectId: 'proj-alpha',
    repoPath: '/repos/proj-alpha',
    requestId: 'req-1',
    status: 'success',
    durationMs: 120,
    queryLength: 32,
    indexState: 'missing',
    indexAction: 'enqueue_full',
  });

  recordIndexUsage({
    timestamp: '2026-04-02T10:00:01.000Z',
    projectId: 'proj-alpha',
    repoPath: '/repos/proj-alpha',
    taskId: 'task-1',
    scope: 'full',
    phase: 'enqueue',
    status: 'queued',
    requestedBy: 'mcp',
    reusedExisting: false,
  });

  recordIndexUsage({
    timestamp: '2026-04-02T10:01:01.000Z',
    projectId: 'proj-alpha',
    repoPath: '/repos/proj-alpha',
    taskId: 'task-1',
    scope: 'full',
    phase: 'execute',
    status: 'done',
    requestedBy: 'daemon',
    durationMs: 4300,
  });

  const toolRows = listToolUsage();
  const indexRows = listIndexUsage();

  assert.equal(toolRows.length, 1);
  assert.equal(indexRows.length, 2);
  assert.equal(toolRows[0].toolName, 'codebase-retrieval');
  assert.equal(toolRows[0].indexState, 'missing');
  assert.equal(toolRows[0].repoPath, '/repos/proj-alpha');
  assert.equal(indexRows[0].phase, 'enqueue');
  assert.equal(indexRows[0].repoPath, '/repos/proj-alpha');
  assert.ok(resolveUsageDbPath().includes(baseDir));
});

test('index optimization analysis 能基于日常使用情况给出索引优化建议', () => {
  const baseDir = makeBaseDir();
  process.env.CONTEXTATLAS_BASE_DIR = baseDir;

  for (let i = 0; i < 8; i++) {
    recordToolUsage({
      timestamp: `2026-04-02T10:0${i}:00.000Z`,
      source: 'mcp',
      toolName: 'codebase-retrieval',
      projectId: 'proj-hot',
      repoPath: '/repos/proj-hot',
      requestId: `req-hot-${i}`,
      status: 'success',
      durationMs: 150 + i,
      queryLength: 40,
      indexState: i < 5 ? 'missing' : 'ready',
      indexAction: i < 5 ? 'enqueue_full' : 'none',
    });
  }

  for (let i = 0; i < 4; i++) {
    recordIndexUsage({
      timestamp: `2026-04-02T11:0${i}:00.000Z`,
      projectId: 'proj-hot',
      repoPath: '/repos/proj-hot',
      taskId: `task-hot-${i}`,
      scope: 'full',
      phase: 'enqueue',
      status: 'queued',
      requestedBy: 'mcp',
      reusedExisting: i > 0,
    });
  }

  recordIndexUsage({
    timestamp: '2026-04-02T11:10:00.000Z',
    projectId: 'proj-hot',
    repoPath: '/repos/proj-hot',
    taskId: 'task-hot-final',
    scope: 'full',
    phase: 'execute',
    status: 'failed',
    requestedBy: 'daemon',
    durationMs: 6000,
    error: 'lock timeout',
  });

  recordIndexUsage({
    timestamp: '2026-04-02T11:20:00.000Z',
    projectId: 'proj-hot',
    repoPath: '/repos/proj-hot',
    taskId: 'task-hot-ok',
    scope: 'incremental',
    phase: 'execute',
    status: 'done',
    requestedBy: 'daemon',
    durationMs: 1200,
  });

  const report = analyzeIndexOptimization();
  const ids = report.recommendations.map((item: { id: string }) => item.id);

  assert.equal(report.summary.totalToolCalls, 8);
  assert.equal(report.summary.toolBreakdown['codebase-retrieval'], 8);
  assert.equal(report.summary.indexing.queryBeforeIndexRate, 0.625);
  assert.equal(report.summary.indexing.reusedQueueRate, 0.75);
  assert.equal(report.summary.hotProjects[0].projectId, 'proj-hot');
  assert.equal(report.summary.hotProjects[0].repoPath, '/repos/proj-hot');
  assert.ok(ids.includes('preindex-hot-projects'));
  assert.ok(ids.includes('daemon-throughput-or-availability'));
  assert.ok(ids.includes('reduce-full-index-frequency'));
  assert.ok(ids.includes('fix-index-failures'));
  assert.ok(
    report.actions.some((item: { command: string }) =>
      item.command.includes('contextatlas index /repos/proj-hot'),
    ),
  );
  assert.ok(
    report.actions.some((item: { command: string }) =>
      item.command.includes('contextatlas daemon start'),
    ),
  );
});

test('usage:index-report CLI 输出 JSON 报告', () => {
  const baseDir = makeBaseDir();
  process.env.CONTEXTATLAS_BASE_DIR = baseDir;

  recordToolUsage({
    timestamp: '2026-04-02T09:00:00.000Z',
    source: 'mcp',
    toolName: 'codebase-retrieval',
    projectId: 'proj-cli',
    repoPath: '/repos/proj-cli',
    requestId: 'req-cli',
    status: 'success',
    durationMs: 88,
    queryLength: 20,
    indexState: 'ready',
    indexAction: 'none',
  });

  const result = spawnSync(
    'node',
    [path.join(REPO_ROOT, 'dist/index.js'), 'usage:index-report', '--json'],
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
  assert.equal(payload.summary.totalToolCalls, 1);
  assert.equal(payload.summary.hotProjects[0].projectId, 'proj-cli');
  assert.ok(Array.isArray(payload.actions));
});

test('index optimization analysis 支持按时间窗口和项目过滤并输出日趋势', () => {
  const baseDir = makeBaseDir();
  process.env.CONTEXTATLAS_BASE_DIR = baseDir;

  recordToolUsage({
    timestamp: '2026-04-01T09:00:00.000Z',
    source: 'mcp',
    toolName: 'codebase-retrieval',
    projectId: 'proj-a',
    repoPath: '/repos/proj-a',
    requestId: 'req-a-1',
    status: 'success',
    durationMs: 90,
    queryLength: 18,
    indexState: 'ready',
    indexAction: 'none',
  });

  recordToolUsage({
    timestamp: '2026-04-02T09:00:00.000Z',
    source: 'mcp',
    toolName: 'codebase-retrieval',
    projectId: 'proj-a',
    repoPath: '/repos/proj-a',
    requestId: 'req-a-2',
    status: 'success',
    durationMs: 120,
    queryLength: 30,
    indexState: 'missing',
    indexAction: 'enqueue_full',
  });

  recordToolUsage({
    timestamp: '2026-04-02T10:00:00.000Z',
    source: 'mcp',
    toolName: 'find_memory',
    projectId: 'proj-a',
    repoPath: '/repos/proj-a',
    status: 'success',
    durationMs: 25,
  });

  recordToolUsage({
    timestamp: '2026-04-02T11:00:00.000Z',
    source: 'mcp',
    toolName: 'codebase-retrieval',
    projectId: 'proj-b',
    repoPath: '/repos/proj-b',
    requestId: 'req-b-1',
    status: 'success',
    durationMs: 80,
    queryLength: 16,
    indexState: 'ready',
    indexAction: 'none',
  });

  recordIndexUsage({
    timestamp: '2026-04-02T09:01:00.000Z',
    projectId: 'proj-a',
    repoPath: '/repos/proj-a',
    taskId: 'task-a',
    scope: 'full',
    phase: 'enqueue',
    status: 'queued',
    requestedBy: 'mcp',
    reusedExisting: false,
  });

  const report = analyzeIndexOptimization({
    days: 1,
    projectId: 'proj-a',
  });

  assert.equal(report.filters.days, 1);
  assert.equal(report.filters.projectId, 'proj-a');
  assert.equal(report.summary.totalToolCalls, 2);
  assert.equal(report.summary.toolBreakdown['codebase-retrieval'], 1);
  assert.equal(report.summary.toolBreakdown['find_memory'], 1);
  assert.equal(report.summary.hotProjects.length, 1);
  assert.equal(report.summary.hotProjects[0].projectId, 'proj-a');
  assert.equal(report.summary.hotProjects[0].repoPath, '/repos/proj-a');
  assert.equal(report.timeSeries.daily.length, 1);
  assert.equal(report.timeSeries.daily[0].date, '2026-04-02');
});

test('usage:index-report CLI 支持 days 和 project-id 过滤', () => {
  const baseDir = makeBaseDir();
  process.env.CONTEXTATLAS_BASE_DIR = baseDir;

  recordToolUsage({
    timestamp: '2026-04-01T09:00:00.000Z',
    source: 'mcp',
    toolName: 'codebase-retrieval',
    projectId: 'proj-cli-filter',
    repoPath: '/repos/proj-cli-filter',
    requestId: 'req-old',
    status: 'success',
    durationMs: 50,
    queryLength: 10,
    indexState: 'ready',
    indexAction: 'none',
  });

  recordToolUsage({
    timestamp: '2026-04-02T09:00:00.000Z',
    source: 'mcp',
    toolName: 'codebase-retrieval',
    projectId: 'proj-cli-filter',
    repoPath: '/repos/proj-cli-filter',
    requestId: 'req-new',
    status: 'success',
    durationMs: 60,
    queryLength: 12,
    indexState: 'missing',
    indexAction: 'enqueue_full',
  });

  const result = spawnSync(
    'node',
    [
      path.join(REPO_ROOT, 'dist/index.js'),
      'usage:index-report',
      '--days',
      '1',
      '--project-id',
      'proj-cli-filter',
      '--json',
    ],
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
  assert.equal(payload.filters.days, 1);
  assert.equal(payload.filters.projectId, 'proj-cli-filter');
  assert.equal(payload.summary.totalToolCalls, 1);
  assert.equal(payload.timeSeries.daily.length, 1);
  assert.equal(payload.timeSeries.daily[0].date, '2026-04-02');
  assert.ok(
    payload.actions.some((item: { command: string }) =>
      item.command.includes('/repos/proj-cli-filter'),
    ),
  );
});

test('formatIndexOptimizationReport 默认输出精简晨报', () => {
  const report = analyzeIndexOptimization(
    {},
    [
      {
        eventId: 1,
        day: '2026-04-02',
        timestamp: '2026-04-02T09:00:00.000Z',
        source: 'mcp',
        toolName: 'codebase-retrieval',
        projectId: 'proj-report',
        repoPath: '/repos/proj-report',
        status: 'success',
        durationMs: 120,
        queryLength: 20,
        indexState: 'missing',
        indexAction: 'enqueue_full',
      },
      {
        eventId: 2,
        day: '2026-04-02',
        timestamp: '2026-04-02T09:10:00.000Z',
        source: 'mcp',
        toolName: 'codebase-retrieval',
        projectId: 'proj-report',
        repoPath: '/repos/proj-report',
        status: 'success',
        durationMs: 140,
        queryLength: 20,
        indexState: 'missing',
        indexAction: 'enqueue_full',
      },
    ],
    [
      {
        eventId: 1,
        day: '2026-04-02',
        timestamp: '2026-04-02T09:05:00.000Z',
        projectId: 'proj-report',
        repoPath: '/repos/proj-report',
        taskId: 'task-1',
        scope: 'full',
        phase: 'enqueue',
        status: 'reused',
        requestedBy: 'mcp',
        reusedExisting: true,
      },
      {
        eventId: 2,
        day: '2026-04-02',
        timestamp: '2026-04-02T09:15:00.000Z',
        projectId: 'proj-report',
        repoPath: '/repos/proj-report',
        taskId: 'task-2',
        scope: 'full',
        phase: 'execute',
        status: 'failed',
        requestedBy: 'daemon',
        durationMs: 5000,
        error: 'boom',
      },
    ],
  );

  const text = formatIndexOptimizationReport(report);
  assert.match(text, /Index Optimization Snapshot/);
  assert.match(text, /Hot Project: proj-report/);
  assert.match(text, /Query Before Index:/);
  assert.match(text, /Queue Reuse:/);
  assert.match(text, /Index Failures:/);
  assert.match(text, /Top Actions:/);
  assert.match(text, /contextatlas index \/repos\/proj-report/);
  assert.match(text, /contextatlas daemon start/);
});

test('formatIndexOptimizationReport 优先显示 repo 目录名', () => {
  const report = analyzeIndexOptimization(
    {},
    [
      {
        eventId: 1,
        day: '2026-04-02',
        timestamp: '2026-04-02T09:00:00.000Z',
        source: 'mcp',
        toolName: 'codebase-retrieval',
        projectId: '7237c3339d',
        repoPath: '/home/yuanzhi/Develop/tools/taskplane',
        status: 'success',
        durationMs: 88,
        queryLength: 18,
        indexState: 'ready',
        indexAction: 'none',
      },
    ],
    [],
  );

  const text = formatIndexOptimizationReport(report);
  assert.match(text, /Hot Project: taskplane \(7237c3339d, 1 calls\)/);
});
