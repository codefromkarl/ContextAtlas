import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const DIST_DIR = path.join(process.cwd(), 'dist');

function findDistModule(prefix: string): string {
  const fileName = fs.readdirSync(DIST_DIR).find((name) => name.startsWith(prefix) && name.endsWith('.js'));
  if (!fileName) {
    throw new Error(`Missing dist module with prefix: ${prefix}`);
  }
  return path.join(DIST_DIR, fileName);
}

const codebaseRetrievalModule = await import(findDistModule('codebaseRetrieval-'));
const searchServiceModule = await import(findDistModule('SearchService-'));

const { buildRetrievalTelemetry, createRetrievalProgressReporter } = codebaseRetrievalModule;
const { initializeSearchDependencies, selectRerankPoolCandidates } = searchServiceModule;

test('initializeSearchDependencies 并行初始化检索依赖', async () => {
  const events: string[] = [];
  let active = 0;
  let maxActive = 0;

  const makeLoader = <T>(name: string, value: T, delay: number) => async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    events.push(`${name}:start`);
    await new Promise((resolve) => setTimeout(resolve, delay));
    events.push(`${name}:end`);
    active--;
    return value;
  };

  const result = await initializeSearchDependencies({
    loadIndexer: makeLoader('indexer', 'IDX', 30),
    loadVectorStore: makeLoader('vector', 'VEC', 30),
    loadDb: makeLoader('db', 'DB', 30),
  });

  assert.deepEqual(result, {
    indexer: 'IDX',
    vectorStore: 'VEC',
    db: 'DB',
  });
  assert.equal(maxActive, 3);
  assert.deepEqual(events.slice(0, 3).sort(), ['db:start', 'indexer:start', 'vector:start']);
});

test('createRetrievalProgressReporter 按阶段输出单调递增进度', () => {
  const calls: Array<{ current: number; total?: number; message?: string }> = [];
  const report = createRetrievalProgressReporter((current, total, message) => {
    calls.push({ current, total, message });
  });

  report('prepare', '准备查询');
  report('init', '初始化检索服务');
  report('retrieve', '执行混合召回');
  report('rerank', '执行精排');
  report('expand', '执行上下文扩展');
  report('pack', '执行上下文打包');
  report('done', '检索完成');

  assert.deepEqual(calls, [
    { current: 1, total: 7, message: '准备查询' },
    { current: 2, total: 7, message: '初始化检索服务' },
    { current: 3, total: 7, message: '执行混合召回' },
    { current: 4, total: 7, message: '执行精排' },
    { current: 5, total: 7, message: '执行上下文扩展' },
    { current: 6, total: 7, message: '执行上下文打包' },
    { current: 7, total: 7, message: '检索完成' },
  ]);
});

test('buildRetrievalTelemetry 汇总查询耗时与结果规模', () => {
  const telemetry = buildRetrievalTelemetry({
    requestId: 'req-123',
    projectId: 'abcdef1234567890',
    query: 'search service rerank',
    totalMs: 123,
    contextPack: {
      query: 'search service rerank',
      seeds: [
        {
          filePath: 'src/a.ts',
          chunkIndex: 0,
          score: 0.9,
          source: 'vector',
          record: {
            file_path: 'src/a.ts',
            chunk_index: 0,
            content: '',
            display_code: '',
            breadcrumb: 'A',
            language: 'typescript',
            hash: '',
            start_line: 1,
            end_line: 2,
            start_byte: 0,
            end_byte: 10,
            raw_start: 0,
            raw_end: 10,
            _distance: 0.1,
          },
        },
      ],
      expanded: [],
      files: [
        {
          filePath: 'src/a.ts',
          segments: [
            {
              filePath: 'src/a.ts',
              rawStart: 0,
              rawEnd: 10,
              startLine: 1,
              endLine: 2,
              score: 0.9,
              breadcrumb: 'A',
              text: 'const a = 1;',
            },
          ],
        },
      ],
      debug: {
        wVec: 0.6,
        wLex: 0.4,
        timingMs: {
          init: 10,
          retrieve: 20,
          retrieveVector: 8,
          retrieveLexical: 5,
          retrieveFuse: 2,
          rerank: 30,
          smartCutoff: 5,
          expand: 15,
          pack: 12,
        },
        retrievalStats: {
          lexicalStrategy: 'chunks_fts',
          vectorCount: 12,
          lexicalCount: 5,
          fusedCount: 14,
          topMCount: 10,
          rerankInputCount: 14,
          rerankedCount: 6,
        },
        resultStats: {
          seedCount: 4,
          expandedCount: 3,
          fileCount: 1,
          segmentCount: 1,
          totalChars: 12,
          budgetLimitChars: 48000,
          budgetUsedChars: 12,
          budgetExhausted: false,
          filesConsidered: 2,
          filesIncluded: 1,
        },
        rerankUsage: {
          billedSearchUnits: 3,
          inputTokens: 42,
        },
      },
    },
  });

  assert.equal(telemetry.requestId, 'req-123');
  assert.equal(telemetry.projectId, 'abcdef1234');
  assert.equal(telemetry.queryLength, 21);
  assert.equal(telemetry.seedCount, 1);
  assert.equal(telemetry.fileCount, 1);
  assert.equal(telemetry.totalChars, 12);
  assert.equal(telemetry.totalMs, 123);
  assert.equal(telemetry.timingMs.rerank, 30);
  assert.equal(telemetry.timingMs.retrieveVector, 8);
  assert.deepEqual(telemetry.retrievalStats, {
    lexicalStrategy: 'chunks_fts',
    vectorCount: 12,
    lexicalCount: 5,
    fusedCount: 14,
    topMCount: 10,
    rerankInputCount: 14,
    rerankedCount: 6,
  });
  assert.deepEqual(telemetry.resultStats, {
    seedCount: 4,
    expandedCount: 3,
    fileCount: 1,
    segmentCount: 1,
    totalChars: 12,
    budgetLimitChars: 48000,
    budgetUsedChars: 12,
    budgetExhausted: false,
    filesConsidered: 2,
    filesIncluded: 1,
  });
  assert.deepEqual(telemetry.rerankUsage, {
    billedSearchUnits: 3,
    inputTokens: 42,
  });
});

test('selectRerankPoolCandidates 在候选较少时保持原样', () => {
  const candidates = [1, 0.92, 0.81, 0.7].map((score, index) => ({
    filePath: `src/f${index}.ts`,
    chunkIndex: index,
    score,
    source: 'vector' as const,
    record: {
      chunk_id: `src/f${index}.ts#hash#${index}`,
      file_path: `src/f${index}.ts`,
      file_hash: 'hash',
      chunk_index: index,
      vector: [],
      display_code: '',
      vector_text: '',
      language: 'typescript',
      breadcrumb: `B${index}`,
      start_index: 0,
      end_index: 1,
      raw_start: 0,
      raw_end: 1,
      vec_start: 0,
      vec_end: 1,
      _distance: 0,
    },
  }));

  const selected = selectRerankPoolCandidates(candidates, {
    rerankTopN: 10,
    rerankMinPool: 12,
    rerankMaxPool: 24,
    rerankPoolScoreRatio: 0.6,
  });

  assert.equal(selected.length, candidates.length);
  assert.deepEqual(selected.map((c: { chunkIndex: number }) => c.chunkIndex), [0, 1, 2, 3]);
});

test('selectRerankPoolCandidates 在分数陡降时收缩 rerank 池', () => {
  const scores = [1, 0.95, 0.91, 0.88, 0.84, 0.8, 0.76, 0.72, 0.69, 0.65, 0.61, 0.58, 0.31, 0.29, 0.26];
  const candidates = scores.map((score, index) => ({
    filePath: `src/f${index}.ts`,
    chunkIndex: index,
    score,
    source: 'vector' as const,
    record: {
      chunk_id: `src/f${index}.ts#hash#${index}`,
      file_path: `src/f${index}.ts`,
      file_hash: 'hash',
      chunk_index: index,
      vector: [],
      display_code: '',
      vector_text: '',
      language: 'typescript',
      breadcrumb: `B${index}`,
      start_index: 0,
      end_index: 1,
      raw_start: 0,
      raw_end: 1,
      vec_start: 0,
      vec_end: 1,
      _distance: 0,
    },
  }));

  const selected = selectRerankPoolCandidates(candidates, {
    rerankTopN: 10,
    rerankMinPool: 12,
    rerankMaxPool: 24,
    rerankPoolScoreRatio: 0.6,
  });

  assert.equal(selected.length, 12);
  assert.deepEqual(
    selected.map((c: { chunkIndex: number }) => c.chunkIndex),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  );
});

test('selectRerankPoolCandidates 在分数平缓时受 maxPool 限制', () => {
  const candidates = Array.from({ length: 40 }, (_, index) => ({
    filePath: `src/f${index}.ts`,
    chunkIndex: index,
    score: 1 - index * 0.01,
    source: 'vector' as const,
    record: {
      chunk_id: `src/f${index}.ts#hash#${index}`,
      file_path: `src/f${index}.ts`,
      file_hash: 'hash',
      chunk_index: index,
      vector: [],
      display_code: '',
      vector_text: '',
      language: 'typescript',
      breadcrumb: `B${index}`,
      start_index: 0,
      end_index: 1,
      raw_start: 0,
      raw_end: 1,
      vec_start: 0,
      vec_end: 1,
      _distance: 0,
    },
  }));

  const selected = selectRerankPoolCandidates(candidates, {
    rerankTopN: 10,
    rerankMinPool: 12,
    rerankMaxPool: 24,
    rerankPoolScoreRatio: 0.6,
  });

  assert.equal(selected.length, 24);
  assert.deepEqual(
    selected.map((c: { chunkIndex: number }) => c.chunkIndex),
    Array.from({ length: 24 }, (_, index) => index),
  );
});
