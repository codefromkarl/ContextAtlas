import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatReleaseGateReport, resolveReleasePaths, runReleaseGate } from '../src/release/gate.ts';

const repoRoot = path.resolve(path.join(import.meta.dirname, '..'));
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'contextatlas-release-gate-'));
const fixtureRepoPath = path.join(tempRoot, 'repo');
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

try {
  const report = runReleaseGate({
    ...resolveReleasePaths(repoRoot, fixtureRepoPath),
    baseEnv: {
      CONTEXTATLAS_BASE_DIR: path.join(tempRoot, '.contextatlas'),
    },
  });

  process.stdout.write(`${formatReleaseGateReport(report)}\n`);
  if (!report.ok) {
    process.exitCode = 1;
  }
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
