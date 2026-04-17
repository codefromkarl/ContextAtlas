import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { batchUpsert, closeDb, generateProjectId, initDb } from '../src/db/index.ts';
import { buildSkeletonPayload } from '../src/graph/SkeletonBuilder.ts';
import { SkeletonStore } from '../src/graph/SkeletonStore.ts';
import { retrieveSkeletonChunks } from '../src/search/SkeletonRecall.ts';
import type { GraphWritePayload } from '../src/graph/types.ts';

function makeTempProjectRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cw-skeleton-recall-'));
}

function createGraphPayload(filePath: string): GraphWritePayload {
  return {
    symbols: [
      {
        id: `typescript:${filePath}:GatewayService:1`,
        name: 'GatewayService',
        type: 'Class',
        filePath,
        language: 'typescript',
        startLine: 1,
        endLine: 20,
        modifiers: [],
        parentId: null,
        exported: true,
      },
    ],
    relations: [
      {
        fromId: `typescript:${filePath}:GatewayService:1`,
        toId: `external:typescript:${filePath}:import:./server:createServer`,
        type: 'IMPORTS',
        confidence: 0.6,
        reason: './server',
      },
    ],
    unresolvedRefs: ['./server:createServer'],
  };
}

test('retrieveSkeletonChunks 基于 skeleton FTS 返回结构候选 chunk', async () => {
  const root = makeTempProjectRoot();
  const projectId = generateProjectId(root);
  const filePath = 'src/gateway/service.ts';
  const db = initDb(projectId);

  batchUpsert(db, [{
    path: filePath,
    hash: 'hash-1',
    mtime: 1,
    size: 120,
    content: 'export class GatewayService {}',
    language: 'typescript',
    vectorIndexHash: null,
  }]);
  new SkeletonStore(db).upsertFile(filePath, buildSkeletonPayload({
    filePath,
    language: 'typescript',
    graph: createGraphPayload(filePath),
  }));

  const chunks = await retrieveSkeletonChunks({
    db,
    vectorStore: {
      getFilesChunks: async () => new Map([
        [filePath, [{
          chunk_id: `${filePath}#hash-1#0`,
          file_path: filePath,
          file_hash: 'hash-1',
          chunk_index: 0,
          vector: [0.1],
          display_code: 'export class GatewayService {}',
          language: 'typescript',
          breadcrumb: 'src/gateway/service.ts > class GatewayService',
          start_index: 0,
          end_index: 30,
          raw_start: 0,
          raw_end: 30,
          vec_start: 0,
          vec_end: 30,
        }]],
      ]),
    } as never,
    query: 'gateway service startup architecture',
    queryTokens: new Set(['gateway', 'service', 'startup']),
    config: {
      enableSkeletonRecall: true,
      skeletonTopKFiles: 5,
      skeletonChunksPerFile: 1,
    },
  });

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].source, 'skeleton');
  assert.equal(chunks[0].filePath, filePath);

  closeDb(db);
});
