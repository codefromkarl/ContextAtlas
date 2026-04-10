import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { closeDb, generateProjectId, initDb } from '../src/db/index.ts';
import { ExecutionTracer } from '../src/graph/ExecutionTracer.ts';
import { GraphStore } from '../src/graph/GraphStore.ts';
import type { GraphWritePayload } from '../src/graph/types.ts';

function makeTempProjectRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cw-execution-tracer-'));
}

function seedIndexedFile(db: ReturnType<typeof initDb>, filePath: string): void {
  db.prepare(
    `
      INSERT OR REPLACE INTO files(path, hash, mtime, size, content, language, vector_index_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(filePath, 'hash', 1, 64, 'export class UserService {}', 'typescript', null);
}

function buildPayload(filePath: string): GraphWritePayload {
  return {
    symbols: [
      {
        id: `typescript:${filePath}:UserService:1`,
        name: 'UserService',
        type: 'Class',
        filePath,
        language: 'typescript',
        startLine: 1,
        endLine: 20,
        modifiers: ['export'],
        parentId: null,
        exported: true,
      },
      {
        id: `typescript:${filePath}:updatePassword:2`,
        name: 'updatePassword',
        type: 'Method',
        filePath,
        language: 'typescript',
        startLine: 2,
        endLine: 8,
        modifiers: [],
        parentId: `typescript:${filePath}:UserService:1`,
        exported: false,
      },
      {
        id: `typescript:${filePath}:hashLocal:10`,
        name: 'hashLocal',
        type: 'Function',
        filePath,
        language: 'typescript',
        startLine: 10,
        endLine: 12,
        modifiers: [],
        parentId: null,
        exported: false,
      },
    ],
    relations: [
      {
        fromId: `typescript:${filePath}:UserService:1`,
        toId: `typescript:${filePath}:updatePassword:2`,
        type: 'HAS_METHOD',
        confidence: 1,
      },
      {
        fromId: `typescript:${filePath}:updatePassword:2`,
        toId: `typescript:${filePath}:hashLocal:10`,
        type: 'CALLS',
        confidence: 1,
      },
    ],
  };
}

test('ExecutionTracer traces downstream paths across resolved relations', () => {
  const rootPath = makeTempProjectRoot();
  const db = initDb(generateProjectId(rootPath));

  try {
    const filePath = 'src/user/UserService.ts';
    seedIndexedFile(db, filePath);
    const store = new GraphStore(db);
    store.upsertFile(filePath, buildPayload(filePath));

    const traced = new ExecutionTracer(store).traceFromSymbol('UserService', {
      direction: 'downstream',
      maxDepth: 3,
    });

    assert.ok(traced);
    assert.equal(traced?.paths.length, 1);
    assert.deepEqual(
      traced?.paths[0]?.symbols.map((symbol) => symbol.name),
      ['UserService', 'updatePassword', 'hashLocal'],
    );
    assert.deepEqual(traced?.paths[0]?.relationTypes, ['HAS_METHOD', 'CALLS']);
  } finally {
    closeDb(db);
    fs.rmSync(rootPath, { recursive: true, force: true });
  }
});
