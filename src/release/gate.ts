import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { buildReleaseSmokePlan, validateSmokeResult, type SmokeStep } from './smoke.js';

export interface ReleaseGateStageResult {
  stage: 'build' | 'test' | 'smoke';
  ok: boolean;
  durationMs: number;
  command: string[];
  failedStep?: string;
  error?: string;
}

export interface ReleaseGateReport {
  ok: boolean;
  stages: ReleaseGateStageResult[];
}

export function runReleaseCommand(command: string[], cwd: string, env?: NodeJS.ProcessEnv) {
  const startedAt = Date.now();
  const result = spawnSync(command[0], command.slice(1), {
    cwd,
    env: { ...process.env, ...(env || {}) },
    encoding: 'utf-8',
  });

  return {
    durationMs: Date.now() - startedAt,
    exitCode: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

export function runReleaseGate(input: {
  repoRoot: string;
  cliEntry: string;
  fixtureRepoPath: string;
  baseEnv?: NodeJS.ProcessEnv;
}): ReleaseGateReport {
  const { repoRoot, cliEntry, fixtureRepoPath, baseEnv } = input;
  const stages: ReleaseGateStageResult[] = [];

  const build = runReleaseCommand(['pnpm', 'build'], repoRoot, baseEnv);
  stages.push({
    stage: 'build',
    ok: build.exitCode === 0,
    durationMs: build.durationMs,
    command: ['pnpm', 'build'],
    error: build.exitCode === 0 ? undefined : build.stderr || build.stdout,
  });
  if (build.exitCode !== 0) return { ok: false, stages };

  const test = runReleaseCommand(['pnpm', 'test'], repoRoot, baseEnv);
  stages.push({
    stage: 'test',
    ok: test.exitCode === 0,
    durationMs: test.durationMs,
    command: ['pnpm', 'test'],
    error: test.exitCode === 0 ? undefined : test.stderr || test.stdout,
  });
  if (test.exitCode !== 0) return { ok: false, stages };

  const smokePlan = buildReleaseSmokePlan({ cliEntry, fixtureRepoPath });
  const smokeStage = runSmokeStage(smokePlan, repoRoot, baseEnv);
  stages.push(smokeStage);

  return {
    ok: stages.every((stage) => stage.ok),
    stages,
  };
}

function runSmokeStage(
  plan: SmokeStep[],
  repoRoot: string,
  baseEnv?: NodeJS.ProcessEnv,
): ReleaseGateStageResult {
  const startedAt = Date.now();

  for (const step of plan) {
    const result = runReleaseCommand(step.command, repoRoot, baseEnv);
    try {
      validateSmokeResult(step, result);
    } catch (error) {
      return {
        stage: 'smoke',
        ok: false,
        durationMs: Date.now() - startedAt,
        command: step.command,
        failedStep: step.name,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {
    stage: 'smoke',
    ok: true,
    durationMs: Date.now() - startedAt,
    command: ['pnpm', 'smoke:release'],
  };
}

export function formatReleaseGateReport(report: ReleaseGateReport): string {
  const lines: string[] = [];
  lines.push('Release Gate Report');
  lines.push(`Status: ${report.ok ? 'PASS' : 'FAIL'}`);
  lines.push('');

  for (const stage of report.stages) {
    lines.push(
      `- ${stage.stage}: ${stage.ok ? 'ok' : 'failed'} (${stage.durationMs}ms)${stage.failedStep ? ` [step=${stage.failedStep}]` : ''}`,
    );
    if (stage.error) {
      lines.push(`  error: ${stage.error}`);
    }
  }

  return lines.join('\n');
}

export function resolveReleasePaths(repoRoot: string, fixtureRepoPath: string) {
  return {
    repoRoot,
    cliEntry: path.join(repoRoot, 'dist', 'index.js'),
    fixtureRepoPath,
  };
}
