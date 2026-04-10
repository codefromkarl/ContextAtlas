import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { batchUpsert, closeDb, generateProjectId, initDb } from '../src/db/index.ts';
import { GraphStore } from '../src/graph/GraphStore.ts';
import { GraphExpander } from '../src/search/GraphExpander.ts';
import type { SearchConfig, ScoredChunk } from '../src/search/types.ts';
import type { GraphWritePayload } from '../src/graph/types.ts';
import type { ChunkRecord } from '../src/vectorStore/index.ts';

function makeTempProjectRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cw-graph-expander-'));
}

function createConfig(): SearchConfig {
  return {
    vectorTopK: 5,
    vectorTopM: 5,
    ftsTopKFiles: 5,
    lexChunksPerFile: 2,
    lexTotalChunks: 5,
    rrfK0: 60,
    wVec: 1,
    wLex: 1,
    fusedTopM: 5,
    rerankTopN: 5,
    rerankMinPool: 2,
    rerankMaxPool: 8,
    rerankPoolScoreRatio: 0.5,
    maxRerankChars: 400,
    maxBreadcrumbChars: 120,
    headRatio: 0.6,
    neighborHops: 1,
    breadcrumbExpandLimit: 2,
    importFilesPerSeed: 2,
    chunksPerImportFile: 2,
    decayNeighbor: 0.8,
    decayBreadcrumb: 0.75,
    decayImport: 0.7,
    decayDepth: 0.5,
    maxSegmentsPerFile: 4,
    maxTotalChars: 4000,
    maxContextBlocks: 8,
    enableSmartTopK: true,
    smartTopScoreRatio: 0.5,
    smartTopScoreDeltaAbs: 0.25,
    smartMinScore: 0.2,
    smartMinK: 2,
    smartMaxK: 8,
  };
}

function createChunkRecord(filePath: string, chunkIndex: number, breadcrumb: string): ChunkRecord {
  return {
    chunk_id: `${filePath}#hash#${chunkIndex}`,
    file_path: filePath,
    file_hash: 'hash',
    chunk_index: chunkIndex,
    vector: [0, 0, 0],
    display_code: `code-${chunkIndex}`,
    language: 'typescript',
    breadcrumb,
    start_index: chunkIndex * 10,
    end_index: chunkIndex * 10 + 5,
    raw_start: chunkIndex * 10,
    raw_end: chunkIndex * 10 + 5,
    vec_start: chunkIndex * 10,
    vec_end: chunkIndex * 10 + 5,
  };
}

function createSeed(filePath: string, breadcrumb: string): ScoredChunk {
  const record = createChunkRecord(filePath, 0, breadcrumb);
  return {
    filePath,
    chunkIndex: 0,
    score: 0.9,
    source: 'vector',
    record: { ...record, _distance: 0 },
  };
}

function createGraphPayload(filePath: string, targetFilePath: string): GraphWritePayload {
  return {
    symbols: [
      {
        id: `typescript:${filePath}:UserService:1`,
        name: 'UserService',
        type: 'Class',
        filePath,
        language: 'typescript',
        startLine: 1,
        endLine: 10,
        modifiers: ['export'],
        parentId: null,
        exported: true,
      },
      {
        id: `typescript:${targetFilePath}:HashService:1`,
        name: 'HashService',
        type: 'Class',
        filePath: targetFilePath,
        language: 'typescript',
        startLine: 1,
        endLine: 10,
        modifiers: ['export'],
        parentId: null,
        exported: true,
      },
    ],
    relations: [
      {
        fromId: `typescript:${filePath}:UserService:1`,
        toId: `typescript:${targetFilePath}:HashService:1`,
        type: 'CALLS',
        confidence: 1,
      },
    ],
  };
}

test('GraphExpander prefers graph relations before import text fallback', async () => {
  const rootPath = makeTempProjectRoot();
  const projectId = generateProjectId(rootPath);
  const db = initDb(projectId);

  try {
    const sourcePath = 'src/user/UserService.ts';
    const targetPath = 'src/security/HashService.ts';
    batchUpsert(db, [
      {
        path: sourcePath,
        hash: 'hash-user',
        mtime: 1,
        size: 80,
        content: 'export class UserService {}',
        language: 'typescript',
        vectorIndexHash: null,
      },
      {
        path: targetPath,
        hash: 'hash-hash',
        mtime: 1,
        size: 80,
        content: 'export class HashService {}',
        language: 'typescript',
        vectorIndexHash: null,
      },
    ]);

    const store = new GraphStore(db);
    store.upsertFile(sourcePath, createGraphPayload(sourcePath, targetPath));

    const targetChunk = createChunkRecord(targetPath, 0, `${targetPath} > class HashService`);
    const fakeVectorStore = {
      getFileChunks: async (filePath: string) => (filePath === targetPath ? [targetChunk] : []),
      getFilesChunks: async (_filePaths: string[]) => new Map<string, ChunkRecord[]>(),
    };

    const expander = new GraphExpander(projectId, createConfig());
    (expander as { db: unknown }).db = db;
    (expander as { vectorStore: unknown }).vectorStore = fakeVectorStore;
    (expander as { allFilePaths: unknown }).allFilePaths = new Set([sourcePath, targetPath]);

    const expanded = await expander.expand([createSeed(sourcePath, `${sourcePath} > class UserService`)]);
    assert.ok(expanded.chunks.some((chunk) => chunk.filePath === targetPath));
    assert.ok(expanded.nextInspectionSuggestions.some((item) => item.includes(targetPath)));
  } finally {
    closeDb(db);
    fs.rmSync(rootPath, { recursive: true, force: true });
  }
});
