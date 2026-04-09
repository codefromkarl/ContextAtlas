import assert from 'node:assert/strict';
import test from 'node:test';
import { ContextPacker } from '../src/search/ContextPacker.ts';
import { HybridRecallEngine } from '../src/search/HybridRecallEngine.ts';
import { SearchService } from '../src/search/SearchService.ts';

function createChunk(score = 0.9) {
  return {
    filePath: 'src/search/SearchService.ts',
    chunkIndex: 0,
    score,
    source: 'vector' as const,
    record: {
      file_path: 'src/search/SearchService.ts',
      chunk_index: 0,
      content: 'export class SearchService {}',
      display_code: 'export class SearchService {}',
      breadcrumb: 'src/search/SearchService.ts > SearchService',
      language: 'typescript',
      hash: 'hash',
      start_line: 1,
      end_line: 1,
      start_byte: 0,
      end_byte: 30,
      raw_start: 0,
      raw_end: 30,
      _distance: 0.1,
    },
  };
}

test('buildContextPack 并发执行时不会让 query-aware config 互相串扰', async () => {
  const service = new SearchService('proj', process.cwd());
  const originalPackWithStats = ContextPacker.prototype.packWithStats;
  const originalHybridRetrieve = HybridRecallEngine.prototype.hybridRetrieve;
  const blockedChunk = createChunk(0.95);
  const normalChunk = createChunk(0.8);

  let releaseFirst: (() => void) | null = null;
  const firstRetrieveGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  try {
    ContextPacker.prototype.packWithStats = async function packWithStatsStub(chunks) {
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
          segmentCount: 0,
          totalChars: 0,
          budgetLimitChars: 48000,
          budgetUsedChars: 0,
          budgetExhausted: false,
          filesConsidered: chunks.length ? 1 : 0,
          filesIncluded: chunks.length ? 1 : 0,
        },
      };
    };

    HybridRecallEngine.prototype.hybridRetrieve = async function hybridRetrieveStub(
      semanticQuery: string,
    ) {
      if (semanticQuery === 'SearchService buildContextPack') {
        await firstRetrieveGate;
        return {
          chunks: [blockedChunk],
          stats: {
            lexicalStrategy: 'chunks_fts',
            vectorCount: 1,
            lexicalCount: 1,
            fusedCount: 1,
          },
          timingMs: {
            retrieveVector: 1,
            retrieveLexical: 1,
            retrieveFuse: 1,
          },
        };
      }

      return {
        chunks: [normalChunk],
        stats: {
          lexicalStrategy: 'chunks_fts',
          vectorCount: 1,
          lexicalCount: 1,
          fusedCount: 1,
        },
        timingMs: {
          retrieveVector: 1,
          retrieveLexical: 1,
          retrieveFuse: 1,
        },
      };
    };
    (service as any).rerank = async (_query: string, candidates: unknown[]) => ({
      chunks: candidates,
      inputCount: candidates.length,
    });
    (service as any).expand = async () => [];

    const firstCall = service.buildContextPack('SearchService buildContextPack', undefined, {
      technicalTerms: ['SearchService'],
    });

    await new Promise((resolve) => setImmediate(resolve));

    const secondResult = await service.buildContextPack('authentication retry safeguards');

    assert.equal(secondResult.debug?.retrievalStats?.queryIntent, 'balanced');
    assert.equal(secondResult.debug?.wVec, 0.6);
    assert.equal(secondResult.debug?.wLex, 0.4);

    releaseFirst?.();
    await firstCall;
  } finally {
    ContextPacker.prototype.packWithStats = originalPackWithStats;
    HybridRecallEngine.prototype.hybridRetrieve = originalHybridRetrieve;
  }
});
