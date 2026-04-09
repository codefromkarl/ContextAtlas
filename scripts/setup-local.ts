import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {
  applyLocalSetup,
  formatLocalSetupReport,
  isLocalSetupToolset,
} from '../src/setup/local.ts';

interface CliOptions {
  dryRun: boolean;
  toolset: 'full' | 'retrieval-only';
}

const repoRoot = path.resolve(path.join(import.meta.dirname, '..'));

try {
  const options = parseArgs(process.argv.slice(2));
  ensureBuildIfNeeded(repoRoot, options.dryRun);

  const report = await applyLocalSetup({
    homeDir: os.homedir(),
    repoRoot,
    nodeCommand: process.execPath,
    toolset: options.toolset,
    dryRun: options.dryRun,
  });

  process.stdout.write(`${formatLocalSetupReport(report)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

function parseArgs(argv: string[]): CliOptions {
  let dryRun = false;
  let toolset: 'full' | 'retrieval-only' = 'full';

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      continue;
    }
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--toolset') {
      const value = argv[index + 1];
      if (!value || !isLocalSetupToolset(value)) {
        throw new Error('--toolset requires full or retrieval-only');
      }
      toolset = value;
      index += 1;
      continue;
    }

    throw new Error(`unknown argument: ${arg}`);
  }

  return { dryRun, toolset };
}

function ensureBuildIfNeeded(repoRootPath: string, dryRun: boolean): void {
  const distEntry = path.join(repoRootPath, 'dist', 'index.js');
  if (existsSync(distEntry) || dryRun) {
    return;
  }

  const result = spawnSync('pnpm', ['build'], {
    cwd: repoRootPath,
    stdio: 'inherit',
    env: process.env,
  });

  if (result.status !== 0) {
    throw new Error(`pnpm build failed with exit code ${result.status ?? 1}`);
  }
}
