import type {
  GlobalMemory,
  GlobalMemoryType,
  MemoryCatalog,
  TaskCheckpoint,
} from './types.js';
import { type ProjectMetaRow, MemoryHubDatabase } from './MemoryHubDatabase.js';

const DEFAULT_CATALOG_META_KEY = 'catalog';
const DEFAULT_GLOBAL_META_PREFIX = 'global:';

export interface ProjectMetaStoreOptions {
  hub: MemoryHubDatabase;
  projectId: string;
  projectRoot: string;
  catalogMetaKey?: string;
  globalMetaPrefix?: string;
}

export class ProjectMetaStore {
  private readonly hub: MemoryHubDatabase;
  private readonly projectId: string;
  private readonly projectRoot: string;
  private readonly catalogMetaKey: string;
  private readonly globalMetaPrefix: string;

  constructor(options: ProjectMetaStoreOptions) {
    this.hub = options.hub;
    this.projectId = options.projectId;
    this.projectRoot = options.projectRoot;
    this.catalogMetaKey = options.catalogMetaKey ?? DEFAULT_CATALOG_META_KEY;
    this.globalMetaPrefix = options.globalMetaPrefix ?? DEFAULT_GLOBAL_META_PREFIX;
  }

  async saveCheckpoint(checkpoint: TaskCheckpoint): Promise<string> {
    const key = `checkpoint:${checkpoint.id}`;
    const normalized: TaskCheckpoint = {
      ...checkpoint,
      repoPath: this.projectRoot,
      updatedAt: new Date().toISOString(),
      createdAt: checkpoint.createdAt || new Date().toISOString(),
    };
    this.hub.setProjectMeta(this.projectId, key, JSON.stringify(normalized));
    return `sqlite://memory-hub.db#project=${this.projectId}&checkpoint=${encodeURIComponent(checkpoint.id)}`;
  }

  async readCheckpoint(checkpointId: string): Promise<TaskCheckpoint | null> {
    const raw = this.hub.getProjectMeta(this.projectId, `checkpoint:${checkpointId}`);
    return this.parseJson<TaskCheckpoint>(raw, null as TaskCheckpoint | null);
  }

  async listCheckpoints(): Promise<TaskCheckpoint[]> {
    const rows = this.hub.listProjectMeta(this.projectId, 'checkpoint:');
    return rows
      .map((row) => this.parseJson<TaskCheckpoint>(row.meta_value, null as TaskCheckpoint | null))
      .filter((value): value is TaskCheckpoint => value !== null)
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }

  async saveCatalog(catalog: MemoryCatalog): Promise<string> {
    this.hub.setProjectMeta(this.projectId, this.catalogMetaKey, JSON.stringify(catalog));
    return `sqlite://memory-hub.db#project=${this.projectId}&meta=${this.catalogMetaKey}`;
  }

  async readCatalog(): Promise<MemoryCatalog | null> {
    const raw = this.hub.getProjectMeta(this.projectId, this.catalogMetaKey);
    return this.parseJson<MemoryCatalog>(raw, null as MemoryCatalog | null);
  }

  async saveGlobal(type: GlobalMemoryType, data: Record<string, unknown>): Promise<string> {
    const globalMemory: GlobalMemory = {
      type,
      data,
      lastUpdated: new Date().toISOString(),
    };

    this.hub.setProjectMeta(
      this.projectId,
      `${this.globalMetaPrefix}${type}`,
      JSON.stringify(globalMemory),
    );

    return `sqlite://memory-hub.db#project=${this.projectId}&meta=${this.globalMetaPrefix}${type}`;
  }

  async readGlobal(type: string): Promise<GlobalMemory | null> {
    const raw = this.hub.getProjectMeta(this.projectId, `${this.globalMetaPrefix}${type}`);
    return this.parseJson<GlobalMemory>(raw, null as GlobalMemory | null);
  }

  async listGlobals(): Promise<GlobalMemory[]> {
    const rows = this.hub.listProjectMeta(this.projectId, this.globalMetaPrefix);
    return rows
      .map((row) => this.parseJson<GlobalMemory>(row.meta_value, null as GlobalMemory | null))
      .filter((value): value is GlobalMemory => value !== null);
  }

  async listProjectMeta(keyPrefix?: string): Promise<ProjectMetaRow[]> {
    return this.hub.listProjectMeta(this.projectId, keyPrefix);
  }

  private parseJson<T>(input: string | null, fallback: T | null): T | null {
    if (!input) {
      return fallback;
    }

    try {
      return JSON.parse(input) as T;
    } catch {
      return fallback;
    }
  }
}
