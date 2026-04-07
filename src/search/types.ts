/**
 * 搜索模块类型定义
 */

import type { RerankUsage } from '../api/reranker.js';
import type { ChunkRecord } from '../vectorStore/index.js';

// ===========================================
// 配置类型
// ===========================================

/** 搜索配置 */
export interface SearchConfig {
  // 召回
  vectorTopK: number;
  vectorTopM: number;
  ftsTopKFiles: number;
  lexChunksPerFile: number;
  lexTotalChunks: number;

  // 融合（Phase 1）
  rrfK0: number;
  wVec: number;
  wLex: number;
  fusedTopM: number;

  // Rerank
  rerankTopN: number;
  rerankMinPool: number;
  rerankMaxPool: number;
  rerankPoolScoreRatio: number;
  maxRerankChars: number;
  maxBreadcrumbChars: number;
  headRatio: number;

  // 扩展（Phase 2）
  neighborHops: number;
  breadcrumbExpandLimit: number;
  importFilesPerSeed: number;
  chunksPerImportFile: number;
  decayNeighbor: number;
  decayBreadcrumb: number;
  decayImport: number;
  decayDepth: number;

  // ContextPacker
  maxSegmentsPerFile: number;
  maxTotalChars: number;
  maxContextBlocks: number;

  // === Smart TopK ===
  /** 是否启用智能 TopK 策略 */
  enableSmartTopK: boolean;

  /**
   * 动态阈值比例：dynamicThreshold 的 ratio 部分
   * ratioThreshold = topScore * smartTopScoreRatio
   * 推荐：0.4 ~ 0.6
   */
  smartTopScoreRatio: number;

  /**
   * 绝对差距护栏：保护 Top1 outlier 场景
   * deltaThreshold = topScore - smartTopScoreDeltaAbs
   * dynamicThreshold = max(floor, min(ratioThreshold, deltaThreshold))
   * 推荐：0.20 ~ 0.35
   */
  smartTopScoreDeltaAbs: number;

  /**
   * 最低分数阈值（floor）：低于此分数视为垃圾
   * 推荐：0.20 ~ 0.30（依赖 reranker 分数归一化稳定性）
   */
  smartMinScore: number;

  /**
   * Safe Harbor：前 minK 个只检查 floor，不检查 ratio/delta
   * 推荐：2 或 3
   */
  smartMinK: number;

  /**
   * 硬上限，避免刷屏 / token 溢出
   */
  smartMaxK: number;
}

// ===========================================
// 搜索结果类型
// ===========================================

/** Chunk 来源类型 */
export type ChunkSource = 'vector' | 'lexical' | 'neighbor' | 'breadcrumb' | 'import';

/** 带得分的 Chunk */
export interface ScoredChunk {
  /** 来源文件路径 */
  filePath: string;
  /** 文件内序号 */
  chunkIndex: number;
  /** 综合得分（rerank score 或衰减后的 score） */
  score: number;
  /** 来源类型 */
  source: ChunkSource;
  /** 原始 ChunkRecord */
  record: ChunkRecord & { _distance: number };
}

/** 合并后的段 */
export interface Segment {
  /** 文件路径 */
  filePath: string;
  /** 原始起始偏移 */
  rawStart: number;
  /** 原始结束偏移 */
  rawEnd: number;
  /** 起始行号（1-indexed） */
  startLine: number;
  /** 结束行号（1-indexed） */
  endLine: number;
  /** 段内最高得分 */
  score: number;
  /** 面包屑（取段内第一个 chunk 的） */
  breadcrumb: string;
  /** 段文本（从原文件切片） */
  text: string;
}

export type LexicalStrategy = 'chunks_fts' | 'files_fts' | 'none';
export type QueryIntent = 'balanced' | 'symbol_lookup';

export interface RetrievalStats {
  queryIntent: QueryIntent;
  lexicalStrategy: LexicalStrategy;
  vectorCount: number;
  lexicalCount: number;
  fusedCount: number;
  topMCount: number;
  rerankInputCount: number;
  rerankedCount: number;
}

export interface ResultStats {
  seedCount: number;
  expandedCount: number;
  fileCount: number;
  segmentCount: number;
  totalChars: number;
  budgetLimitChars: number;
  budgetUsedChars: number;
  budgetExhausted: boolean;
  blockBudgetLimit?: number;
  blockBudgetUsed?: number;
  blockBudgetExhausted?: boolean;
  filesConsidered: number;
  filesIncluded: number;
}

export interface PackStats {
  segmentCount: number;
  totalChars: number;
  budgetLimitChars: number;
  budgetUsedChars: number;
  budgetExhausted: boolean;
  blockBudgetLimit?: number;
  blockBudgetUsed?: number;
  blockBudgetExhausted?: boolean;
  filesConsidered: number;
  filesIncluded: number;
}

export type SearchResultMode = 'overview' | 'expanded';

export interface ExpansionCandidate {
  filePath: string;
  source: ChunkSource;
  reason: string;
  priority: 'high' | 'medium' | 'low';
}

export interface ContextPackDebug {
  wVec: number;
  wLex: number;
  timingMs: Record<string, number>;
  retrievalStats?: RetrievalStats;
  resultStats?: ResultStats;
  rerankUsage?: RerankUsage;
}

/** 上下文包 */
export interface ContextPack {
  /** 原始查询 */
  query: string;
  /** seed chunks（rerank 后的 topN） */
  seeds: ScoredChunk[];
  /** 扩展的 chunks */
  expanded: ScoredChunk[];
  /** 最终输出的段落（按文件聚合） */
  files: Array<{
    filePath: string;
    segments: Segment[];
  }>;
  /** 搜索结果模式 */
  mode?: SearchResultMode;
  /** 供 agent 按需扩展的探索候选 */
  expansionCandidates?: ExpansionCandidate[];
  /** 建议的下一步检查动作 */
  nextInspectionSuggestions?: string[];
  /** 调试信息 */
  debug?: ContextPackDebug;
}
