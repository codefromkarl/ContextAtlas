/**
 * FusionStrategy — 融合策略接口
 *
 * 决定如何将向量召回和词法召回合并为最终候选列表。
 * 将融合决策从 HybridRecallEngine 中解耦，
 * 使融合逻辑可独立测试和扩展。
 */

import type { LexicalStrategy, QueryIntent, ScoredChunk, SearchConfig } from './types.js';
import { fuseRecallResults } from './rrfFusion.js';

// ===========================================
// 接口定义
// ===========================================

export interface FusionInput {
  vectorResults: ScoredChunk[];
  lexicalResults: ScoredChunk[];
  config: Pick<SearchConfig, 'rrfK0' | 'wVec' | 'wLex'>;
  lexicalStrategy: LexicalStrategy;
  queryIntent: QueryIntent;
  lexicalCount: number;
  skeletonCount: number;
  graphCount: number;
  timingMs: {
    retrieveVector: number;
    retrieveLexical: number;
  };
}

export interface FusionOutput {
  chunks: ScoredChunk[];
  timingMs: {
    retrieveVector: number;
    retrieveLexical: number;
    retrieveFuse: number;
  };
}

export interface FusionStrategy {
  fuse(input: FusionInput): FusionOutput;
}

// ===========================================
// 策略实现
// ===========================================

/**
 * 智能融合策略（默认）
 *
 * 三条路径：
 * 1. symbol_lookup + 有词法结果 → 纯词法（精确匹配优先）
 * 2. 无词法结果 → 纯向量
 * 3. 其他 → RRF 融合
 */
export class SmartFusionStrategy implements FusionStrategy {
  fuse(input: FusionInput): FusionOutput {
    const { vectorResults, lexicalResults, config, queryIntent } = input;

    // Path 1: symbol_lookup 短路 — 词法结果已足够精确
    if (queryIntent === 'symbol_lookup' && lexicalResults.length > 0) {
      return {
        chunks: lexicalResults,
        timingMs: {
          ...input.timingMs,
          retrieveFuse: 0,
        },
      };
    }

    // Path 2: 无词法结果 — 纯向量
    if (lexicalResults.length === 0) {
      return {
        chunks: vectorResults,
        timingMs: {
          ...input.timingMs,
          retrieveFuse: 0,
        },
      };
    }

    // Path 3: RRF 融合
    const fuseStart = Date.now();
    const fused = fuseRecallResults(vectorResults, lexicalResults, config);
    const retrieveFuse = Date.now() - fuseStart;

    return {
      chunks: fused,
      timingMs: {
        ...input.timingMs,
        retrieveFuse,
      },
    };
  }
}

/**
 * 始终融合策略（用于测试/对比）
 */
export class AlwaysFuseStrategy implements FusionStrategy {
  fuse(input: FusionInput): FusionOutput {
    const { vectorResults, lexicalResults, config } = input;
    const fuseStart = Date.now();
    const fused = fuseRecallResults(vectorResults, lexicalResults, config);
    const retrieveFuse = Date.now() - fuseStart;

    return {
      chunks: fused,
      timingMs: {
        ...input.timingMs,
        retrieveFuse,
      },
    };
  }
}
