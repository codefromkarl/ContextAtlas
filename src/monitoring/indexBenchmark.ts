import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateProjectId, initDb } from '../db/index.js';
import { analyzeIndexUpdatePlan } from '../indexing/updateStrategy.js';
import { resolveCurrentSnapshotId } from '../storage/layout.js';
import { scanWithSnapshotSwap, type ScanStats } from '../scanner/index.js';

export type IndexBenchmarkSize = 'small' | 'medium' | 'large';
export type IndexBenchmarkScenario = 'full' | 'incremental' | 'repair' | 'noop';

export interface IndexBenchmarkReport {
  size: IndexBenchmarkSize;
  scenario: IndexBenchmarkScenario;
  vectorIndex: false;
  durationMs: number;
  stats: ScanStats;
  plan?: Awaited<ReturnType<typeof analyzeIndexUpdatePlan>>;
}

const SIZE_TO_FILE_COUNT: Record<IndexBenchmarkSize, number> = {
  small: 12,
  medium: 48,
  large: 120,
};

export function buildBenchmarkMatrix(): Array<{
  size: IndexBenchmarkSize;
  scenario: IndexBenchmarkScenario;
}> {
  const sizes: IndexBenchmarkSize[] = ['small', 'medium', 'large'];
  const scenarios: IndexBenchmarkScenario[] = ['full', 'incremental', 'repair', 'noop'];
  return sizes.flatMap((size) => scenarios.map((scenario) => ({ size, scenario })));
}

function createTempBaseDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cw-index-benchmark-'));
}

function writeSyntheticRepo(repoRoot: string, fileCount: number): void {
  for (let i = 0; i < fileCount; i++) {
    const group = `group-${Math.floor(i / 12)}`;
    const dir = path.join(repoRoot, 'src', group);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `file-${i}.ts`),
      [
        `export function value${i}() {`,
        `  return ${i};`,
        '}',
        '',
        `export const label${i} = 'item-${i}';`,
      ].join('\n'),
    );
  }
}

function mutateRepoForIncremental(repoRoot: string, count: number): void {
  for (let i = 0; i < count; i++) {
    const filePath = path.join(repoRoot, 'src', 'group-0', `file-${i}.ts`);
    fs.writeFileSync(
      filePath,
      [
        `export function value${i}() {`,
        `  return ${i + 1000};`,
        '}',
        '',
        `export const label${i} = 'mutated-${i}';`,
      ].join('\n'),
    );
  }
}

function emptyScanStats(totalFiles: number): ScanStats {
  return {
    totalFiles,
    added: 0,
    modified: 0,
    unchanged: totalFiles,
    deleted: 0,
    skipped: 0,
    errors: 0,
  };
}

export async function runIndexBenchmark(input: {
  size: IndexBenchmarkSize;
  scenario: IndexBenchmarkScenario;
}): Promise<IndexBenchmarkReport> {
  const baseDir = createTempBaseDir();
  const repoRoot = path.join(baseDir, 'repo');
  const previousBaseDir = process.env.CONTEXTATLAS_BASE_DIR;
  fs.mkdirSync(repoRoot, { recursive: true });
  writeSyntheticRepo(repoRoot, SIZE_TO_FILE_COUNT[input.size]);
  process.env.CONTEXTATLAS_BASE_DIR = path.join(baseDir, '.contextatlas');

  try {
    const fileCount = SIZE_TO_FILE_COUNT[input.size];

    if (input.scenario === 'full') {
      const startedAt = Date.now();
      const stats = await scanWithSnapshotSwap(repoRoot, { vectorIndex: false });
      return {
        size: input.size,
        scenario: input.scenario,
        vectorIndex: false,
        durationMs: Date.now() - startedAt,
        stats,
      };
    }

    await scanWithSnapshotSwap(repoRoot, { vectorIndex: false });

    if (input.scenario === 'incremental') {
      mutateRepoForIncremental(repoRoot, Math.min(5, fileCount));
      const startedAt = Date.now();
      const stats = await scanWithSnapshotSwap(repoRoot, { vectorIndex: false });
      return {
        size: input.size,
        scenario: input.scenario,
        vectorIndex: false,
        durationMs: Date.now() - startedAt,
        stats,
      };
    }

    if (input.scenario === 'noop') {
      const startedAt = Date.now();
      const stats = await scanWithSnapshotSwap(repoRoot, { vectorIndex: false });
      return {
        size: input.size,
        scenario: input.scenario,
        vectorIndex: false,
        durationMs: Date.now() - startedAt,
        stats,
      };
    }

    const projectId = generateProjectId(repoRoot);
    const snapshotId = resolveCurrentSnapshotId(projectId);
    const db = initDb(projectId, snapshotId);
    try {
      db.exec('UPDATE files SET vector_index_hash = hash');
      db.prepare('UPDATE files SET vector_index_hash = NULL WHERE path IN (SELECT path FROM files ORDER BY path LIMIT 3)').run();
    } finally {
      db.close();
    }

    const startedAt = Date.now();
    const plan = await analyzeIndexUpdatePlan(repoRoot);
    return {
      size: input.size,
      scenario: input.scenario,
      vectorIndex: false,
      durationMs: Date.now() - startedAt,
      stats: {
        totalFiles: fileCount,
        added: 0,
        modified: 0,
        unchanged: Math.max(0, fileCount - plan.changeSummary.unchangedNeedingVectorRepair),
        deleted: 0,
        skipped: 0,
        errors: 0,
      },
      plan,
    };
  } finally {
    if (previousBaseDir === undefined) {
      delete process.env.CONTEXTATLAS_BASE_DIR;
    } else {
      process.env.CONTEXTATLAS_BASE_DIR = previousBaseDir;
    }
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

export function formatIndexBenchmarkReport(report: IndexBenchmarkReport): string {
  const lines: string[] = [];
  lines.push('Index Benchmark Report');
  lines.push(`Size: ${report.size}`);
  lines.push(`Scenario: ${report.scenario}`);
  lines.push(`Vector Index: ${report.vectorIndex}`);
  lines.push(`Duration: ${report.durationMs} ms`);
  lines.push(
    `Stats: total=${report.stats.totalFiles} added=${report.stats.added} modified=${report.stats.modified} unchanged=${report.stats.unchanged} deleted=${report.stats.deleted}`,
  );
  if (report.plan) {
    lines.push(`Plan Mode: ${report.plan.mode}`);
    lines.push(
      `Plan Summary: repair=${report.plan.changeSummary.unchangedNeedingVectorRepair} added=${report.plan.changeSummary.added} modified=${report.plan.changeSummary.modified} deleted=${report.plan.changeSummary.deleted}`,
    );
  }
  return lines.join('\n');
}

export function formatIndexBenchmarkMatrixReport(reports: IndexBenchmarkReport[]): string {
  const lines = ['Index Benchmark Matrix'];
  for (const report of reports) {
    lines.push(
      `- ${report.size}/${report.scenario}: ${report.durationMs} ms (total=${report.stats.totalFiles})`,
    );
  }
  return lines.join('\n');
}
