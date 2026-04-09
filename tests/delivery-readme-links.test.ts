import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('README top navigation links expose update, acceptance, handoff, and delivery entrypoints', () => {
  const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
  const readmeEn = fs.readFileSync(path.join(REPO_ROOT, 'README.EN.md'), 'utf8');

  const expectedLinks = [
    'docs/UPDATE_2026_04_09.md',
    'docs/ITERATION_6_INDEX_AND_MEMORY_ACCEPTANCE_REPORT_2026_04_09.md',
    'docs/HANDOFF_2026_04_09_INDEX_AND_MEMORY.md',
    'docs/DELIVERY_BUNDLE_2026_04_09_INDEX_AND_MEMORY.md',
  ];

  for (const relPath of expectedLinks) {
    assert.match(readme, new RegExp(relPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(readmeEn, new RegExp(relPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.ok(fs.existsSync(path.join(REPO_ROOT, relPath)), `missing linked doc: ${relPath}`);
  }
});
