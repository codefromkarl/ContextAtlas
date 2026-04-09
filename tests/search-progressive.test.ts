import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import test from 'node:test';
import { generateProjectId, initDb } from '../src/db/index.js';
import { ContextPacker } from '../src/search/ContextPacker.ts';
import { HybridRecallEngine } from '../src/search/HybridRecallEngine.ts';
import { SearchService } from '../src/search/SearchService.ts';

function createChunk(filePath: string, chunkIndex: number, start: number, end: number, score = 0.9) {
  return {
    filePath,
    chunkIndex,
    score,
    source: 'vector' as const,
    record: {
      file_path: filePath,
      chunk_index: chunkIndex,
      content: `chunk-${chunkIndex}`,
      display_code: `chunk-${chunkIndex}`,
      breadcrumb: `${filePath} > chunk ${chunkIndex}`,
      language: 'typescript',
      hash: `hash-${chunkIndex}`,
      start_line: chunkIndex + 1,
      end_line: chunkIndex + 1,
      start_byte: start,
      end_byte: end,
      raw_start: start,
      raw_end: end,
      _distance: 0.1,
    },
  };
}

test('buildContextPack respects responseMode and carries progressive retrieval metadata', async () => {
  const seed = createChunk('src/search/SearchService.ts', 0, 0, 10, 0.95);
  const expanded = createChunk('src/search/GraphExpander.ts', 1, 11, 25, 0.7);
  const service = new SearchService('proj', process.cwd(), undefined, undefined, {
    callbacksFactory: () => ({
      rerank: async (_query: string, candidates: unknown[]) => ({
        chunks: candidates,
        inputCount: candidates.length,
      }),
      expand: async () => ({
        chunks: [expanded],
        explorationCandidates: [
          {
            filePath: 'src/search/GraphExpander.ts',
            source: 'import',
            reason: 'expanded via import',
            priority: 'high',
          },
        ],
        nextInspectionSuggestions: ['Inspect src/search/GraphExpander.ts (expanded via import)'],
      }),
    }),
  });
  const originalPackWithStats = ContextPacker.prototype.packWithStats;
  const originalHybridRetrieve = HybridRecallEngine.prototype.hybridRetrieve;
  const packedChunkCounts: number[] = [];

  try {
    ContextPacker.prototype.packWithStats = async function packWithStatsStub(chunks) {
      packedChunkCounts.push(chunks.length);
      return {
        files: chunks.length
          ? [
              {
                filePath: chunks[0].filePath,
                segments: [],
              },
            ]
          : [],
        stats: {
          segmentCount: chunks.length,
          totalChars: chunks.length * 10,
          budgetLimitChars: 48000,
          budgetUsedChars: chunks.length * 10,
          budgetExhausted: false,
          blockBudgetLimit: 12,
          blockBudgetUsed: chunks.length,
          blockBudgetExhausted: false,
          filesConsidered: chunks.length ? 1 : 0,
          filesIncluded: chunks.length ? 1 : 0,
        },
      };
    };

    HybridRecallEngine.prototype.hybridRetrieve = async function hybridRetrieveStub() {
      return {
        chunks: [seed],
        stats: {
          lexicalStrategy: 'chunks_fts' as const,
          vectorCount: 1,
          lexicalCount: 0,
          fusedCount: 1,
        },
        timingMs: {
          retrieveVector: 1,
          retrieveLexical: 0,
          retrieveFuse: 0,
        },
      };
    };
    const overview = await service.buildContextPack('trace retrieval flow', undefined, {
      responseMode: 'overview',
    });
    const expandedResult = await service.buildContextPack('trace retrieval flow', undefined, {
      responseMode: 'expanded',
    });

    assert.deepEqual(packedChunkCounts, [1, 2]);
    assert.equal(overview.mode, 'overview');
    assert.equal(expandedResult.mode, 'expanded');
    assert.equal(expandedResult.expansionCandidates?.[0]?.filePath, 'src/search/GraphExpander.ts');
    assert.equal(expandedResult.nextInspectionSuggestions?.[0], 'Inspect src/search/GraphExpander.ts (expanded via import)');
    assert.equal(expandedResult.debug?.resultStats?.blockBudgetLimit, 12);
    assert.equal(expandedResult.debug?.resultStats?.blockBudgetUsed, 2);
    assert.equal(expandedResult.debug?.resultStats?.blockBudgetExhausted, false);
  } finally {
    ContextPacker.prototype.packWithStats = originalPackWithStats;
    HybridRecallEngine.prototype.hybridRetrieve = originalHybridRetrieve;
  }
});

test('ContextPacker enforces block budget in addition to character budget', async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cw-context-packer-'));
  const repoDir = path.join(tempDir, 'repo');
  const projectId = generateProjectId(repoDir);
  const db = initDb(projectId);
  const filePath = 'src/search/SearchService.ts';
  const content = 'aaaaa\nbbbbb\nccccc\n';

  db.prepare(
    'INSERT OR REPLACE INTO files (path, hash, mtime, size, content, language) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(filePath, 'hash', Date.now(), content.length, content, 'typescript');
  db.close();

  try {
    const packer = new ContextPacker(
      projectId,
      {
        vectorTopK: 10,
        vectorTopM: 10,
        ftsTopKFiles: 10,
        lexChunksPerFile: 2,
        lexTotalChunks: 10,
        rrfK0: 20,
        wVec: 0.6,
        wLex: 0.4,
        fusedTopM: 10,
        rerankTopN: 5,
        rerankMinPool: 5,
        rerankMaxPool: 10,
        rerankPoolScoreRatio: 0.6,
        maxRerankChars: 500,
        maxBreadcrumbChars: 100,
        headRatio: 0.67,
        neighborHops: 1,
        breadcrumbExpandLimit: 1,
        importFilesPerSeed: 0,
        chunksPerImportFile: 0,
        decayNeighbor: 0.8,
        decayBreadcrumb: 0.7,
        decayImport: 0.6,
        decayDepth: 0.7,
        maxSegmentsPerFile: 3,
        maxTotalChars: 1000,
        maxContextBlocks: 2,
        enableSmartTopK: true,
        smartTopScoreRatio: 0.5,
        smartTopScoreDeltaAbs: 0.25,
        smartMinScore: 0.25,
        smartMinK: 2,
        smartMaxK: 8,
      },
      null,
    );

    const result = await packer.packWithStats([
      createChunk(filePath, 0, 0, 5, 0.95),
      createChunk(filePath, 1, 6, 11, 0.9),
      createChunk(filePath, 2, 12, 17, 0.85),
    ]);

    assert.equal(result.stats.segmentCount, 2);
    assert.equal(result.stats.blockBudgetLimit, 2);
    assert.equal(result.stats.blockBudgetUsed, 2);
    assert.equal(result.stats.blockBudgetExhausted, true);
    assert.equal(result.files[0]?.segments.length, 2);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
