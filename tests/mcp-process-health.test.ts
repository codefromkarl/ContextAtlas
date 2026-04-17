import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzeMcpProcessHealth,
  parseContextAtlasMcpProcesses,
  selectPreferredMcpProcess,
  selectDuplicateMcpProcesses,
} from '../src/monitoring/mcpProcessHealth.ts';

test('parseContextAtlasMcpProcesses 仅提取当前仓库的 ContextAtlas mcp 进程', () => {
  const psOutput = [
    '100 1 5 /usr/bin/node /home/yuanzhi/Develop/tools/ContextAtlas/dist/index.js mcp',
    '101 1 20 /usr/bin/node /home/yuanzhi/Develop/tools/ContextAtlas/dist/index.js gateway:embeddings',
    '102 1 30 /usr/bin/node /other/repo/dist/index.js mcp',
  ].join('\n');

  const processes = parseContextAtlasMcpProcesses(
    psOutput,
    '/home/yuanzhi/Develop/tools/ContextAtlas',
  );

  assert.equal(processes.length, 1);
  assert.equal(processes[0]?.pid, 100);
  assert.equal(processes[0]?.elapsedSeconds, 5);
});

test('analyzeMcpProcessHealth 对重复 MCP 进程标记 degraded', () => {
  const report = analyzeMcpProcessHealth({
    repoRoot: '/home/yuanzhi/Develop/tools/ContextAtlas',
    psOutput: [
      '100 1 5 /usr/bin/node /home/yuanzhi/Develop/tools/ContextAtlas/dist/index.js mcp',
      '101 1 8 /usr/bin/node /home/yuanzhi/Develop/tools/ContextAtlas/dist/index.js mcp',
    ].join('\n'),
  });

  assert.equal(report.processCount, 2);
  assert.equal(report.duplicateCount, 1);
  assert.equal(report.overall.status, 'degraded');
  assert.match(report.overall.issues[0] || '', /2 个 ContextAtlas MCP 进程/);
  assert.match(
    report.overall.recommendations[0] || '',
    /ops:apply cleanup-duplicate-mcp/,
  );
});

test('selectDuplicateMcpProcesses 默认保留 pid 最大的最新进程', () => {
  const report = analyzeMcpProcessHealth({
    repoRoot: '/home/yuanzhi/Develop/tools/ContextAtlas',
    psOutput: [
      '100 1 120 /usr/bin/node /home/yuanzhi/Develop/tools/ContextAtlas/dist/index.js mcp',
      '120 1 5 /usr/bin/node /home/yuanzhi/Develop/tools/ContextAtlas/dist/index.js mcp',
      '110 1 30 /usr/bin/node /home/yuanzhi/Develop/tools/ContextAtlas/dist/index.js mcp',
    ].join('\n'),
  });

  const duplicates = selectDuplicateMcpProcesses(report);
  assert.deepEqual(duplicates.map((process) => process.pid), [110, 100]);
});

test('selectPreferredMcpProcess 优先选择 elapsedSeconds 最小的进程', () => {
  const report = analyzeMcpProcessHealth({
    repoRoot: '/home/yuanzhi/Develop/tools/ContextAtlas',
    psOutput: [
      '100 1 120 /usr/bin/node /home/yuanzhi/Develop/tools/ContextAtlas/dist/index.js mcp',
      '120 1 5 /usr/bin/node /home/yuanzhi/Develop/tools/ContextAtlas/dist/index.js mcp',
      '110 1 30 /usr/bin/node /home/yuanzhi/Develop/tools/ContextAtlas/dist/index.js mcp',
    ].join('\n'),
  });

  assert.equal(selectPreferredMcpProcess(report)?.pid, 120);
});


test('executeMcpCleanup 在 apply 无 keepPid 时返回 requires-keep-pid', async () => {
  const states = [
    analyzeMcpProcessHealth({
      repoRoot: '/home/yuanzhi/Develop/tools/ContextAtlas',
      psOutput: [
        '100 1 120 /usr/bin/node /home/yuanzhi/Develop/tools/ContextAtlas/dist/index.js mcp',
        '120 1 5 /usr/bin/node /home/yuanzhi/Develop/tools/ContextAtlas/dist/index.js mcp',
      ].join('\n'),
    }),
  ];

  const { executeMcpCleanup } = await import('../src/monitoring/mcpProcessHealth.ts');
  const result = await executeMcpCleanup(
    { repoRoot: '/home/yuanzhi/Develop/tools/ContextAtlas', apply: true },
    { analyze: () => states[0], kill: () => { throw new Error('should not kill'); }, sleep: async () => {} },
  );

  assert.equal(result.status, 'requires-keep-pid');
  assert.equal(result.suggestedKeepPid, 120);
});

test('executeMcpCleanup 在 keepPid + force 后返回 cleaned', async () => {
  const states = [
    analyzeMcpProcessHealth({
      repoRoot: '/home/yuanzhi/Develop/tools/ContextAtlas',
      psOutput: [
        '100 1 120 /usr/bin/node /home/yuanzhi/Develop/tools/ContextAtlas/dist/index.js mcp',
        '120 1 5 /usr/bin/node /home/yuanzhi/Develop/tools/ContextAtlas/dist/index.js mcp',
      ].join('\n'),
    }),
    analyzeMcpProcessHealth({
      repoRoot: '/home/yuanzhi/Develop/tools/ContextAtlas',
      psOutput: '120 1 5 /usr/bin/node /home/yuanzhi/Develop/tools/ContextAtlas/dist/index.js mcp',
    }),
  ];
  const killed = [];

  const { executeMcpCleanup } = await import('../src/monitoring/mcpProcessHealth.ts');
  const result = await executeMcpCleanup(
    { repoRoot: '/home/yuanzhi/Develop/tools/ContextAtlas', keepPid: 120, apply: true, force: true },
    {
      analyze: () => states.shift() || states[states.length - 1],
      kill: (pid, signal) => killed.push(`${pid}:${signal}`),
      sleep: async () => {},
    },
  );

  assert.equal(result.status, 'cleaned');
  assert.deepEqual(killed, ['100:SIGTERM']);
  assert.deepEqual(result.remainingPids, []);
});
