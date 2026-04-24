import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeRetrievalLogText, formatRetrievalMonitorReport } from '../src/monitoring/retrievalMonitor.ts';

test('retrieval monitor 汇总 skeletonCount/graphCount 并在文本报告里外显', () => {
  const line = `2026-04-02 12:00:00 [INFO] MCP codebase-retrieval 完成 ${JSON.stringify({
    requestId: 'req-graph-1',
    projectId: 'proj1234567',
    totalMs: 180,
    seedCount: 2,
    expandedCount: 1,
    architecturePrimaryCount: 2,
    architecturePrimaryFiles: ['src/cli/registerCommands.ts', 'src/cli/commands/search.ts'],
    visibleFileCount: 4,
    totalChars: 1200,
    timingMs: {
      retrieve: 60,
      rerank: 70,
      expand: 20,
      pack: 30,
    },
    retrievalStats: {
      queryIntent: 'architecture',
      lexicalStrategy: 'chunks_fts',
      vectorCount: 12,
      lexicalCount: 4,
      skeletonCount: 2,
      graphCount: 1,
      fusedCount: 14,
      topMCount: 10,
      rerankedCount: 6,
    },
    resultStats: {
      seedCount: 2,
      expandedCount: 1,
      fileCount: 2,
      segmentCount: 3,
      totalChars: 1200,
      budgetLimitChars: 48000,
      budgetUsedChars: 1200,
      budgetExhausted: false,
      filesConsidered: 2,
      filesIncluded: 2,
    },
  })}`;

  const report = analyzeRetrievalLogText(line);
  assert.equal(report.summary.averages.skeletonCount, 2);
  assert.equal(report.summary.averages.graphCount, 1);
  assert.equal(report.summary.averages.architecturePrimaryCount, 2);
  assert.equal(report.summary.averages.visibleFileCount, 4);
  assert.deepEqual(report.summary.topArchitecturePrimaryFiles, [
    { filePath: 'src/cli/commands/search.ts', count: 1 },
    { filePath: 'src/cli/registerCommands.ts', count: 1 },
  ]);
  assert.equal(report.summary.rates.primaryFallbackRate, 1);

  const text = formatRetrievalMonitorReport(report);
  assert.match(text, /Avg Architecture Primary Count: 2/);
  assert.match(text, /Avg Visible File Count: 4/);
  assert.match(text, /Avg Skeleton Count: 2/);
  assert.match(text, /Avg Graph Count: 1/);
  assert.match(text, /Top Architecture Primary Files:/);
  assert.match(text, /Primary Fallback Rate: 100%/);
  assert.match(text, /src\/cli\/registerCommands\.ts: 1/);
});

test('retrieval monitor 兼容解析当前 codebase-retrieval 完成日志前缀', () => {
  const line = `2026-04-02 12:00:00 [INFO] codebase-retrieval 完成 ${JSON.stringify({
    requestId: 'req-current-1',
    projectId: 'proj1234567',
    totalMs: 99,
    seedCount: 1,
  })}`;

  const report = analyzeRetrievalLogText(line);
  assert.equal(report.summary.requestCount, 1);
  assert.equal(report.summary.averages.totalMs, 99);
});
