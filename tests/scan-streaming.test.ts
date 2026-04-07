import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { FileMeta } from '../src/db/index.ts';
import {
  mergeScanStats,
  scan,
  summarizeProcessResults,
  type ScanStats,
} from '../src/scanner/index.ts';
import type { ProcessResult } from '../src/scanner/processor.ts';

function makeResult(
  overrides: Partial<ProcessResult> & Pick<ProcessResult, 'relPath' | 'status'>,
): ProcessResult {
  return {
    absPath: `/tmp/${overrides.relPath}`,
    relPath: overrides.relPath,
    hash: overrides.hash ?? `${overrides.relPath}-hash`,
    content: overrides.content ?? 'export const value = 1;\n',
    chunks: overrides.chunks ?? [],
    language: overrides.language ?? 'typescript',
    mtime: overrides.mtime ?? 1,
    size: overrides.size ?? 24,
    status: overrides.status,
    error: overrides.error,
  };
}

test('summarizeProcessResults 为单批结果生成持久化变更与统计', () => {
  const results: ProcessResult[] = [
    makeResult({ relPath: 'src/added.ts', status: 'added' }),
    makeResult({ relPath: 'src/changed.ts', status: 'modified', hash: 'changed-hash' }),
    makeResult({
      relPath: 'src/keep.ts',
      status: 'unchanged',
      hash: 'keep-hash',
      mtime: 42,
      content: null,
    }),
    makeResult({
      relPath: 'src/skip.ts',
      status: 'skipped',
      content: null,
      error: 'too large',
    }),
    makeResult({
      relPath: 'src/error.ts',
      status: 'error',
      content: null,
      error: 'read failed',
    }),
  ];

  const summary = summarizeProcessResults(results);

  assert.equal(summary.added, 1);
  assert.equal(summary.modified, 1);
  assert.equal(summary.unchanged, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.errors, 1);
  assert.deepEqual(
    summary.toAdd.map((item: FileMeta) => ({ path: item.path, hash: item.hash })),
    [
      { path: 'src/added.ts', hash: 'src/added.ts-hash' },
      { path: 'src/changed.ts', hash: 'changed-hash' },
    ],
  );
  assert.deepEqual(summary.toUpdateMtime, [{ path: 'src/keep.ts', mtime: 42 }]);
});

test('mergeScanStats 会累计多批扫描与向量统计', () => {
  const base: ScanStats = {
    totalFiles: 4,
    added: 1,
    modified: 0,
    unchanged: 1,
    deleted: 2,
    skipped: 0,
    errors: 0,
    vectorIndex: {
      indexed: 1,
      deleted: 0,
      errors: 0,
    },
  };

  const merged = mergeScanStats(base, {
    added: 2,
    modified: 3,
    unchanged: 4,
    deleted: 0,
    skipped: 1,
    errors: 2,
    vectorIndex: {
      indexed: 5,
      deleted: 1,
      errors: 3,
    },
  });

  assert.equal(merged.totalFiles, 4);
  assert.equal(merged.added, 3);
  assert.equal(merged.modified, 3);
  assert.equal(merged.unchanged, 5);
  assert.equal(merged.deleted, 2);
  assert.equal(merged.skipped, 1);
  assert.equal(merged.errors, 2);
  assert.deepEqual(merged.vectorIndex, {
    indexed: 6,
    deleted: 1,
    errors: 3,
  });
});

test('scan 在跨多个处理批次时仍返回正确统计', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-scan-stream-'));

  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  for (let i = 0; i < 205; i++) {
    fs.writeFileSync(
      path.join(root, 'src', `file-${i}.ts`),
      `export const value${i} = ${i};\n`,
    );
  }

  const first = await scan(root, { vectorIndex: false });
  assert.equal(first.totalFiles, 205);
  assert.equal(first.added, 205);
  assert.equal(first.modified, 0);
  assert.equal(first.deleted, 0);

  fs.rmSync(path.join(root, 'src', 'file-0.ts'));
  fs.rmSync(path.join(root, 'src', 'file-1.ts'));
  fs.rmSync(path.join(root, 'src', 'file-2.ts'));
  fs.writeFileSync(path.join(root, 'src', 'file-3.ts'), 'export const value3 = 300;\n');
  fs.writeFileSync(path.join(root, 'src', 'file-4.ts'), 'export const value4 = 400;\n');

  const second = await scan(root, { vectorIndex: false });
  assert.equal(second.totalFiles, 202);
  assert.equal(second.added, 0);
  assert.equal(second.modified, 2);
  assert.equal(second.deleted, 3);
  assert.equal(second.unchanged, 200);
});
