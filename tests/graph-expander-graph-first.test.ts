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
    enableSkeletonRecall: false,
    skeletonTopKFiles: 6,
    skeletonChunksPerFile: 2,
    enableGraphRecall: false,
    graphRecallTopSymbols: 6,
    graphRecallChunksPerFile: 1,
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
      getFilesChunks: async (filePaths: string[]) => {
        const map = new Map<string, ChunkRecord[]>();
        for (const fp of filePaths) {
          if (fp === targetPath) map.set(fp, [targetChunk]);
        }
        return map;
      },
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

test('GraphExpander prioritizes import candidates ahead of lower-value neighbor candidates', async () => {
  const rootPath = makeTempProjectRoot();
  const projectId = generateProjectId(rootPath);
  const db = initDb(projectId);

  try {
    const sourcePath = 'src/index.ts';
    const importTarget = 'src/cli/registerCommands.ts';
    const neighborPath = 'src/cli/commands/bootstrap.ts';
    batchUpsert(db, [
      {
        path: sourcePath,
        hash: 'hash-index',
        mtime: 1,
        size: 120,
        content: "import { registerCliCommands } from './cli/registerCommands.js';",
        language: 'typescript',
        vectorIndexHash: null,
      },
      {
        path: importTarget,
        hash: 'hash-register',
        mtime: 1,
        size: 90,
        content: 'export function registerCliCommands() {}',
        language: 'typescript',
        vectorIndexHash: null,
      },
      {
        path: neighborPath,
        hash: 'hash-bootstrap',
        mtime: 1,
        size: 90,
        content: 'export function registerBootstrapCommands() {}',
        language: 'typescript',
        vectorIndexHash: null,
      },
    ]);

    const sourceChunks = [
      createChunkRecord(sourcePath, 0, `${sourcePath} > prelude`),
      createChunkRecord(sourcePath, 1, `${sourcePath} > cli registration`),
      createChunkRecord(sourcePath, 2, `${sourcePath} > startup`),
    ];
    const importChunk = createChunkRecord(importTarget, 0, `${importTarget} > registerCliCommands`);
    const neighborChunk = createChunkRecord(neighborPath, 0, `${neighborPath} > registerBootstrapCommands`);

    const fakeVectorStore = {
      getFileChunks: async (filePath: string) => {
        if (filePath === sourcePath) return sourceChunks;
        if (filePath === importTarget) return [importChunk];
        if (filePath === neighborPath) return [neighborChunk];
        return [];
      },
      getFilesChunks: async (filePaths: string[]) => {
        const map = new Map<string, ChunkRecord[]>();
        for (const fp of filePaths) {
          if (fp === sourcePath) map.set(fp, sourceChunks);
          if (fp === importTarget) map.set(fp, [importChunk]);
          if (fp === neighborPath) map.set(fp, [neighborChunk]);
        }
        return map;
      },
    };

    const expander = new GraphExpander(projectId, createConfig());
    (expander as { db: unknown }).db = db;
    (expander as { vectorStore: unknown }).vectorStore = fakeVectorStore;
    (expander as { allFilePaths: unknown }).allFilePaths = new Set([sourcePath, importTarget, neighborPath]);

    const expanded = await expander.expand([createSeed(sourcePath, `${sourcePath} > cli registration`)]);

    assert.equal(expanded.explorationCandidates[0]?.filePath, importTarget);
    assert.equal(expanded.explorationCandidates[0]?.priority, 'high');
  } finally {
    closeDb(db);
    fs.rmSync(rootPath, { recursive: true, force: true });
  }
});

test('GraphExpander prioritizes query-relevant import candidates within import exploration results', async () => {
  const rootPath = makeTempProjectRoot();
  const projectId = generateProjectId(rootPath);
  const db = initDb(projectId);

  try {
    const sourcePath = 'src/index.ts';
    const registerTarget = 'src/cli/registerCommands.ts';
    const genericTarget = 'src/runtimePaths.ts';
    batchUpsert(db, [
      {
        path: sourcePath,
        hash: 'hash-index',
        mtime: 1,
        size: 180,
        content: "import { registerCliCommands } from './cli/registerCommands.js';\nimport { resolveBaseDir } from './runtimePaths.js';",
        language: 'typescript',
        vectorIndexHash: null,
      },
      {
        path: registerTarget,
        hash: 'hash-register',
        mtime: 1,
        size: 90,
        content: 'export function registerCliCommands() {}',
        language: 'typescript',
        vectorIndexHash: null,
      },
      {
        path: genericTarget,
        hash: 'hash-runtime',
        mtime: 1,
        size: 90,
        content: 'export function resolveBaseDir() {}',
        language: 'typescript',
        vectorIndexHash: null,
      },
    ]);

    const registerChunk = createChunkRecord(registerTarget, 0, `${registerTarget} > registerCliCommands`);
    const runtimeChunk = createChunkRecord(genericTarget, 0, `${genericTarget} > resolveBaseDir`);
    const fakeVectorStore = {
      getFilesChunks: async (filePaths: string[]) => {
        const map = new Map<string, ChunkRecord[]>();
        for (const fp of filePaths) {
          if (fp === registerTarget) map.set(fp, [registerChunk]);
          if (fp === genericTarget) map.set(fp, [runtimeChunk]);
        }
        return map;
      },
    };

    const expander = new GraphExpander(projectId, createConfig());
    (expander as { db: unknown }).db = db;
    (expander as { vectorStore: unknown }).vectorStore = fakeVectorStore;
    (expander as { allFilePaths: unknown }).allFilePaths = new Set([sourcePath, registerTarget, genericTarget]);

    const expanded = await expander.expand(
      [createSeed(sourcePath, `${sourcePath} > registerCliCommands`)],
      new Set(['cli', 'command', 'registration', 'entrypoint']),
    );

    assert.ok(expanded.explorationCandidates.length >= 2);
    assert.equal(expanded.explorationCandidates[0]?.filePath, registerTarget);
    assert.equal(expanded.explorationCandidates[1]?.filePath, genericTarget);
  } finally {
    closeDb(db);
    fs.rmSync(rootPath, { recursive: true, force: true });
  }
});
