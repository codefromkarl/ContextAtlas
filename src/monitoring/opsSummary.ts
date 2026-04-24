import type { AlertEvaluationResult } from './alertEngine.js';
import type { IndexHealthReport, IndexStrategySummary } from './indexHealth.js';
import type { MemoryHealthReport } from './memoryHealth.js';
import type { McpProcessHealthReport } from './mcpProcessHealth.js';
import type { IndexOptimizationReport } from '../usage/usageAnalysis.js';
import { collectProjectOperationalIssues } from './healthFull.js';

export interface OpsPrioritizedAction {
  id: string;
  title: string;
  command: string;
  severity: 'high' | 'medium' | 'low';
  reason: string;
}

export interface OpsSummarySnapshot {
  status: 'healthy' | 'degraded' | 'unhealthy';
  metrics: {
    queuedTasks: number;
    failedTasks: number;
    triggeredAlerts: number;
    staleMemoryRate: number;
    expiredMemoryRate: number;
    queryBeforeIndexRate: number;
    avgIndexExecutionDurationMs: number;
  };
  topIssues: string[];
  topActions: string[];
  prioritizedActions: OpsPrioritizedAction[];
  projectViews: Array<{
    projectId: string;
    currentSnapshotId: string | null;
    lastSuccessfulAt: string | null;
    lastSuccessfulScope: 'full' | 'incremental' | null;
    latestTaskRepoPath: string | null;
    strategySummary: IndexStrategySummary | null;
    issues: string[];
  }>;
  sections: {
    index: string;
    memory: string;
    governance: string;
    alerts: string;
    usage: string;
  };
}

export function summarizeOpsSnapshot(input: {
  indexHealth: IndexHealthReport;
  memoryHealth: MemoryHealthReport;
  mcpProcessHealth?: McpProcessHealthReport;
  usageReport: IndexOptimizationReport;
  alertResult: AlertEvaluationResult;
}): OpsSummarySnapshot {
  const indexStatus = input.indexHealth.overall.status;
  const memoryStatus = input.memoryHealth.overall.status;
  const alertStatus =
    input.alertResult.triggered.some((alert) => alert.severity === 'critical')
      ? 'unhealthy'
      : input.alertResult.triggered.length > 0
        ? 'degraded'
        : 'healthy';

  const status = [indexStatus, memoryStatus, alertStatus].includes('unhealthy')
    ? 'unhealthy'
    : [indexStatus, memoryStatus, alertStatus].includes('degraded')
      ? 'degraded'
      : 'healthy';

  const topIssues = [
    ...input.indexHealth.overall.issues,
    ...input.memoryHealth.overall.issues,
    ...(input.mcpProcessHealth?.overall.issues || []),
    ...input.alertResult.triggered.map((alert) => `${alert.ruleName}: ${alert.message}`),
  ].slice(0, 5);

  const topActions = [
    ...input.indexHealth.overall.recommendations,
    ...input.memoryHealth.overall.recommendations,
    ...(input.mcpProcessHealth?.overall.recommendations || []),
    ...input.usageReport.actions.map((action) => `${action.title}: ${action.command}`),
  ].filter((value, index, array) => array.indexOf(value) === index).slice(0, 5);
  const prioritizedActions = synthesizeOpsActions(input);
  const representativeStrategy = input.indexHealth.snapshots.find((snapshot) => snapshot.strategySummary)
    ?.strategySummary;
  const projectScoresById = new Map(
    input.memoryHealth.projectScores.map((project) => [project.projectId, project]),
  );
  const longTermScopes = input.memoryHealth.longTermFreshness.byScope || ({} as NonNullable<
    MemoryHealthReport['longTermFreshness']['byScope']
  >);

  return {
    status,
    metrics: {
      queuedTasks: input.indexHealth.queue.queued,
      failedTasks: input.indexHealth.queue.failed,
      triggeredAlerts: input.alertResult.triggered.length,
      staleMemoryRate: input.memoryHealth.longTermFreshness.staleRate,
      expiredMemoryRate: input.memoryHealth.longTermFreshness.expiredRate,
      queryBeforeIndexRate: input.usageReport.summary.indexing.queryBeforeIndexRate,
      avgIndexExecutionDurationMs: input.usageReport.summary.indexing.avgExecutionDurationMs,
    },
    topIssues,
    topActions,
    prioritizedActions,
    projectViews: input.indexHealth.snapshots.map((snapshot) => {
      const projectScore = projectScoresById.get(snapshot.projectId);
      const issues = collectProjectOperationalIssues({
        snapshot,
        memoryIssues: projectScore?.issues || [],
      });

      return {
        projectId: snapshot.projectId,
        currentSnapshotId: snapshot.currentSnapshotId,
        lastSuccessfulAt: snapshot.lastSuccessfulAt,
        lastSuccessfulScope: snapshot.lastSuccessfulScope,
        latestTaskRepoPath: snapshot.latestTaskRepoPath,
        strategySummary: snapshot.strategySummary,
        issues,
      };
    }),
    sections: {
      index: `status=${input.indexHealth.overall.status} queued=${input.indexHealth.queue.queued} failed=${input.indexHealth.queue.failed} latestScope=${input.indexHealth.snapshots.find((snapshot) => snapshot.lastSuccessfulScope)?.lastSuccessfulScope || 'unknown'} lastSuccess=${input.indexHealth.snapshots.find((snapshot) => snapshot.lastSuccessfulAt)?.lastSuccessfulAt || 'n/a'}${representativeStrategy ? ` plan=${formatStrategySummaryInline(representativeStrategy)}` : ''}`,
      memory: `status=${input.memoryHealth.overall.status} staleRate=${Math.round(input.memoryHealth.longTermFreshness.staleRate * 100)}%`,
      governance: `catalog=${input.memoryHealth.catalogConsistency.isConsistent ? 'consistent' : 'inconsistent'} orphaned=${Math.round(input.memoryHealth.featureMemoryHealth.orphanedRate * 100)}% scopes=project:${longTermScopes.project?.total || 0},global-user:${longTermScopes['global-user']?.total || 0}${input.mcpProcessHealth ? ` mcpDuplicates=${input.mcpProcessHealth.duplicateCount}` : ''}`,
      alerts: `triggered=${input.alertResult.triggered.length}`,
      usage: `queryBeforeIndex=${Math.round(input.usageReport.summary.indexing.queryBeforeIndexRate * 100)}% avgIndexMs=${Math.round(input.usageReport.summary.indexing.avgExecutionDurationMs)}`,
    },
  };
}

export function formatOpsSummaryReport(summary: OpsSummarySnapshot): string {
  const lines: string[] = [];
  const topActions = summary.topActions || [];
  const prioritizedActions = summary.prioritizedActions || [];
  lines.push('Ops Summary');
  lines.push(`Status: ${summary.status.toUpperCase()}`);
  lines.push('');
  lines.push('Key Metrics:');
  lines.push(`- Queued Tasks: ${summary.metrics.queuedTasks}`);
  lines.push(`- Failed Tasks: ${summary.metrics.failedTasks}`);
  lines.push(`- Triggered Alerts: ${summary.metrics.triggeredAlerts}`);
  lines.push(`- Stale Memory Rate: ${Math.round(summary.metrics.staleMemoryRate * 100)}%`);
  lines.push(`- Expired Memory Rate: ${Math.round(summary.metrics.expiredMemoryRate * 100)}%`);
  lines.push(`- Query Before Index: ${Math.round(summary.metrics.queryBeforeIndexRate * 100)}%`);
  lines.push(`- Avg Index Execution: ${Math.round(summary.metrics.avgIndexExecutionDurationMs)}ms`);
  lines.push('');
  lines.push('Sections:');
  lines.push(`- Index: ${summary.sections.index}`);
  lines.push(`- Memory: ${summary.sections.memory}`);
  lines.push(`- Governance: ${summary.sections.governance}`);
  lines.push(`- Alerts: ${summary.sections.alerts}`);
  lines.push(`- Usage: ${summary.sections.usage}`);
  lines.push('');
  lines.push('Per-Project:');
  if (summary.projectViews.length === 0) {
    lines.push('- No project-specific health views');
  } else {
    for (const project of summary.projectViews) {
      lines.push(
        `- ${project.projectId}: snapshot=${project.currentSnapshotId || 'none'} latest=${project.lastSuccessfulScope || 'unknown'} @ ${project.lastSuccessfulAt || 'n/a'}`,
      );
      if (project.latestTaskRepoPath) {
        lines.push(`  repo: ${project.latestTaskRepoPath}`);
      }
      if (project.strategySummary) {
        lines.push(`  Strategy: ${formatStrategySummaryInline(project.strategySummary)}`);
      }
      if (project.issues.length > 0) {
        lines.push(`  issues: ${project.issues.join(', ')}`);
      }
    }
  }
  lines.push('');
  lines.push('Top Issues:');
  if (summary.topIssues.length === 0) {
    lines.push('- No major issues');
  } else {
    for (const issue of summary.topIssues) {
      lines.push(`- ${issue}`);
    }
  }
  lines.push('');
  lines.push('Top Actions:');
  if (topActions.length === 0) {
    lines.push('- No immediate actions');
  } else {
    for (const action of topActions) {
      lines.push(`- ${action}`);
    }
  }
  lines.push('');
  lines.push('Priority Actions:');
  if (prioritizedActions.length === 0) {
    lines.push('- No prioritized actions');
  } else {
    for (const action of prioritizedActions) {
      lines.push(`- [${action.severity}] ${action.title}: ${action.command}`);
      lines.push(`  reason: ${action.reason}`);
      const applyHint = formatOpsApplyHint(action);
      if (applyHint) {
        lines.push(`  apply: ${applyHint}`);
      }
    }
  }
  return lines.join('\n');
}

function formatStrategySummaryInline(summary: IndexStrategySummary): string {
  const triggers = summary.signals.fullRebuildTriggers.join(',') || 'none';
  return `${summary.mode} changed=${summary.signals.changedFiles} churn=${(summary.signals.churnRatio * 100).toFixed(1)}% incrCost=${(summary.signals.incrementalCostRatio * 100).toFixed(1)}% triggers=${triggers}`;
}

function synthesizeOpsActions(input: {
  indexHealth: IndexHealthReport;
  memoryHealth: MemoryHealthReport;
  mcpProcessHealth?: McpProcessHealthReport;
  usageReport: IndexOptimizationReport;
  alertResult: AlertEvaluationResult;
}): OpsSummarySnapshot['prioritizedActions'] {
  const actions: OpsSummarySnapshot['prioritizedActions'] = [];

  if (!input.indexHealth.daemon.isRunning && input.indexHealth.queue.queued > 0) {
    actions.push({
      id: 'start-daemon',
      title: 'Start daemon',
      command: 'contextatlas daemon start',
      severity: 'high',
      reason: '存在排队任务但守护进程未运行，优先恢复队列消费能力。',
    });
  }

  if (input.indexHealth.queue.failed > 0) {
    actions.push({
      id: 'inspect-index-failures',
      title: 'Inspect index failures',
      command: 'contextatlas health:check --json',
      severity: 'high',
      reason: '已有索引任务失败，需要先定位失败任务和错误原因。',
    });
  }

  if (input.indexHealth.snapshots.some((snapshot) => snapshot.dbIntegrity === 'corrupted')) {
    actions.push({
      id: 'force-rebuild-corrupted-index',
      title: 'Force rebuild corrupted index',
      command: 'contextatlas index <repo> --force',
      severity: 'high',
      reason: '发现索引数据库损坏，需要执行全量重建。',
    });
  }

  if (
    input.indexHealth.snapshots.some(
      (snapshot) =>
        snapshot.vectorChunkCount > 0
        && (!snapshot.hasChunksFts || (snapshot.chunkFtsCoverage !== null && snapshot.chunkFtsCoverage < 0.95)),
    )
  ) {
    actions.push({
      id: 'rebuild-chunk-fts',
      title: 'Rebuild chunk FTS',
      command: 'contextatlas fts:rebuild-chunks --project-id <projectId>',
      severity: 'medium',
      reason: 'chunk FTS 覆盖不足，会直接影响词法召回质量。',
    });
  }

  if (!input.memoryHealth.catalogConsistency.isConsistent) {
    actions.push({
      id: 'rebuild-memory-catalog',
      title: 'Rebuild memory catalog',
      command: 'contextatlas memory:rebuild-catalog',
      severity: 'medium',
      reason: 'feature memories 与 catalog 不一致，路由结果可能失真。',
    });
  }

  if ((input.mcpProcessHealth?.duplicateCount || 0) > 0) {
    actions.push({
      id: 'cleanup-duplicate-mcp',
      title: 'Clean duplicate MCP processes',
      command: 'contextatlas mcp:cleanup-duplicates --json',
      severity: 'high',
      reason: '检测到重复的 ContextAtlas MCP 进程，可能导致继续连接旧的 dist hash 产物。',
    });
  }

  if (input.memoryHealth.longTermFreshness.staleRate > 0.3) {
    actions.push({
      id: 'prune-stale-memory',
      title: 'Prune stale long-term memory',
      command: 'contextatlas memory:prune-long-term --include-stale --apply',
      severity: 'medium',
      reason: '长期记忆 stale 比例过高，会降低可信度。',
    });
  }

  if (input.usageReport.summary.indexing.queryBeforeIndexRate > 0.2) {
    actions.push({
      id: 'review-index-plan',
      title: 'Review index update plan',
      command: 'contextatlas index:plan <repo>',
      severity: 'medium',
      reason: '查询经常发生在索引未就绪前，应检查预索引或增量更新策略。',
    });
  }

  for (const action of input.usageReport.actions) {
    actions.push({
      id: `usage-${action.id}`,
      title: action.title,
      command: action.command,
      severity: 'low',
      reason: action.reason,
    });
  }

  return actions
    .filter(
      (action, index, array) =>
        array.findIndex((candidate) => candidate.command === action.command) === index,
    )
    .slice(0, 6);
}

function formatOpsApplyHint(action: OpsPrioritizedAction): string | null {
  switch (action.id) {
    case 'start-daemon':
      return 'contextatlas ops:apply start-daemon';
    case 'rebuild-memory-catalog':
      return 'contextatlas ops:apply rebuild-memory-catalog';
    case 'rebuild-chunk-fts':
      return 'contextatlas ops:apply rebuild-chunk-fts --project-id <projectId>';
    case 'cleanup-duplicate-mcp':
      return 'contextatlas ops:apply cleanup-duplicate-mcp';
    default:
      return null;
  }
}
