import type { AlertEvaluationResult } from './alertEngine.js';
import type { IndexHealthReport } from './indexHealth.js';
import { formatIndexHealthReport } from './indexHealth.js';
import type { MemoryHealthReport } from './memoryHealth.js';
import { formatMemoryHealthReport } from './memoryHealth.js';
import { formatAlertReport } from './alertEngine.js';

export function buildHealthFullReport(input: {
  indexHealth: IndexHealthReport;
  memoryHealth: MemoryHealthReport;
  alerts: AlertEvaluationResult;
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

      const issues: string[] = [];
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
      } else if (
        snapshot.vectorChunkCount > 0 &&
        snapshot.chunkFtsCoverage !== null &&
        snapshot.chunkFtsCoverage < 0.95
      ) {
        issues.push('degraded-chunk-fts-coverage');
      }
      if (memoryScore && memoryScore.issues.length > 0) {
        issues.push(...memoryScore.issues);
      }

      if (issues.length > 0) {
        lines.push(`  issues: ${issues.join(', ')}`);
      }
    }
  }

  lines.push('');
  lines.push(formatIndexHealthReport(input.indexHealth));
  lines.push('');
  lines.push(formatMemoryHealthReport(input.memoryHealth));
  lines.push('');
  lines.push(formatAlertReport(input.alerts));
  return lines.join('\n');
}
