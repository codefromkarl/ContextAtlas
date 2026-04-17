import { spawnSync } from 'node:child_process';
import path from 'node:path';

export interface McpProcessInfo {
  pid: number;
  ppid: number | null;
  elapsedSeconds: number | null;
  startedAt: string;
  command: string;
}

export interface McpProcessHealthReport {
  repoRoot: string;
  processCount: number;
  duplicateCount: number;
  processes: McpProcessInfo[];
  overall: {
    status: 'healthy' | 'degraded';
    issues: string[];
    recommendations: string[];
  };
}


export interface McpCleanupOptions {
  repoRoot: string;
  keepPid?: number | null;
  apply?: boolean;
  force?: boolean;
}

export interface McpCleanupResult {
  repoRoot: string;
  apply: boolean;
  force: boolean;
  keptPid: number | null;
  suggestedKeepPid: number | null;
  duplicatePids: number[];
  duplicateCount: number;
  status: 'noop' | 'dry-run' | 'requires-keep-pid' | 'cleaned' | 'partial';
  remainingPids?: number[];
}

interface McpCleanupDependencies {
  analyze?: (input: { repoRoot: string }) => McpProcessHealthReport;
  kill?: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void;
  sleep?: (ms: number) => Promise<void>;
}

function parsePsLine(line: string): McpProcessInfo | null {
  const elapsedMatch = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
  if (elapsedMatch) {
    const pid = Number.parseInt(elapsedMatch[1] || '', 10);
    const ppid = Number.parseInt(elapsedMatch[2] || '', 10);
    const elapsedSeconds = Number.parseInt(elapsedMatch[3] || '', 10);

    return {
      pid: Number.isFinite(pid) ? pid : -1,
      ppid: Number.isFinite(ppid) ? ppid : null,
      elapsedSeconds: Number.isFinite(elapsedSeconds) ? elapsedSeconds : null,
      startedAt: elapsedMatch[3] || 'unknown',
      command: elapsedMatch[4] || '',
    };
  }

  const match = line.trim().match(/^(\S+)\s+(\d+)\s+(\d+)\s+\S+\s+(\S+)\s+\S+\s+\S+\s+(.+)$/);
  if (!match) {
    return null;
  }

  const pid = Number.parseInt(match[2] || '', 10);
  const ppid = Number.parseInt(match[3] || '', 10);

  return {
    pid: Number.isFinite(pid) ? pid : -1,
    ppid: Number.isFinite(ppid) ? ppid : null,
    elapsedSeconds: null,
    startedAt: match[4] || 'unknown',
    command: match[5] || '',
  };
}

export function parseContextAtlasMcpProcesses(psOutput: string, repoRoot: string): McpProcessInfo[] {
  const normalizedRepoRoot = path.resolve(repoRoot);
  const expectedNeedle = path.join(normalizedRepoRoot, 'dist', 'index.js');

  return psOutput
    .split('\n')
    .map((line) => parsePsLine(line))
    .filter((process): process is McpProcessInfo => process !== null)
    .filter((process) =>
      process.command.includes(expectedNeedle) && /\bdist\/index\.js\s+mcp(?:\s|$)/.test(process.command),
    );
}

export function analyzeMcpProcessHealth(input: {
  repoRoot?: string;
  psOutput?: string;
} = {}): McpProcessHealthReport {
  const repoRoot = path.resolve(input.repoRoot || process.cwd());
  const psOutput = input.psOutput ?? process.env.CONTEXTATLAS_PS_OUTPUT ?? spawnSync('ps', ['-eo', 'pid=,ppid=,etimes=,command='], { encoding: 'utf8' }).stdout;
  const processes = parseContextAtlasMcpProcesses(psOutput, repoRoot);
  const duplicateCount = Math.max(0, processes.length - 1);
  const issues =
    duplicateCount > 0
      ? [`检测到 ${processes.length} 个 ContextAtlas MCP 进程，存在重复/陈旧进程风险`]
      : [];
  const recommendations =
    duplicateCount > 0
      ? ['先执行 contextatlas ops:apply cleanup-duplicate-mcp --dry-run 预览修复，再按提示执行 contextatlas ops:apply cleanup-duplicate-mcp']
      : [];

  return {
    repoRoot,
    processCount: processes.length,
    duplicateCount,
    processes,
    overall: {
      status: duplicateCount > 0 ? 'degraded' : 'healthy',
      issues,
      recommendations,
    },
  };
}

export function selectDuplicateMcpProcesses(report: McpProcessHealthReport): McpProcessInfo[] {
  if (report.processes.length <= 1) {
    return [];
  }

  const sorted = [...report.processes].sort((a, b) => {
    if (a.elapsedSeconds !== null && b.elapsedSeconds !== null && a.elapsedSeconds !== b.elapsedSeconds) {
      return a.elapsedSeconds - b.elapsedSeconds;
    }
    return b.pid - a.pid;
  });
  return sorted.slice(1);
}

export function selectPreferredMcpProcess(report: McpProcessHealthReport): McpProcessInfo | null {
  if (report.processes.length === 0) {
    return null;
  }

  return [...report.processes].sort((a, b) => {
    if (a.elapsedSeconds !== null && b.elapsedSeconds !== null && a.elapsedSeconds !== b.elapsedSeconds) {
      return a.elapsedSeconds - b.elapsedSeconds;
    }
    return b.pid - a.pid;
  })[0] || null;
}

export function formatMcpProcessHealthReport(report: McpProcessHealthReport): string {
  const lines: string[] = [];
  lines.push('MCP Process Health');
  lines.push(`- Repo Root: ${report.repoRoot}`);
  lines.push(`- Process Count: ${report.processCount}`);
  lines.push(`- Status: ${report.overall.status}`);
  if (report.overall.issues.length > 0) {
    lines.push(`- Issues: ${report.overall.issues.join(' | ')}`);
  }
  if (report.processes.length > 0) {
    lines.push('- Processes:');
    for (const process of report.processes) {
      lines.push(`  - pid=${process.pid} started=${process.startedAt} cmd=${process.command}`);
    }
  }
  return lines.join('\n');
}


export async function executeMcpCleanup(
  options: McpCleanupOptions,
  dependencies: McpCleanupDependencies = {},
): Promise<McpCleanupResult> {
  const analyze = dependencies.analyze || ((input: { repoRoot: string }) => analyzeMcpProcessHealth({ repoRoot: input.repoRoot }));
  const kill = dependencies.kill || ((pid: number, signal: 'SIGTERM' | 'SIGKILL') => process.kill(pid, signal));
  const sleep = dependencies.sleep || ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  const report = analyze({ repoRoot: options.repoRoot });
  const preferred = selectPreferredMcpProcess(report);
  const keptPid = options.keepPid ?? preferred?.pid ?? null;
  const duplicates = keptPid === null
    ? []
    : report.processes.filter((processInfo) => processInfo.pid != keptPid);

  const result: McpCleanupResult = {
    repoRoot: options.repoRoot,
    apply: Boolean(options.apply),
    force: Boolean(options.force),
    keptPid,
    suggestedKeepPid: preferred?.pid ?? null,
    duplicatePids: duplicates.map((processInfo) => processInfo.pid),
    duplicateCount: duplicates.length,
    status: duplicates.length == 0
      ? 'noop'
      : options.apply
        ? (options.keepPid == null ? 'requires-keep-pid' : 'partial')
        : 'dry-run',
  };

  if (!options.apply || options.keepPid == null || duplicates.length == 0) {
    return result;
  }

  for (const processInfo of duplicates) {
    kill(processInfo.pid, 'SIGTERM');
  }

  await sleep(500);

  let afterReport = analyze({ repoRoot: options.repoRoot });
  let remaining = afterReport.processes.filter((processInfo) => processInfo.pid != keptPid);

  if (remaining.length > 0 && options.force) {
    for (const processInfo of remaining) {
      kill(processInfo.pid, 'SIGKILL');
    }
    await sleep(200);
    afterReport = analyze({ repoRoot: options.repoRoot });
    remaining = afterReport.processes.filter((processInfo) => processInfo.pid != keptPid);
  }

  result.remainingPids = remaining.map((processInfo) => processInfo.pid);
  result.status = remaining.length == 0 ? 'cleaned' : 'partial';
  return result;
}
