import crypto from 'node:crypto';
import type {
  GlobalMemory,
  LongTermMemoryItem,
  LongTermMemoryScope,
  LongTermMemorySearchResult,
  LongTermMemoryStatus,
  LongTermMemoryType,
  ResolvedLongTermMemoryItem,
} from './types.js';
import { MemoryHubDatabase } from './MemoryHubDatabase.js';

const DEFAULT_GLOBAL_META_PREFIX = 'global:';
const DEFAULT_LONG_TERM_MEMORY_STALE_DAYS = 30;

export interface LongTermMemoryServiceOptions {
  hub: MemoryHubDatabase;
  resolveScopeProjectId: (
    scope: LongTermMemoryScope,
    ensureWritable: boolean,
  ) => Promise<string | null>;
  globalMetaPrefix?: string;
  defaultStaleDays?: number;
}

export class LongTermMemoryService {
  private readonly hub: MemoryHubDatabase;
  private readonly resolveScopeProjectIdFn: LongTermMemoryServiceOptions['resolveScopeProjectId'];
  private readonly globalMetaPrefix: string;
  private readonly defaultStaleDays: number;

  constructor(options: LongTermMemoryServiceOptions) {
    this.hub = options.hub;
    this.resolveScopeProjectIdFn = options.resolveScopeProjectId;
    this.globalMetaPrefix = options.globalMetaPrefix ?? DEFAULT_GLOBAL_META_PREFIX;
    this.defaultStaleDays = options.defaultStaleDays ?? DEFAULT_LONG_TERM_MEMORY_STALE_DAYS;
  }

  async append(
    input: Omit<LongTermMemoryItem, 'id' | 'createdAt' | 'updatedAt'> & {
      id?: string;
      createdAt?: string;
      updatedAt?: string;
    },
  ): Promise<{ memory: LongTermMemoryItem; action: 'created' | 'merged' | 'updated' }> {
    const now = new Date().toISOString();
    const item: LongTermMemoryItem = {
      ...input,
      durability: input.durability || 'stable',
      provenance: [...new Set(input.provenance || [])],
      id: input.id || crypto.randomUUID(),
      createdAt: input.createdAt || now,
      updatedAt: input.updatedAt || now,
    };

    const items = await this.read(item.type, item.scope);
    const existingIndex = items.findIndex((entry) => entry.id === item.id);
    if (existingIndex >= 0) {
      const previous = items[existingIndex];
      items[existingIndex] = {
        ...previous,
        ...item,
        durability: this.mergeDurability(previous.durability, item.durability),
        provenance: this.mergeStringList(previous.provenance, item.provenance),
        tags: this.mergeStringList(previous.tags, item.tags),
        links: this.mergeStringList(previous.links, item.links),
        confidence: Math.max(previous.confidence || 0, item.confidence || 0),
        source: this.mergeLongTermMemorySource(previous.source, item.source),
        createdAt: previous?.createdAt || item.createdAt,
        updatedAt: now,
      };
      await this.save(item.type, item.scope, items);
      return { memory: items[existingIndex] || item, action: 'updated' };
    }

    const mergeIndex = items.findIndex((entry) => this.isSameLongTermMemory(entry, item));
    if (mergeIndex >= 0) {
      const previous = items[mergeIndex];
      items[mergeIndex] = {
        ...previous,
        summary: item.summary.length >= previous.summary.length ? item.summary : previous.summary,
        why: item.why || previous.why,
        howToApply: item.howToApply || previous.howToApply,
        tags: this.mergeStringList(previous.tags, item.tags),
        links: this.mergeStringList(previous.links, item.links),
        provenance: this.mergeStringList(previous.provenance, item.provenance),
        durability: this.mergeDurability(previous.durability, item.durability),
        confidence: Math.max(previous.confidence || 0, item.confidence || 0),
        source: this.mergeLongTermMemorySource(previous.source, item.source),
        lastVerifiedAt: item.lastVerifiedAt || previous.lastVerifiedAt,
        validFrom: item.validFrom || previous.validFrom,
        validUntil: item.validUntil || previous.validUntil,
        updatedAt: now,
      };
      await this.save(item.type, item.scope, items);
      return { memory: items[mergeIndex], action: 'merged' };
    }

    items.push(item);
    await this.save(item.type, item.scope, items);
    return { memory: item, action: 'created' };
  }

  async read(
    type: LongTermMemoryType,
    scope: LongTermMemoryScope,
  ): Promise<LongTermMemoryItem[]> {
    const projectId = await this.resolveScopeProjectIdFn(scope, false);
    if (!projectId) {
      return [];
    }

    const raw = this.hub.getProjectMeta(projectId, `${this.globalMetaPrefix}${type}`);
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

  async list(options?: {
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
        const items = await this.read(type, scope);
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

  async find(
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
    const items = await this.list({
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

  async delete(
    type: LongTermMemoryType,
    scope: LongTermMemoryScope,
    id: string,
  ): Promise<boolean> {
    const items = await this.read(type, scope);
    const filtered = items.filter((entry) => entry.id !== id);
    if (filtered.length === items.length) {
      return false;
    }

    await this.save(type, scope, filtered);
    return true;
  }

  async prune(options?: {
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
        const items = await this.read(type, scope);
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
          await this.save(type, scope, keptItems);
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

  private async save(
    type: LongTermMemoryType,
    scope: LongTermMemoryScope,
    items: LongTermMemoryItem[],
  ): Promise<string> {
    const projectId = await this.resolveScopeProjectIdFn(scope, true);
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
      `${this.globalMetaPrefix}${type}`,
      JSON.stringify(globalMemory),
    );

    return `sqlite://memory-hub.db#project=${projectId}&meta=${this.globalMetaPrefix}${type}`;
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
          durability:
            item.durability === 'ephemeral' || item.durability === 'stable'
              ? item.durability
              : 'stable',
          provenance: Array.isArray(item.provenance) ? item.provenance.map(String) : [],
          validFrom: item.validFrom ? String(item.validFrom) : undefined,
          validUntil: item.validUntil ? String(item.validUntil) : undefined,
          lastVerifiedAt: item.lastVerifiedAt ? String(item.lastVerifiedAt) : undefined,
          createdAt: item.createdAt ? String(item.createdAt) : globalMemory.lastUpdated,
          updatedAt: item.updatedAt ? String(item.updatedAt) : globalMemory.lastUpdated,
        },
      ];
    });
  }

  private isSameLongTermMemory(a: LongTermMemoryItem, b: LongTermMemoryItem): boolean {
    return a.type === b.type
      && a.scope === b.scope
      && this.normalizeMemoryText(a.title) === this.normalizeMemoryText(b.title)
      && this.normalizeMemoryText(a.summary) === this.normalizeMemoryText(b.summary);
  }

  private normalizeMemoryText(input: string): string {
    return input.toLowerCase().trim().replace(/\s+/g, ' ');
  }

  private mergeStringList(a?: string[], b?: string[]): string[] {
    return [...new Set([...(a || []), ...(b || [])].filter(Boolean))];
  }

  private mergeDurability(
    a?: LongTermMemoryItem['durability'],
    b?: LongTermMemoryItem['durability'],
  ): LongTermMemoryItem['durability'] {
    if (a === 'stable' || b === 'stable') return 'stable';
    return a || b || 'stable';
  }

  private mergeLongTermMemorySource(
    a?: LongTermMemoryItem['source'],
    b?: LongTermMemoryItem['source'],
  ): LongTermMemoryItem['source'] {
    const rank = { 'agent-inferred': 1, 'tool-result': 2, 'user-explicit': 3 } as const;
    const left = a || 'agent-inferred';
    const right = b || 'agent-inferred';
    return rank[left] >= rank[right] ? left : right;
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
    staleDays = this.defaultStaleDays,
  ): ResolvedLongTermMemoryItem {
    return {
      ...memory,
      status: this.getLongTermMemoryStatus(memory, staleDays),
    };
  }

  private getLongTermMemoryStatus(
    memory: LongTermMemoryItem,
    staleDays = this.defaultStaleDays,
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
}
