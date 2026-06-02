/**
 * IntentPostProcessor - 意图后处理策略
 *
 * 按 QueryIntent 应用不同的后处理步骤：
 * - architecture: 去重 + 文件多样性
 * - symbol_lookup: 源文件多样性
 * - balanced/其他: 透传
 *
 * 新意图只需实现 IntentPostProcessor 接口并注册。
 */

import type { ScoredChunk, QueryIntent, SearchConfig } from './types.js';

// ===========================================
// 接口定义
// ===========================================

export interface IntentPostProcessor {
  /** 此处理器负责的意图 */
  readonly intent: QueryIntent;

  /**
   * 处理 reranked seeds
   *
   * @param seeds - smart cutoff 后的初始 seeds
   * @param reranked - 完整 reranked 列表
   * @param topM - 原始召回 topM
   * @returns 处理后的 seeds
   */
  process(
    seeds: ScoredChunk[],
    reranked: ScoredChunk[],
    topM: ScoredChunk[],
  ): ScoredChunk[];
}

// ===========================================
// Architecture 后处理器
// ===========================================

const ARCHITECTURE_MIN_UNIQUE_FILES = 4;
const ARCHITECTURE_MIN_SOURCE_FILES = 3;

export class ArchitecturePostProcessor implements IntentPostProcessor {
  readonly intent: QueryIntent = 'architecture';

  process(
    seeds: ScoredChunk[],
    reranked: ScoredChunk[],
    topM: ScoredChunk[],
  ): ScoredChunk[] {
    // Step 1: 去重（每个文件只保留最高分 chunk）
    const deduped = dedupeByFile(seeds);

    // Step 2: 确保文件多样性
    return ensureFileDiversity(
      deduped,
      reranked,
      topM,
      ARCHITECTURE_MIN_UNIQUE_FILES,
      ARCHITECTURE_MIN_SOURCE_FILES,
    );
  }
}

// ===========================================
// SymbolLookup 后处理器
// ===========================================

const SYMBOL_LOOKUP_MIN_SOURCE_FILES = 3;

export class SymbolLookupPostProcessor implements IntentPostProcessor {
  readonly intent: QueryIntent = 'symbol_lookup';

  process(
    seeds: ScoredChunk[],
    _reranked: ScoredChunk[],
    topM: ScoredChunk[],
  ): ScoredChunk[] {
    return ensureSourceFileDiversity(
      seeds,
      topM,
      SYMBOL_LOOKUP_MIN_SOURCE_FILES,
    );
  }
}

// ===========================================
// 默认透传后处理器
// ===========================================

export class PassthroughPostProcessor implements IntentPostProcessor {
  readonly intent: QueryIntent;

  constructor(intent: QueryIntent) {
    this.intent = intent;
  }

  process(seeds: ScoredChunk[]): ScoredChunk[] {
    return seeds;
  }
}

// ===========================================
// 注册表
// ===========================================

const registry = new Map<QueryIntent, IntentPostProcessor>();

function ensureRegistry(): void {
  if (registry.size > 0) return;

  register(new ArchitecturePostProcessor());
  register(new SymbolLookupPostProcessor());
}

function register(processor: IntentPostProcessor): void {
  registry.set(processor.intent, processor);
}

/**
 * 获取指定意图的后处理器
 *
 * 未注册的意图返回透传处理器。
 */
export function getPostProcessor(intent: QueryIntent): IntentPostProcessor {
  ensureRegistry();
  return registry.get(intent) ?? new PassthroughPostProcessor(intent);
}

/**
 * 注册自定义后处理器（用于扩展）
 */
export function registerPostProcessor(processor: IntentPostProcessor): void {
  ensureRegistry();
  register(processor);
}

// ===========================================
// 纯函数实现
// ===========================================

function dedupeByFile(chunks: ScoredChunk[]): ScoredChunk[] {
  const byFile = new Set<string>();
  const deduped: ScoredChunk[] = [];
  for (const chunk of chunks) {
    if (byFile.has(chunk.filePath)) {
      continue;
    }
    byFile.add(chunk.filePath);
    deduped.push(chunk);
  }
  return deduped;
}

function ensureFileDiversity(
  seeds: ScoredChunk[],
  supplemental: ScoredChunk[],
  topM: ScoredChunk[],
  minUniqueFiles: number,
  minSourceFiles: number,
): ScoredChunk[] {
  const result = [...seeds];
  const seenFiles = new Set(result.map((c) => c.filePath));

  const countSourceFiles = (): number =>
    Array.from(seenFiles).filter((f) => f.toLowerCase().startsWith('src/')).length;

  if (seenFiles.size >= minUniqueFiles && countSourceFiles() >= minSourceFiles) {
    return result;
  }

  const candidates = [...supplemental, ...topM];

  // 优先补 src/ 下的文件
  for (const chunk of candidates) {
    if (!chunk.filePath.toLowerCase().startsWith('src/')) continue;
    if (seenFiles.has(chunk.filePath)) continue;
    seenFiles.add(chunk.filePath);
    result.push(chunk);
    if (seenFiles.size >= minUniqueFiles && countSourceFiles() >= minSourceFiles) {
      return result;
    }
  }

  // 再补其他文件
  for (const chunk of candidates) {
    if (seenFiles.has(chunk.filePath)) continue;
    seenFiles.add(chunk.filePath);
    result.push(chunk);
    if (seenFiles.size >= minUniqueFiles && countSourceFiles() >= minSourceFiles) {
      break;
    }
  }

  return result;
}

function ensureSourceFileDiversity(
  seeds: ScoredChunk[],
  supplemental: ScoredChunk[],
  minSourceFiles: number,
): ScoredChunk[] {
  const result = [...seeds];
  const seenFiles = new Set(result.map((c) => c.filePath));

  const countSourceFiles = (): number =>
    Array.from(seenFiles).filter((f) => f.toLowerCase().startsWith('src/')).length;

  if (countSourceFiles() >= minSourceFiles) {
    return result;
  }

  for (const chunk of supplemental) {
    if (!chunk.filePath.toLowerCase().startsWith('src/')) continue;
    if (seenFiles.has(chunk.filePath)) continue;
    seenFiles.add(chunk.filePath);
    result.push(chunk);
    if (countSourceFiles() >= minSourceFiles) {
      break;
    }
  }

  return result;
}
