import assert from 'node:assert/strict';
import test from 'node:test';
import { extractChangedFilesFromDiff } from '../src/hooks/postCommitIndexer.ts';

test('extracts changed file paths from git diff --name-status output', () => {
  const diffOutput = `A\tsrc/newFeature.ts
M\tsrc/existingModule.ts
D\tsrc/oldFile.ts
R\tsrc/renamedOld.ts\tsrc/renamedNew.ts
`;
  const files = extractChangedFilesFromDiff(diffOutput);
  assert.deepEqual(files.added, ['src/newFeature.ts']);
  assert.deepEqual(files.modified, ['src/existingModule.ts', 'src/renamedNew.ts']);
  assert.deepEqual(files.deleted, ['src/oldFile.ts']);
  assert.deepEqual(files.renamed, { 'src/renamedOld.ts': 'src/renamedNew.ts' });
});

test('ignores non-code files', () => {
  const diffOutput = `M\tpackage-lock.json
M\tREADME.md
M\tsrc/important.ts
`;
  const files = extractChangedFilesFromDiff(diffOutput);
  assert.deepEqual(files.modified, ['src/important.ts']);
  assert.equal(files.modified.length, 1, 'should only include code files');
});

test('handles empty diff', () => {
  const files = extractChangedFilesFromDiff('');
  assert.deepEqual(files.added, []);
  assert.deepEqual(files.modified, []);
  assert.deepEqual(files.deleted, []);
  assert.deepEqual(files.renamed, {});
});

test('handles diff with only non-code files', () => {
  const diffOutput = `M\tpackage-lock.json
M\t.gitignore
A\tassets/logo.png
`;
  const files = extractChangedFilesFromDiff(diffOutput);
  assert.equal(files.added.length, 0);
  assert.equal(files.modified.length, 0);
  assert.equal(files.deleted.length, 0);
});

test('supports various code file extensions', () => {
  const diffOutput = `A\tsrc/main.rs
M\tlib/parser.py
A\tsrc/App.tsx
M\tcmd/server.go
A\ttests/test.java
`;
  const files = extractChangedFilesFromDiff(diffOutput);
  assert.equal(files.added.length, 3, 'rs, tsx, java');
  assert.equal(files.modified.length, 2, 'py, go');
});

test('ignores lock files even with code-like paths', () => {
  const diffOutput = `M\tCargo.lock
M\tapp/core.ts
M\tyarn.lock
`;
  const files = extractChangedFilesFromDiff(diffOutput);
  assert.deepEqual(files.modified, ['app/core.ts']);
});
