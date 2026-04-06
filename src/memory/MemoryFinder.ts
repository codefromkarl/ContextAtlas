/**
 * MemoryFinder - 功能记忆查找器
 *
 * 使用关键词 + 标签匹配进行快速查找，无需向量检索
 * 目标：50ms 内返回结果
 *
 * 路由模式：当 catalog 可用时，通过 MemoryRouter 按需加载模块记忆
 * 降级模式：路由失败时，回退到存储层全量遍历（向后兼容）
 */

import { logger } from '../utils/logger.js';
import { MemoryRouter } from './MemoryRouter.js';
import { MemoryStore } from './MemoryStore.js';
import type { FeatureMemory, MemorySearchResult, FindOptions, RouteInput } from './types.js';

export class MemoryFinder {
  private router: MemoryRouter;
  private store: MemoryStore;

  constructor(projectRoot: string) {
    this.router = MemoryRouter.forProject(projectRoot);
    this.store = new MemoryStore(projectRoot);
  }

  /**
   * 初始化路由器（加载 catalog + global 记忆）
   *
   * 在首次 find() 调用时自动触发，也可由调用方显式调用
   */
  async initialize(): Promise<void> {
    await this.router.initialize();
  }

  // ===========================================
  // 核心查找方法
  // ===========================================

  /**
   * 核心方法：查找记忆
   *
   * 路由模式：catalog 可用时，使用 MemoryRouter 按需加载
   * 降级模式：catalog 不可用时，回退到全量遍历（向后兼容）
   */
  async find(query: string, options?: FindOptions): Promise<MemorySearchResult[]> {
    // 确保路由器已初始化（包含首次自动构建 catalog）
    await this.initialize();
    const loadedCatalog = this.router.getCatalog();

    // 路由模式：catalog 存在，使用路由器按需加载
    if (loadedCatalog) {
      return this.findByRouter(query, options);
    }

    // 降级模式：catalog 不可用，全量遍历
    return this.findLegacy(query, options);
  }

  /**
   * 路由模式查找：使用 MemoryRouter 按需加载匹配模块
   *
   * 优势：仅加载 catalog 中匹配的模块，避免全量 I/O
   */
  private async findByRouter(query: string, options?: FindOptions): Promise<MemorySearchResult[]> {
    const queryLower = query.toLowerCase();

    try {
      const routeInput: RouteInput = { query };
      const routeResult = await this.router.route(routeInput);

      if (routeResult.memories.length === 0) {
        return [];
      }

      // 对路由返回的记忆重新计算精确匹配分数
      const results: MemorySearchResult[] = [];

      for (const memory of routeResult.memories) {
        if (memory.confirmationStatus === 'suggested') {
          continue;
        }
        const { score, matchFields } = this.calculateScore(memory, queryLower);

        if (score > 0) {
          results.push({ memory, score, matchFields });
        }
      }

      // 按分数排序
      results.sort((a, b) => b.score - a.score);

      // 应用选项
      const { minScore = 0, limit = 10 } = options ?? {};
      return results
        .filter(r => r.score >= minScore)
        .slice(0, limit);
    } catch (err) {
      logger.warn(
        { error: (err as Error).message },
        '路由模式查找失败，降级到全量扫描',
      );
      return this.findLegacy(query, options);
    }
  }

  /**
   * 降级模式：全量遍历查找（向后兼容）
   *
   * 当 catalog 不可用时，遍历当前项目已存储的全部模块记忆
   */
  private async findLegacy(query: string, options?: FindOptions): Promise<MemorySearchResult[]> {
    const memories = await this.store.listFeatures();
    const queryLower = query.toLowerCase();
    const results: MemorySearchResult[] = [];

    for (const memory of memories) {
      if (memory.confirmationStatus === 'suggested') {
        continue;
      }
      const { score, matchFields } = this.calculateScore(memory, queryLower);

      if (score > 0) {
        results.push({ memory, score, matchFields });
      }
    }

    // 按分数排序
    results.sort((a, b) => b.score - a.score);

    // 应用选项
    const { minScore = 0, limit = 10 } = options ?? {};
    return results
      .filter(r => r.score >= minScore)
      .slice(0, limit);
  }

  // ===========================================
  // 精确查找 / 辅助方法
  // ===========================================

  /**
   * 计算记忆与查询的匹配分数
   */
  private calculateScore(
    memory: FeatureMemory,
    queryLower: string,
  ): { score: number; matchFields: string[] } {
    let score = 0;
    const matchFields: string[] = [];

    // 名称匹配（权重最高）
    if (memory.name.toLowerCase().includes(queryLower)) {
      score += 20;
      matchFields.push('name');
    }

    // 职责描述匹配
    if (memory.responsibility.toLowerCase().includes(queryLower)) {
      score += 10;
      matchFields.push('responsibility');
    }

    // 关键模式匹配
    const patternMatches = memory.keyPatterns.filter(p =>
      p.toLowerCase().includes(queryLower),
    );
    if (patternMatches.length > 0) {
      score += 5 * patternMatches.length;
      matchFields.push('keyPatterns');
    }

    // API 导出匹配
    const exportMatches = memory.api.exports.filter(e =>
      e.toLowerCase().includes(queryLower),
    );
    if (exportMatches.length > 0) {
      score += 3 * exportMatches.length;
      matchFields.push('exports');
    }

    // 数据流匹配
    if (memory.dataFlow.toLowerCase().includes(queryLower)) {
      score += 5;
      matchFields.push('dataFlow');
    }

    // 依赖匹配
    const importMatches = memory.dependencies.imports.filter(i =>
      i.toLowerCase().includes(queryLower),
    );
    if (importMatches.length > 0) {
      score += 2 * importMatches.length;
      matchFields.push('imports');
    }

    score += getConfirmationStatusScore(memory.confirmationStatus);
    return { score, matchFields };
  }

  /**
   * 按模块名称精确查找
   */
  async findByName(moduleName: string): Promise<FeatureMemory | null> {
    await this.initialize();

    // 优先走路由器（支持 catalog key / entry.file / 缓存）
    const routed = await this.router.loadModule(moduleName);
    if (routed) {
      return routed;
    }

    return this.store.readFeature(moduleName);
  }

  /**
   * 获取模块详细依赖
   */
  async getDependencies(moduleName: string): Promise<{
    imports: string[];
    external: string[];
  } | null> {
    const memory = await this.findByName(moduleName);
    return memory?.dependencies ?? null;
  }

  /**
   * 列出所有功能记忆
   */
  async listAll(): Promise<FeatureMemory[]> {
    const memories = await this.store.listFeatures();
    return memories.sort((a, b) =>
      new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime()
    );
  }
}

function getConfirmationStatusScore(
  status: FeatureMemory['confirmationStatus'],
): number {
  switch (status) {
    case 'human-confirmed':
      return 6;
    case 'agent-inferred':
      return 2;
    case 'suggested':
      return -100;
    default:
      return 4;
  }
}
