import path from 'node:path';
import { type FeatureMemoryRow, MemoryHubDatabase } from './MemoryHubDatabase.js';
import type { FeatureMemory } from './types.js';

export interface FeatureMemoryRepositoryOptions {
  hub: MemoryHubDatabase;
  projectId: string;
}

export class FeatureMemoryRepository {
  private readonly hub: MemoryHubDatabase;
  private readonly projectId: string;

  constructor(options: FeatureMemoryRepositoryOptions) {
    this.hub = options.hub;
    this.projectId = options.projectId;
  }

  async save(memory: FeatureMemory): Promise<string> {
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
      confirmation_status: memory.confirmationStatus || 'human-confirmed',
      review_status: memory.reviewStatus || 'verified',
      review_reason: memory.reviewReason,
      review_marked_at: memory.reviewMarkedAt,
      updated_at: memory.lastUpdated,
    });

    return `sqlite://memory-hub.db#project=${this.projectId}&module=${encodeURIComponent(memory.name)}`;
  }

  async readByName(moduleName: string): Promise<FeatureMemory | null> {
    const exact = this.hub.getMemory(this.projectId, moduleName);
    if (exact) {
      return this.mapRowToFeature(exact);
    }

    const normalizedQuery = this.normalizeModuleName(moduleName);
    const rows = this.hub.listMemories(this.projectId);
    const matched = rows.find((row) => this.normalizeModuleName(row.name) === normalizedQuery);

    return matched ? this.mapRowToFeature(matched) : null;
  }

  async readByPath(relativePath: string): Promise<FeatureMemory | null> {
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

  async delete(moduleName: string): Promise<boolean> {
    const existing = await this.readByName(moduleName);
    if (!existing) {
      return false;
    }
    return this.hub.deleteMemory(this.projectId, existing.name);
  }

  async markNeedsReview(moduleName: string, reason: string): Promise<FeatureMemory | null> {
    const existing = await this.readByName(moduleName);
    if (!existing) {
      return null;
    }

    const reviewMarkedAt = new Date().toISOString();
    const updated = this.hub.updateMemoryReviewStatus(this.projectId, existing.name, {
      review_status: 'needs-review',
      review_reason: reason,
      review_marked_at: reviewMarkedAt,
    });

    if (!updated) {
      return null;
    }

    return this.readByName(existing.name);
  }

  async list(): Promise<FeatureMemory[]> {
    return this.hub.listMemories(this.projectId).map((row) => this.mapRowToFeature(row));
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
      confirmationStatus: row.confirmation_status || 'human-confirmed',
      reviewStatus: row.review_status || 'verified',
      reviewReason: row.review_reason || undefined,
      reviewMarkedAt: row.review_marked_at || undefined,
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

  private normalizeModuleName(name: string): string {
    return name
      .toLowerCase()
      .trim()
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-');
  }
}
