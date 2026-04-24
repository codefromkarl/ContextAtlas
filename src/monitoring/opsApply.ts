import { spawn } from 'node:child_process';
import path from 'node:path';
import { getEmbeddingConfig } from '../config.js';
import { initDb } from '../db/index.js';
import { MemoryStore } from '../memory/MemoryStore.js';
import { MemoryRouter } from '../memory/MemoryRouter.js';
import { rebuildChunksFtsFromVectorStore } from '../search/fts.js';
import { resolveCurrentSnapshotId } from '../storage/layout.js';
import { getVectorStore } from '../vectorStore/index.js';
import type { IndexOptimizationReport } from '../usage/usageAnalysis.js';
import type { AlertEvaluationResult } from './alertEngine.js';
import type { IndexHealthReport, SnapshotHealth } from './indexHealth.js';
import type { MemoryHealthReport } from './memoryHealth.js';
import type { McpCleanupResult, McpProcessHealthReport } from './mcpProcessHealth.js';
import { summarizeOpsSnapshot, type OpsSummarySnapshot } from './opsSummary.js';

export interface OpsApplyInput {
  indexHealth: IndexHealthReport;
  memoryHealth: MemoryHealthReport;
  mcpProcessHealth?: McpProcessHealthReport;
  usageReport: IndexOptimizationReport;
  alertResult: AlertEvaluationResult;
}

export type OpsApplyKind =
  | 'daemon-start'
  | 'memory-rebuild-catalog'
  | 'fts-rebuild-chunks'
  | 'mcp-cleanup-duplicates';

export interface OpsApplyPlan {
  actionId: string;
  title: string;
  command: string;
  severity: 'high' | 'medium' | 'low';
  reason: string;
  kind: OpsApplyKind;
  repoPath?: string;
  projectId?: string;
}

export interface OpsApplyResult extends OpsApplyPlan {
  status: 'applied' | 'planned';
  pid?: number | null;
  keptPid?: number | null;
  duplicateCount?: number;
  remainingPids?: number[];
  moduleCount?: number;
  scopeCount?: number;
  filesProcessed?: number;
  chunksIndexed?: number;
}

export interface OpsApplyOptions {
  actionId: string;
  repoPath?: string;
  projectId?: string;
}

interface OpsApplyDependencies {
  startDaemon?: (input: { cliEntryPath?: string }) => Promise<{ pid?: number | null }>;
  cleanupDuplicateMcp?: (input: { repoRoot: string }) => Promise<McpCleanupResult>;
}

export interface OpsVerificationOptions {
  days?: number;
  staleDays?: number;
  repoPath?: string;
  verificationDelayMs?: number;
  verificationRetries?: number;
}

export interface OpsVerificationSnapshot {
  input: OpsApplyInput;
  summary: OpsSummarySnapshot;
}

export interface OpsVerificationDependencies {
  applyPlan?: (plan: OpsApplyPlan) => Promise<OpsApplyResult>;
  collectSnapshot?: () => Promise<OpsVerificationSnapshot>;
  recordOutcome?: (entry: {
    actionId: string;
    restored: boolean;
    beforeStatus: OpsSummarySnapshot['status'];
    afterStatus: OpsSummarySnapshot['status'];
  }) => Promise<{ id?: string | null } | null>;
}

export interface OpsApplyVerificationResult {
  action: OpsApplyResult;
  before: OpsSummarySnapshot;
  after: OpsSummarySnapshot;
  restored: boolean;
  recordedMemoryId: string | null;
}

function isChunkFtsRepairCandidate(snapshot: SnapshotHealth): boolean {
  return (
    snapshot.vectorChunkCount > 0
    && (!snapshot.hasChunksFts
      || (snapshot.chunkFtsCoverage !== null && snapshot.chunkFtsCoverage < 0.95))
  );
}

function resolveChunkFtsProjectId(
  indexHealth: IndexHealthReport,
  projectId?: string,
): string {
  const candidates = indexHealth.snapshots
    .filter((snapshot) => isChunkFtsRepairCandidate(snapshot))
    .map((snapshot) => snapshot.projectId);

  if (projectId) {
    if (!candidates.includes(projectId)) {
      throw new Error(
        `projectId ${projectId} 当前不在 chunk FTS 修复候选列表中，可选值: ${candidates.join(', ') || '无'}`,
      );
    }
    return projectId;
  }

  if (candidates.length === 1) {
    return candidates[0];
  }

  if (candidates.length === 0) {
    throw new Error('当前没有需要重建 chunk FTS 的项目');
  }

  throw new Error(
    `rebuild-chunk-fts 需要显式指定 --project-id（projectId）；当前候选项目: ${candidates.join(', ')}`,
  );
}

function toPlanBase(action: {
  id: string;
  title: string;
  command: string;
  severity: 'high' | 'medium' | 'low';
  reason: string;
}): Omit<OpsApplyPlan, 'kind'> {
  return {
    actionId: action.id,
    title: action.title,
    command: action.command,
    severity: action.severity,
    reason: action.reason,
  };
}

export function planOpsAction(input: OpsApplyInput, options: OpsApplyOptions): OpsApplyPlan {
  const summary = summarizeOpsSnapshot(input);
  const action = summary.prioritizedActions.find((candidate) => candidate.id === options.actionId);

  if (!action) {
    throw new Error(`当前 ops:summary 中不存在动作: ${options.actionId}`);
  }

  switch (action.id) {
    case 'start-daemon':
      return {
        ...toPlanBase(action),
        kind: 'daemon-start',
        repoPath: path.resolve(options.repoPath || process.cwd()),
      };
    case 'rebuild-memory-catalog':
      return {
        ...toPlanBase(action),
        kind: 'memory-rebuild-catalog',
        repoPath: path.resolve(options.repoPath || process.cwd()),
      };
    case 'rebuild-chunk-fts':
      return {
        ...toPlanBase(action),
        kind: 'fts-rebuild-chunks',
        repoPath: path.resolve(options.repoPath || process.cwd()),
        projectId: resolveChunkFtsProjectId(input.indexHealth, options.projectId),
      };
    case 'cleanup-duplicate-mcp':
      return {
        ...toPlanBase(action),
        kind: 'mcp-cleanup-duplicates',
        repoPath: path.resolve(options.repoPath || process.cwd()),
      };
    default:
      throw new Error(`动作 ${action.id} 暂不支持 ops:apply`);
  }
}

async function defaultStartDaemon(input: { cliEntryPath?: string }): Promise<{ pid?: number | null }> {
  const cliEntryPath = input.cliEntryPath || process.argv[1];
  if (!cliEntryPath) {
    throw new Error('无法解析当前 CLI 入口，不能后台启动 daemon');
  }

  const child = spawn(process.execPath, [path.resolve(cliEntryPath), 'daemon', 'start'], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();

  return { pid: child.pid ?? null };
}

export async function applyOpsActionPlan(
  plan: OpsApplyPlan,
  dependencies: OpsApplyDependencies & { cliEntryPath?: string } = {},
): Promise<OpsApplyResult> {
  switch (plan.kind) {
    case 'daemon-start': {
      const daemon = dependencies.startDaemon || defaultStartDaemon;
      const started = await daemon({ cliEntryPath: dependencies.cliEntryPath });
      return {
        ...plan,
        status: 'applied',
        pid: started.pid ?? null,
      };
    }
    case 'memory-rebuild-catalog': {
      const repoPath = plan.repoPath || process.cwd();
      const router = MemoryRouter.forProject(repoPath);
      const catalog = await router.buildCatalog();
      return {
        ...plan,
        status: 'applied',
        repoPath,
        moduleCount: Object.keys(catalog.modules).length,
        scopeCount: Object.keys(catalog.scopes).length,
      };
    }
    case 'fts-rebuild-chunks': {
      if (!plan.projectId) {
        throw new Error('fts-rebuild-chunks 缺少 projectId');
      }

      const snapshotId = resolveCurrentSnapshotId(plan.projectId);
      const db = initDb(plan.projectId, snapshotId);
      try {
        const vectorStore = await getVectorStore(
          plan.projectId,
          getEmbeddingConfig().dimensions,
          snapshotId,
        );
        try {
          const result = await rebuildChunksFtsFromVectorStore(db, vectorStore);
          return {
            ...plan,
            status: 'applied',
            filesProcessed: result.filesProcessed,
            chunksIndexed: result.chunksIndexed,
          };
        } finally {
          await vectorStore.close();
        }
      } finally {
        db.close();
      }
    }
    case 'mcp-cleanup-duplicates': {
      const cleanup = dependencies.cleanupDuplicateMcp || (async (input: { repoRoot: string }) => {
        const { analyzeMcpProcessHealth, executeMcpCleanup } = await import('./mcpProcessHealth.js');
        const report = analyzeMcpProcessHealth({ repoRoot: input.repoRoot });
        return executeMcpCleanup({
          repoRoot: input.repoRoot,
          keepPid: report.processes[0]?.pid ?? null,
          apply: true,
          force: true,
        });
      });
      const result = await cleanup({ repoRoot: plan.repoPath || process.cwd() });
      return {
        ...plan,
        status: 'applied',
        keptPid: result.keptPid,
        duplicateCount: result.duplicateCount,
        remainingPids: result.remainingPids,
      };
    }
    default: {
      const exhaustive: never = plan.kind;
      throw new Error(`未知 ops apply 动作: ${exhaustive}`);
    }
  }
}

export function formatOpsApplyReport(result: OpsApplyResult): string {
  const lines = [
    'Ops Apply',
    `Action: ${result.actionId}`,
    `Status: ${result.status.toUpperCase()}`,
    `Command: ${result.command}`,
  ];

  if (result.pid !== undefined) {
    lines.push(`Daemon PID: ${result.pid ?? 'unknown'}`);
  }
  if (result.repoPath) {
    lines.push(`Repo: ${result.repoPath}`);
  }
  if (result.projectId) {
    lines.push(`Project ID: ${result.projectId}`);
  }
  if (result.moduleCount !== undefined) {
    lines.push(`Catalog Modules: ${result.moduleCount}`);
  }
  if (result.scopeCount !== undefined) {
    lines.push(`Catalog Scopes: ${result.scopeCount}`);
  }
  if (result.filesProcessed !== undefined) {
    lines.push(`Files Processed: ${result.filesProcessed}`);
  }
  if (result.chunksIndexed !== undefined) {
    lines.push(`Chunks Indexed: ${result.chunksIndexed}`);
  }

  return lines.join('\n');
}

export function formatOpsApplyVerificationReport(result: OpsApplyVerificationResult): string {
  const lines = [formatOpsApplyReport(result.action)];
  lines.push(`Before Status: ${result.before.status.toUpperCase()}`);
  lines.push(`After Status: ${result.after.status.toUpperCase()}`);
  lines.push(`Restored: ${result.restored ? 'YES' : 'NO'}`);
  if (result.recordedMemoryId) {
    lines.push(`Recorded Memory: ${result.recordedMemoryId}`);
  }
  return lines.join('\n');
}

function isRestored(before: OpsSummarySnapshot, after: OpsSummarySnapshot): boolean {
  if (after.status === 'healthy') {
    return true;
  }

  if (before.status === after.status) {
    return false;
  }

  return before.status === 'unhealthy' && after.status === 'degraded';
}

function isActionStillPresent(summary: OpsSummarySnapshot, actionId: string): boolean {
  return summary.prioritizedActions.some((action) => action.id === actionId);
}

async function collectOpsVerificationSnapshot(
  options: Pick<OpsVerificationOptions, 'days' | 'staleDays'> = {},
): Promise<OpsVerificationSnapshot> {
  const { analyzeIndexHealth } = await import('./indexHealth.js');
  const { analyzeMemoryHealth } = await import('./memoryHealth.js');
  const { analyzeMcpProcessHealth } = await import('./mcpProcessHealth.js');
  const { evaluateAlerts } = await import('./alertEngine.js');
  const { analyzeIndexOptimization } = await import('../usage/usageAnalysis.js');
  const { buildAlertEvaluationMetrics } = await import('./healthFull.js');

  const days = Number.isFinite(options.days) && (options.days || 0) > 0 ? options.days : 7;
  const staleDays =
    Number.isFinite(options.staleDays) && (options.staleDays || 0) > 0 ? options.staleDays : 30;

  const [indexHealth, memoryHealth, mcpProcessHealth] = await Promise.all([
    analyzeIndexHealth(),
    analyzeMemoryHealth({ staleDays }),
    Promise.resolve(analyzeMcpProcessHealth()),
  ]);
  const usageReport = analyzeIndexOptimization({ days });
  const alertResult = evaluateAlerts(
    buildAlertEvaluationMetrics({ indexHealth, memoryHealth, mcpProcessHealth }),
  );

  const input = {
    indexHealth,
    memoryHealth,
    mcpProcessHealth,
    usageReport,
    alertResult,
  };

  return {
    input,
    summary: summarizeOpsSnapshot(input),
  };
}

async function recordOpsVerificationOutcome(
  repoPath: string,
  entry: {
    actionId: string;
    restored: boolean;
    beforeStatus: OpsSummarySnapshot['status'];
    afterStatus: OpsSummarySnapshot['status'];
  },
): Promise<{ id?: string | null }> {
  const store = new MemoryStore(repoPath);
  const memory = await store.appendLongTermMemoryItem({
    type: 'project-state',
    title: `ops:apply:${entry.actionId}:${entry.restored ? 'restored' : 'pending'}`,
    summary: `action=${entry.actionId} | restored=${entry.restored} | before=${entry.beforeStatus} | after=${entry.afterStatus}`,
    why: '记录自动修复动作是否真正恢复系统状态',
    howToApply: '后续排查同类问题时先查看最近一次 ops:apply 恢复结果',
    tags: ['ops-apply', entry.actionId, entry.restored ? 'restored' : 'pending'],
    scope: 'project',
    source: 'tool-result',
    confidence: 1,
    lastVerifiedAt: new Date().toISOString(),
  });
  return { id: memory.memory.id };
}

export async function applyOpsActionWithVerification(
  plan: OpsApplyPlan,
  options: OpsVerificationOptions = {},
  dependencies: OpsVerificationDependencies = {},
): Promise<OpsApplyVerificationResult> {
  const applyPlan = dependencies.applyPlan || applyOpsActionPlan;
  const collectSnapshot =
    dependencies.collectSnapshot
    || (() =>
      collectOpsVerificationSnapshot({
        days: options.days,
        staleDays: options.staleDays,
      }));

  const beforeSnapshot = await collectSnapshot();
  const action = await applyPlan(plan);

  const retries = Math.max(0, options.verificationRetries ?? 0);
  const delayMs = Math.max(0, options.verificationDelayMs ?? 0);

  let afterSnapshot = await collectSnapshot();
  for (let attempt = 0; attempt < retries; attempt += 1) {
    if (
      isRestored(beforeSnapshot.summary, afterSnapshot.summary)
      || !isActionStillPresent(afterSnapshot.summary, plan.actionId)
    ) {
      break;
    }
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    afterSnapshot = await collectSnapshot();
  }

  const restored =
    isRestored(beforeSnapshot.summary, afterSnapshot.summary)
    || !isActionStillPresent(afterSnapshot.summary, plan.actionId);
  const repoPath = path.resolve(options.repoPath || plan.repoPath || process.cwd());
  const recorded = dependencies.recordOutcome
    ? await dependencies.recordOutcome({
        actionId: plan.actionId,
        restored,
        beforeStatus: beforeSnapshot.summary.status,
        afterStatus: afterSnapshot.summary.status,
      })
    : await recordOpsVerificationOutcome(repoPath, {
        actionId: plan.actionId,
        restored,
        beforeStatus: beforeSnapshot.summary.status,
        afterStatus: afterSnapshot.summary.status,
      });

  return {
    action,
    before: beforeSnapshot.summary,
    after: afterSnapshot.summary,
    restored,
    recordedMemoryId: recorded?.id ?? null,
  };
}
