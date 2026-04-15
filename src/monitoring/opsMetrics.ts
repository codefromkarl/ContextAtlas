import { analyzeMemoryHealth, type MemoryHealthReport } from './memoryHealth.js';
import {
  analyzeRetrievalLogDirectory,
  type RetrievalMonitorReport,
} from './retrievalMonitor.js';
import { MemoryHubDatabase } from '../memory/MemoryHubDatabase.js';
import { MemoryStore } from '../memory/MemoryStore.js';
import { resolveBaseDir } from '../runtimePaths.js';
import {
  listIndexUsage,
  listToolUsage,
} from '../usage/usageTracker.js';

export interface OpsMetricsRepoInput {
  projectId: string;
  projectName: string;
  querySuccessRate: number;
  emptyResultRate: number;
  staleMemoryRate: number;
  indexFailureRate: number;
}

export interface OpsMetricsReport {
  filters: {
    days?: number;
    staleDays?: number;
    logDir?: string;
  };
  governance: {
    projectProfileModes: {
      editable: number;
      organizationReadonly: number;
    };
    sharedMemoryPolicies: {
      disabled: number;
      readonly: number;
      editable: number;
    };
    personalMemoryScopes: {
      project: number;
      globalUser: number;
    };
    longTermMemoryScopes: {
      project: number;
      globalUser: number;
    };
  };
  summary: {
    querySuccessRate: number;
    emptyResultRate: number;
    staleMemoryRate: number;
    indexFailureRate: number;
    correctionRate: number;
    retrievalLatencyMs: number;
  };
  repoQualityDistribution: Array<
    OpsMetricsRepoInput & {
      score: number;
      band: 'healthy' | 'watch' | 'risky';
    }
  >;
  moduleQualityDistribution: Array<{
    projectId: string;
    projectName: string;
    moduleName: string;
    reviewStatus: 'verified' | 'needs-review';
    staleSignalRate: number;
    correctionSignalRate: number;
    score: number;
    band: 'healthy' | 'watch' | 'risky';
  }>;
}

export interface AnalyzeOpsMetricsOptions {
  days?: number;
  staleDays?: number;
  logDir?: string;
  retrievalReportFactory?: (input: {
    days?: number;
    logDir: string;
    projectId?: string;
  }) => RetrievalMonitorReport;
  retrievalFallbackReport?: RetrievalMonitorReport;
  memoryHealthFactory?: (input: { staleDays?: number }) => Promise<MemoryHealthReport>;
}

type GovernanceSummary = OpsMetricsReport['governance'];

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function rate<T>(items: T[], predicate: (item: T) => boolean): number {
  if (items.length === 0) return 0;
  return items.filter(predicate).length / items.length;
}

function scoreRepo(input: OpsMetricsRepoInput): number {
  return round(
    (
      input.querySuccessRate * 0.35
      + (1 - input.emptyResultRate) * 0.25
      + (1 - input.staleMemoryRate) * 0.2
      + (1 - input.indexFailureRate) * 0.2
    ) * 100,
    1,
  );
}

function bandFromScore(score: number): 'healthy' | 'watch' | 'risky' {
  if (score >= 80) return 'healthy';
  if (score >= 60) return 'watch';
  return 'risky';
}

function scoreModule(input: {
  reviewStatus: 'verified' | 'needs-review';
  staleSignalRate: number;
  correctionSignalRate: number;
}): number {
  return round(
    (
      (input.reviewStatus === 'verified' ? 1 : 0.4) * 0.45
      + (1 - input.staleSignalRate) * 0.3
      + (1 - input.correctionSignalRate) * 0.25
    ) * 100,
    1,
  );
}

function filterByWindow<T extends { timestamp: string }>(rows: T[], days?: number): T[] {
  if (!days || days <= 0) return rows;
  const newest = rows.reduce<number>(
    (max, row) => Math.max(max, new Date(row.timestamp).getTime()),
    0,
  );
  if (!newest) return rows;
  const threshold = newest - (days - 1) * 24 * 60 * 60 * 1000;
  return rows.filter((row) => new Date(row.timestamp).getTime() >= threshold);
}

function parseFeedbackOutcome(summary: string): string | null {
  const matched = summary.match(/outcome=([^|]+)/);
  return matched?.[1]?.trim() || null;
}

async function collectProjectStaleRates(
  staleDays?: number,
): Promise<Map<string, { projectName: string; staleMemoryRate: number; correctionRate: number }>> {
  const hub = MemoryHubDatabase.getDefault();
  try {
    const projects = hub.listProjects();
    const result = new Map<
      string,
      { projectName: string; staleMemoryRate: number; correctionRate: number }
    >();

    for (const project of projects) {
      try {
        const store = new MemoryStore(project.path);
        const longTerm = await store.listLongTermMemories({
          scope: 'project',
          staleDays,
          includeExpired: true,
        });
        const feedback = await store.listLongTermMemories({
          scope: 'project',
          types: ['feedback'],
          staleDays,
          includeExpired: true,
        });

        const staleMemoryRate = round(
          rate(longTerm, (item) => item.status === 'stale'),
        );
        const correctionRate = round(
          rate(
            feedback,
            (item) =>
              ['not-helpful', 'memory-stale', 'wrong-module'].includes(
                parseFeedbackOutcome(item.summary) || '',
              ),
          ),
        );

        result.set(project.id, {
          projectName: project.name,
          staleMemoryRate,
          correctionRate,
        });
      } catch {
        result.set(project.id, {
          projectName: project.name,
          staleMemoryRate: 0,
          correctionRate: 0,
        });
      }
    }

    return result;
  } finally {
    hub.close();
  }
}

async function collectModuleQualityDistribution(
  staleDays?: number,
): Promise<OpsMetricsReport['moduleQualityDistribution']> {
  const hub = MemoryHubDatabase.getDefault();
  try {
    const projects = hub.listProjects();
    const result: OpsMetricsReport['moduleQualityDistribution'] = [];

    for (const project of projects) {
      try {
        const store = new MemoryStore(project.path);
        const features = await store.listFeatures();
        const feedback = await store.listLongTermMemories({
          scope: 'project',
          types: ['feedback'],
          staleDays,
          includeExpired: true,
        });

        for (const feature of features) {
          const featureFeedback = feedback.filter((item) => (item.summary || '').includes(`targetId=${feature.name}`));
          const staleSignalRate = round(
            rate(featureFeedback, (item) => (parseFeedbackOutcome(item.summary) || '') === 'memory-stale'),
          );
          const correctionSignalRate = round(
            rate(featureFeedback, (item) => {
              const outcome = parseFeedbackOutcome(item.summary) || '';
              return outcome === 'not-helpful' || outcome === 'wrong-module';
            }),
          );
          const score = scoreModule({
            reviewStatus: feature.reviewStatus || 'verified',
            staleSignalRate,
            correctionSignalRate,
          });

          result.push({
            projectId: project.id,
            projectName: project.name,
            moduleName: feature.name,
            reviewStatus: feature.reviewStatus || 'verified',
            staleSignalRate,
            correctionSignalRate,
            score,
            band: bandFromScore(score),
          });
        }
      } catch {
        continue;
      }
    }

    return result;
  } finally {
    hub.close();
  }
}

async function collectGovernanceSummary(
  memoryHealth: MemoryHealthReport,
): Promise<GovernanceSummary> {
  const summary: GovernanceSummary = {
    projectProfileModes: {
      editable: 0,
      organizationReadonly: 0,
    },
    sharedMemoryPolicies: {
      disabled: 0,
      readonly: 0,
      editable: 0,
    },
    personalMemoryScopes: {
      project: 0,
      globalUser: 0,
    },
    longTermMemoryScopes: {
      project: memoryHealth.longTermFreshness.byScope.project?.total || 0,
      globalUser: memoryHealth.longTermFreshness.byScope['global-user']?.total || 0,
    },
  };

  const hub = MemoryHubDatabase.getDefault();
  try {
    const projects = hub.listProjects();
    for (const project of projects) {
      try {
        const store = new MemoryStore(project.path);
        const profile = await store.readProfile();
        const governance = profile?.governance;
        const profileMode = governance?.profileMode || 'editable';
        const sharedMemory = governance?.sharedMemory || 'readonly';
        const personalMemory = governance?.personalMemory || 'global-user';

        if (profileMode === 'organization-readonly') {
          summary.projectProfileModes.organizationReadonly += 1;
        } else {
          summary.projectProfileModes.editable += 1;
        }

        summary.sharedMemoryPolicies[sharedMemory] += 1;
        if (personalMemory === 'project') {
          summary.personalMemoryScopes.project += 1;
        } else {
          summary.personalMemoryScopes.globalUser += 1;
        }
      } catch {
        summary.projectProfileModes.editable += 1;
        summary.sharedMemoryPolicies.readonly += 1;
        summary.personalMemoryScopes.globalUser += 1;
      }
    }
    return summary;
  } finally {
    hub.close();
  }
}

function buildZeroRetrievalReport(): RetrievalMonitorReport {
  return {
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
  };
}

export function buildOpsMetricsReport(input: {
  querySuccessRate: number;
  emptyResultRate: number;
  staleMemoryRate: number;
  indexFailureRate: number;
  correctionRate: number;
  retrievalLatencyMs: number;
  repos: OpsMetricsRepoInput[];
  modules?: OpsMetricsReport['moduleQualityDistribution'];
  filters?: OpsMetricsReport['filters'];
  governance?: OpsMetricsReport['governance'];
}): OpsMetricsReport {
  return {
    filters: input.filters || {},
    governance: input.governance || {
      projectProfileModes: {
        editable: 0,
        organizationReadonly: 0,
      },
      sharedMemoryPolicies: {
        disabled: 0,
        readonly: 0,
        editable: 0,
      },
      personalMemoryScopes: {
        project: 0,
        globalUser: 0,
      },
      longTermMemoryScopes: {
        project: 0,
        globalUser: 0,
      },
    },
    summary: {
      querySuccessRate: round(input.querySuccessRate),
      emptyResultRate: round(input.emptyResultRate),
      staleMemoryRate: round(input.staleMemoryRate),
      indexFailureRate: round(input.indexFailureRate),
      correctionRate: round(input.correctionRate),
      retrievalLatencyMs: round(input.retrievalLatencyMs, 2),
    },
    repoQualityDistribution: input.repos
      .map((repo) => {
        const score = scoreRepo(repo);
        return {
          ...repo,
          score,
          band: bandFromScore(score),
        };
      })
      .sort((a, b) => b.score - a.score || a.projectId.localeCompare(b.projectId)),
    moduleQualityDistribution: [...(input.modules || [])].sort(
      (a, b) => b.score - a.score || a.moduleName.localeCompare(b.moduleName),
    ),
  };
}

export async function analyzeOpsMetrics(
  options: AnalyzeOpsMetricsOptions = {},
): Promise<OpsMetricsReport> {
  const effectiveLogDir = options.logDir || `${resolveBaseDir()}/logs`;
  const toolRows = filterByWindow(listToolUsage(), options.days);
  const indexRows = filterByWindow(listIndexUsage(), options.days);
  const retrievalRows = toolRows.filter((row) => row.toolName === 'codebase-retrieval');
  const executeRows = indexRows.filter((row) => row.phase === 'execute');
  const retrievalFactory =
    options.retrievalReportFactory
    || ((input: { days?: number; logDir: string; projectId?: string }) =>
      analyzeRetrievalLogDirectory({
        dirPath: input.logDir,
        days: input.days,
        projectId: input.projectId,
      }));
  const memoryHealthFactory = options.memoryHealthFactory || analyzeMemoryHealth;

  const memoryHealth = await memoryHealthFactory({ staleDays: options.staleDays });

  let retrievalReport = options.retrievalFallbackReport || buildZeroRetrievalReport();
  if (effectiveLogDir) {
    try {
      retrievalReport = retrievalFactory({
        days: options.days,
        logDir: effectiveLogDir,
      });
    } catch {
      retrievalReport = options.retrievalFallbackReport || buildZeroRetrievalReport();
    }
  }

  const projectStaleRates = await collectProjectStaleRates(options.staleDays);
  const moduleQualityDistribution = await collectModuleQualityDistribution(options.staleDays);
  const governance = await collectGovernanceSummary(memoryHealth);
  const allProjectIds = new Set<string>([
    ...retrievalRows.map((row) => row.projectId).filter((value): value is string => Boolean(value)),
    ...indexRows.map((row) => row.projectId).filter((value): value is string => Boolean(value)),
    ...memoryHealth.projectScores.map((row) => row.projectId),
    ...projectStaleRates.keys(),
  ]);

  const repos: OpsMetricsRepoInput[] = [];
  for (const projectId of allProjectIds) {
    const repoRetrievalRows = retrievalRows.filter((row) => row.projectId === projectId);
    const repoExecuteRows = executeRows.filter((row) => row.projectId === projectId);
    const profileMetrics = projectStaleRates.get(projectId);

    let repoRetrieval = buildZeroRetrievalReport();
    if (effectiveLogDir) {
      try {
        repoRetrieval = retrievalFactory({
          days: options.days,
          logDir: effectiveLogDir,
          projectId,
        });
      } catch {
        repoRetrieval = buildZeroRetrievalReport();
      }
    }

    repos.push({
      projectId,
      projectName: profileMetrics?.projectName || projectId,
      querySuccessRate:
        repoRetrievalRows.length > 0
          ? round(rate(repoRetrievalRows, (row) => row.status === 'success'))
          : round(rate(retrievalRows, (row) => row.status === 'success')),
      emptyResultRate: round(repoRetrieval.summary.rates.noSeedRate || 0),
      staleMemoryRate: profileMetrics?.staleMemoryRate || 0,
      indexFailureRate:
        repoExecuteRows.length > 0
          ? round(rate(repoExecuteRows, (row) => row.status === 'failed'))
          : 0,
    });
  }

  const correctionRates = [...projectStaleRates.values()].map((item) => item.correctionRate);
  const correctionRate =
    correctionRates.length > 0
      ? round(correctionRates.reduce((sum, value) => sum + value, 0) / correctionRates.length)
      : 0;

  return buildOpsMetricsReport({
    filters: {
      days: options.days,
      staleDays: options.staleDays,
      logDir: effectiveLogDir,
    },
    querySuccessRate: round(rate(retrievalRows, (row) => row.status === 'success')),
    emptyResultRate: round(retrievalReport.summary.rates.noSeedRate || 0),
    staleMemoryRate: round(memoryHealth.longTermFreshness.staleRate),
    indexFailureRate: round(rate(executeRows, (row) => row.status === 'failed')),
    correctionRate,
    retrievalLatencyMs: round(retrievalReport.summary.averages.totalMs || 0, 2),
    repos,
    modules: moduleQualityDistribution,
    governance,
  });
}

export function formatOpsMetricsReport(report: OpsMetricsReport): string {
  const lines: string[] = [];
  lines.push('Ops Metrics');
  if (report.filters.days) {
    lines.push(`Window: last ${report.filters.days} day(s)`);
  }
  lines.push('');
  lines.push('Core Metrics:');
  lines.push(`- Query Success Rate: ${Math.round(report.summary.querySuccessRate * 100)}%`);
  lines.push(`- Empty Result Rate: ${Math.round(report.summary.emptyResultRate * 100)}%`);
  lines.push(`- Stale Memory Rate: ${Math.round(report.summary.staleMemoryRate * 100)}%`);
  lines.push(`- Index Failure Rate: ${Math.round(report.summary.indexFailureRate * 100)}%`);
  lines.push(`- Correction Rate: ${Math.round(report.summary.correctionRate * 100)}%`);
  lines.push(`- Retrieval Latency: ${Math.round(report.summary.retrievalLatencyMs)}ms`);
  lines.push('');
  lines.push('Governance:');
  lines.push(
    `- Profile Modes: editable=${report.governance.projectProfileModes.editable}, organization-readonly=${report.governance.projectProfileModes.organizationReadonly}`,
  );
  lines.push(
    `- Shared Memory: editable=${report.governance.sharedMemoryPolicies.editable}, readonly=${report.governance.sharedMemoryPolicies.readonly}, disabled=${report.governance.sharedMemoryPolicies.disabled}`,
  );
  lines.push(
    `- Personal Memory Defaults: project=${report.governance.personalMemoryScopes.project}, global-user=${report.governance.personalMemoryScopes.globalUser}`,
  );
  lines.push(
    `- Long-term Scope Totals: project=${report.governance.longTermMemoryScopes.project}, global-user=${report.governance.longTermMemoryScopes.globalUser}`,
  );
  lines.push('');
  lines.push('Repo Quality Distribution:');
  if (report.repoQualityDistribution.length === 0) {
    lines.push('- No project data');
  } else {
    for (const repo of report.repoQualityDistribution) {
      lines.push(
        `- [${repo.band}] ${repo.projectName} (${repo.projectId}): score=${repo.score}, success=${Math.round(repo.querySuccessRate * 100)}%, empty=${Math.round(repo.emptyResultRate * 100)}%, stale=${Math.round(repo.staleMemoryRate * 100)}%, indexFail=${Math.round(repo.indexFailureRate * 100)}%`,
      );
    }
  }
  lines.push('');
  lines.push('Module Quality Distribution:');
  if (report.moduleQualityDistribution.length === 0) {
    lines.push('- No module data');
  } else {
    for (const module of report.moduleQualityDistribution.slice(0, 20)) {
      lines.push(
        `- [${module.band}] ${module.projectName}/${module.moduleName}: score=${module.score}, review=${module.reviewStatus}, stale=${Math.round(module.staleSignalRate * 100)}%, correction=${Math.round(module.correctionSignalRate * 100)}%`,
      );
    }
  }
  return lines.join('\n');
}
