/**
 * MemoryStoreProvider — 可选的 MemoryStore 实例缓存
 *
 * 在 MCP server 或 CLI session 生命周期内复用同一个 MemoryStore。
 * 消除同一 repo 重复创建 store 的开销。
 *
 * 使用方式：
 * ```ts
 * const provider = new MemoryStoreProvider();
 * const store = await provider.getStore('/path/to/repo');
 * ```
 *
 * 不使用 provider 时，`new MemoryStore(repoPath)` 仍然完全有效。
 */

import { MemoryStore } from './MemoryStore.js';

export class MemoryStoreProvider {
  private readonly cache = new Map<string, MemoryStore>();

  /**
   * 获取或创建项目 MemoryStore
   *
   * 同一 repoPath 返回同一个实例。
   */
  getStore(repoPath: string): MemoryStore {
    const normalized = repoPath.replace(/\\/g, '/').replace(/\/+$/, '');
    const existing = this.cache.get(normalized);
    if (existing) {
      return existing;
    }

    const store = new MemoryStore(normalized);
    this.cache.set(normalized, store);
    return store;
  }

  /**
   * 清除缓存（用于测试或 session 结束）
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * 是否有缓存的 store
   */
  hasStore(repoPath: string): boolean {
    return this.cache.has(repoPath.replace(/\\/g, '/').replace(/\/+$/, ''));
  }
}
