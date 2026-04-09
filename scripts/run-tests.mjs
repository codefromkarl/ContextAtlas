#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';

const mode = process.argv[2];

if (mode !== 'source' && mode !== 'dist') {
  console.error('Usage: node scripts/run-tests.mjs <source|dist>');
  process.exit(1);
}

const repoRoot = process.cwd();
const testsDir = path.join(repoRoot, 'tests');
const distTestFiles = new Set([
  'crawler.test.mjs',
  'fts-rebuild.test.ts',
  'mcp-stdio.test.ts',
  'retrieval-monitoring.test.ts',
  'retrieval-optimization.test.ts',
  'usage-tracker.test.ts',
]);

const selectedTests = readdirSync(testsDir)
  .filter((name) => name.endsWith('.test.ts') || name.endsWith('.test.mjs'))
  .sort()
  .filter((name) => (mode === 'dist' ? distTestFiles.has(name) : !distTestFiles.has(name)))
  .map((name) => path.join('tests', name));

if (selectedTests.length === 0) {
  console.error(`No tests selected for mode: ${mode}`);
  process.exit(1);
}

const result = spawnSync('node', ['--import', 'tsx', '--test', ...selectedTests], {
  cwd: repoRoot,
  env: process.env,
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
