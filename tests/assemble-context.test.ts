import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { handleAssembleContext } from '../src/mcp/tools/assembleContext.ts';
import { MemoryHubDatabase } from '../src/memory/MemoryHubDatabase.ts';
import { MemoryStore } from '../src/memory/MemoryStore.ts';
import { SearchService } from '../src/search/SearchService.ts';

async function withTempProject(
  run: (projectRoot: string, dbPath: string) => Promise<void>,
): Promise<void> {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cw-assemble-context-'));
  const projectRoot = path.join(tempDir, 'project');
  const dbPath = path.join(tempDir, 'memory-hub.db');
  mkdirSync(projectRoot, { recursive: true });

  try {
    await run(projectRoot, dbPath);
  } finally {
    MemoryStore.resetSharedHubForTests();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function buildMemory(name: string, responsibility: string, file: string): Parameters<MemoryStore['saveFeature']>[0] {
  return {
    name,
    responsibility,
    location: {
      dir: 'src/search',
      files: [file],
    },
    api: {
      exports: [name],
      endpoints: [],
    },
    dependencies: {
      imports: ['GraphExpander'],
      external: [],
    },
    dataFlow: `${name} data flow`,
    keyPatterns: [name.toLowerCase(), 'search'],
    lastUpdated: new Date('2026-04-07T10:00:00.000Z').toISOString(),
    confirmationStatus: 'human-confirmed',
  };
}

test('assemble_context combines checkpoint, module memory, and code evidence into json', async () => {
  await withTempProject(async (projectRoot, dbPath) => {
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

    process.env.CONTEXTATLAS_BASE_DIR = path.dirname(projectRoot);
    process.env.MCP_AUTO_INDEX = 'false';
    process.env.EMBEDDINGS_API_KEY = 'test-key';
    process.env.EMBEDDINGS_BASE_URL = 'http://127.0.0.1/embeddings';
    process.env.EMBEDDINGS_MODEL = 'test-embedding-model';
    process.env.RERANK_API_KEY = 'test-key';
    process.env.RERANK_BASE_URL = 'http://127.0.0.1/rerank';
    process.env.RERANK_MODEL = 'test-rerank-model';

    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const { generateProjectId, initDb } = await import('../src/db/index.js');
    const projectId = generateProjectId(projectRoot);
    const db = initDb(projectId);
    db.close();

    const store = new MemoryStore(projectRoot);
    await store.saveFeature(buildMemory('SearchService', 'orchestrates retrieval and packing', 'SearchService.ts'));
    await store.saveCheckpoint({
      id: 'chk_assemble',
      repoPath: projectRoot,
      title: 'Assemble checkpoint',
      goal: 'Trace retrieval flow',
      phase: 'implementation',
      summary: 'Checkpoint for assembly validation',
      activeBlockIds: ['memory:searchservice'],
      exploredRefs: ['src/search/SearchService.ts:L1-L24'],
      keyFindings: ['SearchService is the primary search orchestrator'],
      unresolvedQuestions: ['Should the context include code evidence?'],
      nextSteps: ['Inspect code evidence and memory routes'],
      createdAt: '2026-04-07T10:00:00.000Z',
      updatedAt: '2026-04-07T10:00:00.000Z',
    });

    const { SearchService: SearchServiceJs } = await import('../src/search/SearchService.js');
    const originalInit = SearchService.prototype.init;
    const originalBuildContextPack = SearchService.prototype.buildContextPack;
    const originalInitJs = SearchServiceJs.prototype.init;
    const originalBuildContextPackJs = SearchServiceJs.prototype.buildContextPack;

    const initMock = async function initMock(): Promise<void> {};
    const buildContextPackMock = (async function buildContextPackMock(
      query,
      _onStage,
      options = {},
    ) {
      assert.match(query, /^Trace retrieval flow/);
      assert.match(query, /SearchService/);
      assert.deepEqual(options.technicalTerms, [
        'SearchService',
        'SearchService.ts',
        'Assemble checkpoint',
        'Trace retrieval flow',
      ]);
      assert.equal(options.responseMode, 'expanded');

      return {
        query,
        seeds: [
          {
            filePath: 'src/search/SearchService.ts',
            chunkIndex: 0,
            score: 0.97,
            source: 'vector' as const,
            record: {
              file_path: 'src/search/SearchService.ts',
              chunk_index: 0,
              content: 'export class SearchService {}',
              display_code: 'export class SearchService {}',
              breadcrumb: 'src/search/SearchService.ts',
              language: 'typescript',
              hash: 'chunk-1',
              start_line: 1,
              end_line: 1,
              start_byte: 0,
              end_byte: 29,
              raw_start: 0,
              raw_end: 29,
              _distance: 0.03,
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
                rawEnd: 29,
                startLine: 1,
                endLine: 1,
                score: 0.97,
                breadcrumb: 'src/search/SearchService.ts',
                text: 'export class SearchService {}',
              },
            ],
          },
        ],
        debug: {
          wVec: 0.4,
          wLex: 0.6,
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
        mode: 'expanded' as const,
        expansionCandidates: [],
        nextInspectionSuggestions: ['Inspect GraphExpander'],
      };
    }) as typeof SearchService.prototype.buildContextPack;

    SearchService.prototype.init = initMock;
    SearchService.prototype.buildContextPack = buildContextPackMock;
    SearchServiceJs.prototype.init = initMock;
    SearchServiceJs.prototype.buildContextPack = buildContextPackMock;

    try {
      const response = await handleAssembleContext({
        repo_path: projectRoot,
        phase: 'implementation',
        profile: 'implementation',
        query: 'Trace retrieval flow',
        moduleName: 'SearchService',
        filePaths: ['src/search/SearchService.ts'],
        checkpoint_id: 'chk_assemble',
        format: 'json',
      });

      const payload = JSON.parse(response.content[0].text) as {
        assemblyProfile: { requestedPhase: string; resolvedProfile: string; source: string };
        routing: {
          checkpoint: { checkpointId?: string; loaded: boolean };
          moduleMemory: { selectedCount: number; selectedModules: string[]; maxResults: number } | null;
          codebaseRetrieval: {
            informationRequest: string;
            technicalTerms: string[];
            summary: { codeBlocks: number; files: number; totalSegments: number } | null;
          } | null;
        };
        budget: { selectedContextBlocks: number };
        selectedContext: {
          checkpoint: { checkpoint: { id: string; phase: string } } | null;
          moduleMemories: Array<{ name: string }>;
          codebaseRetrieval: { summary: { codeBlocks: number } } | null;
          contextBlocks: Array<{ id: string; type: string; provenance: Array<{ source: string; ref: string }> }>;
          summary: {
            checkpointBlocks: number;
            moduleMemoryBlocks: number;
            codeBlocks: number;
            totalBlocks: number;
            references: number;
          };
        };
        references: Array<{ blockId: string; source: string; ref: string }>;
        source: {
          checkpoint: { tool: string; checkpointId: string } | null;
          moduleMemory: { tool: string; resultCount: number } | null;
          codebaseRetrieval: { tool: string; summary: { codeBlocks: number } } | null;
        };
      };

      assert.equal(payload.assemblyProfile.requestedPhase, 'implementation');
      assert.equal(payload.assemblyProfile.resolvedProfile, 'implementation');
      assert.equal(payload.assemblyProfile.source, 'profile');
      assert.equal(payload.routing.checkpoint.loaded, true);
      assert.equal(payload.routing.checkpoint.checkpointId, 'chk_assemble');
      assert.equal(payload.routing.moduleMemory?.selectedCount, 1);
      assert.deepEqual(payload.routing.moduleMemory?.selectedModules, ['SearchService']);
      assert.equal(payload.routing.codebaseRetrieval?.informationRequest, 'Trace retrieval flow');
      assert.deepEqual(payload.routing.codebaseRetrieval?.technicalTerms, [
        'SearchService',
        'SearchService.ts',
        'Assemble checkpoint',
        'Trace retrieval flow',
      ]);
      assert.equal(payload.selectedContext.moduleMemories[0]?.name, 'SearchService');
      assert.ok(payload.selectedContext.contextBlocks.some((block) => block.type === 'task-state'));
      assert.ok(payload.selectedContext.contextBlocks.some((block) => block.type === 'module-summary'));
      assert.ok(payload.selectedContext.contextBlocks.some((block) => block.type === 'code-evidence'));
      assert.equal(payload.selectedContext.summary.totalBlocks, payload.selectedContext.contextBlocks.length);
      assert.equal(payload.budget.selectedContextBlocks, payload.selectedContext.contextBlocks.length);
      assert.equal(payload.source.checkpoint?.tool, 'load_checkpoint');
      assert.equal(payload.source.moduleMemory?.tool, 'load_module_memory');
      assert.equal(payload.source.codebaseRetrieval?.tool, 'codebase-retrieval');

      const sources = new Set(payload.references.map((reference) => reference.source));
      assert.ok(sources.has('code'));
      assert.ok(sources.has('feature-memory'));
      assert.ok(sources.has('long-term-memory'));
    } finally {
      SearchService.prototype.init = originalInit;
      SearchService.prototype.buildContextPack = originalBuildContextPack;
      SearchServiceJs.prototype.init = originalInitJs;
      SearchServiceJs.prototype.buildContextPack = originalBuildContextPackJs;

      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});

test('assemble_context maps research phase to the overview assembly profile in text output', async () => {
  await withTempProject(async (projectRoot, dbPath) => {
    process.env.MCP_AUTO_INDEX = 'false';
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const store = new MemoryStore(projectRoot);
    await store.saveFeature(buildMemory('SearchService', 'orchestrates retrieval and packing', 'SearchService.ts'));

    const { SearchService: SearchServiceJs } = await import('../src/search/SearchService.js');
    const originalInit = SearchService.prototype.init;
    const originalBuildContextPack = SearchService.prototype.buildContextPack;
    const originalInitJs = SearchServiceJs.prototype.init;
    const originalBuildContextPackJs = SearchServiceJs.prototype.buildContextPack;

    const initMock = async function initMock(): Promise<void> {};
    const buildContextPackMock = (async function buildContextPackMock(
      query,
      _onStage,
      options = {},
    ) {
      assert.equal(query, 'SearchService');
      assert.deepEqual(options.technicalTerms, ['SearchService']);
      assert.equal(options.responseMode, 'expanded');

      return {
        query,
        seeds: [],
        expanded: [],
        files: [],
        debug: {
          wVec: 0.4,
          wLex: 0.6,
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
            vectorCount: 0,
            lexicalCount: 0,
            fusedCount: 0,
            topMCount: 0,
            rerankInputCount: 0,
            rerankedCount: 0,
          },
          resultStats: {
            seedCount: 0,
            expandedCount: 0,
            fileCount: 0,
            segmentCount: 0,
            totalChars: 0,
            budgetLimitChars: 48000,
            budgetUsedChars: 0,
            budgetExhausted: false,
            filesConsidered: 0,
            filesIncluded: 0,
          },
          rerankUsage: {
            billedSearchUnits: 0,
            inputTokens: 0,
          },
        },
        mode: 'expanded' as const,
        expansionCandidates: [],
        nextInspectionSuggestions: ['Inspect SearchService'],
      };
    }) as typeof SearchService.prototype.buildContextPack;

    SearchService.prototype.init = initMock;
    SearchService.prototype.buildContextPack = buildContextPackMock;
    SearchServiceJs.prototype.init = initMock;
    SearchServiceJs.prototype.buildContextPack = buildContextPackMock;

    try {
      const response = await handleAssembleContext({
        repo_path: projectRoot,
        phase: 'research',
        query: 'SearchService',
        moduleName: 'SearchService',
        format: 'text',
      });

      assert.match(response.content[0].text, /## Context Assembly/);
      assert.match(response.content[0].text, /- \*\*Stage\*\*: research/);
      assert.match(response.content[0].text, /- \*\*Assembly Profile\*\*: overview/);
      assert.match(response.content[0].text, /- \*\*Assembly Source\*\*: phase/);
      assert.match(response.content[0].text, /- \*\*Checkpoint\*\*: None/);
      assert.match(response.content[0].text, /### Selected Context Blocks/);
      assert.match(response.content[0].text, /- \*\*Content\*\*:/);
      assert.match(response.content[0].text, /Responsibility: orchestrates retrieval and packing/);
      assert.match(response.content[0].text, /- \*\*ID\*\*: memory:searchservice/);
      assert.match(response.content[0].text, /- \*\*Type\*\*: module-summary/);
    } finally {
      SearchService.prototype.init = originalInit;
      SearchService.prototype.buildContextPack = originalBuildContextPack;
      SearchServiceJs.prototype.init = originalInitJs;
      SearchServiceJs.prototype.buildContextPack = originalBuildContextPackJs;
    }
  });
});
