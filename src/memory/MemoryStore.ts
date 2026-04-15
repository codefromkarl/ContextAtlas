/**
 * MemoryStore - 项目记忆 facade（SQLite 后端）
 *
 * 单一真相源：~/.contextatlas/memory-hub.db
 * 初始化与兼容导入交给 MemoryStoreBootstrap，
 * feature / decision / meta / long-term 逻辑分别下沉到子模块。
 */

import path from 'node:path';
import { generateProjectId } from '../db/index.js';
import { logger } from '../utils/logger.js';
import { DecisionStore } from './DecisionStore.js';
import { FeatureMemoryCatalogCoordinator } from './FeatureMemoryCatalogCoordinator.js';
import { FeatureMemoryRepository } from './FeatureMemoryRepository.js';
import { LongTermMemoryService } from './LongTermMemoryService.js';
import { MemoryHubDatabase } from './MemoryHubDatabase.js';
import { MemoryStoreBootstrap } from './MemoryStoreBootstrap.js';
import { ProjectMetaStore } from './ProjectMetaStore.js';
import type {
  DecisionRecord,
  FeatureMemory,
  GlobalMemory,
  GlobalMemoryType,
  LongTermMemoryItem,
  LongTermMemoryScope,
  LongTermMemorySearchResult,
  LongTermMemoryType,
  MemoryCatalog,
  ProjectProfile,
  ResolvedLongTermMemoryItem,
  TaskCheckpoint,
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
    MemoryHubDatabase.setTestOverride(hub);
  }

  static resetSharedHubForTests(): void {
    MemoryStore.sharedHub = null;
    MemoryHubDatabase.setTestOverride(null);
  }

  private readonly projectRoot: string;
  private projectId: string;
  private readonly projectName: string;
  private readonly hub: MemoryHubDatabase;
  private readonly bootstrap: MemoryStoreBootstrap;
  private readonly featureMemoryCatalogCoordinator: FeatureMemoryCatalogCoordinator;
  private readonly longTermMemoryService: LongTermMemoryService;
  private scopedServicesProjectId: string | null = null;
  private projectMetaStore: ProjectMetaStore | null = null;
  private featureMemoryRepository: FeatureMemoryRepository | null = null;
  private decisionStore: DecisionStore | null = null;

  constructor(projectRoot: string) {
    this.projectRoot = path.resolve(projectRoot);
    this.projectId = generateProjectId(this.projectRoot);
    this.projectName = path.basename(this.projectRoot) || this.projectId;

    if (!MemoryStore.sharedHub) {
      MemoryStore.sharedHub = new MemoryHubDatabase();
    }
    this.hub = MemoryStore.sharedHub;
    this.bootstrap = new MemoryStoreBootstrap({
      hub: this.hub,
      projectRoot: this.projectRoot,
      projectName: this.projectName,
      initialProjectId: this.projectId,
      catalogMetaKey: CATALOG_META_KEY,
      globalMetaPrefix: GLOBAL_META_PREFIX,
      onProjectIdChange: (projectId) => {
        this.projectId = projectId;
      },
    });
    this.featureMemoryCatalogCoordinator = new FeatureMemoryCatalogCoordinator(this.projectRoot);
    this.longTermMemoryService = new LongTermMemoryService({
      hub: this.hub,
      globalMetaPrefix: GLOBAL_META_PREFIX,
      defaultStaleDays: DEFAULT_LONG_TERM_MEMORY_STALE_DAYS,
      resolveScopeProjectId: (scope, ensureWritable) =>
        this.resolveScopeProjectId(scope, ensureWritable),
    });
  }

  /** 当前项目 ID（SQLite 主键） */
  getProjectId(): string {
    return this.projectId;
  }

  /**
   * 只读初始化：不触发项目注册与导入
   */
  async initializeReadOnly(): Promise<void> {
    await this.bootstrap.initializeReadOnly();
  }

  /**
   * 可写初始化：确保项目已注册，并在首次时尝试导入旧文件记忆
   */
  async initializeWritable(): Promise<void> {
    await this.bootstrap.initializeWritable();
  }

  async initialize(): Promise<void> {
    await this.initializeWritable();
  }

  private hasProject(): boolean {
    return this.hub.getProject(this.projectId) !== null;
  }

  private ensureProjectScopedServices(): void {
    if (this.scopedServicesProjectId === this.projectId) {
      return;
    }

    this.projectMetaStore = new ProjectMetaStore({
      hub: this.hub,
      projectId: this.projectId,
      projectRoot: this.projectRoot,
      catalogMetaKey: CATALOG_META_KEY,
      globalMetaPrefix: GLOBAL_META_PREFIX,
    });
    this.featureMemoryRepository = new FeatureMemoryRepository({
      hub: this.hub,
      projectId: this.projectId,
    });
    this.decisionStore = new DecisionStore({
      hub: this.hub,
      projectId: this.projectId,
    });
    this.scopedServicesProjectId = this.projectId;
  }

  private getProjectMetaStore(): ProjectMetaStore {
    this.ensureProjectScopedServices();
    return this.projectMetaStore!;
  }

  private getLongTermMemoryService(): LongTermMemoryService {
    return this.longTermMemoryService;
  }

  private getFeatureMemoryRepository(): FeatureMemoryRepository {
    this.ensureProjectScopedServices();
    return this.featureMemoryRepository!;
  }

  private getFeatureMemoryCatalogCoordinator(): FeatureMemoryCatalogCoordinator {
    return this.featureMemoryCatalogCoordinator;
  }

  private getDecisionStore(): DecisionStore {
    this.ensureProjectScopedServices();
    return this.decisionStore!;
  }

  // ===========================================
  // Feature Memory CRUD
  // ===========================================

  async saveFeature(memory: FeatureMemory): Promise<string> {
    await this.initializeWritable();
    const savedTo = await this.getFeatureMemoryRepository().save(memory);
    await this.getFeatureMemoryCatalogCoordinator().onFeatureSaved(memory);

    logger.info({ name: memory.name, projectId: this.projectId }, '功能记忆已保存到 SQLite');
    return savedTo;
  }

  async readFeature(moduleName: string): Promise<FeatureMemory | null> {
    await this.initializeReadOnly();

    if (!this.hasProject()) {
      return null;
    }
    return this.getFeatureMemoryRepository().readByName(moduleName);
  }

  /**
   * 按相对路径读取功能记忆（如 "features/search-service.json"）
   */
  async readFeatureByPath(relativePath: string): Promise<FeatureMemory | null> {
    await this.initializeReadOnly();

    if (!this.hasProject()) {
      return null;
    }
    return this.getFeatureMemoryRepository().readByPath(relativePath);
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
    const deleted = await this.getFeatureMemoryRepository().delete(moduleName);
    if (deleted) {
      await this.getFeatureMemoryCatalogCoordinator().onFeatureDeleted(moduleName);
      logger.info({ module: moduleName, projectId: this.projectId }, '功能记忆已删除');
    }
    return deleted;
  }

  async markFeatureNeedsReview(
    moduleName: string,
    reason: string,
  ): Promise<FeatureMemory | null> {
    await this.initializeWritable();
    const flagged = await this.getFeatureMemoryRepository().markNeedsReview(moduleName, reason);
    if (flagged) {
      await this.getFeatureMemoryCatalogCoordinator().onFeatureSaved(flagged);
    }
    return flagged;
  }

  async listFeatures(): Promise<FeatureMemory[]> {
    await this.initializeReadOnly();
    if (!this.hasProject()) {
      return [];
    }
    return this.getFeatureMemoryRepository().list();
  }

  async saveCheckpoint(checkpoint: TaskCheckpoint): Promise<string> {
    await this.initializeWritable();
    return this.getProjectMetaStore().saveCheckpoint(checkpoint);
  }

  async readCheckpoint(checkpointId: string): Promise<TaskCheckpoint | null> {
    await this.initializeReadOnly();
    if (!this.hasProject()) {
      return null;
    }
    return this.getProjectMetaStore().readCheckpoint(checkpointId);
  }

  async listCheckpoints(): Promise<TaskCheckpoint[]> {
    await this.initializeReadOnly();
    if (!this.hasProject()) {
      return [];
    }
    return this.getProjectMetaStore().listCheckpoints();
  }

  // ===========================================
  // Decision Record CRUD
  // ===========================================

  async saveDecision(decision: DecisionRecord): Promise<string> {
    await this.initializeWritable();
    const savedTo = await this.getDecisionStore().save(decision);
    logger.info({ id: decision.id, projectId: this.projectId }, '决策记录已保存到 SQLite');
    return savedTo;
  }

  async readDecision(decisionId: string): Promise<DecisionRecord | null> {
    await this.initializeReadOnly();

    if (!this.hasProject()) {
      return null;
    }
    return this.getDecisionStore().read(decisionId);
  }

  async listDecisions(): Promise<DecisionRecord[]> {
    await this.initializeReadOnly();

    if (!this.hasProject()) {
      return [];
    }
    return this.getDecisionStore().list();
  }

  // ===========================================
  // Project Profile
  // ===========================================

  async saveProfile(profile: ProjectProfile, options?: { force?: boolean }): Promise<string> {
    await this.initializeWritable();
    const existingProfile = await this.readProfile();
    if (
      existingProfile?.governance?.profileMode === 'organization-readonly'
      && !options?.force
    ) {
      throw new Error('Project profile is readonly. Re-run with force to override.');
    }
    return this.getProjectMetaStore().saveGlobal('profile', profile as unknown as Record<string, unknown>);
  }

  async readProfile(): Promise<ProjectProfile | null> {
    await this.initializeReadOnly();
    if (!this.hasProject()) {
      return null;
    }
    const globalProfile = await this.getProjectMetaStore().readGlobal('profile');
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
    const savedTo = await this.getProjectMetaStore().saveCatalog(catalog);
    logger.info(
      { version: catalog.version, projectId: this.projectId },
      'Catalog 索引已保存到 SQLite',
    );
    return savedTo;
  }

  async readCatalog(): Promise<MemoryCatalog | null> {
    await this.initializeReadOnly();

    if (!this.hasProject()) {
      return null;
    }
    return this.getProjectMetaStore().readCatalog();
  }

  // ===========================================
  // Global Memory (Tier 1 全局记忆)
  // ===========================================

  async saveGlobal(type: GlobalMemoryType, data: Record<string, unknown>): Promise<string> {
    await this.initializeWritable();
    const savedTo = await this.getProjectMetaStore().saveGlobal(type, data);
    logger.info({ type, projectId: this.projectId }, '全局记忆已保存到 SQLite');
    return savedTo;
  }

  async readGlobal(type: string): Promise<GlobalMemory | null> {
    await this.initializeReadOnly();

    if (!this.hasProject()) {
      return null;
    }
    return this.getProjectMetaStore().readGlobal(type);
  }

  async listGlobals(): Promise<GlobalMemory[]> {
    await this.initializeReadOnly();

    if (!this.hasProject()) {
      return [];
    }
    return this.getProjectMetaStore().listGlobals();
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
  ): Promise<{ memory: LongTermMemoryItem; action: 'created' | 'merged' | 'updated' }> {
    return this.getLongTermMemoryService().append(input);
  }

  async readLongTermMemory(
    type: LongTermMemoryType,
    scope: LongTermMemoryScope,
  ): Promise<LongTermMemoryItem[]> {
    return this.getLongTermMemoryService().read(type, scope);
  }

  async listLongTermMemories(options?: {
    types?: LongTermMemoryType[];
    scope?: LongTermMemoryScope;
    includeExpired?: boolean;
    staleDays?: number;
  }): Promise<ResolvedLongTermMemoryItem[]> {
    return this.getLongTermMemoryService().list(options);
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
    return this.getLongTermMemoryService().find(query, options);
  }

  async deleteLongTermMemoryItem(
    type: LongTermMemoryType,
    scope: LongTermMemoryScope,
    id: string,
  ): Promise<boolean> {
    return this.getLongTermMemoryService().delete(type, scope, id);
  }

  async invalidateLongTermMemoryItem(
    type: LongTermMemoryType,
    scope: LongTermMemoryScope,
    input: {
      id?: string;
      factKey?: string;
      ended?: string;
      reason?: string;
    },
  ): Promise<{ invalidatedCount: number; memory: LongTermMemoryItem | null }> {
    return this.getLongTermMemoryService().invalidate(type, scope, input);
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
    return this.getLongTermMemoryService().prune(options);
  }

  // ===========================================
  // Internal helpers
  // ===========================================

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
}
