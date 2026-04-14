/**
 * 搜索模块默认配置
 *
 * 融合权重可通过环境变量覆盖：
 * - SEARCH_W_VEC / SEARCH_W_LEX: RRF 向量/词法权重（默认 0.6/0.4）
 * - SEARCH_RRF_K0: RRF 常数（默认 20）
 * - SEARCH_VECTOR_TOP_K / SEARCH_VECTOR_TOP_M: 向量召回参数
 */

import type { SearchConfig } from './types.js';

function envFloat(key: string, fallback: number): number {
  const val = parseFloat(process.env[key] || '');
  return Number.isFinite(val) ? val : fallback;
}

function envInt(key: string, fallback: number): number {
  const val = parseInt(process.env[key] || '', 10);
  return Number.isFinite(val) ? val : fallback;
}

export const DEFAULT_CONFIG: SearchConfig = {
  // 召回
  vectorTopK: envInt('SEARCH_VECTOR_TOP_K', 80),
  vectorTopM: envInt('SEARCH_VECTOR_TOP_M', 60),
  ftsTopKFiles: envInt('SEARCH_FTS_TOP_K_FILES', 20),
  lexChunksPerFile: envInt('SEARCH_LEX_CHUNKS_PER_FILE', 2),
  lexTotalChunks: envInt('SEARCH_LEX_TOTAL_CHUNKS', 40),

  // 融合
  rrfK0: envInt('SEARCH_RRF_K0', 20),
  wVec: envFloat('SEARCH_W_VEC', 0.6),
  wLex: envFloat('SEARCH_W_LEX', 0.4),
  fusedTopM: envInt('SEARCH_FUSED_TOP_M', 60),

  // Rerank
  rerankTopN: 10,
  rerankMinPool: 12,
  rerankMaxPool: 24,
  rerankPoolScoreRatio: 0.6,
  maxRerankChars: 1000,
  maxBreadcrumbChars: 250,
  headRatio: 0.67,

  // 扩展 (同文件充分展开，跨文件由 Agent 按需发起)
  neighborHops: 2,
  breadcrumbExpandLimit: 3,
  importFilesPerSeed: 0,
  chunksPerImportFile: 0,
  decayNeighbor: 0.8,
  decayBreadcrumb: 0.7,
  decayImport: 0.6,
  decayDepth: 0.7,

  // ContextPacker
  maxSegmentsPerFile: 3,
  maxTotalChars: 48000,
  maxContextBlocks: 12,

  // Smart TopK
  enableSmartTopK: true,
  smartTopScoreRatio: 0.5,
  smartTopScoreDeltaAbs: 0.25,
  smartMinScore: 0.25,
  smartMinK: 2,
  smartMaxK: 8,
};
