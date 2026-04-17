import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { batchUpsert, closeDb, generateProjectId, initDb } from '../src/db/index.ts';
import { GraphStore } from '../src/graph/GraphStore.ts';
import type { GraphWritePayload } from '../src/graph/types.ts';

function makeTempProjectRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cw-graph-store-'));
}

function createUserGraphPayload(filePath: string): GraphWritePayload {
  return {
    symbols: [
      {
        id: `typescript:${filePath}:UserService:1`,
        name: 'UserService',
        type: 'Class',
        filePath,
        language: 'typescript',
        startLine: 1,
        endLine: 30,
        modifiers: ['export'],
        parentId: null,
        exported: true,
      },
      {
        id: `typescript:${filePath}:updatePassword:10`,
        name: 'updatePassword',
        type: 'Method',
        filePath,
        language: 'typescript',
        startLine: 10,
        endLine: 20,
        modifiers: ['public'],
        parentId: `typescript:${filePath}:UserService:1`,
        exported: false,
      },
      {
        id: `typescript:${filePath}:hashPassword:40`,
        name: 'hashPassword',
        type: 'Function',
        filePath,
        language: 'typescript',
        startLine: 40,
        endLine: 50,
        modifiers: [],
        parentId: null,
        exported: false,
      },
    ],
    relations: [
      {
        fromId: `typescript:${filePath}:UserService:1`,
        toId: `typescript:${filePath}:updatePassword:10`,
        type: 'HAS_METHOD',
        confidence: 1,
      },
      {
        fromId: `typescript:${filePath}:updatePassword:10`,
        toId: `typescript:${filePath}:hashPassword:40`,
        type: 'CALLS',
        confidence: 1,
      },
    ],
    invocations: [
      {
        id: `typescript:${filePath}:updatePassword:10:call:hashPassword:11`,
        filePath,
        enclosingSymbolId: `typescript:${filePath}:updatePassword:10`,
        calleeName: 'hashPassword',
        resolvedTargetId: `typescript:${filePath}:call:hashPassword`,
        startLine: 11,
        endLine: 11,
      },
    ],
  };
}

function seedIndexedFile(db: ReturnType<typeof initDb>, filePath: string): void {
  batchUpsert(db, [
    {
      path: filePath,
      hash: 'hash-user-service',
      mtime: 1,
      size: 128,
      content: 'export class UserService {}',
      language: 'typescript',
      vectorIndexHash: null,
    },
  ]);
}

test('GraphStore persists symbols, supports lookup, and traverses downstream impact', () => {
  const rootPath = makeTempProjectRoot();
  const db = initDb(generateProjectId(rootPath));

  try {
    const store = new GraphStore(db);
    const filePath = 'src/user/UserService.ts';
    seedIndexedFile(db, filePath);
    store.upsertFile(filePath, createUserGraphPayload(filePath));

    const matches = store.findSymbolsByName('UserService');
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.filePath, filePath);
    assert.deepEqual(matches[0]?.modifiers, ['export']);

    const searchMatches = store.searchSymbols('UserService');
    assert.equal(searchMatches.length, 1);
    assert.equal(searchMatches[0]?.name, 'UserService');

    const impact = store.getImpact(matches[0]!.id, { direction: 'downstream', maxDepth: 2 });
    assert.equal(impact.length, 2);
    assert.equal(impact[0]?.symbol.name, 'updatePassword');
    assert.equal(impact[0]?.viaRelationType, 'HAS_METHOD');
    assert.equal(impact[1]?.symbol.name, 'hashPassword');
    assert.equal(impact[1]?.depth, 2);

    const invocationRow = db.prepare(
      'SELECT callee_name, enclosing_symbol_id FROM invocations WHERE file_path = ?',
    ).get(filePath) as { callee_name: string; enclosing_symbol_id: string | null } | undefined;
    assert.equal(invocationRow?.callee_name, 'hashPassword');
    assert.match(invocationRow?.enclosing_symbol_id ?? '', /updatePassword/);
  } finally {
    closeDb(db);
    fs.rmSync(rootPath, { recursive: true, force: true });
  }
});

test('GraphStore deleteFile removes file symbols and attached relations', () => {
  const rootPath = makeTempProjectRoot();
  const db = initDb(generateProjectId(rootPath));

  try {
    const store = new GraphStore(db);
    const filePath = 'src/user/UserService.ts';
    seedIndexedFile(db, filePath);
    store.upsertFile(filePath, createUserGraphPayload(filePath));

    store.deleteFile(filePath);

    assert.equal(store.findSymbolsByName('UserService').length, 0);
    assert.equal(store.searchSymbols('UserService').length, 0);
    const relationRow = db.prepare('SELECT COUNT(*) AS count FROM relations').get() as
      | { count: number }
      | undefined;
    assert.equal(relationRow?.count ?? -1, 0);
    const invocationRow = db.prepare('SELECT COUNT(*) AS count FROM invocations').get() as
      | { count: number }
      | undefined;
    assert.equal(invocationRow?.count ?? -1, 0);
  } finally {
    closeDb(db);
    fs.rmSync(rootPath, { recursive: true, force: true });
  }
});
