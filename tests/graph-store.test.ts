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

test('GraphStore resolves external relations with same-file, import-scoped, and global fallback tiers', () => {
  const rootPath = makeTempProjectRoot();
  const db = initDb(generateProjectId(rootPath));

  try {
    const store = new GraphStore(db);
    const servicePath = 'src/user/UserService.ts';
    const cryptoPath = 'crypto.ts';
    const globalPath = 'src/shared/global.ts';
    seedIndexedFile(db, servicePath);
    seedIndexedFile(db, cryptoPath);
    seedIndexedFile(db, globalPath);

    store.upsertFile(servicePath, {
      symbols: [
        {
          id: 'typescript:src/user/UserService.ts:root:updatePassword:0:1:4',
          name: 'updatePassword',
          type: 'Function',
          filePath: servicePath,
          language: 'typescript',
          startLine: 1,
          endLine: 4,
          modifiers: [],
          parentId: null,
          exported: true,
        },
        {
          id: 'typescript:src/user/UserService.ts:root:hashLocal:0:6:8',
          name: 'hashLocal',
          type: 'Function',
          filePath: servicePath,
          language: 'typescript',
          startLine: 6,
          endLine: 8,
          modifiers: [],
          parentId: null,
          exported: false,
        },
      ],
      relations: [
        {
          fromId: 'typescript:src/user/UserService.ts:root:updatePassword:0:1:4',
          toId: 'external:typescript:src/user/UserService.ts:call:hashLocal',
          type: 'CALLS',
          confidence: 0.5,
        },
        {
          fromId: 'typescript:src/user/UserService.ts:root:updatePassword:0:1:4',
          toId: 'external:typescript:src/user/UserService.ts:call:hashPassword',
          type: 'CALLS',
          confidence: 0.5,
          reason: './crypto',
        },
        {
          fromId: 'typescript:src/user/UserService.ts:root:updatePassword:0:1:4',
          toId: 'external:typescript:src/user/UserService.ts:call:globalHelper',
          type: 'CALLS',
          confidence: 0.5,
        },
      ],
    });
    store.upsertFile(cryptoPath, {
      symbols: [
        {
          id: 'typescript:crypto.ts:root:hashPassword:0:1:3',
          name: 'hashPassword',
          type: 'Function',
          filePath: cryptoPath,
          language: 'typescript',
          startLine: 1,
          endLine: 3,
          modifiers: ['export'],
          parentId: null,
          exported: true,
        },
      ],
      relations: [],
    });
    store.upsertFile(globalPath, {
      symbols: [
        {
          id: 'typescript:src/shared/global.ts:root:globalHelper:0:1:3',
          name: 'globalHelper',
          type: 'Function',
          filePath: globalPath,
          language: 'typescript',
          startLine: 1,
          endLine: 3,
          modifiers: ['export'],
          parentId: null,
          exported: true,
        },
      ],
      relations: [],
    });

    const direct = store.getDirectRelations('typescript:src/user/UserService.ts:root:updatePassword:0:1:4', 'downstream');
    assert.ok(direct.some((relation) => relation.targetName === 'hashLocal' && relation.reason?.includes('resolution=same-file')));
    assert.ok(direct.some((relation) => relation.targetName === 'hashPassword' && relation.reason?.includes('resolution=import-scoped')));
    assert.ok(direct.some((relation) => relation.targetName === 'globalHelper' && relation.reason?.includes('resolution=global-fallback')));

    const impact = store.getImpact('typescript:src/user/UserService.ts:root:updatePassword:0:1:4', {
      direction: 'downstream',
      maxDepth: 1,
    });
    assert.deepEqual(
      impact.map((entry) => entry.symbol.name).sort(),
      ['globalHelper', 'hashLocal', 'hashPassword'],
    );
  } finally {
    closeDb(db);
    fs.rmSync(rootPath, { recursive: true, force: true });
  }
});

test('GraphStore resolves receiver typed method calls before generic name fallback', () => {
  const rootPath = makeTempProjectRoot();
  const db = initDb(generateProjectId(rootPath));

  try {
    const store = new GraphStore(db);
    const filePath = 'src/user/UserService.ts';
    seedIndexedFile(db, filePath);

    store.upsertFile(filePath, {
      symbols: [
        {
          id: 'typescript:src/user/UserService.ts:root:UserRepo:0:1:5',
          name: 'UserRepo',
          type: 'Class',
          filePath,
          language: 'typescript',
          startLine: 1,
          endLine: 5,
          modifiers: ['export'],
          parentId: null,
          exported: true,
        },
        {
          id: 'typescript:src/user/UserService.ts:UserRepo:save:1:2:4',
          name: 'save',
          type: 'Method',
          filePath,
          language: 'typescript',
          startLine: 2,
          endLine: 4,
          modifiers: [],
          parentId: 'typescript:src/user/UserService.ts:root:UserRepo:0:1:5',
          exported: false,
        },
        {
          id: 'typescript:src/user/UserService.ts:root:AuditLog:0:7:11',
          name: 'AuditLog',
          type: 'Class',
          filePath,
          language: 'typescript',
          startLine: 7,
          endLine: 11,
          modifiers: ['export'],
          parentId: null,
          exported: true,
        },
        {
          id: 'typescript:src/user/UserService.ts:AuditLog:save:1:8:10',
          name: 'save',
          type: 'Method',
          filePath,
          language: 'typescript',
          startLine: 8,
          endLine: 10,
          modifiers: [],
          parentId: 'typescript:src/user/UserService.ts:root:AuditLog:0:7:11',
          exported: false,
        },
        {
          id: 'typescript:src/user/UserService.ts:root:updatePassword:1:13:16',
          name: 'updatePassword',
          type: 'Function',
          filePath,
          language: 'typescript',
          startLine: 13,
          endLine: 16,
          modifiers: [],
          parentId: null,
          exported: true,
        },
      ],
      relations: [
        {
          fromId: 'typescript:src/user/UserService.ts:root:updatePassword:1:13:16',
          toId: 'external:typescript:src/user/UserService.ts:call:save',
          type: 'CALLS',
          confidence: 0.75,
          reason: 'receiver=this.repo;receiverType=UserRepo',
        },
      ],
    });

    const direct = store.getDirectRelations('typescript:src/user/UserService.ts:root:updatePassword:1:13:16', 'downstream');
    assert.ok(
      direct.some(
        (relation) =>
          relation.symbol?.id === 'typescript:src/user/UserService.ts:UserRepo:save:1:2:4'
          && relation.reason?.includes('receiverType=UserRepo')
          && relation.reason?.includes('resolution=same-file'),
      ),
    );
  } finally {
    closeDb(db);
    fs.rmSync(rootPath, { recursive: true, force: true });
  }
});
