import type { AlertEvaluationResult } from './alertEngine.js';
import type { IndexHealthReport } from './indexHealth.js';
import { formatIndexHealthReport } from './indexHealth.js';
import type { MemoryHealthReport } from './memoryHealth.js';
import { formatMemoryHealthReport } from './memoryHealth.js';
import type { McpProcessHealthReport } from './mcpProcessHealth.js';
import { formatMcpProcessHealthReport } from './mcpProcessHealth.js';
import { formatAlertReport } from './alertEngine.js';
import type { GraphHealthReport } from './graphHealth.js';
import { formatGraphHealthReport } from './graphHealth.js';
import type { ContractHealthReport } from '../analysis/contractAnalysis.js';

export function collectProjectOperationalIssues(input: {
  snapshot: IndexHealthReport['snapshots'][number];
  memoryIssues?: string[];
}): string[] {
  const issues: string[] = [];
  const { snapshot, memoryIssues = [] } = input;

  if (!snapshot.hasCurrentSnapshot) issues.push('missing-current-snapshot');
  if (snapshot.dbIntegrity === 'corrupted') issues.push('corrupted-db');
  if (snapshot.hasIndexDb && !snapshot.hasVectorIndex && snapshot.fileCount > 0) {
    issues.push('missing-vector-index');
  }
  if (
    snapshot.vectorChunkCount > 0 &&
    (!snapshot.hasChunksFts || snapshot.chunkFtsCount === 0)
  ) {
    issues.push('missing-chunk-fts');
  }
  if (
    snapshot.vectorChunkCount > 0 &&
    snapshot.chunkFtsCoverage !== null &&
    snapshot.chunkFtsCoverage < 0.95
  ) {
    issues.push('degraded-chunk-fts-coverage');
  }

  issues.push(...memoryIssues);
  return issues.filter((issue, index, array) => array.indexOf(issue) === index);
}

function formatStrategySummaryLine(
  strategySummary: NonNullable<IndexHealthReport['snapshots'][number]['strategySummary']>,
): string {
  const triggers =
    strategySummary.signals.fullRebuildTriggers.length > 0
      ? ` triggers=${strategySummary.signals.fullRebuildTriggers.join(',')}`
      : '';
  return `Strategy: ${strategySummary.mode} (changed=${strategySummary.signals.changedFiles}, churn=${(strategySummary.signals.churnRatio * 100).toFixed(1)}%, cost=${(strategySummary.signals.incrementalCostRatio * 100).toFixed(1)}%)${triggers}`;
}

export function buildAlertEvaluationMetrics(input: {
  indexHealth: IndexHealthReport;
  memoryHealth: MemoryHealthReport;
  mcpProcessHealth?: McpProcessHealthReport;
  graphHealth?: GraphHealthReport;
  contractHealth?: ContractHealthReport;
}): Record<string, unknown> {
  return {
    ...input.indexHealth,
    memory: {
      staleRate: input.memoryHealth.longTermFreshness.staleRate,
      expiredRate: input.memoryHealth.longTermFreshness.expiredRate,
      orphanedRate: input.memoryHealth.featureMemoryHealth.orphanedRate,
      catalogInconsistent: !input.memoryHealth.catalogConsistency.isConsistent,
    },
    ...(input.mcpProcessHealth
      ? {
          mcp: {
            duplicateCount: input.mcpProcessHealth.duplicateCount,
          },
        }
      : {}),
    ...(input.graphHealth
      ? {
          graph: {
            status: input.graphHealth.overall.status,
            unresolvedRatio: input.graphHealth.unresolvedRatio,
            symbols: input.graphHealth.totals.symbols,
            relations: input.graphHealth.totals.relations,
          },
        }
      : {}),
    ...(input.contractHealth
      ? {
          contract: {
            status: input.contractHealth.status,
            routeCount: input.contractHealth.routeCount,
            toolCount: input.contractHealth.toolCount,
            mismatchCount: input.contractHealth.mismatchCount,
          },
        }
      : {}),
  };
}

export function buildHealthFullReport(input: {
  indexHealth: IndexHealthReport;
  memoryHealth: MemoryHealthReport;
  alerts: AlertEvaluationResult;
  mcpProcessHealth?: McpProcessHealthReport;
  graphHealth?: GraphHealthReport;
  contractHealth?: ContractHealthReport;
}): string {
  const lines: string[] = [];
  lines.push('='.repeat(60));
  lines.push('Full System Health Report');
  lines.push('='.repeat(60));
  lines.push('');
  lines.push('Per-Project Summary');

  if (input.indexHealth.snapshots.length === 0) {
    lines.push('- No indexed projects');
  } else {
    for (const snapshot of input.indexHealth.snapshots) {
      const memoryScore = input.memoryHealth.projectScores.find(
        (project) => project.projectId === snapshot.projectId,
      );
      const ftsCoverage =
        snapshot.chunkFtsCoverage !== null
          ? `${(snapshot.chunkFtsCoverage * 100).toFixed(1)}%`
          : 'n/a';
      lines.push(
        `- ${snapshot.projectId}: snapshot=${snapshot.currentSnapshotId || 'none'} latest=${snapshot.lastSuccessfulScope || 'unknown'} @ ${snapshot.lastSuccessfulAt || 'n/a'} | FTS=${ftsCoverage} | Memory Score=${memoryScore?.freshnessScore ?? 'n/a'}`,
      );
      if (snapshot.strategySummary) {
        lines.push(`  ${formatStrategySummaryLine(snapshot.strategySummary)}`);
      }

      const issues = collectProjectOperationalIssues({
        snapshot,
        memoryIssues: memoryScore?.issues || [],
      });

      if (issues.length > 0) {
        lines.push(`  issues: ${issues.join(', ')}`);
      }
    }
  }

  lines.push('');
  lines.push(formatIndexHealthReport(input.indexHealth));
  lines.push('');
  lines.push(formatMemoryHealthReport(input.memoryHealth));
  if (input.mcpProcessHealth) {
    lines.push('');
    lines.push(formatMcpProcessHealthReport(input.mcpProcessHealth));
  }
  if (input.graphHealth) {
    lines.push('');
    lines.push(formatGraphHealthReport(input.graphHealth));
  }
  if (input.contractHealth) {
    lines.push('');
    lines.push('Contract Health');
    lines.push(`Status: ${input.contractHealth.status.toUpperCase()}`);
    lines.push(`Routes: ${input.contractHealth.routeCount}`);
    lines.push(`Route Consumers: ${input.contractHealth.routeConsumerCount}`);
    lines.push(`Tools: ${input.contractHealth.toolCount}`);
    lines.push(`Mapped Tools: ${input.contractHealth.mappedToolCount}`);
    lines.push(`Mismatches: ${input.contractHealth.mismatchCount}`);
    if (input.contractHealth.issues.length > 0) {
      lines.push('Issues:');
      input.contractHealth.issues.forEach((issue) => lines.push(`- ${issue}`));
    }
  }
  lines.push('');
  lines.push(formatAlertReport(input.alerts));
  return lines.join('\n');
}
