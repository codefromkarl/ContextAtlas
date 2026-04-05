import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { generateProjectId, initDb } from '../src/db/index.js';
import { handleCodebaseRetrieval } from '../src/mcp/tools/codebaseRetrieval.js';
import { SearchService } from '../src/search/SearchService.js';

function createTempBaseDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cw-codebase-retrieval-test-'));
}

test('handleCodebaseRetrieval completes success path with combined query telemetry', async () => {
  const baseDir = createTempBaseDir();
  const repoDir = path.join(baseDir, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });

  const previousEnv = {
    CONTEXTATLAS_BASE_DIR: process.env.CONTEXTATLAS_BASE_DIR,
    MCP_AUTO_INDEX: process.env.MCP_AUTO_INDEX,
    EMBEDDINGS_API_KEY: process.env.EMBEDDINGS_API_KEY,
    EMBEDDINGS_BASE_URL: process.env.EMBEDDINGS_BASE_URL,
    EMBEDDINGS_MODEL: process.env.EMBEDDINGS_MODEL,
    RERANK_API_KEY: process.env.RERANK_API_KEY,
    RERANK_BASE_URL: process.env.RERANK_BASE_URL,
    RERANK_MODEL: process.env.RERANK_MODEL,
  };

  process.env.CONTEXTATLAS_BASE_DIR = baseDir;
  process.env.MCP_AUTO_INDEX = 'false';
  process.env.EMBEDDINGS_API_KEY = 'test-key';
  process.env.EMBEDDINGS_BASE_URL = 'http://127.0.0.1/embeddings';
  process.env.EMBEDDINGS_MODEL = 'test-embedding-model';
  process.env.RERANK_API_KEY = 'test-key';
  process.env.RERANK_BASE_URL = 'http://127.0.0.1/rerank';
  process.env.RERANK_MODEL = 'test-rerank-model';

  const projectId = generateProjectId(repoDir);
  const db = initDb(projectId);
  db.close();

  const originalInit = SearchService.prototype.init;
  const originalBuildContextPack = SearchService.prototype.buildContextPack;

  SearchService.prototype.init = async function initMock(): Promise<void> {};
  SearchService.prototype.buildContextPack = (async function buildContextPackMock(
    query,
    _onStage,
    options = {},
  ) {
    assert.equal(query, 'Trace retrieval flow SearchService indexHealth');
    assert.deepEqual(options.technicalTerms, ['SearchService', 'indexHealth']);
    assert.equal(options.semanticQuery, 'Trace retrieval flow');
    assert.equal(options.lexicalQuery, 'SearchService indexHealth');

    return {
      query,
      seeds: [
        {
          filePath: 'src/search/SearchService.ts',
          chunkIndex: 0,
          score: 0.92,
          source: 'vector' as const,
          record: {
            file_path: 'src/search/SearchService.ts',
            chunk_index: 0,
            content: 'export class SearchService {}',
            display_code: 'export class SearchService {}',
            breadcrumb: 'src/search/SearchService.ts',
            language: 'typescript',
            hash: 'h1',
            start_line: 1,
            end_line: 1,
            start_byte: 0,
            end_byte: 30,
            raw_start: 0,
            raw_end: 30,
            _distance: 0.08,
          },
        },
      ],
      expanded: [],
      files: [
        {
          filePath: 'src/search/SearchService.ts',
          segments: [
            {
              filePath: 'src/search/SearchService.ts',
              rawStart: 0,
              rawEnd: 30,
              startLine: 1,
              endLine: 1,
              score: 0.92,
              breadcrumb: 'src/search/SearchService.ts',
              text: 'export class SearchService {}',
            },
          ],
        },
      ],
      debug: {
        wVec: 0.35,
        wLex: 0.65,
        timingMs: {
          retrieve: 1,
          retrieveVector: 1,
          retrieveLexical: 0,
          retrieveFuse: 0,
          rerank: 1,
          smartCutoff: 0,
          expand: 0,
          pack: 0,
        },
        retrievalStats: {
          queryIntent: 'symbol_lookup' as const,
          lexicalStrategy: 'chunks_fts' as const,
          vectorCount: 1,
          lexicalCount: 1,
          fusedCount: 1,
          topMCount: 1,
          rerankInputCount: 1,
          rerankedCount: 1,
        },
        resultStats: {
          seedCount: 1,
          expandedCount: 0,
          fileCount: 1,
          segmentCount: 1,
          totalChars: 29,
          budgetLimitChars: 48000,
          budgetUsedChars: 29,
          budgetExhausted: false,
          filesConsidered: 1,
          filesIncluded: 1,
        },
        rerankUsage: {
          billedSearchUnits: 1,
          inputTokens: 8,
        },
      },
    };
  }) as typeof SearchService.prototype.buildContextPack;

  try {
    const response = await handleCodebaseRetrieval({
      repo_path: repoDir,
      information_request: 'Trace retrieval flow',
      technical_terms: ['SearchService', 'indexHealth'],
    });

    assert.equal(response.content[0].type, 'text');
    assert.match(response.content[0].text, /Found 1 relevant code blocks/);
    assert.match(response.content[0].text, /src\/search\/SearchService\.ts/);
  } finally {
    SearchService.prototype.init = originalInit;
    SearchService.prototype.buildContextPack = originalBuildContextPack;

    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});
