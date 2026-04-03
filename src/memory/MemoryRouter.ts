/**
 * MemoryRouter - 渐进式记忆加载核心路由器
 *
 * 使用轻量级 catalog 索引作为路由表，实现按需加载模块记忆，避免全量扫描。
 *
 * 三层加载架构：
 *   Tier 0: catalog（始终加载，路由索引，存于 SQLite 项目元数据）
 *   Tier 1: global（始终加载，公共记忆，存于 SQLite 项目元数据）
 *   Tier 2: feature memories（按需加载，存于 SQLite feature_memories）
 */

import path from 'node:path';
import { logger } from '../utils/logger.js';
import { MemoryStore } from './MemoryStore.js';
import type {
  CatalogModuleEntry,
  FeatureMemory,
  GlobalMemory,
  MemoryCatalog,
  RouteInput,
  RouteResult,
} from './types.js';

/** catalog schema 版本号 */
const CATALOG_VERSION = 1;
const DEFAULT_GLOBAL_FILES: MemoryCatalog['globalMemoryFiles'] = [
  'profile',
  'conventions',
  'cross-cutting',
  'user',
  'feedback',
  'project-state',
  'reference',
];

export class MemoryRouter {
  private static readonly instances = new Map<string, MemoryRouter>();

  static forProject(projectRoot: string): MemoryRouter {
    const normalizedRoot = path.resolve(projectRoot);
    const existing = MemoryRouter.instances.get(normalizedRoot);
    if (existing) {
      return existing;
    }

    const router = new MemoryRouter(normalizedRoot);
    MemoryRouter.instances.set(normalizedRoot, router);
    return router;
  }

  private readonly store: MemoryStore;
  private catalog: MemoryCatalog | null = null;
  private globals: Map<string, GlobalMemory> = new Map();
  private moduleCache: Map<string, FeatureMemory> = new Map();
  private initialized = false;
  private initializePromise: Promise<{
    catalog: MemoryCatalog | null;
    globals: GlobalMemory[];
  }> | null = null;

  constructor(projectRoot: string) {
    this.store = new MemoryStore(projectRoot);
  }

  // ===========================================
  // Phase 1: 初始化
  // ===========================================

  /**
   * Phase 1: 初始化 - 加载 catalog + 全局记忆
   *
   * 行为：
   * - 若 catalog 不存在，则自动从已存储的模块记忆构建（避免回退全量扫描）
   * - 统一加载 global 记忆（含旧结构兼容）
   */
  async initialize(): Promise<{
    catalog: MemoryCatalog | null;
    globals: GlobalMemory[];
  }> {
    if (this.initialized && this.catalog) {
      return {
        catalog: this.catalog,
        globals: Array.from(this.globals.values()),
      };
    }

    if (this.initializePromise) {
      return this.initializePromise;
    }

    this.initializePromise = (async () => {
      this.catalog = await this.store.readCatalog();

      if (!this.catalog) {
        logger.debug('Catalog 不存在，自动从模块记忆构建');
        this.catalog = await this.buildCatalog();
      } else if (this.ensureCatalogDefaults(this.catalog)) {
        await this.store.saveCatalog(this.catalog);
      }

      const allGlobals = await this.store.listGlobals();
      const globalMap = new Map(allGlobals.map((g) => [g.type, g]));

      this.globals.clear();
      const expectedGlobalFiles = this.catalog?.globalMemoryFiles.length
        ? this.catalog.globalMemoryFiles
        : DEFAULT_GLOBAL_FILES;

      for (const fileType of expectedGlobalFiles) {
        const globalMemory = globalMap.get(fileType as GlobalMemory['type']);
        if (globalMemory) {
          this.globals.set(globalMemory.type, globalMemory);
        }
      }

      // catalog 中未声明时，仍保留实际存在的全局记忆（兼容）
      for (const globalMemory of allGlobals) {
        if (!this.globals.has(globalMemory.type)) {
          this.globals.set(globalMemory.type, globalMemory);
        }
      }

      this.initialized = true;
      logger.debug(
        {
          moduleCount: this.catalog ? Object.keys(this.catalog.modules).length : 0,
          globalCount: this.globals.size,
        },
        'MemoryRouter 初始化完成',
      );

      return {
        catalog: this.catalog,
        globals: Array.from(this.globals.values()),
      };
    })();

    try {
      return await this.initializePromise;
    } finally {
      this.initializePromise = null;
    }
  }

  // ===========================================
  // Phase 2: 路由
  // ===========================================

  /**
   * Phase 2: 路由 - 根据输入匹配相关模块
   *
   * 匹配策略（按优先级）：
   * 1. moduleName -> 精确模块匹配
   * 2. filePaths -> triggerPaths 匹配（支持前缀与 glob）
   * 3. query -> keywords 包含匹配
   * 4. scope -> 显式加载整个 scope
   * 5. scope cascade -> 按 scope 联动加载（需显式开启）
   */
  async route(input: RouteInput): Promise<RouteResult> {
    if (!this.initialized) {
      await this.initialize();
    }

    const result: RouteResult = {
      matchedModules: [],
      memories: [],
      matchDetails: [],
    };

    if (!this.catalog) {
      logger.debug('Catalog 不可用，无法路由');
      return result;
    }

    const { modules, scopes } = this.catalog;
    const matchedSet = new Set<string>();

    // --- 策略 1: moduleName 精确匹配 ---
    if (input.moduleName) {
      const resolved = this.resolveModuleName(input.moduleName);
      if (resolved) {
        matchedSet.add(resolved);
        result.matchDetails.push({
          module: resolved,
          matchedBy: 'explicit-module',
          detail: `显式模块 "${input.moduleName}"`,
        });
      }
    }

    // --- 策略 2: filePaths -> triggerPaths 匹配 ---
    if (input.filePaths && input.filePaths.length > 0) {
      for (const [modName, entry] of Object.entries(modules)) {
        for (const fp of input.filePaths) {
          if (this.matchesTriggerPath(fp, entry.triggerPaths)) {
            matchedSet.add(modName);
            result.matchDetails.push({
              module: modName,
              matchedBy: 'path',
              detail: `文件路径 "${fp}" 命中 triggerPath`,
            });
            break;
          }
        }
      }
    }

    // --- 策略 3: query -> keywords 匹配 ---
    if (input.query) {
      for (const [modName, entry] of Object.entries(modules)) {
        if (matchedSet.has(modName)) continue;
        if (this.matchesKeyword(input.query, entry.keywords)) {
          matchedSet.add(modName);
          result.matchDetails.push({
            module: modName,
            matchedBy: 'keyword',
            detail: `查询 "${input.query}" 命中关键词`,
          });
        }
      }
    }

    // --- 策略 4: scope -> 显式加载整个 scope ---
    if (input.scope) {
      for (const [modName, entry] of Object.entries(modules)) {
        if (entry.scope === input.scope && !matchedSet.has(modName)) {
          matchedSet.add(modName);
          result.matchDetails.push({
            module: modName,
            matchedBy: 'explicit-scope',
            detail: `显式 scope "${input.scope}"`,
          });
        }
      }
    }

    // --- 策略 5: scope cascade 联动（默认关闭，避免冗余） ---
    if (input.enableScopeCascade) {
      const cascadeScopes = new Set<string>();
      for (const modName of matchedSet) {
        const entry = modules[modName];
        if (entry && scopes[entry.scope]?.cascadeLoad) {
          cascadeScopes.add(entry.scope);
        }
      }

      for (const [modName, entry] of Object.entries(modules)) {
        if (cascadeScopes.has(entry.scope) && !matchedSet.has(modName)) {
          matchedSet.add(modName);
          result.matchDetails.push({
            module: modName,
            matchedBy: 'scope-cascade',
            detail: `scope "${entry.scope}" cascade 联动加载`,
          });
        }
      }
    }

    result.matchedModules = Array.from(matchedSet);

    const loadedMemorySet = new Set<string>();
    for (const modName of result.matchedModules) {
      const memory = await this.loadModule(modName);
      if (memory) {
        const memoryKey = `${this.normalizeModuleName(memory.name)}::${this.normalizePath(memory.location.dir)}`;
        if (loadedMemorySet.has(memoryKey)) {
          continue;
        }
        loadedMemorySet.add(memoryKey);
        result.memories.push(memory);
      }
    }

    logger.debug(
      {
        matchedCount: result.matchedModules.length,
        loadedCount: result.memories.length,
      },
      '路由匹配完成',
    );

    return result;
  }

  // ===========================================
  // 模块加载（带缓存）
  // ===========================================

  /**
   * 按需加载单个模块记忆（带缓存）
   */
  async loadModule(moduleName: string): Promise<FeatureMemory | null> {
    if (!this.initialized) {
      await this.initialize();
    }

    const resolvedName = this.resolveModuleName(moduleName) ?? this.normalizeModuleName(moduleName);

    const cached = this.moduleCache.get(resolvedName);
    if (cached) {
      return cached;
    }

    let memory: FeatureMemory | null = null;
    const entry = this.catalog?.modules[resolvedName];

    if (entry?.file) {
      memory = await this.store.readFeatureByPath(entry.file);
    }

    if (!memory) {
      memory = await this.store.readFeature(resolvedName);
    }

    if (memory) {
      this.moduleCache.set(resolvedName, memory);
    }

    return memory;
  }

  /**
   * 加载整个 scope 的所有模块
   */
  async loadScope(scopeName: string): Promise<FeatureMemory[]> {
    if (!this.initialized) {
      await this.initialize();
    }

    if (!this.catalog) {
      return [];
    }

    const memories: FeatureMemory[] = [];
    for (const [modName, entry] of Object.entries(this.catalog.modules)) {
      if (entry.scope !== scopeName) continue;

      const memory = await this.loadModule(modName);
      if (memory) {
        memories.push(memory);
      }
    }

    return memories;
  }

  // ===========================================
  // Catalog 维护
  // ===========================================

  /**
   * 维护 catalog - record_memory 时调用
   * 从 FeatureMemory 提取 keywords 和 triggerPaths 自动更新路由条目
   */
  async updateCatalogEntry(moduleName: string, memory: FeatureMemory): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }

    const entry = this.buildEntryFromMemory(memory);
    const normalizedModuleName = this.normalizeModuleName(moduleName);

    if (!this.catalog) {
      this.catalog = {
        version: CATALOG_VERSION,
        globalMemoryFiles: [...DEFAULT_GLOBAL_FILES],
        modules: {},
        scopes: {},
      };
    }

    this.ensureCatalogDefaults(this.catalog);
    this.catalog.modules[normalizedModuleName] = entry;

    if (!this.catalog.scopes[entry.scope]) {
      this.catalog.scopes[entry.scope] = {
        description: `自动检测的 scope: ${entry.scope}`,
        cascadeLoad: true,
      };
    }

    await this.store.saveCatalog(this.catalog);
    this.moduleCache.set(normalizedModuleName, memory);

    logger.info({ module: normalizedModuleName, scope: entry.scope }, 'Catalog 条目已更新');
  }

  async removeCatalogEntry(moduleName: string): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }

    if (!this.catalog) {
      return;
    }

    const normalizedModuleName = this.normalizeModuleName(moduleName);
    const existingEntry = this.catalog.modules[normalizedModuleName];
    if (!existingEntry) {
      this.moduleCache.delete(normalizedModuleName);
      return;
    }

    delete this.catalog.modules[normalizedModuleName];
    this.moduleCache.delete(normalizedModuleName);

    const scopeStillUsed = Object.values(this.catalog.modules).some(
      (entry) => entry.scope === existingEntry.scope,
    );

    if (!scopeStillUsed) {
      delete this.catalog.scopes[existingEntry.scope];
    }

    await this.store.saveCatalog(this.catalog);
    logger.info({ module: normalizedModuleName, scope: existingEntry.scope }, 'Catalog 条目已删除');
  }

  /**
   * 从现有模块记忆自动构建 catalog
   * 用于首次迁移或重建索引
   */
  async buildCatalog(): Promise<MemoryCatalog> {
    const catalog: MemoryCatalog = {
      version: CATALOG_VERSION,
      globalMemoryFiles: [...DEFAULT_GLOBAL_FILES],
      modules: {},
      scopes: {},
    };

    const memories = await this.store.listFeatures();

    const scopeModuleMap = new Map<string, string[]>();

    for (const memory of memories) {
      const moduleName = this.normalizeModuleName(memory.name);
      const entry = this.buildEntryFromMemory(memory);

      catalog.modules[moduleName] = entry;

      if (!scopeModuleMap.has(entry.scope)) {
        scopeModuleMap.set(entry.scope, []);
      }
      scopeModuleMap.get(entry.scope)?.push(moduleName);
    }

    for (const [scopeName, modNames] of scopeModuleMap) {
      catalog.scopes[scopeName] = {
        description: `Scope "${scopeName}" 包含 ${modNames.length} 个模块`,
        cascadeLoad: true,
      };
    }

    await this.store.saveCatalog(catalog);
    this.catalog = catalog;

    logger.info(
      {
        moduleCount: Object.keys(catalog.modules).length,
        scopeCount: Object.keys(catalog.scopes).length,
      },
      'Catalog 构建完成',
    );

    return catalog;
  }

  // ===========================================
  // Helper / Accessor
  // ===========================================

  /** 获取已初始化的 catalog（未初始化时为 null） */
  getCatalog(): MemoryCatalog | null {
    return this.catalog;
  }

  /** 获取已加载的全局记忆 */
  getGlobals(): GlobalMemory[] {
    return Array.from(this.globals.values());
  }

  /** 清除模块缓存 */
  clearCache(): void {
    this.moduleCache.clear();
    logger.debug('模块缓存已清除');
  }

  // ===========================================
  // 私有工具方法
  // ===========================================

  /**
   * 判断 filePath 是否命中任一 triggerPath
   *
   * 支持：
   * - 精确匹配
   * - 目录前缀匹配
   * - 简单 glob（* / **）
   */
  private matchesTriggerPath(filePath: string, triggerPaths: string[]): boolean {
    const normalizedFile = this.normalizePath(filePath);

    return triggerPaths.some((tp) => {
      const normalizedTp = this.normalizePath(tp);

      if (normalizedTp.includes('*')) {
        return this.globToRegExp(normalizedTp).test(normalizedFile);
      }

      const trimmed = normalizedTp.replace(/\/$/, '');
      return normalizedFile === trimmed || normalizedFile.startsWith(trimmed + '/');
    });
  }

  /**
   * 判断 query 是否命中任一 keyword（不区分大小写的部分匹配）
   */
  private matchesKeyword(query: string, keywords: string[]): boolean {
    const rawTokens = query
      .toLowerCase()
      .split(/[\s,/_-]+/)
      .map((t) => t.trim())
      .filter(Boolean);

    const tokens = rawTokens.length > 0 ? rawTokens : [query.toLowerCase()];

    return keywords.some((k) => {
      const lowerKeyword = k.toLowerCase();
      return tokens.some((token) => {
        if (token.length < 2) {
          return false;
        }
        if (lowerKeyword.includes(token)) {
          return true;
        }
        return token.length >= 5 && token.includes(lowerKeyword);
      });
    });
  }

  /**
   * 从 FeatureMemory 构建 CatalogModuleEntry
   */
  private buildEntryFromMemory(memory: FeatureMemory): CatalogModuleEntry {
    const fileName = `${this.normalizeModuleName(memory.name)}.json`;
    const scope = this.inferScope(memory.location.dir);

    const keywordSet = new Set<string>();
    keywordSet.add(memory.name);
    for (const kp of memory.keyPatterns) {
      keywordSet.add(kp);
    }
    for (const exp of memory.api.exports) {
      keywordSet.add(exp);
    }

    const triggerPathSet = new Set<string>();
    const normalizedDir = this.normalizePath(memory.location.dir).replace(/\/$/, '');

    if (normalizedDir) {
      triggerPathSet.add(`${normalizedDir}/`);
    }

    for (const file of memory.location.files) {
      const normalizedFile = this.normalizePath(file);
      if (!normalizedFile) continue;

      if (normalizedFile.includes('/')) {
        triggerPathSet.add(normalizedFile);
      } else if (normalizedDir) {
        triggerPathSet.add(`${normalizedDir}/${normalizedFile}`.replace(/\/{2,}/g, '/'));
      } else {
        triggerPathSet.add(normalizedFile);
      }
    }

    return {
      file: `features/${fileName}`,
      scope,
      keywords: Array.from(keywordSet),
      triggerPaths: Array.from(triggerPathSet),
      lastUpdated: memory.lastUpdated,
    };
  }

  /**
   * 从目录路径推导 scope 名称
   */
  private inferScope(dir: string): string {
    if (!dir) return 'default';

    const cleaned = this.normalizePath(dir)
      .replace(/\/+$/, '')
      .replace(/^src\/+/, '');

    if (!cleaned) return 'root';

    return cleaned.replace(/\//g, '-');
  }

  private normalizeModuleName(moduleName: string): string {
    return moduleName.trim().toLowerCase().replace(/\s+/g, '-');
  }

  private normalizePath(rawPath: string): string {
    return rawPath.replace(/\\/g, '/').replace(/^\.\//, '').trim();
  }

  private resolveModuleName(moduleName: string): string | null {
    if (!this.catalog) {
      return this.normalizeModuleName(moduleName);
    }

    const trimmed = moduleName.trim();
    if (this.catalog.modules[trimmed]) {
      return trimmed;
    }

    const normalized = this.normalizeModuleName(moduleName);
    if (this.catalog.modules[normalized]) {
      return normalized;
    }

    const lowerInput = moduleName.toLowerCase().trim();

    for (const [key, entry] of Object.entries(this.catalog.modules)) {
      if (key.toLowerCase() === lowerInput) {
        return key;
      }

      if (entry.keywords.some((keyword) => keyword.toLowerCase() === lowerInput)) {
        return key;
      }
    }

    return null;
  }

  private globToRegExp(globPattern: string): RegExp {
    const DOUBLE_STAR = '__CW_DOUBLE_STAR__';
    const SINGLE_STAR = '__CW_SINGLE_STAR__';

    let pattern = globPattern.replace(/\*\*/g, DOUBLE_STAR).replace(/\*/g, SINGLE_STAR);

    pattern = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replaceAll(DOUBLE_STAR, '.*')
      .replaceAll(SINGLE_STAR, '[^/]*');

    return new RegExp(`^${pattern}$`);
  }

  /** 确保 catalog 默认字段存在（含全局记忆清单） */
  private ensureCatalogDefaults(catalog: MemoryCatalog): boolean {
    let changed = false;

    if (!catalog.globalMemoryFiles || catalog.globalMemoryFiles.length === 0) {
      catalog.globalMemoryFiles = [...DEFAULT_GLOBAL_FILES];
      changed = true;
    } else {
      const merged = Array.from(new Set([...catalog.globalMemoryFiles, ...DEFAULT_GLOBAL_FILES]));
      if (merged.length !== catalog.globalMemoryFiles.length) {
        catalog.globalMemoryFiles = merged;
        changed = true;
      }
    }

    if (!catalog.scopes) {
      catalog.scopes = {};
      changed = true;
    }

    if (!catalog.modules) {
      catalog.modules = {};
      changed = true;
    }

    return changed;
  }
}
