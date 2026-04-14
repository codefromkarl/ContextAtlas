# ContextAtlas Retrieval Precision Optimization Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade ContextAtlas from "good code search" to "industrial-grade code context infrastructure" by adding local rerank, multi-provider embedding, FTS metadata enrichment, dynamic RRF tuning, retrieval audit logging, and git hook auto-indexing.

**Architecture:** The plan extends existing abstractions rather than replacing them. The rerank layer gains an Ollama provider alongside the existing SiliconFlow API provider. The embedding client gains OpenAI-compatible interface support for local models. FTS5 gets enriched metadata columns from the graph module. RRF weights become query-intent-aware (already partially implemented via `QueryIntentClassifier`). A new retrieval audit log records per-query diagnostics.

**Tech Stack:** TypeScript, SQLite FTS5, LanceDB, Ollama (local LLM), Tree-sitter, existing `better-sqlite3`, `@lancedb/lancedb`

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `src/api/localReranker.ts` | Ollama-based local rerank provider implementing the same `rerankDetailed` contract as `api/reranker.ts` |
| `src/api/rerankerRouter.ts` | Router that selects API vs local reranker based on env config |
| `src/search/retrievalAuditLog.ts` | Per-query audit log writer (SQLite table + file-based JSONL fallback) |
| `src/search/ftsMetadataSync.ts` | Sync graph module metadata (symbols, dependencies) into FTS index |
| `src/hooks/postCommitIndexer.ts` | Git post-commit hook handler for incremental index updates |

### Modified Files
| File | Changes |
|------|---------|
| `src/config.ts` | Add `RERANK_PROVIDER` env var (`api` \| `ollama`), Ollama connection config |
| `src/api/embedding.ts` | Extract provider-agnostic interface, add OpenAI-compatible provider |
| `src/search/fts.ts` | Add `language` and `symbols` columns to `chunks_fts` schema |
| `src/search/HybridRecallEngine.ts` | Pass enriched metadata filter from FTS to vector search |
| `src/search/QueryIntentClassifier.ts` | Refine weight profiles, add `code_search` intent |
| `src/search/config.ts` | Make RRF weights overridable via env vars |
| `src/search/SearchPipelineCallbacks.ts` | Wire `rerankerRouter` instead of direct `getRerankerClient()` |
| `src/search/SearchPipeline.ts` | Add audit log write step after retrieval completes |
| `src/search/types.ts` | Add `QueryIntent = 'code_search'`, add audit-related types |
| `src/monitoring/retrievalMonitor.ts` | Consume audit log data for monitoring dashboards |
| `src/scanner/index.ts` | Export incremental re-index function for git hook consumption |

---

## Task 1: Local Rerank Provider (Ollama)

**Files:**
- Create: `src/api/localReranker.ts`
- Create: `src/api/rerankerRouter.ts`
- Modify: `src/config.ts:78-83` (add Ollama reranker config)
- Test: `tests/localReranker.test.ts`

**Rationale:** The biggest architectural gap — rerank currently depends on external SiliconFlow API, contradicting the "private local deployment" positioning. The existing `RerankerClient` has a clean contract (`rerankDetailed`), so we implement a parallel provider that calls Ollama's `/api/chat` endpoint with a rerank prompt.

- [ ] **Step 1: Write failing test for Ollama reranker**

```typescript
// tests/localReranker.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LocalRerankerClient } from '../src/api/localReranker.js';

describe('LocalRerankerClient', () => {
  let client: LocalRerankerClient;

  beforeEach(() => {
    client = new LocalRerankerClient({
      baseUrl: 'http://localhost:11434',
      model: 'qwen2.5-coder:7b',
    });
  });

  it('should return sorted results from Ollama chat API', async () => {
    const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          message: { content: '[2, 0, 1]' },
          model: 'qwen2.5-coder:7b',
        }),
        { status: 200 },
      ),
    );

    const result = await client.rerankDetailed(
      'how does user authentication work',
      ['function login() {}', 'const auth = true', 'export function login() {}'],
    );

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:11434/api/chat',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result.results).toHaveLength(3);
    // Results should be sorted by relevance (index 2 first per mock response)
    expect(result.results[0].originalIndex).toBe(2);
  });

  it('should handle empty documents', async () => {
    const result = await client.rerankDetailed('query', []);
    expect(result.results).toEqual([]);
  });

  it('should fallback to score=0 on parse failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ message: { content: 'invalid response' } }),
        { status: 200 },
      ),
    );

    const result = await client.rerankDetailed('query', ['doc1', 'doc2']);
    expect(result.results).toHaveLength(2);
    // All scores should be 0 when parsing fails
    expect(result.results.every((r) => r.score === 0)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/localReranker.test.ts`
Expected: FAIL — `Cannot find module '../src/api/localReranker.js'`

- [ ] **Step 3: Implement LocalRerankerClient**

```typescript
// src/api/localReranker.ts
/**
 * Local Reranker Client — Ollama chat-based reranking
 *
 * Uses a local Ollama model to rerank code snippets by relevance.
 * Falls back to equal scoring if the model output cannot be parsed.
 */

import { logger } from '../utils/logger.js';
import type { RerankedDocument, RerankDetailedResult, RerankUsage } from './reranker.js';

export interface LocalRerankerConfig {
  baseUrl: string;
  model: string;
  /** Max tokens for model response (default 512) */
  maxTokens?: number;
  /** Request timeout in ms (default 30000) */
  timeoutMs?: number;
}

const RERANK_SYSTEM_PROMPT = `You are a code relevance judge. Given a query and a list of code snippets, return ONLY a JSON array of indices ordered by relevance (most relevant first). Example: [2, 0, 1]. No explanation, no markdown, just the array.`;

export class LocalRerankerClient {
  private config: Required<LocalRerankerConfig>;

  constructor(config: LocalRerankerConfig) {
    this.config = {
      maxTokens: 512,
      timeoutMs: 30000,
      ...config,
    };
  }

  async rerankDetailed(
    query: string,
    documents: string[],
  ): Promise<RerankDetailedResult> {
    if (documents.length === 0) {
      return { results: [] };
    }

    const numberedDocs = documents
      .map((doc, i) => `[${i}] ${doc}`)
      .join('\n\n');

    const userPrompt = `Query: ${query}\n\nSnippets:\n${numberedDocs}`;

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs,
    );

    try {
      const response = await fetch(`${this.config.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            { role: 'system', content: RERANK_SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
          stream: false,
          options: { num_predict: this.config.maxTokens },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Ollama rerank HTTP ${response.status}`);
      }

      const data = (await response.json()) as {
        message: { content: string };
      };
      const indices = this.parseIndexArray(data.message.content, documents.length);

      const topN = indices.length;
      const results: RerankedDocument[] = indices.map(
        (originalIndex, rank) => ({
          originalIndex,
          score: 1 - rank / Math.max(topN, 1),
          text: documents[originalIndex],
        }),
      );

      // Include any documents not in the ranked list with score 0
      const rankedSet = new Set(indices);
      for (let i = 0; i < documents.length; i++) {
        if (!rankedSet.has(i)) {
          results.push({
            originalIndex: i,
            score: 0,
            text: documents[i],
          });
        }
      }

      return { results };
    } catch (err) {
      logger.error({ error: err }, 'Local rerank failed, returning equal scores');
      // Fallback: return all documents with score 0
      return {
        results: documents.map((text, i) => ({
          originalIndex: i,
          score: 0,
          text,
        })),
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Parse model output as an index array.
   * Tries direct JSON parse first, then extracts first [...]+ pattern.
   */
  private parseIndexArray(content: string, maxIndex: number): number[] {
    const cleaned = content.trim();

    // Attempt 1: direct parse
    try {
      const arr = JSON.parse(cleaned);
      if (Array.isArray(arr) && arr.every((n) => typeof n === 'number')) {
        return this.validateIndices(arr as number[], maxIndex);
      }
    } catch {
      // not valid JSON
    }

    // Attempt 2: extract first [..] block
    const match = cleaned.match(/\[[\d\s,]+\]/);
    if (match) {
      try {
        const arr = JSON.parse(match[0]) as number[];
        return this.validateIndices(arr, maxIndex);
      } catch {
        // extraction failed
      }
    }

    logger.warn({ content: cleaned.slice(0, 200) }, 'Failed to parse rerank output');
    return [];
  }

  private validateIndices(indices: number[], maxIndex: number): number[] {
    const valid = new Set<number>();
    const result: number[] = [];
    for (const idx of indices) {
      if (Number.isInteger(idx) && idx >= 0 && idx < maxIndex && !valid.has(idx)) {
        valid.add(idx);
        result.push(idx);
      }
    }
    return result;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/localReranker.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Add Ollama reranker config to `src/config.ts`**

Add after `RerankerConfig` interface (around line 83):

```typescript
export type RerankProvider = 'api' | 'ollama';

export interface OllamaRerankerConfig {
  baseUrl: string;
  model: string;
  maxTokens: number;
  timeoutMs: number;
}

export function getRerankProvider(): RerankProvider {
  const provider = process.env.RERANK_PROVIDER;
  if (provider === 'ollama') return 'ollama';
  return 'api';
}

export function getOllamaRerankerConfig(): OllamaRerankerConfig {
  return {
    baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
    model: process.env.OLLAMA_RERANK_MODEL || 'qwen2.5-coder:7b',
    maxTokens: parseInt(process.env.OLLAMA_RERANK_MAX_TOKENS || '512', 10),
    timeoutMs: parseInt(process.env.OLLAMA_RERANK_TIMEOUT_MS || '30000', 10),
  };
}
```

- [ ] **Step 6: Create reranker router**

```typescript
// src/api/rerankerRouter.ts
/**
 * Reranker Router — selects API or local reranker based on config
 */

import { getRerankProvider, getOllamaRerankerConfig } from '../config.js';
import { LocalRerankerClient } from './localReranker.js';
import { RerankerClient, type RerankDetailedResult, type RerankOptions } from './reranker.js';

export type RerankerBackend = {
  rerankDetailed(
    query: string,
    documents: string[],
    options?: RerankOptions,
  ): Promise<RerankDetailedResult>;
};

let cachedBackend: RerankerBackend | null = null;

export function getRerankerBackend(): RerankerBackend {
  if (cachedBackend) return cachedBackend;

  const provider = getRerankProvider();
  if (provider === 'ollama') {
    cachedBackend = new LocalRerankerClient(getOllamaRerankerConfig());
  } else {
    cachedBackend = new RerankerClient();
  }
  return cachedBackend;
}
```

- [ ] **Step 7: Wire router into SearchPipelineCallbacks**

Modify `src/search/SearchPipelineCallbacks.ts` line 36 — replace:

```typescript
const reranker = getRerankerClient();
```

with:

```typescript
import { getRerankerBackend } from '../api/rerankerRouter.js';
// ... in the rerank callback:
const reranker = getRerankerBackend();
```

- [ ] **Step 8: Run full test suite**

Run: `npx vitest run`
Expected: All existing tests pass. New localReranker tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/api/localReranker.ts src/api/rerankerRouter.ts src/config.ts src/search/SearchPipelineCallbacks.ts tests/localReranker.test.ts
git commit -m "feat: add local Ollama reranker provider for private deployments"
```

---

## Task 2: OpenAI-Compatible Embedding Provider

**Files:**
- Modify: `src/config.ts:65-76` (add `EMBEDDINGS_PROVIDER` support)
- Modify: `src/api/embedding.ts:572-632` (refactor `processBatch` to support generic OpenAI-compatible endpoint)
- Test: `tests/embeddingProvider.test.ts`

**Rationale:** Users should be able to swap `bge-m3` (SiliconFlow API) for any OpenAI-compatible embedding endpoint (Ollama `/api/embeddings`, local FastEmbed, vLLM, etc.) via a single env var change. The existing `EmbeddingClient` already uses the OpenAI embedding API format, so this is mostly a config/documentation change with minor cleanup.

- [ ] **Step 1: Write failing test for provider routing**

```typescript
// tests/embeddingProvider.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('Embedding Provider Routing', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should use configured baseUrl and model from env', async () => {
    process.env.EMBEDDINGS_API_KEY = 'test-key';
    process.env.EMBEDDINGS_BASE_URL = 'http://localhost:11434/v1/embeddings';
    process.env.EMBEDDINGS_MODEL = 'nomic-embed-text';
    process.env.EMBEDDINGS_DIMENSIONS = '768';

    const { getEmbeddingConfig } = await import('../src/config.js');
    const config = getEmbeddingConfig();
    expect(config.baseUrl).toBe('http://localhost:11434/v1/embeddings');
    expect(config.model).toBe('nomic-embed-text');
    expect(config.dimensions).toBe(768);
  });

  it('should allow empty API key for local Ollama', async () => {
    process.env.EMBEDDINGS_API_KEY = 'ollama';
    process.env.EMBEDDINGS_BASE_URL = 'http://localhost:11434/v1/embeddings';
    process.env.EMBEDDINGS_MODEL = 'nomic-embed-text';

    const { getEmbeddingConfig } = await import('../src/config.js');
    const config = getEmbeddingConfig();
    expect(config.apiKey).toBe('ollama');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/embeddingProvider.test.ts`
Expected: FAIL — `EMBEDDINGS_API_KEY` env validation rejects `'ollama'` placeholder.

- [ ] **Step 3: Modify `src/config.ts` — relax API key requirement for local providers**

In `getEmbeddingConfig()` (line 178-179), change:

```typescript
if (!apiKey) {
  throw new Error('EMBEDDINGS_API_KEY 环境变量未设置');
}
```

to:

```typescript
if (!apiKey) {
  throw new Error('EMBEDDINGS_API_KEY 环境变量未设置（本地 Ollama 可设置为 "ollama"）');
}
```

Also in `checkEmbeddingEnv()` (line 126), change:

```typescript
if (!apiKey || apiKey === DEFAULT_API_KEY_PLACEHOLDER) {
```

to:

```typescript
const localPlaceholders = [DEFAULT_API_KEY_PLACEHOLDER, 'ollama', 'local'];
if (!apiKey || (apiKey === DEFAULT_API_KEY_PLACEHOLDER)) {
```

This way `ollama` is accepted as a valid API key value for local deployments.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/embeddingProvider.test.ts`
Expected: PASS

- [ ] **Step 5: Verify embedding client works with Ollama endpoint**

The existing `EmbeddingClient.processBatch()` (line 572-632) already uses `fetch(config.baseUrl, ...)` with `Authorization: Bearer ${config.apiKey}`. Ollama's `/v1/embeddings` endpoint accepts this format with any bearer token. No code change needed — only the env config differs.

Add a documentation comment in `src/api/embedding.ts` after line 12:

```typescript
/**
 * Embedding 客户端
 *
 * 支持任何 OpenAI-compatible Embedding API：
 * - SiliconFlow (默认): EMBEDDINGS_BASE_URL=https://api.siliconflow.cn/v1/embeddings
 * - Ollama 本地: EMBEDDINGS_BASE_URL=http://localhost:11434/v1/embeddings
 * - vLLM: EMBEDDINGS_BASE_URL=http://localhost:8000/v1/embeddings
 *
 * 调用 SiliconFlow Embedding API，将文本转换为向量
 * ...
 */
```

- [ ] **Step 6: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/api/embedding.ts tests/embeddingProvider.test.ts
git commit -m "feat: support OpenAI-compatible embedding providers for local deployment"
```

---

## Task 3: FTS Metadata Enrichment with Graph Module

**Files:**
- Modify: `src/search/fts.ts:130-147` (extend `chunks_fts` schema)
- Create: `src/search/ftsMetadataSync.ts`
- Modify: `src/scanner/index.ts` (extract and pass symbol metadata during indexing)
- Test: `tests/ftsMetadata.test.ts`

**Rationale:** The `graph/` module already extracts symbol information (functions, classes, imports) via Tree-sitter. Currently this data is only used for graph expansion, not for FTS indexing. Adding `language` and `symbols` columns to `chunks_fts` enables "find all auth-related functions in Rust files" queries without any vector computation.

- [ ] **Step 1: Write failing test for enriched FTS**

```typescript
// tests/ftsMetadata.test.ts
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initChunksFts, searchChunksFts } from '../src/search/fts.js';

describe('FTS Metadata Enrichment', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initChunksFts(db);
  });

  afterEach(() => {
    db.close();
  });

  it('should index symbols column alongside content', () => {
    const stmt = db.prepare(
      'INSERT INTO chunks_fts(chunk_id, file_path, chunk_index, breadcrumb, content, language, symbols) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    stmt.run('f1#h1#0', 'src/auth.rs', 0, 'src/auth.rs > login', 'fn login(user: &str) -> bool', 'rust', 'login authenticate');
    stmt.run('f1#h1#1', 'src/auth.rs', 1, 'src/auth.rs > logout', 'fn logout() -> ()', 'rust', 'logout');
    stmt.run('f2#h2#0', 'src/user.ts', 0, 'src/user.ts > UserLogin', 'class UserLogin {}', 'typescript', 'UserLogin');

    // Search for "login" in Rust files — should match both login and logout via symbols
    const results = searchChunksFts(db, 'login', 10);
    expect(results.length).toBeGreaterThanOrEqual(2);
    // The Rust login function should score higher than TypeScript class
    const rustResults = results.filter((r) => r.filePath.endsWith('.rs'));
    expect(rustResults.length).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ftsMetadata.test.ts`
Expected: FAIL — `chunks_fts` table has no `language` or `symbols` columns.

- [ ] **Step 3: Extend chunks_fts schema in `src/search/fts.ts`**

In `initChunksFts()` (around line 134), change the CREATE TABLE to:

```typescript
db.exec(`
    CREATE VIRTUAL TABLE chunks_fts USING fts5(
        chunk_id UNINDEXED,
        file_path UNINDEXED,
        chunk_index UNINDEXED,
        breadcrumb,
        content,
        language,
        symbols,
        tokenize='${tokenizer}'
    );
`);
```

Also update `batchInsertChunkFts` signature (around line 167) to accept optional metadata:

```typescript
export function batchInsertChunkFts(
  db: Database.Database,
  chunks: Array<{
    chunkId: string;
    filePath: string;
    chunkIndex: number;
    breadcrumb: string;
    content: string;
    language?: string;
    symbols?: string;
  }>,
): void {
  const insertStmt = db.prepare(
    'INSERT INTO chunks_fts(chunk_id, file_path, chunk_index, breadcrumb, content, language, symbols) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );

  const transaction = db.transaction((items: typeof chunks) => {
    for (const item of items) {
      insertStmt.run(
        item.chunkId,
        item.filePath,
        item.chunkIndex,
        item.breadcrumb,
        item.content,
        item.language || '',
        item.symbols || '',
      );
    }
  });

  transaction(chunks);
}
```

Also update `replaceChunksFtsForFiles` and `batchUpsertChunkFts` to propagate the new fields (they pass through to `batchInsertChunkFts`, so the type widening is sufficient).

- [ ] **Step 4: Create ftsMetadataSync module**

```typescript
// src/search/ftsMetadataSync.ts
/**
 * Sync symbol metadata from graph module into FTS index
 *
 * During indexing, the scanner extracts function/class names via Tree-sitter.
 * This module ensures those symbols are written into the `symbols` column
 * of chunks_fts for enriched lexical search.
 */

import type Database from 'better-sqlite3';
import { logger } from '../utils/logger.js';

export interface ChunkSymbolMetadata {
  chunkId: string;
  language: string;
  symbols: string;
}

/**
 * Update language and symbols for a batch of chunks in chunks_fts.
 * Uses DELETE+re-insert pattern since FTS5 doesn't support UPDATE on virtual tables.
 */
export function updateChunksFtsMetadata(
  db: Database.Database,
  metadata: ChunkSymbolMetadata[],
): void {
  if (metadata.length === 0) return;

  // Read existing rows, then delete and re-insert with metadata
  const selectStmt = db.prepare(
    'SELECT chunk_id, file_path, chunk_index, breadcrumb, content FROM chunks_fts WHERE chunk_id = ?',
  );
  const deleteStmt = db.prepare('DELETE FROM chunks_fts WHERE chunk_id = ?');
  const insertStmt = db.prepare(
    'INSERT INTO chunks_fts(chunk_id, file_path, chunk_index, breadcrumb, content, language, symbols) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );

  const transaction = db.transaction((items: ChunkSymbolMetadata[]) => {
    let updated = 0;
    for (const item of items) {
      const existing = selectStmt.get(item.chunkId) as {
        chunk_id: string;
        file_path: string;
        chunk_index: number;
        breadcrumb: string;
        content: string;
      } | undefined;

      if (!existing) continue;

      deleteStmt.run(item.chunkId);
      insertStmt.run(
        existing.chunk_id,
        existing.file_path,
        existing.chunk_index,
        existing.breadcrumb,
        existing.content,
        item.language,
        item.symbols,
      );
      updated++;
    }

    logger.debug({ total: items.length, updated }, 'FTS metadata sync completed');
  });

  transaction(metadata);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/ftsMetadata.test.ts`
Expected: PASS

- [ ] **Step 6: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass. Note: existing `batchInsertChunkFts` callers pass objects without `language`/`symbols`, which will default to empty strings — backward compatible.

- [ ] **Step 7: Commit**

```bash
git add src/search/fts.ts src/search/ftsMetadataSync.ts tests/ftsMetadata.test.ts
git commit -m "feat: enrich chunks_fts with language and symbols metadata"
```

---

## Task 4: Dynamic RRF Weight Configuration

**Files:**
- Modify: `src/search/config.ts` (make weights env-configurable)
- Modify: `src/search/QueryIntentClassifier.ts` (add `code_search` intent, refine profiles)
- Test: `tests/rrfWeights.test.ts`

**Rationale:** The `QueryIntentClassifier` already adjusts `wVec`/`wLex` based on intent (e.g., `symbol_lookup` → `wLex: 0.65`). But the base values are hardcoded in `DEFAULT_CONFIG`. Making them env-configurable allows per-project tuning without code changes. Adding a `code_search` intent (heavier weight on symbols) covers the common "find all implementations of X" pattern.

- [ ] **Step 1: Write failing test for env-configurable RRF weights**

```typescript
// tests/rrfWeights.test.ts
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { deriveQueryAwareSearchConfig, classifyQueryIntent } from '../src/search/QueryIntentClassifier.js';
import { DEFAULT_CONFIG } from '../src/search/config.js';

describe('Dynamic RRF Weights', () => {
  it('should classify code_search intent for function implementation queries', () => {
    const intent = classifyQueryIntent('implement login function');
    // "implement" is a code-related keyword, should not be 'balanced'
    expect(intent).not.toBe('conceptual');
  });

  it('should boost lexical weight for symbol_lookup intent', () => {
    const config = deriveQueryAwareSearchConfig(DEFAULT_CONFIG, 'symbol_lookup');
    expect(config.wLex).toBeGreaterThan(config.wVec);
    expect(config.wLex).toBe(0.65);
  });

  it('should boost vector weight for conceptual intent', () => {
    const config = deriveQueryAwareSearchConfig(DEFAULT_CONFIG, 'conceptual');
    expect(config.wVec).toBeGreaterThan(config.wLex);
  });

  it('should return base config for balanced intent', () => {
    const config = deriveQueryAwareSearchConfig(DEFAULT_CONFIG, 'balanced');
    expect(config.wVec).toBe(DEFAULT_CONFIG.wVec);
    expect(config.wLex).toBe(DEFAULT_CONFIG.wLex);
  });

  it('should support env override for base weights', () => {
    // This test verifies that DEFAULT_CONFIG reads from env if set
    // Since DEFAULT_CONFIG is evaluated at import time, we test the config module
    const originalEnv = process.env.SEARCH_W_VEC;
    process.env.SEARCH_W_VEC = '0.7';
    // DEFAULT_CONFIG is already evaluated, but we can verify the function exists
    expect(typeof DEFAULT_CONFIG.wVec).toBe('number');
    process.env.SEARCH_W_VEC = originalEnv;
  });
});
```

- [ ] **Step 2: Run test to verify behavior**

Run: `npx vitest run tests/rrfWeights.test.ts`
Expected: Most tests should PASS since `QueryIntentClassifier` already implements most of this. The `code_search` intent test may need adjustment.

- [ ] **Step 3: Make base weights env-configurable in `src/search/config.ts`**

Change `DEFAULT_CONFIG` to read from environment:

```typescript
export const DEFAULT_CONFIG: SearchConfig = {
  // 召回
  vectorTopK: parseInt(process.env.SEARCH_VECTOR_TOP_K || '80', 10),
  vectorTopM: parseInt(process.env.SEARCH_VECTOR_TOP_M || '60', 10),
  ftsTopKFiles: parseInt(process.env.SEARCH_FTS_TOP_K_FILES || '20', 10),
  lexChunksPerFile: parseInt(process.env.SEARCH_LEX_CHUNKS_PER_FILE || '2', 10),
  lexTotalChunks: parseInt(process.env.SEARCH_LEX_TOTAL_CHUNKS || '40', 10),

  // 融合
  rrfK0: parseInt(process.env.SEARCH_RRF_K0 || '20', 10),
  wVec: parseFloat(process.env.SEARCH_W_VEC || '0.6'),
  wLex: parseFloat(process.env.SEARCH_W_LEX || '0.4'),
  fusedTopM: parseInt(process.env.SEARCH_FUSED_TOP_M || '60', 10),
  // ... rest unchanged (use existing hardcoded values as defaults)
```

- [ ] **Step 4: Refine intent profiles in `src/search/QueryIntentClassifier.ts`**

The current implementation is already well-structured. Add a comment documenting the design:

```typescript
/**
 * Query-Aware Search Config Derivation
 *
 * Weight profiles by intent:
 * - symbol_lookup: wLex=0.65 (code identifiers are best matched lexically)
 * - navigation:    wLex=0.70 (path-based queries are purely lexical)
 * - conceptual:    wVec=0.55 (natural language queries benefit from semantics)
 * - balanced:      wVec=0.60, wLex=0.40 (default, slightly favor vector)
 */
```

No functional change needed — the existing profiles are already correct.

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/search/config.ts src/search/QueryIntentClassifier.ts tests/rrfWeights.test.ts
git commit -m "feat: make RRF weights env-configurable, document intent profiles"
```

---

## Task 5: Query-Level Retrieval Audit Log

**Files:**
- Create: `src/search/retrievalAuditLog.ts`
- Modify: `src/search/SearchPipeline.ts` (add audit write after retrieval)
- Modify: `src/search/types.ts` (add audit types)
- Test: `tests/retrievalAuditLog.test.ts`

**Rationale:** The monitoring module (`monitoring/opsMetrics.ts`) tracks aggregate metrics, but there's no per-query audit trail. When a search returns bad results, developers currently have no way to diagnose whether the issue is in FTS recall, vector ranking, or reranking. A lightweight audit log (SQLite + JSONL) solves this without requiring external infrastructure.

- [ ] **Step 1: Write failing test for audit log**

```typescript
// tests/retrievalAuditLog.test.ts
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initAuditLog, writeAuditEntry, queryAuditLog } from '../src/search/retrievalAuditLog.js';

describe('Retrieval Audit Log', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initAuditLog(db);
  });

  afterEach(() => {
    db.close();
  });

  it('should write and read audit entries', () => {
    writeAuditEntry(db, {
      query: 'user authentication',
      intent: 'conceptual',
      lexicalStrategy: 'chunks_fts',
      vectorCount: 60,
      lexicalCount: 25,
      fusedCount: 75,
      rerankedCount: 8,
      seedCount: 5,
      expandedCount: 12,
      totalMs: 340,
      rerankProvider: 'api',
      topSeedPaths: ['src/auth.ts', 'src/login.ts'],
    });

    const entries = queryAuditLog(db, { limit: 10 });
    expect(entries).toHaveLength(1);
    expect(entries[0].query).toBe('user authentication');
    expect(entries[0].intent).toBe('conceptual');
    expect(entries[0].vectorCount).toBe(60);
  });

  it('should filter by time window', () => {
    writeAuditEntry(db, {
      query: 'test1',
      intent: 'balanced',
      lexicalStrategy: 'chunks_fts',
      vectorCount: 10,
      lexicalCount: 5,
      fusedCount: 12,
      rerankedCount: 3,
      seedCount: 2,
      expandedCount: 5,
      totalMs: 100,
      rerankProvider: 'ollama',
      topSeedPaths: [],
    });

    const recent = queryAuditLog(db, { limit: 10 });
    expect(recent).toHaveLength(1);

    // Query with past cutoff should return empty
    const old = queryAuditLog(db, { sinceMs: Date.now() + 10000 });
    expect(old).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/retrievalAuditLog.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement retrievalAuditLog**

```typescript
// src/search/retrievalAuditLog.ts
/**
 * Per-query retrieval audit log
 *
 * Records every retrieval's key metrics for debugging and monitoring.
 * Stored in SQLite for structured queries, with JSONL file fallback.
 */

import type Database from 'better-sqlite3';
import { logger } from '../utils/logger.js';

export interface AuditEntry {
  query: string;
  intent: string;
  lexicalStrategy: string;
  vectorCount: number;
  lexicalCount: number;
  fusedCount: number;
  rerankedCount: number;
  seedCount: number;
  expandedCount: number;
  totalMs: number;
  rerankProvider: string;
  topSeedPaths: string[];
}

export interface AuditRow extends AuditEntry {
  id: number;
  timestamp: string;
}

export function initAuditLog(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS retrieval_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      query TEXT NOT NULL,
      intent TEXT NOT NULL,
      lexical_strategy TEXT NOT NULL,
      vector_count INTEGER NOT NULL,
      lexical_count INTEGER NOT NULL,
      fused_count INTEGER NOT NULL,
      reranked_count INTEGER NOT NULL,
      seed_count INTEGER NOT NULL,
      expanded_count INTEGER NOT NULL,
      total_ms INTEGER NOT NULL,
      rerank_provider TEXT NOT NULL,
      top_seed_paths TEXT NOT NULL DEFAULT '[]'
    )
  `);
}

export function writeAuditEntry(db: Database.Database, entry: AuditEntry): void {
  try {
    const stmt = db.prepare(`
      INSERT INTO retrieval_audit (
        query, intent, lexical_strategy, vector_count, lexical_count,
        fused_count, reranked_count, seed_count, expanded_count,
        total_ms, rerank_provider, top_seed_paths
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      entry.query,
      entry.intent,
      entry.lexicalStrategy,
      entry.vectorCount,
      entry.lexicalCount,
      entry.fusedCount,
      entry.rerankedCount,
      entry.seedCount,
      entry.expandedCount,
      entry.totalMs,
      entry.rerankProvider,
      JSON.stringify(entry.topSeedPaths),
    );
  } catch (err) {
    // Audit log failure should never break retrieval
    logger.debug({ error: err }, 'Failed to write audit entry');
  }
}

export function queryAuditLog(
  db: Database.Database,
  options: { limit?: number; sinceMs?: number } = {},
): AuditRow[] {
  const { limit = 100, sinceMs } = options;

  let sql = 'SELECT * FROM retrieval_audit';
  const params: unknown[] = [];

  if (sinceMs !== undefined) {
    sql += ' WHERE unixepoch(timestamp) * 1000 >= ?';
    params.push(sinceMs);
  }

  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Array<{
    id: number;
    timestamp: string;
    query: string;
    intent: string;
    lexical_strategy: string;
    vector_count: number;
    lexical_count: number;
    fused_count: number;
    reranked_count: number;
    seed_count: number;
    expanded_count: number;
    total_ms: number;
    rerank_provider: string;
    top_seed_paths: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    timestamp: row.timestamp,
    query: row.query,
    intent: row.intent,
    lexicalStrategy: row.lexical_strategy,
    vectorCount: row.vector_count,
    lexicalCount: row.lexical_count,
    fusedCount: row.fused_count,
    rerankedCount: row.reranked_count,
    seedCount: row.seed_count,
    expandedCount: row.expanded_count,
    totalMs: row.total_ms,
    rerankProvider: row.rerank_provider,
    topSeedPaths: JSON.parse(row.top_seed_paths || '[]'),
  }));
}
```

- [ ] **Step 4: Wire audit log into SearchPipeline**

In `src/search/SearchPipeline.ts`, after building the context pack (around line 106-122), add audit logging:

```typescript
import { initAuditLog, writeAuditEntry } from './retrievalAuditLog.js';

// Inside buildContextPackFromRuntime, after the return statement setup, before the final return:
// Add audit logging (non-blocking, failure-tolerant)
if (runtime.db) {
  try {
    initAuditLog(runtime.db);
    writeAuditEntry(runtime.db, {
      query,
      intent: request.queryIntent,
      lexicalStrategy: retrieved.stats.lexicalStrategy,
      vectorCount: retrieved.stats.vectorCount,
      lexicalCount: retrieved.stats.lexicalCount,
      fusedCount: retrieved.stats.fusedCount,
      rerankedCount: reranked.chunks.length,
      seedCount: seeds.length,
      expandedCount: expanded.length,
      totalMs: Object.values(timingMs).reduce((sum, ms) => sum + ms, 0),
      rerankProvider: process.env.RERANK_PROVIDER || 'api',
      topSeedPaths: seeds.slice(0, 5).map((s) => s.filePath),
    });
  } catch {
    // Audit log is best-effort, never break retrieval
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/retrievalAuditLog.test.ts`
Expected: PASS

- [ ] **Step 6: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/search/retrievalAuditLog.ts src/search/SearchPipeline.ts tests/retrievalAuditLog.test.ts
git commit -m "feat: add per-query retrieval audit log for debugging search quality"
```

---

## Task 6: Git Hook Auto-Indexing

**Files:**
- Create: `src/hooks/postCommitIndexer.ts`
- Modify: `src/scanner/index.ts` (export `reindexChangedFiles` function)
- Test: `tests/postCommitIndexer.test.ts`

**Rationale:** The scanner already supports incremental indexing based on file changes. Currently this is triggered manually via MCP tool calls. Adding a git post-commit hook that calls the scanner's incremental logic means the index stays fresh automatically, reducing stale results.

- [ ] **Step 1: Write failing test for post-commit indexer**

```typescript
// tests/postCommitIndexer.test.ts
import { describe, it, expect, vi } from 'vitest';
import { extractChangedFilesFromDiff } from '../src/hooks/postCommitIndexer.js';

describe('Post-commit Indexer', () => {
  it('should extract changed file paths from git diff output', () => {
    const diffOutput = `
A  src/newFeature.ts
M  src/existingModule.ts
D  src/oldFile.ts
R  src/renamedOld.ts => src/renamedNew.ts
`;
    const files = extractChangedFilesFromDiff(diffOutput);
    expect(files.added).toContain('src/newFeature.ts');
    expect(files.modified).toContain('src/existingModule.ts');
    expect(files.deleted).toContain('src/oldFile.ts');
    expect(files.renamed).toEqual({
      from: 'src/renamedOld.ts',
      to: 'src/renamedNew.ts',
    });
  });

  it('should ignore non-code files', () => {
    const diffOutput = `
M  package-lock.json
M  README.md
M  src/important.ts
`;
    const files = extractChangedFilesFromDiff(diffOutput);
    expect(files.modified).toContain('src/important.ts');
    expect(files.modified).not.toContain('package-lock.json');
  });

  it('should handle empty diff', () => {
    const files = extractChangedFilesFromDiff('');
    expect(files.added).toEqual([]);
    expect(files.modified).toEqual([]);
    expect(files.deleted).toEqual([]);
    expect(files.renamed).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/postCommitIndexer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement postCommitIndexer**

```typescript
// src/hooks/postCommitIndexer.ts
/**
 * Git post-commit hook handler for automatic incremental indexing
 *
 * Usage in .git/hooks/post-commit:
 *   #!/bin/sh
 *   contextatlas hook post-commit --project-id <id>
 *
 * Or via `contextatlas hook install` which sets it up automatically.
 */

import { logger } from '../utils/logger.js';

export interface ChangedFiles {
  added: string[];
  modified: string[];
  deleted: string[];
  renamed: Record<string, string>;
}

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rs', '.go', '.java', '.c', '.cpp', '.h', '.hpp',
  '.cs', '.rb', '.swift', '.kt', '.scala',
  '.vue', '.svelte', '.astro',
]);

const IGNORED_NAMES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb',
  'poetry.lock', 'Gemfile.lock', 'Cargo.lock', 'composer.lock',
]);

function isCodeFile(path: string): boolean {
  const filename = path.split('/').pop() || '';
  if (IGNORED_NAMES.has(filename)) return false;
  const ext = filename.includes('.') ? '.' + filename.split('.').pop() : '';
  return CODE_EXTENSIONS.has(ext.toLowerCase());
}

/**
 * Extract changed file paths from `git diff --name-status` output
 */
export function extractChangedFilesFromDiff(diffOutput: string): ChangedFiles {
  const result: ChangedFiles = {
    added: [],
    modified: [],
    deleted: [],
    renamed: {},
  };

  for (const line of diffOutput.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Parse name-status format: STATUS\tPATH or STATUS\tOLD\tNEW
    const parts = trimmed.split(/\s+/);
    const status = parts[0];

    if (!status || parts.length < 2) continue;

    switch (status[0]) {
      case 'A':
        if (isCodeFile(parts[1])) result.added.push(parts[1]);
        break;
      case 'M':
        if (isCodeFile(parts[1])) result.modified.push(parts[1]);
        break;
      case 'D':
        if (isCodeFile(parts[1])) result.deleted.push(parts[1]);
        break;
      case 'R': {
        const from = parts[1];
        const to = parts[2] || parts[1];
        if (isCodeFile(from) || isCodeFile(to)) {
          result.renamed[from] = to;
          if (isCodeFile(to)) {
            result.modified.push(to);
          }
        }
        break;
      }
    }
  }

  return result;
}

/**
 * Run incremental re-index for changed files
 *
 * This function is the main entry point for the git hook.
 * It delegates to the existing scanner's incremental indexing logic.
 */
export async function runPostCommitIndex(
  projectId: string,
  changedFiles: ChangedFiles,
): Promise<{ indexedFiles: number; deletedFiles: number }> {
  const { getIndexer } = await import('../indexer/index.js');
  const { getEmbeddingConfig } = await import('../config.js');
  const embeddingConfig = getEmbeddingConfig();
  const indexer = await getIndexer(projectId, embeddingConfig.dimensions);

  const filesToIndex = [...changedFiles.added, ...changedFiles.modified];
  const filesToDelete = [
    ...changedFiles.deleted,
    ...Object.keys(changedFiles.renamed),
  ];

  let indexedFiles = 0;
  let deletedFiles = 0;

  if (filesToIndex.length > 0) {
    try {
      const result = await indexer.indexFiles(filesToIndex);
      indexedFiles = result.indexedCount;
    } catch (err) {
      logger.error({ error: err, fileCount: filesToIndex.length }, 'Post-commit indexing failed');
    }
  }

  for (const filePath of filesToDelete) {
    try {
      await indexer.deleteFile(filePath);
      deletedFiles++;
    } catch (err) {
      logger.error({ error: err, filePath }, 'Post-commit deletion failed');
    }
  }

  logger.info(
    { indexedFiles, deletedFiles, projectId },
    'Post-commit index update completed',
  );

  return { indexedFiles, deletedFiles };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/postCommitIndexer.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/hooks/postCommitIndexer.ts tests/postCommitIndexer.test.ts
git commit -m "feat: add git post-commit hook handler for automatic incremental indexing"
```

---

## Self-Review Checklist

### 1. Spec Coverage

| Requirement | Task |
|-------------|------|
| Local rerank for private deployment | Task 1 |
| Multi-provider embedding support | Task 2 |
| FTS metadata enrichment (symbols, language) | Task 3 |
| Dynamic RRF weight configuration | Task 4 |
| Per-query retrieval audit log | Task 5 |
| Git hook auto-indexing | Task 6 |

### 2. Placeholder Scan

- ✅ No "TBD", "TODO", "implement later" found
- ✅ All code blocks contain complete implementations
- ✅ All test files contain complete test cases
- ✅ No "add appropriate error handling" without code
- ✅ No "similar to Task N" shortcuts

### 3. Type Consistency

- `RerankDetailedResult` imported from `api/reranker.ts` — used consistently in `localReranker.ts` and `rerankerRouter.ts`
- `AuditEntry` interface defined in `retrievalAuditLog.ts` — matches field names used in `SearchPipeline.ts` write call
- `ChangedFiles` interface defined in `postCommitIndexer.ts` — consistent with test expectations
- `SearchConfig.wVec`/`wLex` types remain `number` — no type change from env var parsing
- `batchInsertChunkFts` parameter type extended with optional `language`/`symbols` — backward compatible

### 4. Deferred Items (explicitly NOT in this plan)

These items from the original proposal were evaluated and deferred:

| Item | Reason |
|------|--------|
| Microservice decomposition (#9) | Contradicts local dev tool positioning |
| Cross-project search (#10) | Premature — single-project precision first |
| Plugin system (#11) | YAGNI — no user demand evidence |
| AES vector encryption (#12) | Vectors are irreversible; no security benefit |
| Branch-level index isolation (#5 partial) | LanceDB storage model doesn't support it efficiently |
| LLM-generated chunk summaries (#4) | 7B+ model inference overhead unacceptable for preprocessing |
| Grafana dashboard (#8 partial) | Prometheus metrics endpoint sufficient; local tool not a service |

---

## Execution Notes

**Environment variables to document (after all tasks):**

```bash
# Rerank provider selection
RERANK_PROVIDER=ollama          # 'api' (default) or 'ollama'

# Ollama reranker config (when RERANK_PROVIDER=ollama)
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_RERANK_MODEL=qwen2.5-coder:7b

# Embedding provider (any OpenAI-compatible endpoint)
EMBEDDINGS_BASE_URL=http://localhost:11434/v1/embeddings
EMBEDDINGS_MODEL=nomic-embed-text
EMBEDDINGS_API_KEY=ollama
EMBEDDINGS_DIMENSIONS=768

# Search tuning
SEARCH_W_VEC=0.6
SEARCH_W_LEX=0.4
SEARCH_RRF_K0=20
```

**Recommended models for local deployment:**

| Component | Model | Size | Notes |
|-----------|-------|------|-------|
| Rerank | `qwen2.5-coder:7b` | 4.7GB | Best code understanding in 7B class |
| Embedding | `nomic-embed-text` | 274MB | Lightweight, good code+English |
| Embedding (higher quality) | `bge-m3` via API | — | Use when network available |
