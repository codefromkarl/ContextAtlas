/**
 * SharedMemoryHub - 共享记忆库管理（SQLite 后端）
 *
 * 主存储：~/.contextatlas/memory-hub.db
 * 兼容：checkForUpdates 仍支持旧文件路径 shared reference。
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deriveStableProjectId } from '../db/index.js';
import { logger } from '../utils/logger.js';
import { MemoryHubDatabase } from './MemoryHubDatabase.js';
import { MemoryStore } from './MemoryStore.js';
import type { FeatureMemory, SharedReference } from './types.js';

export type MemoryCategory = 'commons' | 'frameworks' | 'patterns';

export interface SharedMemoryMetadata {
  contributedAt: string;
  contributor?: string;
  sourceProject?: string;
  version?: string;
}

export interface SyncResult {
  success: boolean;
  filePath: string;
  message: string;
}

const SHARED_PROJECT_ID = '__shared_memory_hub__';
const SHARED_PROJECT_NAME = 'Shared Memory Hub';
const SHARED_PROJECT_PATH = 'sqlite://memory-hub.db#shared';
const SHARED_META_PREFIX = 'shared:';
const SHARED_PROJECT_CANONICAL_ID = deriveStableProjectId(SHARED_PROJECT_PATH);

export class SharedMemoryHub {
  private static sharedDb: MemoryHubDatabase | null = null;

  private readonly db: MemoryHubDatabase;

  // 为兼容旧调用签名，保留可选参数但不再使用文件目录。
  constructor(_deprecatedHubPath?: string) {
    if (_deprecatedHubPath) {
      this.db = new MemoryHubDatabase(_deprecatedHubPath);
      return;
    }

    if (!SharedMemoryHub.sharedDb) {
      SharedMemoryHub.sharedDb = new MemoryHubDatabase();
    }
    this.db = SharedMemoryHub.sharedDb;
  }

  /**
   * 初始化共享记忆存储
   */
  async initialize(): Promise<void> {
    this.db.ensureProject({
      name: SHARED_PROJECT_NAME,
      path: SHARED_PROJECT_PATH,
    });
  }

  /**
   * 贡献记忆到共享库
   */
  async contribute(
    category: MemoryCategory,
    memory: FeatureMemory,
    metadata?: { contributor?: string; sourceProject?: string; version?: string; projectRoot?: string },
  ): Promise<string> {
    await this.initialize();

    if (metadata?.projectRoot) {
      const store = new MemoryStore(metadata.projectRoot);
      const profile = await store.readProfile();
      const policy = profile?.governance?.sharedMemory || 'readonly';
      if (policy !== 'editable') {
        throw new Error(`Shared memory is ${policy}; contribution requires editable policy`);
      }
    }

    const memoryWithMetadata: FeatureMemory & SharedMemoryMetadata = {
      ...memory,
      contributedAt: new Date().toISOString(),
      ...(metadata || {}),
    };

    const slug = this.slugify(memory.name);
    const key = this.buildMetaKey(category, slug);

    this.db.setProjectMeta(SHARED_PROJECT_CANONICAL_ID, key, JSON.stringify(memoryWithMetadata));

    const ref = this.buildSharedRef(category, slug);
    logger.info({ category, name: memory.name, ref }, '记忆已贡献到共享库（SQLite）');
    return ref;
  }

  /**
   * 从共享库拉取记忆
   */
  async pull(
    category: MemoryCategory,
    name: string,
  ): Promise<(FeatureMemory & SharedMemoryMetadata) | null> {
    await this.initialize();

    const slug = this.slugify(name);
    const key = this.buildMetaKey(category, slug);
    const raw = this.db.getProjectMeta(SHARED_PROJECT_CANONICAL_ID, key);

    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw) as FeatureMemory & SharedMemoryMetadata;
    } catch {
      return null;
    }
  }

  /**
   * 列出共享库中所有记忆
   */
  async list(
    category?: MemoryCategory,
  ): Promise<Array<{ category: string; name: string; path: string }>> {
    await this.initialize();

    const rows = this.db.listProjectMeta(SHARED_PROJECT_CANONICAL_ID, SHARED_META_PREFIX);
    const results: Array<{ category: string; name: string; path: string }> = [];

    for (const row of rows) {
      const parsed = this.parseMetaKey(row.meta_key);
      if (!parsed) continue;
      if (category && parsed.category !== category) continue;

      results.push({
        category: parsed.category,
        name: parsed.slug,
        path: this.buildSharedRef(parsed.category, parsed.slug),
      });
    }

    return results;
  }

  /**
   * 同步共享记忆到项目
   */
  async syncToProject(
    category: MemoryCategory,
    name: string,
    projectRoot: string,
    options?: { as?: string },
  ): Promise<SyncResult> {
    const memory = await this.pull(category, name);
    if (!memory) {
      return {
        success: false,
        filePath: '',
        message: `Shared memory "${name}" not found in category "${category}"`,
      };
    }

    const store = new MemoryStore(projectRoot);
    const profile = await store.readProfile();
    if (profile?.governance?.sharedMemory === 'disabled') {
      return {
        success: false,
        filePath: '',
        message: 'Shared memory is disabled by project profile governance',
      };
    }

    const syncedMemory: FeatureMemory = {
      ...memory,
      name: options?.as || memory.name,
      memoryType: this.mapCategoryToMemoryType(category),
      sourceProjectId: SHARED_PROJECT_CANONICAL_ID,
    };

    const filePath = await store.saveFeature(syncedMemory);
    return {
      success: true,
      filePath,
      message: `Synced "${name}" from ${category} to project`,
    };
  }

  /**
   * 检查共享记忆更新
   */
  async checkForUpdates(
    localMemory: FeatureMemory & { sharedReferences?: SharedReference[] },
  ): Promise<
    Array<{
      reference: SharedReference;
      hasUpdate: boolean;
      localVersion?: string;
      remoteVersion?: string;
    }>
  > {
    if (!localMemory.sharedReferences) return [];

    const results: Array<{
      reference: SharedReference;
      hasUpdate: boolean;
      localVersion?: string;
      remoteVersion?: string;
    }> = [];

    for (const ref of localMemory.sharedReferences) {
      const sharedMemory = await this.pullFromReference(ref.from);
      if (!sharedMemory) continue;

      const remoteVersion = sharedMemory.version || sharedMemory.lastUpdated;
      const localVersion = localMemory.lastUpdated;
      const hasUpdate = remoteVersion !== localVersion;

      results.push({
        reference: ref,
        hasUpdate,
        localVersion,
        remoteVersion,
      });
    }

    return results;
  }

  /**
   * 删除共享记忆
   */
  async delete(category: MemoryCategory, name: string): Promise<boolean> {
    await this.initialize();

    const slug = this.slugify(name);
    const key = this.buildMetaKey(category, slug);
    const deleted = this.db.deleteProjectMeta(SHARED_PROJECT_ID, key);

    if (deleted) {
      logger.info({ category, name }, '共享记忆已删除（SQLite）');
    }

    return deleted;
  }

  /**
   * 获取共享记忆统计信息
   */
  async getStats(): Promise<{
    total: number;
    byCategory: Record<MemoryCategory, number>;
  }> {
    const all = await this.list();
    const byCategory: Record<MemoryCategory, number> = {
      commons: 0,
      frameworks: 0,
      patterns: 0,
    };

    for (const item of all) {
      byCategory[item.category as MemoryCategory]++;
    }

    return {
      total: all.length,
      byCategory,
    };
  }

  private async pullFromReference(
    ref: string,
  ): Promise<(FeatureMemory & SharedMemoryMetadata) | null> {
    // 新格式：sqlite://memory-hub.db#shared/<category>/<slug>
    const sqliteMatch = ref.match(/^sqlite:\/\/memory-hub\.db#shared\/([^/]+)\/([^/]+)$/);
    if (sqliteMatch) {
      const category = sqliteMatch[1] as MemoryCategory;
      const slug = decodeURIComponent(sqliteMatch[2]);
      const key = this.buildMetaKey(category, slug);
      const raw = this.db.getProjectMeta(SHARED_PROJECT_ID, key);
      if (!raw) return null;
      try {
        return JSON.parse(raw) as FeatureMemory & SharedMemoryMetadata;
      } catch {
        return null;
      }
    }

    // 兼容旧格式：文件路径
    try {
      const expandedPath = ref.startsWith('~') ? ref.replace('~', os.homedir()) : ref;
      const content = await fs.readFile(path.resolve(expandedPath), 'utf-8');
      return JSON.parse(content) as FeatureMemory & SharedMemoryMetadata;
    } catch {
      return null;
    }
  }

  private slugify(name: string): string {
    return name
      .toLowerCase()
      .trim()
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-');
  }

  private buildMetaKey(category: MemoryCategory, slug: string): string {
    return `${SHARED_META_PREFIX}${category}:${slug}`;
  }

  private parseMetaKey(key: string): { category: MemoryCategory; slug: string } | null {
    if (!key.startsWith(SHARED_META_PREFIX)) {
      return null;
    }

    const payload = key.slice(SHARED_META_PREFIX.length);
    const idx = payload.indexOf(':');
    if (idx <= 0) return null;

    const category = payload.slice(0, idx) as MemoryCategory;
    const slug = payload.slice(idx + 1);

    if (!['commons', 'frameworks', 'patterns'].includes(category) || !slug) {
      return null;
    }

    return { category, slug };
  }

  private buildSharedRef(category: MemoryCategory, slug: string): string {
    return `sqlite://memory-hub.db#shared/${category}/${encodeURIComponent(slug)}`;
  }

  private mapCategoryToMemoryType(category: MemoryCategory): FeatureMemory['memoryType'] {
    if (category === 'frameworks') return 'framework';
    if (category === 'patterns') return 'pattern';
    return 'shared';
  }
}
