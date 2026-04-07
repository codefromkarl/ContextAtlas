import { logger } from '../utils/logger.js';
import { importLegacyProjectMemoryIfNeeded } from './LegacyMemoryImporter.js';
import { MemoryHubDatabase } from './MemoryHubDatabase.js';
import { importOmcProjectProfileIfNeeded } from './OmcProjectMemoryImporter.js';

export interface MemoryStoreBootstrapOptions {
  hub: MemoryHubDatabase;
  projectRoot: string;
  projectName: string;
  initialProjectId: string;
  catalogMetaKey: string;
  globalMetaPrefix: string;
  onProjectIdChange?: (projectId: string) => void;
}

export class MemoryStoreBootstrap {
  private readonly hub: MemoryHubDatabase;
  private readonly projectRoot: string;
  private readonly projectName: string;
  private readonly catalogMetaKey: string;
  private readonly globalMetaPrefix: string;
  private readonly onProjectIdChange?: (projectId: string) => void;
  private projectId: string;
  private readInitialized = false;
  private writeInitialized = false;

  constructor(options: MemoryStoreBootstrapOptions) {
    this.hub = options.hub;
    this.projectRoot = options.projectRoot;
    this.projectName = options.projectName;
    this.projectId = options.initialProjectId;
    this.catalogMetaKey = options.catalogMetaKey;
    this.globalMetaPrefix = options.globalMetaPrefix;
    this.onProjectIdChange = options.onProjectIdChange;
  }

  getProjectId(): string {
    return this.projectId;
  }

  async initializeReadOnly(): Promise<void> {
    if (this.readInitialized) {
      return;
    }

    const existingProject = this.hub.getProjectByPath(this.projectRoot);
    if (existingProject) {
      this.setProjectId(existingProject.id);
    }

    this.readInitialized = true;
  }

  async initializeWritable(): Promise<void> {
    if (this.writeInitialized) {
      return;
    }

    const project = this.hub.ensureProject({
      path: this.projectRoot,
      name: this.projectName,
    });
    this.setProjectId(project.id);

    await this.initializeReadOnly();

    await importLegacyProjectMemoryIfNeeded({
      projectRoot: this.projectRoot,
      projectId: this.projectId,
      hub: this.hub,
      catalogMetaKey: this.catalogMetaKey,
      globalMetaPrefix: this.globalMetaPrefix,
    });

    await importOmcProjectProfileIfNeeded({
      projectRoot: this.projectRoot,
      projectId: this.projectId,
      hub: this.hub,
    });

    this.writeInitialized = true;
    logger.info({ projectId: this.projectId }, 'Project Memory SQLite 存储初始化完成');
  }

  private setProjectId(projectId: string): void {
    if (this.projectId === projectId) {
      return;
    }
    this.projectId = projectId;
    this.onProjectIdChange?.(projectId);
  }
}
