import path from 'node:path';
import {
  type IndexUsageRecord,
  listIndexUsage,
  listToolUsage,
  type ToolUsageRecord,
} from './usageTracker.js';

export interface AnalyzeIndexOptimizationOptions {
  days?: number;
  projectId?: string;
}

export interface IndexOptimizationReport {
  filters: {
    days?: number;
    projectId?: string;
  };
  summary: {
    totalToolCalls: number;
    toolBreakdown: Record<string, number>;
    hotProjects: Array<{
      projectId: string;
      repoPath?: string;
      toolCalls: number;
      queryBeforeIndexRate: number;
    }>;
    indexing: {
      queryBeforeIndexRate: number;
      reusedQueueRate: number;
      fullIndexRate: number;
      failedExecutionRate: number;
      avgExecutionDurationMs: number;
    };
  };
  timeSeries: {
    daily: Array<{
      date: string;
      toolCalls: number;
      retrievalCalls: number;
      queryBeforeIndexRate: number;
    }>;
  };
  actions: Array<{
    id: string;
    title: string;
    command: string;
    reason: string;
  }>;
  recommendations: Array<{
    id: string;
    severity: 'low' | 'medium' | 'high';
    title: string;
    reason: string;
    evidence: Record<string, number | string>;
  }>;
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function rate<T>(items: T[], predicate: (item: T) => boolean): number {
  if (items.length === 0) return 0;
  return items.filter(predicate).length / items.length;
}

function formatHotProjectLabel(project?: {
  projectId: string;
  repoPath?: string;
  toolCalls: number;
}): string {
  if (!project) return 'N/A';
  const repoName = project.repoPath ? path.basename(project.repoPath) : null;
  if (repoName && repoName !== project.projectId) {
    return `${repoName} (${project.projectId}, ${project.toolCalls} calls)`;
  }
  return `${project.projectId} (${project.toolCalls} calls)`;
}

function buildRecommendations(
  report: IndexOptimizationReport,
): IndexOptimizationReport['recommendations'] {
  const recs: IndexOptimizationReport['recommendations'] = [];
  const { hotProjects, indexing } = report.summary;

  if (
    hotProjects.some((project) => project.toolCalls >= 5 && project.queryBeforeIndexRate >= 0.3)
  ) {
    const target = hotProjects[0];
    recs.push({
      id: 'preindex-hot-projects',
      severity: 'high',
      title: '为高频项目建立预索引',
      reason: '日常使用集中在少数项目上，且这些项目存在较高比例的“查询发生在索引未就绪前”的情况。',
      evidence: {
        projectId: target.projectId,
        toolCalls: target.toolCalls,
        queryBeforeIndexRate: target.queryBeforeIndexRate,
      },
    });
  }

  if (indexing.reusedQueueRate >= 0.5 && indexing.queryBeforeIndexRate >= 0.2) {
    recs.push({
      id: 'daemon-throughput-or-availability',
      severity: 'high',
      title: '提高索引守护进程可用性或吞吐',
      reason:
        '大量查询重复复用已排队任务，说明查询高峰期队列消费速度不足，或者 daemon 并未稳定运行。',
      evidence: {
        reusedQueueRate: indexing.reusedQueueRate,
        queryBeforeIndexRate: indexing.queryBeforeIndexRate,
      },
    });
  }

  if (indexing.fullIndexRate >= 0.5) {
    recs.push({
      id: 'reduce-full-index-frequency',
      severity: 'medium',
      title: '降低全量索引比例',
      reason: '全量索引事件占比较高，说明当前索引触发策略对热项目仍过于粗放。',
      evidence: {
        fullIndexRate: indexing.fullIndexRate,
      },
    });
  }

  if (indexing.failedExecutionRate > 0) {
    recs.push({
      id: 'fix-index-failures',
      severity: 'high',
      title: '优先修复索引执行失败',
      reason: '索引执行存在失败事件，会直接影响查询时索引可用性和使用体验。',
      evidence: {
        failedExecutionRate: indexing.failedExecutionRate,
      },
    });
  }

  if (report.timeSeries.daily.length >= 2) {
    const first = report.timeSeries.daily[0];
    const last = report.timeSeries.daily[report.timeSeries.daily.length - 1];
    if (last.queryBeforeIndexRate >= first.queryBeforeIndexRate + 0.2) {
      recs.push({
        id: 'query-before-index-trending-up',
        severity: 'medium',
        title: '查询发生在索引未就绪前的比例在上升',
        reason: '最近窗口内查询先于索引完成的情况变多，说明预索引或索引守护进程策略需要调整。',
        evidence: {
          firstDate: first.date,
          firstRate: first.queryBeforeIndexRate,
          lastDate: last.date,
          lastRate: last.queryBeforeIndexRate,
        },
      });
    }
  }

  return recs;
}

function buildActions(report: IndexOptimizationReport): IndexOptimizationReport['actions'] {
  const actions: IndexOptimizationReport['actions'] = [];
  const topHotProject = report.summary.hotProjects[0];

  if (
    topHotProject &&
    topHotProject.repoPath &&
    (report.recommendations.some((item) => item.id === 'preindex-hot-projects') ||
      (report.filters.projectId === topHotProject.projectId &&
        topHotProject.queryBeforeIndexRate > 0) ||
      topHotProject.queryBeforeIndexRate >= 0.5)
  ) {
    actions.push({
      id: 'preindex-hot-project',
      title: '先为最高频项目建立索引',
      command: `contextatlas index ${topHotProject.repoPath}`,
      reason: `项目 ${topHotProject.projectId} 的查询先于索引完成比例较高`,
    });
  }

  if (report.recommendations.some((item) => item.id === 'daemon-throughput-or-availability')) {
    actions.push({
      id: 'start-daemon',
      title: '持续运行索引守护进程',
      command: 'contextatlas daemon start',
      reason: '队列复用率过高，说明查询时经常等待已有索引任务完成',
    });
  }

  return actions;
}

function filterByWindow<T extends { day: string; projectId?: string }>(
  rows: T[],
  options: AnalyzeIndexOptimizationOptions,
): T[] {
  const { days, projectId } = options;
  let allowedDays: Set<string> | null = null;

  if (days && days > 0) {
    const uniqueDays = Array.from(new Set(rows.map((row) => row.day))).sort();
    allowedDays = new Set(uniqueDays.slice(-days));
  }

  return rows.filter((row) => {
    if (allowedDays && !allowedDays.has(row.day)) {
      return false;
    }
    if (projectId && row.projectId !== projectId) {
      return false;
    }
    return true;
  });
}

function buildDailySeries(toolRows: ToolUsageRecord[]) {
  const groups = new Map<string, ToolUsageRecord[]>();
  for (const row of toolRows) {
    const bucket = groups.get(row.day) || [];
    bucket.push(row);
    groups.set(row.day, bucket);
  }

  return Array.from(groups.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, rows]) => {
      const retrievalRows = rows.filter((row) => row.toolName === 'codebase-retrieval');
      return {
        date,
        toolCalls: rows.length,
        retrievalCalls: retrievalRows.length,
        queryBeforeIndexRate: round(rate(retrievalRows, (row) => row.indexState === 'missing')),
      };
    });
}

function groupHotProjects(toolRows: ToolUsageRecord[]) {
  const perProject = new Map<string, ToolUsageRecord[]>();
  for (const row of toolRows) {
    const projectId = row.projectId || 'unknown';
    const bucket = perProject.get(projectId) || [];
    bucket.push(row);
    perProject.set(projectId, bucket);
  }

  return Array.from(perProject.entries())
    .map(([projectId, rows]) => ({
      projectId,
      repoPath: rows.find((row) => row.repoPath)?.repoPath,
      toolCalls: rows.length,
      queryBeforeIndexRate: round(
        rate(rows, (row) => row.toolName === 'codebase-retrieval' && row.indexState === 'missing'),
      ),
    }))
    .sort((a, b) => b.toolCalls - a.toolCalls);
}

export function analyzeIndexOptimization(
  options: AnalyzeIndexOptimizationOptions = {},
  toolRows: ToolUsageRecord[] = listToolUsage(),
  indexRows: IndexUsageRecord[] = listIndexUsage(),
): IndexOptimizationReport {
  const filteredToolRows = filterByWindow(toolRows, options);
  const filteredIndexRows = filterByWindow(indexRows, options);

  const toolBreakdown = filteredToolRows.reduce<Record<string, number>>((acc, row) => {
    acc[row.toolName] = (acc[row.toolName] || 0) + 1;
    return acc;
  }, {});
  const retrievalRows = filteredToolRows.filter((row) => row.toolName === 'codebase-retrieval');
  const enqueueRows = filteredIndexRows.filter((row) => row.phase === 'enqueue');
  const executeRows = filteredIndexRows.filter((row) => row.phase === 'execute');

  const report: IndexOptimizationReport = {
    filters: {
      days: options.days,
      projectId: options.projectId,
    },
    summary: {
      totalToolCalls: filteredToolRows.length,
      toolBreakdown,
      hotProjects: groupHotProjects(retrievalRows),
      indexing: {
        queryBeforeIndexRate: round(rate(retrievalRows, (row) => row.indexState === 'missing')),
        reusedQueueRate: round(rate(enqueueRows, (row) => row.reusedExisting === true)),
        fullIndexRate: round(rate(indexRows, (row) => row.scope === 'full')),
        failedExecutionRate: round(rate(executeRows, (row) => row.status === 'failed')),
        avgExecutionDurationMs: round(average(executeRows.map((row) => row.durationMs || 0)), 2),
      },
    },
    timeSeries: {
      daily: buildDailySeries(filteredToolRows),
    },
    actions: [],
    recommendations: [],
  };

  report.recommendations = buildRecommendations(report);
  report.actions = buildActions(report);
  return report;
}

export function formatIndexOptimizationReport(report: IndexOptimizationReport): string {
  const lines: string[] = [];
  lines.push('Index Optimization Snapshot');
  if (report.filters.projectId) {
    lines.push(`Project Filter: ${report.filters.projectId}`);
  }
  if (report.filters.days) {
    lines.push(`Window: last ${report.filters.days} day(s)`);
  }
  const hotProject = report.summary.hotProjects[0];
  lines.push(`Tool Calls: ${report.summary.totalToolCalls}`);
  lines.push(`Hot Project: ${formatHotProjectLabel(hotProject)}`);
  lines.push('');
  lines.push('Key Metrics:');
  lines.push(
    `- Query Before Index: ${Math.round(report.summary.indexing.queryBeforeIndexRate * 100)}%`,
  );
  lines.push(`- Queue Reuse: ${Math.round(report.summary.indexing.reusedQueueRate * 100)}%`);
  lines.push(`- Index Failures: ${Math.round(report.summary.indexing.failedExecutionRate * 100)}%`);
  lines.push('');
  lines.push('Top Actions:');
  if (report.actions.length === 0) {
    lines.push('- 暂无直接可执行动作');
  } else {
    for (const action of report.actions.slice(0, 2)) {
      lines.push(`- ${action.title}: ${action.command}`);
    }
  }
  lines.push('');
  lines.push('Notes:');
  if (report.recommendations.length === 0) {
    lines.push('- 当前没有明显的索引优化建议');
  } else {
    for (const recommendation of report.recommendations.slice(0, 2)) {
      lines.push(
        `- [${recommendation.severity}] ${recommendation.title}: ${recommendation.reason}`,
      );
    }
  }
  return lines.join('\n');
}
