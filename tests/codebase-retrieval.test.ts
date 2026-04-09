import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { generateProjectId, initDb } from '../src/db/index.js';
import { getActiveTask } from '../src/indexing/queue.js';
import { handleCodebaseRetrieval } from '../src/mcp/tools/codebaseRetrieval.js';
import { MemoryStore } from '../src/memory/MemoryStore.js';
import { scan } from '../src/scanner/index.js';
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
    assert.equal(options.responseMode, 'expanded');

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
      mode: 'expanded' as const,
      expansionCandidates: [],
      nextInspectionSuggestions: [],
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

test('handleCodebaseRetrieval annotates retrieval-stage fetch failures', async () => {
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
    _query,
    onStage,
  ) {
    onStage?.('retrieve');
    throw new TypeError('fetch failed');
  }) as typeof SearchService.prototype.buildContextPack;

  try {
    await assert.rejects(
      () =>
        handleCodebaseRetrieval({
          repo_path: repoDir,
          information_request: 'SearchService retrieval flow',
        }),
      /retrieve stage failed: fetch failed/,
    );
  } finally {
    SearchService.prototype.init = originalInit;
    SearchService.prototype.buildContextPack = originalBuildContextPack;
    if (previousEnv.CONTEXTATLAS_BASE_DIR === undefined) {
      delete process.env.CONTEXTATLAS_BASE_DIR;
    } else {
      process.env.CONTEXTATLAS_BASE_DIR = previousEnv.CONTEXTATLAS_BASE_DIR;
    }
    if (previousEnv.MCP_AUTO_INDEX === undefined) {
      delete process.env.MCP_AUTO_INDEX;
    } else {
      process.env.MCP_AUTO_INDEX = previousEnv.MCP_AUTO_INDEX;
    }
    if (previousEnv.EMBEDDINGS_API_KEY === undefined) {
      delete process.env.EMBEDDINGS_API_KEY;
    } else {
      process.env.EMBEDDINGS_API_KEY = previousEnv.EMBEDDINGS_API_KEY;
    }
    if (previousEnv.EMBEDDINGS_BASE_URL === undefined) {
      delete process.env.EMBEDDINGS_BASE_URL;
    } else {
      process.env.EMBEDDINGS_BASE_URL = previousEnv.EMBEDDINGS_BASE_URL;
    }
    if (previousEnv.EMBEDDINGS_MODEL === undefined) {
      delete process.env.EMBEDDINGS_MODEL;
    } else {
      process.env.EMBEDDINGS_MODEL = previousEnv.EMBEDDINGS_MODEL;
    }
    if (previousEnv.RERANK_API_KEY === undefined) {
      delete process.env.RERANK_API_KEY;
    } else {
      process.env.RERANK_API_KEY = previousEnv.RERANK_API_KEY;
    }
    if (previousEnv.RERANK_BASE_URL === undefined) {
      delete process.env.RERANK_BASE_URL;
    } else {
      process.env.RERANK_BASE_URL = previousEnv.RERANK_BASE_URL;
    }
    if (previousEnv.RERANK_MODEL === undefined) {
      delete process.env.RERANK_MODEL;
    } else {
      process.env.RERANK_MODEL = previousEnv.RERANK_MODEL;
    }
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('handleCodebaseRetrieval formats default result card with memory and decision context', async () => {
  const baseDir = createTempBaseDir();
  const repoDir = path.join(baseDir, 'repo');
  fs.mkdirSync(path.join(repoDir, 'src', 'search'), { recursive: true });
  fs.writeFileSync(
    path.join(repoDir, 'src', 'search', 'SearchService.ts'),
    'export class SearchService {}',
  );

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

  const store = new MemoryStore(repoDir);
  await store.saveFeature({
    name: 'SearchService',
    responsibility: '协调混合检索、精排和上下文打包',
    location: {
      dir: 'src/search',
      files: ['SearchService.ts'],
    },
    api: {
      exports: ['SearchService'],
      endpoints: [],
    },
    dependencies: {
      imports: ['GraphExpander', 'ContextPacker'],
      external: [],
    },
    dataFlow: 'query -> recall -> rerank -> expand -> pack',
    keyPatterns: ['search', 'rerank', 'context pack'],
    lastUpdated: new Date('2026-04-05T10:00:00Z').toISOString(),
    memoryType: 'shared',
    sourceProjectId: 'shared-search-patterns',
  });
  await store.saveDecision({
    id: '2026-04-default-result-card',
    date: '2026-04-05',
    owner: 'search-owner',
    reviewer: 'ops-lead',
    title: '默认检索结果卡片',
    context: '需要把代码、记忆和解释统一成稳定阅读结构',
    decision: '统一输出代码命中、模块记忆、决策记录和命中原因四个区域',
    alternatives: [],
    rationale: '降低首次使用成本并建立可信感',
    consequences: ['CLI 与 MCP 响应结构对齐'],
    status: 'accepted',
  });
  await store.appendLongTermMemoryItem({
    type: 'project-state',
    title: '检索结果可信化',
    summary: '当前阶段需要把代码命中、项目记忆和决策记录统一进结果卡片',
    why: '让用户知道为什么结果可信',
    howToApply: '优先展示来源层级和状态信号',
    tags: ['retrieval', 'trust'],
    scope: 'project',
    source: 'user-explicit',
    confidence: 0.92,
    lastVerifiedAt: new Date('2026-04-05T09:00:00Z').toISOString(),
  });
  await store.appendLongTermMemoryItem({
    type: 'feedback',
    title: 'feature-memory:SearchService:memory-stale',
    summary:
      'outcome=memory-stale | targetType=feature-memory | target=SearchService | query=Trace retrieval flow',
    why: '反馈用于修正 feature-memory 结果质量',
    howToApply: '后续检索到 SearchService 时降低盲目信任',
    tags: ['feedback', 'memory-stale', 'feature-memory', 'SearchService'],
    scope: 'project',
    source: 'user-explicit',
    confidence: 1,
    lastVerifiedAt: new Date('2026-04-05T10:30:00Z').toISOString(),
  });
  await store.appendLongTermMemoryItem({
    type: 'evidence',
    title: 'retrieval-evidence-incident',
    summary: '用户反馈要求把 evidence 明确展示到 codebase-retrieval 主路径。',
    why: '避免代理只看到摘要，看不到支撑结论的原始证据层。',
    howToApply: '在 contextBlocks 和 references 里显式暴露 evidence 条目。',
    tags: ['retrieval', 'evidence', 'SearchService'],
    scope: 'project',
    source: 'user-explicit',
    confidence: 0.95,
    lastVerifiedAt: new Date('2026-04-05T10:40:00Z').toISOString(),
  });

  const originalInit = SearchService.prototype.init;
  const originalBuildContextPack = SearchService.prototype.buildContextPack;

  SearchService.prototype.init = async function initMock(): Promise<void> {};
  SearchService.prototype.buildContextPack = (async function buildContextPackMock() {
    return {
      query: 'Trace retrieval flow SearchService',
      seeds: [
        {
          filePath: 'src/search/SearchService.ts',
          chunkIndex: 0,
          score: 0.96,
          source: 'vector' as const,
          record: {
            file_path: 'src/search/SearchService.ts',
            chunk_index: 0,
            content: 'export class SearchService {}',
            display_code: 'export class SearchService {}',
            breadcrumb: 'src/search/SearchService.ts > SearchService',
            language: 'typescript',
            hash: 'h1',
            start_line: 1,
            end_line: 1,
            start_byte: 0,
            end_byte: 30,
            raw_start: 0,
            raw_end: 30,
            _distance: 0.04,
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
              score: 0.96,
              breadcrumb: 'src/search/SearchService.ts > SearchService',
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
      },
    };
  }) as typeof SearchService.prototype.buildContextPack;

  try {
    const response = await handleCodebaseRetrieval({
      repo_path: repoDir,
      information_request: 'Trace retrieval flow',
      technical_terms: ['SearchService'],
    });

    const text = response.content[0].text;
    assert.match(text, /## 结果卡片/);
    assert.match(text, /### 代码命中 \(Source: Code\)/);
    assert.match(text, /### 相关模块记忆 \(Source: Feature Memory\)/);
    assert.match(text, /SearchService/);
    assert.match(text, /类型: shared/);
    assert.match(text, /来源项目: [a-z0-9]+/);
    assert.match(text, /反馈信号: 近期存在 memory-stale 反馈/);
    assert.match(text, /### 相关决策记录 \(Source: Decision Record\)/);
    assert.match(text, /默认检索结果卡片/);
    assert.match(text, /Owner: search-owner/);
    assert.match(text, /Reviewer: ops-lead/);
    assert.match(text, /### 相关长期记忆 \(Source: Long-term Memory\)/);
    assert.match(text, /检索结果可信化/);
    assert.match(text, /### 近期反馈信号 \(Source: Feedback Loop\)/);
    assert.match(text, /feature-memory:SearchService:memory-stale/);
    assert.match(text, /Outcome: memory-stale/);
    assert.match(text, /### 跨项目参考 \(Source: Cross-project Hub\)/);
    assert.match(text, /### 来源层级与可信规则/);
    assert.match(text, /Code > Feature Memory > Decision Record > Long-term Memory/);
    assert.match(text, /发生冲突时直接展示冲突状态/);
    assert.match(text, /### 下一步动作/);
    assert.match(text, /contextatlas feedback:record --outcome helpful --target-type code/);
    assert.match(text, /contextatlas feedback:record --outcome memory-stale --target-type feature-memory --query "Trace retrieval flow" --target-id "SearchService"/);
    assert.match(text, /contextatlas memory:suggest SearchService --files "SearchService\.ts"/);
    assert.match(text, /contextatlas decision:record/);
    assert.match(text, /contextatlas memory:record-long-term --type reference/);
    assert.match(text, /### 为什么命中这些结果/);
    assert.match(text, /technical terms/i);
    assert.match(text, /src\/search\/SearchService\.ts/);
    assert.match(text, /近期反馈会直接外显/);
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

test('codebaseRetrievalSchema normalizes markdown alias and accepts json response format', async () => {
  const { codebaseRetrievalSchema } = await import('../src/mcp/tools/codebaseRetrieval.ts');
  const markdownParsed = codebaseRetrievalSchema.parse({
    repo_path: '/tmp/repo',
    information_request: 'trace auth flow',
    response_format: 'markdown',
  });
  assert.equal(markdownParsed.response_format, 'text');

  const jsonParsed = codebaseRetrievalSchema.parse({
    repo_path: '/tmp/repo',
    information_request: 'trace auth flow',
    response_format: 'json',
  });
  assert.equal(jsonParsed.response_format, 'json');
});

test('handleCodebaseRetrieval returns block-first json payload when response_format=json', async () => {
  const baseDir = createTempBaseDir();
  const repoDir = path.join(baseDir, 'repo');
  fs.mkdirSync(path.join(repoDir, 'src', 'search'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'src', 'search', 'SearchService.ts'), 'export class SearchService {}');

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

  const store = new MemoryStore(repoDir);
  await store.saveFeature({
    name: 'SearchService',
    responsibility: '协调混合检索、精排和上下文打包',
    location: { dir: 'src/search', files: ['SearchService.ts'] },
    api: { exports: ['SearchService'], endpoints: [] },
    dependencies: { imports: ['GraphExpander', 'ContextPacker'], external: [] },
    dataFlow: 'query -> recall -> rerank -> expand -> pack',
    keyPatterns: ['search', 'rerank', 'context pack'],
    evidenceRefs: ['evidence:retrieval-evidence-ref'],
    lastUpdated: new Date('2026-04-05T10:00:00Z').toISOString(),
  });
  await store.appendLongTermMemoryItem({
    id: 'retrieval-evidence-ref',
    type: 'evidence',
    title: 'retrieval-evidence-incident',
    summary: '用户反馈要求把 evidence 明确展示到 codebase-retrieval 主路径。',
    why: '避免代理只看到摘要，看不到支撑结论的原始证据层。',
    howToApply: '在 contextBlocks 和 references 里显式暴露 evidence 条目。',
    tags: ['retrieval', 'evidence', 'SearchService'],
    scope: 'project',
    source: 'user-explicit',
    confidence: 0.95,
    lastVerifiedAt: new Date('2026-04-05T10:40:00Z').toISOString(),
  });
  await store.appendLongTermMemoryItem({
    id: 'migration-user-module',
    type: 'temporal-fact',
    title: 'User module migration window',
    summary: 'User module migration remains blocked until data backfill is verified.',
    tags: ['migration', 'user-module'],
    scope: 'project',
    source: 'user-explicit',
    confidence: 1,
    factKey: 'migration:user-module',
    validFrom: '2026-04-08',
    lastVerifiedAt: new Date('2026-04-05T10:50:00Z').toISOString(),
  });

  const originalInit = SearchService.prototype.init;
  const originalBuildContextPack = SearchService.prototype.buildContextPack;
  SearchService.prototype.init = async function initMock(): Promise<void> {};
  SearchService.prototype.buildContextPack = (async function buildContextPackMock() {
    return {
      query: 'Trace retrieval flow SearchService',
      seeds: [
        {
          filePath: 'src/search/SearchService.ts',
          chunkIndex: 0,
          score: 0.96,
          source: 'vector' as const,
          record: {
            file_path: 'src/search/SearchService.ts',
            chunk_index: 0,
            content: 'export class SearchService {}',
            display_code: 'export class SearchService {}',
            breadcrumb: 'src/search/SearchService.ts > SearchService',
            language: 'typescript',
            hash: 'h1',
            start_line: 1,
            end_line: 1,
            start_byte: 0,
            end_byte: 30,
            raw_start: 0,
            raw_end: 30,
            _distance: 0.04,
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
              score: 0.96,
              breadcrumb: 'src/search/SearchService.ts > SearchService',
              text: 'export class SearchService {}',
            },
          ],
        },
      ],
      debug: { wVec: 0.35, wLex: 0.65, timingMs: { retrieve: 1, rerank: 1, expand: 0, pack: 0 } },
      mode: 'overview' as const,
      expansionCandidates: [
        {
          filePath: 'src/search/GraphExpander.ts',
          source: 'import' as const,
          reason: 'expanded via import',
          priority: 'high' as const,
        },
      ],
      nextInspectionSuggestions: ['Inspect src/search/GraphExpander.ts (expanded via import)'],
    };
  }) as typeof SearchService.prototype.buildContextPack;

  try {
    const response = await handleCodebaseRetrieval({
      repo_path: repoDir,
      information_request: 'Trace retrieval flow',
      technical_terms: ['SearchService'],
      response_format: 'json',
    });

    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.responseMode, 'expanded');
    assert.equal(payload.summary.codeBlocks, 1);
    assert.ok(Array.isArray(payload.contextBlocks));
    assert.ok(payload.contextBlocks.some((block: { type: string }) => block.type === 'code-evidence'));
    assert.ok(payload.contextBlocks.some((block: { type: string }) => block.type === 'module-summary'));
    assert.ok(
      payload.contextBlocks.some(
        (block: { title: string; provenance: Array<{ source: string; ref: string }> }) =>
          block.title === 'retrieval-evidence-incident'
          && block.provenance.some((item) => item.source === 'evidence'),
      ),
    );
    assert.ok(
      payload.contextBlocks.some(
        (block: { id: string; title: string; content: string }) =>
          block.id === 'temporal:migration:user-module'
          && block.title === 'User module migration window'
          && block.content.includes('Fact Key: migration:user-module'),
      ),
    );
    assert.equal(payload.blockFirst.schemaVersion, 1);
    assert.equal(payload.blockFirst.contextBlocks.length, payload.contextBlocks.length);
    assert.equal(payload.blockFirst.checkpointCandidate.title, 'Trace retrieval flow');
    assert.equal(payload.blockFirst.checkpointCandidate.source, 'retrieval');
    assert.equal(payload.blockFirst.checkpointCandidate.confidence, 'high');
    assert.ok(Array.isArray(payload.blockFirst.checkpointCandidate.supportingRefs));
    assert.ok(
      payload.blockFirst.checkpointCandidate.supportingRefs.some((ref: string) => ref.startsWith('evidence:')),
    );
    assert.equal(payload.checkpointCandidate.goal, 'Trace retrieval flow');
    assert.equal(payload.checkpointCandidate.phase, 'overview');
    assert.ok(Array.isArray(payload.references));
    assert.ok(
      payload.references.some(
        (item: { source: string; ref: string }) =>
          item.source === 'evidence' && typeof item.ref === 'string' && item.ref.length > 0,
      ),
    );
    assert.ok(
      payload.references.some(
        (item: { source: string; ref: string }) =>
          item.source === 'long-term-memory' && item.ref === 'migration-user-module',
      ),
    );
    assert.ok(Array.isArray(payload.nextInspectionSuggestions));
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

test('handleCodebaseRetrieval returns block-first overview json payload when response_mode=overview', async () => {
  const baseDir = createTempBaseDir();
  const repoDir = path.join(baseDir, 'repo');
  fs.mkdirSync(path.join(repoDir, 'src', 'search'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'src', 'search', 'SearchService.ts'), 'export class SearchService {}');

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

  const store = new MemoryStore(repoDir);
  await store.saveFeature({
    name: 'SearchService',
    responsibility: '协调混合检索、精排和上下文打包',
    location: { dir: 'src/search', files: ['SearchService.ts'] },
    api: { exports: ['SearchService'], endpoints: [] },
    dependencies: { imports: ['GraphExpander', 'ContextPacker'], external: [] },
    dataFlow: 'query -> recall -> rerank -> expand -> pack',
    keyPatterns: ['search', 'rerank', 'context pack'],
    lastUpdated: new Date('2026-04-05T10:00:00Z').toISOString(),
  });

  const originalInit = SearchService.prototype.init;
  const originalBuildContextPack = SearchService.prototype.buildContextPack;
  SearchService.prototype.init = async function initMock(): Promise<void> {};
  SearchService.prototype.buildContextPack = (async function buildContextPackMock() {
    return {
      query: 'Trace retrieval flow SearchService',
      seeds: [
        {
          filePath: 'src/search/SearchService.ts',
          chunkIndex: 0,
          score: 0.96,
          source: 'vector' as const,
          record: {
            file_path: 'src/search/SearchService.ts',
            chunk_index: 0,
            content: 'export class SearchService {}',
            display_code: 'export class SearchService {}',
            breadcrumb: 'src/search/SearchService.ts > SearchService',
            language: 'typescript',
            hash: 'h1',
            start_line: 1,
            end_line: 1,
            start_byte: 0,
            end_byte: 30,
            raw_start: 0,
            raw_end: 30,
            _distance: 0.04,
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
              score: 0.96,
              breadcrumb: 'src/search/SearchService.ts > SearchService',
              text: 'export class SearchService {}',
            },
          ],
        },
      ],
      debug: { wVec: 0.35, wLex: 0.65, timingMs: { retrieve: 1, rerank: 1, expand: 0, pack: 0 } },
    };
  }) as typeof SearchService.prototype.buildContextPack;

  try {
    const response = await handleCodebaseRetrieval({
      repo_path: repoDir,
      information_request: 'Trace retrieval flow',
      technical_terms: ['SearchService'],
      response_format: 'json',
      response_mode: 'overview',
    });

    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.responseMode, 'overview');
    assert.equal(payload.summary.codeBlocks, 1);
    assert.ok(Array.isArray(payload.topFiles));
    assert.ok(Array.isArray(payload.contextBlocks));
    assert.equal(payload.blockFirst.schemaVersion, 1);
    assert.ok(payload.blockFirst.contextBlocks.some((block: { type: string }) => block.type === 'code-evidence'));
    assert.ok(payload.blockFirst.contextBlocks.some((block: { type: string }) => block.type === 'module-summary'));
    assert.equal(payload.blockFirst.checkpointCandidate.source, 'retrieval');
    assert.equal(payload.checkpointCandidate.phase, 'overview');
    assert.ok(Array.isArray(payload.references));
    assert.ok(Array.isArray(payload.nextInspectionSuggestions));
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

test('handleCodebaseRetrieval surfaces stale and conflict status for feature memory', async () => {
  const baseDir = createTempBaseDir();
  const repoDir = path.join(baseDir, 'repo');
  fs.mkdirSync(path.join(repoDir, 'src', 'search'), { recursive: true });
  fs.writeFileSync(
    path.join(repoDir, 'src', 'search', 'SearchService.ts'),
    'export class SearchService {}',
  );

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

  const store = new MemoryStore(repoDir);
  await store.saveFeature({
    name: 'SearchService',
    responsibility: '旧版检索编排入口',
    location: {
      dir: 'src/legacy-search',
      files: ['SearchService.ts'],
    },
    api: {
      exports: ['SearchService'],
      endpoints: [],
    },
    dependencies: {
      imports: ['OldGraphExpander'],
      external: [],
    },
    dataFlow: 'legacy pipeline',
    keyPatterns: ['search', 'legacy'],
    lastUpdated: '2020-01-01T00:00:00.000Z',
  });

  const originalInit = SearchService.prototype.init;
  const originalBuildContextPack = SearchService.prototype.buildContextPack;

  SearchService.prototype.init = async function initMock(): Promise<void> {};
  SearchService.prototype.buildContextPack = (async function buildContextPackMock() {
    return {
      query: 'Trace retrieval flow SearchService',
      seeds: [
        {
          filePath: 'src/search/SearchService.ts',
          chunkIndex: 0,
          score: 0.96,
          source: 'vector' as const,
          record: {
            file_path: 'src/search/SearchService.ts',
            chunk_index: 0,
            content: 'export class SearchService {}',
            display_code: 'export class SearchService {}',
            breadcrumb: 'src/search/SearchService.ts > SearchService',
            language: 'typescript',
            hash: 'h1',
            start_line: 1,
            end_line: 1,
            start_byte: 0,
            end_byte: 30,
            raw_start: 0,
            raw_end: 30,
            _distance: 0.04,
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
              score: 0.96,
              breadcrumb: 'src/search/SearchService.ts > SearchService',
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
      },
    };
  }) as typeof SearchService.prototype.buildContextPack;

  try {
    const response = await handleCodebaseRetrieval({
      repo_path: repoDir,
      information_request: 'Trace retrieval flow',
      technical_terms: ['SearchService'],
    });

    const text = response.content[0].text;
    const flagged = await store.readFeature('SearchService');
    assert.match(text, /状态: stale, conflict/);
    assert.match(text, /复核状态: needs-review/);
    assert.match(text, /最后核验: 2020-01-01T00:00:00.000Z/);
    assert.match(text, /可信度: low/);
    assert.match(text, /Code > Feature Memory > Decision Record > Long-term Memory/);
    assert.match(text, /代码优先于 stale\/conflict memory/);
    assert.equal(flagged?.reviewStatus, 'needs-review');
    assert.equal(flagged?.reviewReason, '当前查询命中的代码路径与记忆记录不一致');
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

test('handleCodebaseRetrieval returns lexical fallback when project is not indexed', async () => {
  const baseDir = createTempBaseDir();
  const repoDir = path.join(baseDir, 'repo');
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(repoDir, 'src', 'auth.ts'),
    [
      'export async function loginUser() {',
      '  const token = await issueToken();',
      '  return token;',
      '}',
      '',
      'async function issueToken() {',
      "  return 'token';",
      '}',
    ].join('\n'),
  );

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
  delete process.env.EMBEDDINGS_API_KEY;
  delete process.env.EMBEDDINGS_BASE_URL;
  delete process.env.EMBEDDINGS_MODEL;
  delete process.env.RERANK_API_KEY;
  delete process.env.RERANK_BASE_URL;
  delete process.env.RERANK_MODEL;

  try {
    const response = await handleCodebaseRetrieval({
      repo_path: repoDir,
      information_request: '用户登录 token 流程',
      technical_terms: ['loginUser'],
    });

    const text = response.content[0].text;
    assert.match(text, /索引状态: 索引缺失，当前返回词法降级结果/);
    assert.match(text, /可部分回答/);
    assert.match(text, /完整模式未就绪/);
    assert.match(text, /loginUser/);
    assert.match(text, /src\/auth\.ts/);
    assert.doesNotMatch(text, /配置缺失/);
  } finally {
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

test('handleCodebaseRetrieval enqueues indexing and still returns lexical fallback', async () => {
  const baseDir = createTempBaseDir();
  const repoDir = path.join(baseDir, 'repo');
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(repoDir, 'src', 'payment.ts'),
    'export function retryPayment() { return true; }\n',
  );

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
  process.env.MCP_AUTO_INDEX = 'true';
  delete process.env.EMBEDDINGS_API_KEY;
  delete process.env.EMBEDDINGS_BASE_URL;
  delete process.env.EMBEDDINGS_MODEL;
  delete process.env.RERANK_API_KEY;
  delete process.env.RERANK_BASE_URL;
  delete process.env.RERANK_MODEL;

  try {
    const response = await handleCodebaseRetrieval({
      repo_path: repoDir,
      information_request: 'payment retry logic',
      technical_terms: ['retryPayment'],
    });

    const projectId = generateProjectId(repoDir);
    const activeTask = getActiveTask(projectId);

    assert.ok(activeTask);
    assert.equal(activeTask?.status, 'queued');

    const text = response.content[0].text;
    assert.match(text, /索引状态: 索引任务已入队，当前返回词法降级结果/);
    assert.match(text, /task_id:/);
    assert.match(text, /retryPayment/);
    assert.match(text, /payment\.ts/);
  } finally {
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

test('handleCodebaseRetrieval skips auto-enqueue when indexed repo is already up to date', async () => {
  const baseDir = createTempBaseDir();
  const repoDir = path.join(baseDir, 'repo');
  fs.mkdirSync(path.join(repoDir, 'src', 'search'), { recursive: true });
  fs.writeFileSync(
    path.join(repoDir, 'src', 'search', 'SearchService.ts'),
    'export class SearchService {}\n',
  );

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
  process.env.MCP_AUTO_INDEX = 'true';
  process.env.EMBEDDINGS_API_KEY = 'test-key';
  process.env.EMBEDDINGS_BASE_URL = 'http://127.0.0.1/embeddings';
  process.env.EMBEDDINGS_MODEL = 'test-embedding-model';
  process.env.RERANK_API_KEY = 'test-key';
  process.env.RERANK_BASE_URL = 'http://127.0.0.1/rerank';
  process.env.RERANK_MODEL = 'test-rerank-model';

  const originalInit = SearchService.prototype.init;
  const originalBuildContextPack = SearchService.prototype.buildContextPack;
  SearchService.prototype.init = async function initMock(): Promise<void> {};
  SearchService.prototype.buildContextPack = (async function buildContextPackMock() {
    return {
      query: 'Trace retrieval flow SearchService',
      seeds: [],
      expanded: [],
      files: [],
      debug: {
        wVec: 0.35,
        wLex: 0.65,
        timingMs: { retrieve: 1, rerank: 1, expand: 0, pack: 0 },
      },
      mode: 'expanded' as const,
      expansionCandidates: [],
      nextInspectionSuggestions: [],
    };
  }) as typeof SearchService.prototype.buildContextPack;

  try {
    await scan(repoDir, { vectorIndex: false });
    const projectId = generateProjectId(repoDir);
    const db = initDb(projectId);
    db.exec('UPDATE files SET vector_index_hash = hash');
    db.close();

    const response = await handleCodebaseRetrieval({
      repo_path: repoDir,
      information_request: 'Trace retrieval flow',
      technical_terms: ['SearchService'],
    });

    const activeTask = getActiveTask(projectId);

    assert.equal(activeTask, null);
    assert.match(response.content[0].text, /Found 0 relevant code blocks|代码命中/);
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


test('handleCodebaseRetrieval returns lightweight overview payload when response_mode=overview and format=json', async () => {
  const baseDir = createTempBaseDir();
  const repoDir = path.join(baseDir, 'repo');
  fs.mkdirSync(path.join(repoDir, 'src', 'search'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'src', 'search', 'SearchService.ts'), 'export class SearchService {}');

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
  SearchService.prototype.buildContextPack = (async function buildContextPackMock() {
    return {
      query: 'Trace retrieval flow SearchService',
      seeds: [
        {
          filePath: 'src/search/SearchService.ts',
          chunkIndex: 0,
          score: 0.96,
          source: 'vector' as const,
          record: {
            file_path: 'src/search/SearchService.ts',
            chunk_index: 0,
            content: 'export class SearchService {}',
            display_code: 'export class SearchService {}',
            breadcrumb: 'src/search/SearchService.ts > SearchService',
            language: 'typescript',
            hash: 'h1',
            start_line: 1,
            end_line: 1,
            start_byte: 0,
            end_byte: 30,
            raw_start: 0,
            raw_end: 30,
            _distance: 0.04,
          },
        },
      ],
      expanded: [
        {
          filePath: 'src/search/GraphExpander.ts',
          chunkIndex: 1,
          score: 0.73,
          source: 'import' as const,
          record: {
            file_path: 'src/search/GraphExpander.ts',
            chunk_index: 1,
            content: 'export class GraphExpander {}',
            display_code: 'export class GraphExpander {}',
            breadcrumb: 'src/search/GraphExpander.ts > GraphExpander',
            language: 'typescript',
            hash: 'h2',
            start_line: 1,
            end_line: 1,
            start_byte: 0,
            end_byte: 30,
            raw_start: 0,
            raw_end: 30,
            _distance: 0.27,
          },
        },
      ],
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
              score: 0.96,
              breadcrumb: 'src/search/SearchService.ts > SearchService',
              text: 'export class SearchService {}',
            },
          ],
        },
      ],
      debug: { wVec: 0.35, wLex: 0.65, timingMs: { retrieve: 1, rerank: 1, expand: 0, pack: 0 } },
    };
  }) as typeof SearchService.prototype.buildContextPack;

  try {
    const response = await handleCodebaseRetrieval({
      repo_path: repoDir,
      information_request: 'Trace retrieval flow',
      technical_terms: ['SearchService'],
      response_format: 'json',
      response_mode: 'overview',
    });

    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.summary.codeBlocks, 1);
    assert.ok(Array.isArray(payload.topFiles));
    assert.ok(Array.isArray(payload.expansionCandidates));
    assert.equal(payload.expansionCandidates[0].filePath, 'src/search/GraphExpander.ts');
    assert.equal(payload.expansionCandidates[0].reason, 'expanded via import');
    assert.ok(Array.isArray(payload.nextInspectionSuggestions));
    assert.ok(Array.isArray(payload.contextBlocks));
    assert.equal(payload.contextBlocks.length, 2);
    assert.equal(payload.blockFirst.schemaVersion, 1);
    assert.equal(payload.blockFirst.contextBlocks.length, payload.contextBlocks.length);
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

test('handleCodebaseRetrieval returns lightweight overview text without full code blocks', async () => {
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
  SearchService.prototype.buildContextPack = (async function buildContextPackMock() {
    return {
      query: 'Trace retrieval flow SearchService',
      seeds: [
        {
          filePath: 'src/search/SearchService.ts',
          chunkIndex: 0,
          score: 0.96,
          source: 'vector' as const,
          record: {
            file_path: 'src/search/SearchService.ts',
            chunk_index: 0,
            content: 'export class SearchService {}',
            display_code: 'export class SearchService {}',
            breadcrumb: 'src/search/SearchService.ts > SearchService',
            language: 'typescript',
            hash: 'h1',
            start_line: 1,
            end_line: 1,
            start_byte: 0,
            end_byte: 30,
            raw_start: 0,
            raw_end: 30,
            _distance: 0.04,
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
              score: 0.96,
              breadcrumb: 'src/search/SearchService.ts > SearchService',
              text: 'export class SearchService {}',
            },
          ],
        },
      ],
      debug: { wVec: 0.35, wLex: 0.65, timingMs: { retrieve: 1, rerank: 1, expand: 0, pack: 0 } },
    };
  }) as typeof SearchService.prototype.buildContextPack;

  try {
    const response = await handleCodebaseRetrieval({
      repo_path: repoDir,
      information_request: 'Trace retrieval flow',
      technical_terms: ['SearchService'],
      response_mode: 'overview',
    });

    const text = response.content[0].text;
    assert.match(text, /## Retrieval Overview/);
    assert.match(text, /### Top Files/);
    assert.match(text, /### Next Inspection Suggestions/);
    assert.doesNotMatch(text, /```typescript/);
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
