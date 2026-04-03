/**
 * MemoryStore - 功能记忆存储管理（SQLite 后端）
 *
 * 单一真相源：~/.contextatlas/memory-hub.db
 * 兼容策略：首次初始化可从旧 .project-memory 目录自动导入。
 */

import crypto from 'node:crypto';
import path from 'node:path';
import { generateProjectId } from '../db/index.js';
import { logger } from '../utils/logger.js';
import { importLegacyProjectMemoryIfNeeded } from './LegacyMemoryImporter.js';
import { type FeatureMemoryRow, MemoryHubDatabase } from './MemoryHubDatabase.js';
import { MemoryRouter } from './MemoryRouter.js';
import type {
  DecisionRecord,
  FeatureMemory,
  GlobalMemory,
  GlobalMemoryType,
  LongTermMemoryItem,
  LongTermMemoryScope,
  LongTermMemorySearchResult,
  LongTermMemoryStatus,
  LongTermMemoryType,
  MemoryCatalog,
  ProjectProfile,
  ResolvedLongTermMemoryItem,
} from './types.js';

const CATALOG_META_KEY = 'catalog';
const GLOBAL_META_PREFIX = 'global:';
const GLOBAL_USER_MEMORY_PATH = 'contextatlas://agent-memory/global-user';
const GLOBAL_USER_MEMORY_NAME = 'ContextAtlas Global User Memory';
const DEFAULT_LONG_TERM_MEMORY_STALE_DAYS = 30;

export class MemoryStore {
  private static sharedHub: MemoryHubDatabase | null = null;

  static setSharedHubForTests(hub: MemoryHubDatabase | null): void {
    MemoryStore.sharedHub = hub;
  }

  static resetSharedHubForTests(): void {
    MemoryStore.sharedHub = null;
  }

  private readonly projectRoot: string;
  private projectId: string;
  private readonly projectName: string;
  private readonly hub: MemoryHubDatabase;
  private readInitialized = false;
  private writeInitialized = false;

  constructor(projectRoot: string) {
    this.projectRoot = path.resolve(projectRoot);
    this.projectId = generateProjectId(this.projectRoot);
    this.projectName = path.basename(this.projectRoot) || this.projectId;

    if (!MemoryStore.sharedHub) {
      MemoryStore.sharedHub = new MemoryHubDatabase();
    }
    this.hub = MemoryStore.sharedHub;
  }

  /** 当前项目 ID（SQLite 主键） */
  getProjectId(): string {
    return this.projectId;
  }

  /**
   * 只读初始化：不触发项目注册与导入
   */
  async initializeReadOnly(): Promise<void> {
    if (this.readInitialized) {
      return;
    }

    const existingProject = this.hub.getProjectByPath(this.projectRoot);
    if (existingProject) {
      this.projectId = existingProject.id;
    }

    this.readInitialized = true;
  }

  /**
   * 可写初始化：确保项目已注册，并在首次时尝试导入旧文件记忆
   */
  async initializeWritable(): Promise<void> {
    if (this.writeInitialized) {
      return;
    }

    const project = this.hub.ensureProject({
      path: this.projectRoot,
      name: this.projectName,
    });
    this.projectId = project.id;

    await this.initializeReadOnly();

    await importLegacyProjectMemoryIfNeeded({
      projectRoot: this.projectRoot,
      projectId: this.projectId,
      hub: this.hub,
      catalogMetaKey: CATALOG_META_KEY,
      globalMetaPrefix: GLOBAL_META_PREFIX,
    });

    this.writeInitialized = true;
    logger.info({ projectId: this.projectId }, 'Project Memory SQLite 存储初始化完成');
  }

  async initialize(): Promise<void> {
    await this.initializeWritable();
  }

  private hasProject(): boolean {
    return this.hub.getProject(this.projectId) !== null;
  }

  // ===========================================
  // Feature Memory CRUD
  // ===========================================

  async saveFeature(memory: FeatureMemory): Promise<string> {
    await this.initializeWritable();

    this.hub.saveMemory({
      project_id: this.projectId,
      name: memory.name,
      responsibility: memory.responsibility,
      location_dir: memory.location.dir,
      location_files: memory.location.files,
      api_exports: memory.api.exports,
      api_endpoints: memory.api.endpoints || [],
      dependencies: memory.dependencies,
      data_flow: memory.dataFlow,
      key_patterns: memory.keyPatterns,
      memory_type: memory.memoryType || 'local',
    });

    const router = MemoryRouter.forProject(this.projectRoot);
    await router.updateCatalogEntry(memory.name, memory);

    logger.info({ name: memory.name, projectId: this.projectId }, '功能记忆已保存到 SQLite');
    return `sqlite://memory-hub.db#project=${this.projectId}&module=${encodeURIComponent(memory.name)}`;
  }

  async readFeature(moduleName: string): Promise<FeatureMemory | null> {
    await this.initializeReadOnly();

    if (!this.hasProject()) {
      return null;
    }

    const exact = this.hub.getMemory(this.projectId, moduleName);
    if (exact) {
      return this.mapRowToFeature(exact);
    }

    const normalizedQuery = this.normalizeModuleName(moduleName);
    const rows = this.hub.listMemories(this.projectId);
    const matched = rows.find((row) => this.normalizeModuleName(row.name) === normalizedQuery);

    return matched ? this.mapRowToFeature(matched) : null;
  }

  /**
   * 按相对路径读取功能记忆（如 "features/search-service.json"）
   */
  async readFeatureByPath(relativePath: string): Promise<FeatureMemory | null> {
    await this.initializeReadOnly();

    if (!this.hasProject()) {
      return null;
    }

    const normalizedPath = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');

    if (normalizedPath.startsWith('features/')) {
      const basename = path.basename(normalizedPath, '.json');
      const rows = this.hub.listMemories(this.projectId);
      const matched = rows.find((row) => this.normalizeModuleName(row.name) === basename);
      if (matched) {
        return this.mapRowToFeature(matched);
      }
    }

    const rows = this.hub.listMemories(this.projectId);
    const candidates = rows.flatMap((row) => {
      const locationFiles = this.parseJson<string[]>(row.location_files, []);
      const dir = row.location_dir.replace(/\\/g, '/').replace(/\/$/, '');

      return locationFiles.map((file) => ({
        row,
        fullPath: `${dir}/${file}`.replace(/\/{2,}/g, '/'),
        basename: path.basename(file.replace(/\\/g, '/')),
      }));
    });

    const exact = candidates.find((candidate) => candidate.fullPath === normalizedPath);
    if (exact) {
      return this.mapRowToFeature(exact.row);
    }

    // 仅当 basename 唯一时，允许 basename 回退匹配，避免同名文件误召回
    if (!normalizedPath.includes('/')) {
      const byBasename = candidates.filter((candidate) => candidate.basename === normalizedPath);
      if (byBasename.length === 1) {
        return this.mapRowToFeature(byBasename[0].row);
      }
      return null;
    }

    const bySuffix = candidates.filter((candidate) =>
      candidate.fullPath.endsWith(`/${normalizedPath}`),
    );
    if (bySuffix.length === 1) {
      return this.mapRowToFeature(bySuffix[0].row);
    }

    return null;
  }

  async updateFeature(
    moduleName: string,
    updates: Partial<FeatureMemory>,
  ): Promise<FeatureMemory | null> {
    const existing = await this.readFeature(moduleName);
    if (!existing) {
      return null;
    }

    const updated: FeatureMemory = {
      ...existing,
      ...updates,
      location: {
        ...existing.location,
        ...(updates.location || {}),
      },
      api: {
        ...existing.api,
        ...(updates.api || {}),
      },
      dependencies: {
        ...existing.dependencies,
        ...(updates.dependencies || {}),
      },
      lastUpdated: new Date().toISOString(),
    };

    await this.saveFeature(updated);
    return updated;
  }

  async deleteFeature(moduleName: string): Promise<boolean> {
    await this.initializeWritable();

    const existing = await this.readFeature(moduleName);
    if (!existing) {
      return false;
    }

    const deleted = this.hub.deleteMemory(this.projectId, existing.name);
    if (deleted) {
      const router = MemoryRouter.forProject(this.projectRoot);
      await router.removeCatalogEntry(existing.name);
      logger.info({ module: existing.name, projectId: this.projectId }, '功能记忆已删除');
    }
    return deleted;
  }

  async listFeatures(): Promise<FeatureMemory[]> {
    await this.initializeReadOnly();
    if (!this.hasProject()) {
      return [];
    }
    return this.hub.listMemories(this.projectId).map((row) => this.mapRowToFeature(row));
  }

  // ===========================================
  // Decision Record CRUD
  // ===========================================

  async saveDecision(decision: DecisionRecord): Promise<string> {
    await this.initializeWritable();

    const contextPayload = JSON.stringify({
      context: decision.context,
      alternatives: decision.alternatives,
      consequences: decision.consequences,
      date: decision.date,
    });

    this.hub.saveDecision({
      project_id: this.projectId,
      decision_id: decision.id,
      title: decision.title,
      context: contextPayload,
      decision: decision.decision,
      rationale: decision.rationale,
      status: decision.status,
    });

    logger.info({ id: decision.id, projectId: this.projectId }, '决策记录已保存到 SQLite');
    return `sqlite://memory-hub.db#project=${this.projectId}&decision=${encodeURIComponent(decision.id)}`;
  }

  async readDecision(decisionId: string): Promise<DecisionRecord | null> {
    await this.initializeReadOnly();

    if (!this.hasProject()) {
      return null;
    }

    const row = this.hub.getDecision(this.projectId, decisionId) as Record<string, unknown> | null;
    if (!row) {
      return null;
    }

    const contextPayload = this.parseJson<Record<string, unknown>>(
      typeof row.context === 'string' ? row.context : '',
      {},
    );

    return {
      id: String(row.decision_id ?? decisionId),
      date: String(contextPayload.date ?? row.created_at ?? new Date().toISOString().split('T')[0]),
      title: String(row.title ?? ''),
      context: String(contextPayload.context ?? ''),
      decision: String(row.decision ?? ''),
      alternatives: this.parseAlternatives(contextPayload.alternatives),
      rationale: String(row.rationale ?? ''),
      consequences: this.parseStringArray(contextPayload.consequences),
      status: (row.status as DecisionRecord['status']) || 'accepted',
    };
  }

  async listDecisions(): Promise<DecisionRecord[]> {
    await this.initializeReadOnly();

    if (!this.hasProject()) {
      return [];
    }

    const rows = this.hub.listDecisions(this.projectId) as Array<Record<string, unknown>>;
    return rows
      .map((row) => {
        const contextPayload = this.parseJson<Record<string, unknown>>(
          typeof row.context === 'string' ? row.context : '',
          {},
        );

        return {
          id: String(row.decision_id ?? ''),
          date: String(
            contextPayload.date ?? row.created_at ?? new Date().toISOString().split('T')[0],
          ),
          title: String(row.title ?? ''),
          context: String(contextPayload.context ?? ''),
          decision: String(row.decision ?? ''),
          alternatives: this.parseAlternatives(contextPayload.alternatives),
          rationale: String(row.rationale ?? ''),
          consequences: this.parseStringArray(contextPayload.consequences),
          status: (row.status as DecisionRecord['status']) || 'accepted',
        };
      })
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }

  // ===========================================
  // Project Profile
  // ===========================================

  async saveProfile(profile: ProjectProfile): Promise<string> {
    await this.initializeWritable();
    return this.saveGlobal('profile', profile as unknown as Record<string, unknown>);
  }

  async readProfile(): Promise<ProjectProfile | null> {
    const globalProfile = await this.readGlobal('profile');
    if (!globalProfile?.data) {
      return null;
    }

    return globalProfile.data as unknown as ProjectProfile;
  }

  // ===========================================
  // Catalog (Tier 0 路由索引)
  // ===========================================

  async saveCatalog(catalog: MemoryCatalog): Promise<string> {
    await this.initializeWritable();
    this.hub.setProjectMeta(this.projectId, CATALOG_META_KEY, JSON.stringify(catalog));
    logger.info(
      { version: catalog.version, projectId: this.projectId },
      'Catalog 索引已保存到 SQLite',
    );
    return `sqlite://memory-hub.db#project=${this.projectId}&meta=${CATALOG_META_KEY}`;
  }

  async readCatalog(): Promise<MemoryCatalog | null> {
    await this.initializeReadOnly();

    if (!this.hasProject()) {
      return null;
    }

    const raw = this.hub.getProjectMeta(this.projectId, CATALOG_META_KEY);
    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw) as MemoryCatalog;
    } catch {
      return null;
    }
  }

  // ===========================================
  // Global Memory (Tier 1 全局记忆)
  // ===========================================

  async saveGlobal(type: GlobalMemoryType, data: Record<string, unknown>): Promise<string> {
    await this.initializeWritable();

    const globalMemory: GlobalMemory = {
      type,
      data,
      lastUpdated: new Date().toISOString(),
    };

    this.hub.setProjectMeta(
      this.projectId,
      `${GLOBAL_META_PREFIX}${type}`,
      JSON.stringify(globalMemory),
    );

    logger.info({ type, projectId: this.projectId }, '全局记忆已保存到 SQLite');
    return `sqlite://memory-hub.db#project=${this.projectId}&meta=${GLOBAL_META_PREFIX}${type}`;
  }

  async readGlobal(type: string): Promise<GlobalMemory | null> {
    await this.initializeReadOnly();

    if (!this.hasProject()) {
      return null;
    }

    const raw = this.hub.getProjectMeta(this.projectId, `${GLOBAL_META_PREFIX}${type}`);
    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw) as GlobalMemory;
    } catch {
      return null;
    }
  }

  async listGlobals(): Promise<GlobalMemory[]> {
    await this.initializeReadOnly();

    if (!this.hasProject()) {
      return [];
    }

    const rows = this.hub.listProjectMeta(this.projectId, GLOBAL_META_PREFIX);
    const globals: GlobalMemory[] = [];

    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.meta_value) as GlobalMemory;
        globals.push(parsed);
      } catch {
        // 跳过损坏项
      }
    }

    return globals;
  }

  // ===========================================
  // Long-term Memory
  // ===========================================

  async appendLongTermMemoryItem(
    input: Omit<LongTermMemoryItem, 'id' | 'createdAt' | 'updatedAt'> & {
      id?: string;
      createdAt?: string;
      updatedAt?: string;
    },
  ): Promise<LongTermMemoryItem> {
    const now = new Date().toISOString();
    const item: LongTermMemoryItem = {
      ...input,
      id: input.id || crypto.randomUUID(),
      createdAt: input.createdAt || now,
      updatedAt: input.updatedAt || now,
    };

    const items = await this.readLongTermMemory(item.type, item.scope);
    const existingIndex = items.findIndex((entry) => entry.id === item.id);
    if (existingIndex >= 0) {
      const previous = items[existingIndex];
      items[existingIndex] = {
        ...previous,
        ...item,
        createdAt: previous?.createdAt || item.createdAt,
        updatedAt: now,
      };
      await this.saveLongTermMemory(item.type, item.scope, items);
      return items[existingIndex] || item;
    }

    items.push(item);
    await this.saveLongTermMemory(item.type, item.scope, items);
    return item;
  }

  async readLongTermMemory(
    type: LongTermMemoryType,
    scope: LongTermMemoryScope,
  ): Promise<LongTermMemoryItem[]> {
    const projectId = await this.resolveScopeProjectId(scope, false);
    if (!projectId) {
      return [];
    }

    const raw = this.hub.getProjectMeta(projectId, `${GLOBAL_META_PREFIX}${type}`);
    if (!raw) {
      return [];
    }

    try {
      const parsed = JSON.parse(raw) as GlobalMemory;
      return this.extractLongTermMemoryItems(parsed, type, scope);
    } catch {
      return [];
    }
  }

  async listLongTermMemories(options?: {
    types?: LongTermMemoryType[];
    scope?: LongTermMemoryScope;
    includeExpired?: boolean;
    staleDays?: number;
  }): Promise<ResolvedLongTermMemoryItem[]> {
    const requestedTypes = options?.types?.length
      ? options.types
      : (['user', 'feedback', 'project-state', 'reference'] as LongTermMemoryType[]);
    const requestedScopes = options?.scope
      ? [options.scope]
      : (['project', 'global-user'] as LongTermMemoryScope[]);

    const results: ResolvedLongTermMemoryItem[] = [];
    for (const scope of requestedScopes) {
      for (const type of requestedTypes) {
        const items = await this.readLongTermMemory(type, scope);
        const resolved = items
          .map((item) => this.resolveLongTermMemory(item, options?.staleDays))
          .filter((item) => options?.includeExpired || item.status !== 'expired');
        results.push(...resolved);
      }
    }

    return results.sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }

  async findLongTermMemories(
    query: string,
    options?: {
      types?: LongTermMemoryType[];
      scope?: LongTermMemoryScope;
      limit?: number;
      minScore?: number;
      includeExpired?: boolean;
      staleDays?: number;
    },
  ): Promise<LongTermMemorySearchResult[]> {
    const queryLower = query.toLowerCase();
    const items = await this.listLongTermMemories({
      types: options?.types,
      scope: options?.scope,
      includeExpired: options?.includeExpired,
      staleDays: options?.staleDays,
    });

    const results: LongTermMemorySearchResult[] = [];
    for (const item of items) {
      const { score, matchFields } = this.calculateLongTermMemoryScore(item, queryLower);
      if (score > 0) {
        results.push({ memory: item, score, matchFields });
      }
    }

    const minScore = options?.minScore ?? 0;
    const limit = options?.limit ?? 20;

    return results
      .filter((entry) => entry.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async deleteLongTermMemoryItem(
    type: LongTermMemoryType,
    scope: LongTermMemoryScope,
    id: string,
  ): Promise<boolean> {
    const items = await this.readLongTermMemory(type, scope);
    const filtered = items.filter((entry) => entry.id !== id);
    if (filtered.length === items.length) {
      return false;
    }

    await this.saveLongTermMemory(type, scope, filtered);
    return true;
  }

  async pruneLongTermMemories(options?: {
    types?: LongTermMemoryType[];
    scope?: LongTermMemoryScope;
    includeExpired?: boolean;
    includeStale?: boolean;
    staleDays?: number;
    dryRun?: boolean;
  }): Promise<{
    scannedCount: number;
    prunedCount: number;
    pruned: ResolvedLongTermMemoryItem[];
  }> {
    const requestedTypes = options?.types?.length
      ? options.types
      : (['user', 'feedback', 'project-state', 'reference'] as LongTermMemoryType[]);
    const requestedScopes = options?.scope
      ? [options.scope]
      : (['project', 'global-user'] as LongTermMemoryScope[]);

    const pruned: ResolvedLongTermMemoryItem[] = [];
    let scannedCount = 0;

    for (const scope of requestedScopes) {
      for (const type of requestedTypes) {
        const items = await this.readLongTermMemory(type, scope);
        scannedCount += items.length;

        const resolvedItems = items.map((item) =>
          this.resolveLongTermMemory(item, options?.staleDays),
        );
        const itemsToPrune = resolvedItems.filter((item) =>
          this.shouldPruneLongTermMemory(item, options),
        );

        if (itemsToPrune.length === 0) {
          continue;
        }

        pruned.push(...itemsToPrune);

        if (!options?.dryRun) {
          const prunedIds = new Set(itemsToPrune.map((item) => item.id));
          const keptItems = items.filter((item) => !prunedIds.has(item.id));
          await this.saveLongTermMemory(type, scope, keptItems);
        }
      }
    }

    return {
      scannedCount,
      prunedCount: pruned.length,
      pruned: pruned.sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      ),
    };
  }

  // ===========================================
  // Internal helpers
  // ===========================================

  private async saveLongTermMemory(
    type: LongTermMemoryType,
    scope: LongTermMemoryScope,
    items: LongTermMemoryItem[],
  ): Promise<string> {
    const projectId = await this.resolveScopeProjectId(scope, true);
    if (!projectId) {
      throw new Error(`Unable to resolve project for long-term memory scope: ${scope}`);
    }
    const data = { items };
    const globalMemory: GlobalMemory = {
      type,
      data,
      lastUpdated: new Date().toISOString(),
    };

    this.hub.setProjectMeta(
      projectId,
      `${GLOBAL_META_PREFIX}${type}`,
      JSON.stringify(globalMemory),
    );

    return `sqlite://memory-hub.db#project=${projectId}&meta=${GLOBAL_META_PREFIX}${type}`;
  }

  private async resolveScopeProjectId(
    scope: LongTermMemoryScope,
    ensureWritable: boolean,
  ): Promise<string | null> {
    if (scope === 'project') {
      if (ensureWritable) {
        await this.initializeWritable();
      } else {
        await this.initializeReadOnly();
      }

      return this.hasProject() ? this.projectId : null;
    }

    if (ensureWritable) {
      return this.hub.ensureProject({
        path: GLOBAL_USER_MEMORY_PATH,
        name: GLOBAL_USER_MEMORY_NAME,
      }).id;
    }

    const globalProject = this.hub.getProjectByPath(GLOBAL_USER_MEMORY_PATH);
    return globalProject?.id || null;
  }

  private extractLongTermMemoryItems(
    globalMemory: GlobalMemory,
    type: LongTermMemoryType,
    scope: LongTermMemoryScope,
  ): LongTermMemoryItem[] {
    const container = globalMemory.data as { items?: unknown };
    const rawItems = Array.isArray(container.items) ? container.items : [];
    return rawItems.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') {
        return [];
      }

      const item = entry as Partial<LongTermMemoryItem>;
      if (!item.id || !item.title || !item.summary) {
        return [];
      }

      return [
        {
          id: String(item.id),
          type: (item.type as LongTermMemoryType) || type,
          title: String(item.title),
          summary: String(item.summary),
          why: item.why ? String(item.why) : undefined,
          howToApply: item.howToApply ? String(item.howToApply) : undefined,
          tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
          scope: (item.scope as LongTermMemoryScope) || scope,
          source: (item.source as LongTermMemoryItem['source']) || 'agent-inferred',
          confidence:
            typeof item.confidence === 'number' ? item.confidence : Number(item.confidence ?? 0.5),
          links: Array.isArray(item.links) ? item.links.map(String) : [],
          validFrom: item.validFrom ? String(item.validFrom) : undefined,
          validUntil: item.validUntil ? String(item.validUntil) : undefined,
          lastVerifiedAt: item.lastVerifiedAt ? String(item.lastVerifiedAt) : undefined,
          createdAt: item.createdAt ? String(item.createdAt) : globalMemory.lastUpdated,
          updatedAt: item.updatedAt ? String(item.updatedAt) : globalMemory.lastUpdated,
        },
      ];
    });
  }

  private calculateLongTermMemoryScore(
    memory: ResolvedLongTermMemoryItem,
    queryLower: string,
  ): { score: number; matchFields: string[] } {
    let score = 0;
    const matchFields: string[] = [];

    if (memory.title.toLowerCase().includes(queryLower)) {
      score += 20;
      matchFields.push('title');
    }

    if (memory.summary.toLowerCase().includes(queryLower)) {
      score += 12;
      matchFields.push('summary');
    }

    if (memory.why?.toLowerCase().includes(queryLower)) {
      score += 6;
      matchFields.push('why');
    }

    if (memory.howToApply?.toLowerCase().includes(queryLower)) {
      score += 6;
      matchFields.push('howToApply');
    }

    const tagMatches = memory.tags.filter((tag) => tag.toLowerCase().includes(queryLower));
    if (tagMatches.length > 0) {
      score += tagMatches.length * 4;
      matchFields.push('tags');
    }

    const linkMatches = (memory.links || []).filter((link) =>
      link.toLowerCase().includes(queryLower),
    );
    if (linkMatches.length > 0) {
      score += linkMatches.length * 2;
      matchFields.push('links');
    }

    if (memory.type.toLowerCase().includes(queryLower)) {
      score += 2;
      matchFields.push('type');
    }

    return { score, matchFields };
  }

  private resolveLongTermMemory(
    memory: LongTermMemoryItem,
    staleDays = DEFAULT_LONG_TERM_MEMORY_STALE_DAYS,
  ): ResolvedLongTermMemoryItem {
    return {
      ...memory,
      status: this.getLongTermMemoryStatus(memory, staleDays),
    };
  }

  private getLongTermMemoryStatus(
    memory: LongTermMemoryItem,
    staleDays = DEFAULT_LONG_TERM_MEMORY_STALE_DAYS,
  ): LongTermMemoryStatus {
    if (this.isMemoryExpired(memory.validUntil)) {
      return 'expired';
    }

    const staleThresholdMs = Math.max(staleDays, 1) * 24 * 60 * 60 * 1000;
    const referenceTime =
      this.parseMemoryDate(memory.lastVerifiedAt) ??
      this.parseMemoryDate(memory.updatedAt) ??
      this.parseMemoryDate(memory.createdAt);

    if (referenceTime && Date.now() - referenceTime.getTime() > staleThresholdMs) {
      return 'stale';
    }

    return 'active';
  }

  private isMemoryExpired(validUntil?: string): boolean {
    const expiryTime = this.parseMemoryDate(validUntil, { endOfDay: true });
    if (!expiryTime) {
      return false;
    }
    return expiryTime.getTime() < Date.now();
  }

  private parseMemoryDate(value?: string, options?: { endOfDay?: boolean }): Date | null {
    if (!value) {
      return null;
    }

    const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? `${value}${options?.endOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z'}`
      : value;

    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private shouldPruneLongTermMemory(
    memory: ResolvedLongTermMemoryItem,
    options?: {
      includeExpired?: boolean;
      includeStale?: boolean;
    },
  ): boolean {
    if (memory.status === 'expired') {
      return options?.includeExpired ?? true;
    }

    if (memory.status === 'stale') {
      return options?.includeStale ?? false;
    }

    return false;
  }

  private mapRowToFeature(row: FeatureMemoryRow): FeatureMemory {
    const deps = this.parseJson<{ imports?: string[]; external?: string[] }>(row.dependencies, {});

    return {
      name: row.name,
      location: {
        dir: row.location_dir,
        files: this.parseJson<string[]>(row.location_files, []),
      },
      responsibility: row.responsibility,
      api: {
        exports: this.parseJson<string[]>(row.api_exports, []),
        endpoints: this.parseJson<
          Array<{ method: string; path: string; handler: string; description?: string }>
        >(row.api_endpoints, []),
      },
      dependencies: {
        imports: deps.imports || [],
        external: deps.external || [],
      },
      dataFlow: row.data_flow || '',
      keyPatterns: this.parseJson<string[]>(row.key_patterns, []),
      lastUpdated: row.updated_at || row.created_at || new Date().toISOString(),
      memoryType: row.memory_type,
      sourceProjectId: row.project_id,
    };
  }

  private parseJson<T>(input: string, fallback: T): T {
    try {
      return JSON.parse(input) as T;
    } catch {
      return fallback;
    }
  }

  private parseStringArray(input: unknown): string[] {
    if (!Array.isArray(input)) {
      return [];
    }
    return input.filter((item): item is string => typeof item === 'string');
  }

  private parseAlternatives(input: unknown): DecisionRecord['alternatives'] {
    if (!Array.isArray(input)) {
      return [];
    }

    return input
      .filter(
        (item): item is { name?: unknown; pros?: unknown; cons?: unknown } =>
          !!item && typeof item === 'object',
      )
      .map((item) => ({
        name: typeof item.name === 'string' ? item.name : 'unknown',
        pros: this.parseStringArray(item.pros),
        cons: this.parseStringArray(item.cons),
      }));
  }

  private normalizeModuleName(name: string): string {
    return name
      .toLowerCase()
      .trim()
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-');
  }
}
