/**
 * SearchService - 检索编排 facade
 *
 * Query intent / recall / rerank / expand / pack 的主流程仍由它组织，
 * 但混合召回、rerank 策略和命中片段构造已经分别下沉到子模块。
 */

import type Database from 'better-sqlite3';
import { getRerankerClient, type RerankUsage } from '../api/reranker.js';
import { getEmbeddingConfig } from '../config.js';
import { initDb } from '../db/index.js';
import { getIndexer, type Indexer } from '../indexer/index.js';
import { logger } from '../utils/logger.js';
import { getVectorStore, type VectorStore } from '../vectorStore/index.js';
import { ContextPacker } from './ContextPacker.js';
import { DEFAULT_CONFIG } from './config.js';
import { segmentQuery } from './fts.js';
import { getGraphExpander } from './GraphExpander.js';
import { HybridRecallEngine } from './HybridRecallEngine.js';
import { applySmartCutoff, selectRerankPoolCandidates } from './RerankPolicy.js';
import { buildRerankText } from './SnippetExtractor.js';
import type {
  ContextPack,
  QueryIntent,
  ResultStats,
  RetrievalStats,
  ScoredChunk,
  SearchConfig,
} from './types.js';

export interface SearchDependencyLoaders<TIndexer = Indexer, TVectorStore = VectorStore, TDb = Database.Database> {
  loadIndexer: () => Promise<TIndexer>;
  loadVectorStore: () => Promise<TVectorStore>;
  loadDb: () => Promise<TDb>;
}

export async function initializeSearchDependencies<
  TIndexer = Indexer,
  TVectorStore = VectorStore,
  TDb = Database.Database,
>({
  loadIndexer,
  loadVectorStore,
  loadDb,
}: SearchDependencyLoaders<TIndexer, TVectorStore, TDb>): Promise<{
  indexer: TIndexer;
  vectorStore: TVectorStore;
  db: TDb;
}> {
  const [indexer, vectorStore, db] = await Promise.all([loadIndexer(), loadVectorStore(), loadDb()]);
  return { indexer, vectorStore, db };
}

export type SearchProgressStage = 'retrieve' | 'rerank' | 'expand' | 'pack';

export interface BuildContextPackOptions {
  technicalTerms?: string[];
  semanticQuery?: string;
  lexicalQuery?: string;
}

export function classifyQueryIntent(query: string, technicalTerms: string[] = []): QueryIntent {
  if (technicalTerms.length > 0) {
    return 'symbol_lookup';
  }

  const tokens = segmentQuery(query);
  if (tokens.length === 0) {
    return 'balanced';
  }

  const rawSegments = query.split(/\s+/).filter(Boolean);
  const codeLikeTokenCount = rawSegments.filter((token) => {
    if (/[A-Z]/.test(token)) return true;
    if (token.includes('_')) return true;
    if (token.includes('.')) return true;
    return /[a-z][A-Z]/.test(token);
  }).length;

  if (tokens.length <= 6 && codeLikeTokenCount >= 1) {
    return 'symbol_lookup';
  }

  return 'balanced';
}

export function deriveQueryAwareSearchConfig(
  baseConfig: SearchConfig,
  intent: QueryIntent,
): SearchConfig {
  if (intent === 'symbol_lookup') {
    return {
      ...baseConfig,
      wVec: 0.35,
      wLex: 0.65,
      rerankTopN: Math.min(baseConfig.rerankTopN, 8),
      rerankMinPool: Math.max(Math.min(baseConfig.rerankMinPool, 10), 8),
      rerankMaxPool: Math.max(Math.min(baseConfig.rerankMaxPool, 16), 12),
    };
  }

  return baseConfig;
}
export { selectRerankPoolCandidates } from './RerankPolicy.js';

function buildResultStats({
  seeds,
  expanded,
  files,
  packStats,
}: {
  seeds: ScoredChunk[];
  expanded: ScoredChunk[];
  files: Array<{ filePath: string; segments: { text: string }[] }>;
  packStats: {
    segmentCount: number;
    totalChars: number;
    budgetLimitChars: number;
    budgetUsedChars: number;
    budgetExhausted: boolean;
    filesConsidered: number;
    filesIncluded: number;
  };
}): ResultStats {
  return {
    seedCount: seeds.length,
    expandedCount: expanded.length,
    fileCount: files.length,
    segmentCount: packStats.segmentCount,
    totalChars: packStats.totalChars,
    budgetLimitChars: packStats.budgetLimitChars,
    budgetUsedChars: packStats.budgetUsedChars,
    budgetExhausted: packStats.budgetExhausted,
    filesConsidered: packStats.filesConsidered,
    filesIncluded: packStats.filesIncluded,
  };
}

export class SearchService {
  private projectId: string;
  private snapshotId: string | null | undefined;
  private indexer: Indexer | null = null;
  private vectorStore: VectorStore | null = null;
  private db: Database.Database | null = null;
  private config: SearchConfig;

  constructor(
    projectId: string,
    _projectPath: string,
    config?: Partial<SearchConfig>,
    snapshotId?: string | null,
  ) {
    this.projectId = projectId;
    this.snapshotId = snapshotId;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async init(): Promise<void> {
    const embeddingConfig = getEmbeddingConfig();
    const deps = await initializeSearchDependencies({
      loadIndexer: () => getIndexer(this.projectId, embeddingConfig.dimensions, this.snapshotId),
      loadVectorStore: () => getVectorStore(this.projectId, embeddingConfig.dimensions, this.snapshotId),
      loadDb: async () => initDb(this.projectId, this.snapshotId),
    });
    this.indexer = deps.indexer;
    this.vectorStore = deps.vectorStore;
    this.db = deps.db;
  }

  // 公开接口

  /**
   * 构建上下文包（用于问答/生成）
   */
  async buildContextPack(
    query: string,
    onStage?: (stage: SearchProgressStage) => void,
    options: BuildContextPackOptions = {},
  ): Promise<ContextPack> {
    const queryIntent = classifyQueryIntent(query, options.technicalTerms || []);
    const activeConfig = deriveQueryAwareSearchConfig(this.config, queryIntent);
    const semanticQuery = options.semanticQuery?.trim() || query;
    const lexicalQuery = options.lexicalQuery?.trim() || query;
    const timingMs: Record<string, number> = {};
    let t0 = Date.now();

    // 1. 混合召回
    onStage?.('retrieve');
    const recallEngine = new HybridRecallEngine({
      indexer: this.indexer,
      vectorStore: this.vectorStore,
      db: this.db,
      config: activeConfig,
      extractQueryTokens: (input) => this.extractQueryTokens(input),
    });
    const retrieved = await recallEngine.hybridRetrieve(semanticQuery, lexicalQuery);
    const candidates = retrieved.chunks;
    timingMs.retrieve = Date.now() - t0;
    timingMs.retrieveVector = retrieved.timingMs.retrieveVector;
    timingMs.retrieveLexical = retrieved.timingMs.retrieveLexical;
    timingMs.retrieveFuse = retrieved.timingMs.retrieveFuse;

    // 2. 取 topM
    t0 = Date.now();
    const topM = candidates.sort((a, b) => b.score - a.score).slice(0, activeConfig.fusedTopM);
    const topMCount = topM.length;

    // 3. Rerank → seeds
    onStage?.('rerank');
    const reranked = await this.rerank(query, topM, activeConfig);
    timingMs.rerank = Date.now() - t0;

    // 4. Smart TopK Cutoff
    t0 = Date.now();
    const seeds = applySmartCutoff(reranked.chunks, activeConfig);
    timingMs.smartCutoff = Date.now() - t0;

    // 5. 扩展（Phase 2 实现）
    t0 = Date.now();
    onStage?.('expand');
    const queryTokens = this.extractQueryTokens(query);
    const expanded = await this.expand(seeds, queryTokens, activeConfig);
    timingMs.expand = Date.now() - t0;

    // 6. 打包
    t0 = Date.now();
    onStage?.('pack');
    const packer = new ContextPacker(this.projectId, activeConfig, this.snapshotId);
    const packResult = await packer.packWithStats([...seeds, ...expanded]);
    const files = packResult.files;
    timingMs.pack = Date.now() - t0;
    const retrievalStats: RetrievalStats = {
      queryIntent,
      ...retrieved.stats,
      topMCount,
      rerankInputCount: reranked.inputCount,
      rerankedCount: reranked.chunks.length,
    };
    const resultStats = buildResultStats({
      seeds,
      expanded,
      files,
      packStats: packResult.stats,
    });

    return {
      query,
      seeds,
      expanded,
      files,
      debug: {
        wVec: activeConfig.wVec,
        wLex: activeConfig.wLex,
        timingMs,
        retrievalStats,
        resultStats,
        rerankUsage: reranked.usage,
      },
    };
  }

  /**
   * 提取查询中的 tokens
   *
   * 直接复用 fts.ts 中的 segmentQuery，确保召回和评分逻辑一致
   */
  private extractQueryTokens(query: string): Set<string> {
    const tokens = segmentQuery(query);
    return new Set(tokens);
  }
  // Rerank 方法

  /**
   * Rerank
   */
  private async rerank(
    query: string,
    candidates: ScoredChunk[],
    config: SearchConfig,
  ): Promise<{ chunks: ScoredChunk[]; usage?: RerankUsage; inputCount: number }> {
    if (candidates.length === 0) return { chunks: [] };

    const reranker = getRerankerClient();
    const queryTokens = this.extractQueryTokens(query);
    const rerankPool = selectRerankPoolCandidates(candidates, config);

    // 构造 rerank 文本：围绕命中行截取，而非头尾截断
    const textExtractor = (chunk: ScoredChunk): string => {
      return buildRerankText(
        {
          breadcrumb: chunk.record.breadcrumb,
          displayCode: chunk.record.display_code,
        },
        queryTokens,
        {
          maxBreadcrumbChars: config.maxBreadcrumbChars,
          maxRerankChars: config.maxRerankChars,
          headRatio: config.headRatio,
        },
      );
    };

    const reranked = await reranker.rerankWithDataDetailed(query, rerankPool, textExtractor, {
      topN: config.rerankTopN,
    });

    return {
      chunks: reranked.results
        .filter((r) => r.data !== undefined)
        .map((r) => ({
          ...(r.data as ScoredChunk),
          score: r.score,
        })),
      usage: reranked.usage,
      inputCount: rerankPool.length,
    };
  }

  // 扩展方法

  /**
   * 扩展 seed chunks
   *
   * 使用 GraphExpander 执行三种扩展策略：
   * - E1: 同文件邻居
   * - E2: breadcrumb 补段
   * - E3: 相对路径 import 解析
   */
  private async expand(
    seeds: ScoredChunk[],
    queryTokens: Set<string> | undefined,
    config: SearchConfig,
  ): Promise<ScoredChunk[]> {
    if (seeds.length === 0) return [];

    const expander = await getGraphExpander(this.projectId, config, this.snapshotId);
    const { chunks, stats } = await expander.expand(seeds, queryTokens);

    logger.debug(stats, '上下文扩展统计');

    return chunks;
  }
  /**
   * 获取当前配置
   */
  getConfig(): SearchConfig {
    return { ...this.config };
  }
}
