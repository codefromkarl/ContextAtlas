import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildReleaseSmokePlan, validateSmokeResult } from '../src/release/smoke.ts';

const repoRoot = path.resolve(path.join(import.meta.dirname, '..'));
const cliEntry = path.join(repoRoot, 'dist', 'index.js');
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'contextatlas-release-smoke-'));
const fixtureRepoPath = path.join(tempRoot, 'repo');
const baseDir = path.join(tempRoot, '.contextatlas');
mkdirSync(path.join(fixtureRepoPath, 'src', 'smoke'), { recursive: true });
writeFileSync(
  path.join(fixtureRepoPath, 'src', 'smoke', 'auth.ts'),
  [
    'export async function smokeLogin() {',
    "  return 'ok';",
    '}',
    '',
    'export async function smokeIssueToken() {',
    "  return 'token';",
    '}',
  ].join('\n'),
);

const plan = buildReleaseSmokePlan({ cliEntry, fixtureRepoPath });

try {
  for (const step of plan) {
    const result = spawnSync(step.command[0], step.command.slice(1), {
      cwd: repoRoot,
      env: {
        ...process.env,
        CONTEXTATLAS_BASE_DIR: baseDir,
      },
      encoding: 'utf-8',
    });

    validateSmokeResult(step, {
      exitCode: result.status ?? 1,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    });

    process.stdout.write(`[smoke] ${step.name}: ok\n`);
  }
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
