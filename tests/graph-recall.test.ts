import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { batchUpsert, closeDb, generateProjectId, initDb } from '../src/db/index.ts';
import { GraphStore } from '../src/graph/GraphStore.ts';
import { retrieveGraphChunks } from '../src/search/GraphRecall.ts';
import type { GraphWritePayload } from '../src/graph/types.ts';

function makeTempProjectRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cw-graph-recall-'));
}

function createPayloads() {
  const serviceFile = 'src/user/UserService.ts';
  const cryptoFile = 'src/user/crypto.ts';

  const servicePayload: GraphWritePayload = {
    symbols: [
      {
        id: `typescript:${serviceFile}:UserService:1`,
        name: 'UserService',
        type: 'Class',
        filePath: serviceFile,
        language: 'typescript',
        startLine: 1,
        endLine: 6,
        modifiers: [],
        parentId: null,
        exported: true,
      },
      {
        id: `typescript:${serviceFile}:updatePassword:2`,
        name: 'updatePassword',
        type: 'Method',
        filePath: serviceFile,
        language: 'typescript',
        startLine: 2,
        endLine: 4,
        modifiers: [],
        parentId: `typescript:${serviceFile}:UserService:1`,
        exported: false,
      },
    ],
    relations: [
      {
        fromId: `typescript:${serviceFile}:UserService:1`,
        toId: `typescript:${cryptoFile}:hashPassword:1`,
        type: 'IMPORTS',
        confidence: 1,
      },
      {
        fromId: `typescript:${serviceFile}:updatePassword:2`,
        toId: `typescript:${cryptoFile}:hashPassword:1`,
        type: 'CALLS',
        confidence: 1,
      },
    ],
    unresolvedRefs: [],
  };

  const cryptoPayload: GraphWritePayload = {
    symbols: [
      {
        id: `typescript:${cryptoFile}:hashPassword:1`,
        name: 'hashPassword',
        type: 'Function',
        filePath: cryptoFile,
        language: 'typescript',
        startLine: 1,
        endLine: 3,
        modifiers: [],
        parentId: null,
        exported: true,
      },
    ],
    relations: [],
    unresolvedRefs: [],
  };

  return { serviceFile, cryptoFile, servicePayload, cryptoPayload };
}

test('retrieveGraphChunks 返回命中符号文件与直接关系文件的 graph candidates', async () => {
  const root = makeTempProjectRoot();
  const projectId = generateProjectId(root);
  const db = initDb(projectId);
  const { serviceFile, cryptoFile, servicePayload, cryptoPayload } = createPayloads();

  batchUpsert(db, [
    {
      path: serviceFile,
      hash: 'hash-service',
      mtime: 1,
      size: 120,
      content: 'export class UserService { updatePassword() { return hashPassword(); } }',
      language: 'typescript',
      vectorIndexHash: null,
    },
    {
      path: cryptoFile,
      hash: 'hash-crypto',
      mtime: 1,
      size: 80,
      content: 'export function hashPassword() { return "x"; }',
      language: 'typescript',
      vectorIndexHash: null,
    },
  ]);

  const store = new GraphStore(db);
  store.upsertFile(serviceFile, servicePayload);
  store.upsertFile(cryptoFile, cryptoPayload);

  const chunks = await retrieveGraphChunks({
    db,
    vectorStore: {
      getFilesChunks: async () => new Map([
        [serviceFile, [{
          chunk_id: `${serviceFile}#0`,
          file_path: serviceFile,
          file_hash: 'hash-service',
          chunk_index: 0,
          vector: [0.1],
          display_code: 'export class UserService { updatePassword() { return hashPassword(); } }',
          language: 'typescript',
          breadcrumb: 'src/user/UserService.ts > class UserService > method updatePassword',
          start_index: 0,
          end_index: 60,
          raw_start: 0,
          raw_end: 60,
          vec_start: 0,
          vec_end: 60,
        }]],
        [cryptoFile, [{
          chunk_id: `${cryptoFile}#0`,
          file_path: cryptoFile,
          file_hash: 'hash-crypto',
          chunk_index: 0,
          vector: [0.2],
          display_code: 'export function hashPassword() { return "x"; }',
          language: 'typescript',
          breadcrumb: 'src/user/crypto.ts > function hashPassword',
          start_index: 0,
          end_index: 40,
          raw_start: 0,
          raw_end: 40,
          vec_start: 0,
          vec_end: 40,
        }]],
      ]),
    } as never,
    query: 'updatePassword UserService hashPassword',
    config: {
      enableGraphRecall: true,
      graphRecallTopSymbols: 6,
      graphRecallChunksPerFile: 1,
    },
  });

  assert.deepEqual(
    new Set(chunks.map((chunk) => chunk.filePath)),
    new Set([serviceFile, cryptoFile]),
  );
  assert.ok(chunks.every((chunk) => chunk.source === 'graph'));

  closeDb(db);
});

test('retrieveGraphChunks can pull caller file via stored invocations even without CALLS relation', async () => {
  const root = makeTempProjectRoot();
  const projectId = generateProjectId(root);
  const db = initDb(projectId);
  const serviceFile = 'src/user/UserService.ts';
  const cryptoFile = 'src/user/crypto.ts';

  batchUpsert(db, [
    {
      path: serviceFile,
      hash: 'hash-service',
      mtime: 1,
      size: 120,
      content: 'export class UserService { updatePassword() { return hashPassword(); } }',
      language: 'typescript',
      vectorIndexHash: null,
    },
    {
      path: cryptoFile,
      hash: 'hash-crypto',
      mtime: 1,
      size: 80,
      content: 'export function hashPassword() { return \"x\"; }',
      language: 'typescript',
      vectorIndexHash: null,
    },
  ]);

  const store = new GraphStore(db);
  store.upsertFile(serviceFile, {
    symbols: [
      {
        id: `typescript:${serviceFile}:UserService:1`,
        name: 'UserService',
        type: 'Class',
        filePath: serviceFile,
        language: 'typescript',
        startLine: 1,
        endLine: 5,
        modifiers: [],
        parentId: null,
        exported: true,
      },
      {
        id: `typescript:${serviceFile}:updatePassword:2`,
        name: 'updatePassword',
        type: 'Method',
        filePath: serviceFile,
        language: 'typescript',
        startLine: 2,
        endLine: 4,
        modifiers: [],
        parentId: `typescript:${serviceFile}:UserService:1`,
        exported: false,
      },
    ],
    relations: [],
    invocations: [
      {
        id: `typescript:${serviceFile}:updatePassword:2:call:hashPassword:3`,
        filePath: serviceFile,
        enclosingSymbolId: `typescript:${serviceFile}:updatePassword:2`,
        calleeName: 'hashPassword',
        resolvedTargetId: `typescript:${cryptoFile}:hashPassword:1`,
        startLine: 3,
        endLine: 3,
      },
    ],
    unresolvedRefs: [],
  });
  store.upsertFile(cryptoFile, {
    symbols: [
      {
        id: `typescript:${cryptoFile}:hashPassword:1`,
        name: 'hashPassword',
        type: 'Function',
        filePath: cryptoFile,
        language: 'typescript',
        startLine: 1,
        endLine: 3,
        modifiers: [],
        parentId: null,
        exported: true,
      },
    ],
    relations: [],
    invocations: [],
    unresolvedRefs: [],
  });

  const chunks = await retrieveGraphChunks({
    db,
    vectorStore: {
      getFilesChunks: async () => new Map([
        [serviceFile, [{
          chunk_id: `${serviceFile}#0`,
          file_path: serviceFile,
          file_hash: 'hash-service',
          chunk_index: 0,
          vector: [0.1],
          display_code: 'export class UserService { updatePassword() { return hashPassword(); } }',
          language: 'typescript',
          breadcrumb: 'src/user/UserService.ts > class UserService > method updatePassword',
          start_index: 0,
          end_index: 60,
          raw_start: 0,
          raw_end: 60,
          vec_start: 0,
          vec_end: 60,
        }]],
        [cryptoFile, [{
          chunk_id: `${cryptoFile}#0`,
          file_path: cryptoFile,
          file_hash: 'hash-crypto',
          chunk_index: 0,
          vector: [0.2],
          display_code: 'export function hashPassword() { return \"x\"; }',
          language: 'typescript',
          breadcrumb: 'src/user/crypto.ts > function hashPassword',
          start_index: 0,
          end_index: 40,
          raw_start: 0,
          raw_end: 40,
          vec_start: 0,
          vec_end: 40,
        }]],
      ]),
    } as never,
    query: 'hashPassword',
    config: {
      enableGraphRecall: true,
      graphRecallTopSymbols: 6,
      graphRecallChunksPerFile: 1,
    },
  });

  assert.ok(chunks.some((chunk) => chunk.filePath === cryptoFile));
  assert.ok(chunks.some((chunk) => chunk.filePath === serviceFile));

  closeDb(db);
});
