import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { batchUpsert, closeDb, generateProjectId, initDb } from '../src/db/index.ts';
import { buildFallbackFileSkeleton, buildSkeletonPayload } from '../src/graph/SkeletonBuilder.ts';
import { SkeletonStore } from '../src/graph/SkeletonStore.ts';
import type { GraphWritePayload } from '../src/graph/types.ts';

function makeTempProjectRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cw-skeleton-store-'));
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
      {
        id: `typescript:${filePath}:boot:4`,
        name: 'boot',
        type: 'Method',
        filePath,
        language: 'typescript',
        startLine: 4,
        endLine: 10,
        modifiers: [],
        parentId: `typescript:${filePath}:GatewayService:1`,
        exported: false,
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
    invocations: [
      {
        id: `typescript:${filePath}:boot:4:call:createServer:5`,
        filePath,
        enclosingSymbolId: `typescript:${filePath}:boot:4`,
        calleeName: 'createServer',
        resolvedTargetId: null,
        startLine: 5,
        endLine: 5,
      },
    ],
    unresolvedRefs: ['./server:createServer'],
  };
}

test('SkeletonStore upsertFile 持久化 file/symbol skeleton 与 FTS', () => {
  const root = makeTempProjectRoot();
  const filePath = 'src/gateway/service.ts';
  const db = initDb(generateProjectId(root));

  batchUpsert(db, [{
    path: filePath,
    hash: 'hash-1',
    mtime: 1,
    size: 120,
    content: 'export class GatewayService {}',
    language: 'typescript',
    vectorIndexHash: null,
  }]);

  const payload = buildSkeletonPayload({
    filePath,
    language: 'typescript',
    graph: createGraphPayload(filePath),
  });

  new SkeletonStore(db).upsertFile(filePath, payload);

  const fileRow = db.prepare('SELECT summary, exports, top_symbols FROM file_skeleton WHERE path = ?').get(filePath) as {
    summary: string;
    exports: string;
    top_symbols: string;
  };
  assert.match(fileRow.summary, /exports GatewayService/);
  assert.match(fileRow.summary, /imports \.\/server/);
  assert.match(fileRow.summary, /call names/);
  assert.deepEqual(JSON.parse(fileRow.exports), ['GatewayService']);
  assert.deepEqual(JSON.parse(fileRow.top_symbols), ['Class GatewayService']);

  const symbolRow = db.prepare(
    'SELECT signature, parent_name, exported FROM symbol_skeleton WHERE symbol_id = ?',
  ).get(`typescript:${filePath}:boot:4`) as { signature: string; parent_name: string | null; exported: number };
  assert.equal(symbolRow.signature, 'Method GatewayService.boot');
  assert.equal(symbolRow.parent_name, 'GatewayService');
  assert.equal(symbolRow.exported, 0);

  const ftsRow = db.prepare(
    "SELECT rowid FROM symbol_skeleton_fts WHERE symbol_skeleton_fts MATCH 'GatewayService'",
  ).get() as { rowid: number } | undefined;
  assert.ok(ftsRow);

  closeDb(db);
});

test('buildFallbackFileSkeleton 为 symbol-less entrypoint 文件生成 role hints', () => {
  const payload = buildFallbackFileSkeleton({
    filePath: 'src/index.ts',
    language: 'typescript',
    content: [
      "import { registerCliCommands } from './cli/registerCommands.js';",
      "import { isMcpMode } from './config.js';",
      'registerCliCommands(cli);',
      'cli.parse();',
    ].join('\n'),
  });

  assert.match(payload.file.summary, /role hints .*entrypoint/);
  assert.match(payload.file.summary, /role hints .*cli/);
  assert.match(payload.file.summary, /role hints .*mcp/);
  assert.match(payload.file.summary, /role hints .*command registration/);
});
