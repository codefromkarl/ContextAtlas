import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('README top navigation links expose docs index, latest update, and delivery entrypoints', () => {
  const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
  const readmeEn = fs.readFileSync(path.join(REPO_ROOT, 'README.EN.md'), 'utf8');

  const expectedLinks = [
    'docs/README.md',
    'docs/changelog/2026-04-10.md',
    'docs/archive/deliveries/2026-04-09-index-and-memory/delivery-bundle.md',
  ];

  for (const relPath of expectedLinks) {
    assert.match(readme, new RegExp(relPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(readmeEn, new RegExp(relPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.ok(fs.existsSync(path.join(REPO_ROOT, relPath)), `missing linked doc: ${relPath}`);
  }
});
