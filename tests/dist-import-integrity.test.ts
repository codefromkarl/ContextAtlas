import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST_DIR = path.join(REPO_ROOT, 'dist');

function collectDistJsFiles(dirPath: string): string[] {
  return fs.readdirSync(dirPath)
    .filter((name) => name.endsWith('.js'))
    .sort()
    .map((name) => path.join(dirPath, name));
}

function collectRelativeJsImports(filePath: string): string[] {
  const source = fs.readFileSync(filePath, 'utf8');
  const refs = new Set<string>();
  const pattern = /(?:from\s+|import\()(['"])(\.\/[^'"]+?\.js)\1/g;

  for (const match of source.matchAll(pattern)) {
    refs.add(match[2]);
  }

  return Array.from(refs);
}

test('dist 产物中的相对 js import 目标都存在', () => {
  const distFiles = collectDistJsFiles(DIST_DIR);
  assert.ok(distFiles.length > 0, 'dist 目录中没有可检查的 js 产物');

  const missingRefs: string[] = [];

  for (const filePath of distFiles) {
    for (const ref of collectRelativeJsImports(filePath)) {
      const resolved = path.resolve(path.dirname(filePath), ref);
      if (!fs.existsSync(resolved)) {
        missingRefs.push(`${path.basename(filePath)} -> ${ref}`);
      }
    }
  }

  assert.deepEqual(missingRefs, []);
});
