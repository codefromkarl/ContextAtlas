import crypto from 'node:crypto';
import type {
  GlobalMemory,
  LongTermMemoryHistoryEvent,
  LongTermMemoryItem,
  LongTermMemoryScope,
  LongTermMemorySearchResult,
  LongTermMemoryStatus,
  LongTermMemoryType,
  ResolvedLongTermMemoryItem,
} from './types.js';
import { MemoryHubDatabase, type LongTermMemoryRow } from './MemoryHubDatabase.js';

const DEFAULT_GLOBAL_META_PREFIX = 'global:';
const DEFAULT_LONG_TERM_MEMORY_STALE_DAYS = 30;
const HISTORY_PROVENANCE_PREFIX = 'history:v1:';

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
      history: this.normalizeHistoryEvents(input.history),
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
        invalidates: this.mergeStringList(previous.invalidates, item.invalidates),
        confidence: Math.max(previous.confidence || 0, item.confidence || 0),
        source: this.mergeLongTermMemorySource(previous.source, item.source),
        factKey: previous.factKey || item.factKey,
        invalidatedBy: item.invalidatedBy || previous.invalidatedBy,
        history: this.mergeHistoryEvents(previous.history, item.history, [
          this.createHistoryEvent('updated', item, now),
          ...this.createVerifiedHistoryEvents(item, now),
        ]),
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
        invalidates: this.mergeStringList(previous.invalidates, item.invalidates),
        durability: this.mergeDurability(previous.durability, item.durability),
        confidence: Math.max(previous.confidence || 0, item.confidence || 0),
        source: this.mergeLongTermMemorySource(previous.source, item.source),
        factKey: previous.factKey || item.factKey,
        invalidatedBy: item.invalidatedBy || previous.invalidatedBy,
        lastVerifiedAt: item.lastVerifiedAt || previous.lastVerifiedAt,
        validFrom: item.validFrom || previous.validFrom,
        validUntil: item.validUntil || previous.validUntil,
        history: this.mergeHistoryEvents(previous.history, item.history, [
          this.createHistoryEvent('merged', item, now),
          ...this.createVerifiedHistoryEvents(item, now),
        ]),
        updatedAt: now,
      };
      await this.save(item.type, item.scope, items);
      return { memory: items[mergeIndex], action: 'merged' };
    }

    const createdItem: LongTermMemoryItem = {
      ...item,
      history: this.mergeHistoryEvents(item.history, [
        this.createHistoryEvent('created', item, now),
        ...this.createVerifiedHistoryEvents(item, now),
      ]),
    };
    items.push(createdItem);
    await this.save(item.type, item.scope, items);
    return { memory: createdItem, action: 'created' };
  }

  async read(
    type: LongTermMemoryType,
    scope: LongTermMemoryScope,
  ): Promise<LongTermMemoryItem[]> {
    const projectId = await this.resolveScopeProjectIdFn(scope, false);
    if (!projectId) {
      return [];
    }

    const persisted = this.hub
      .listLongTermMemories(projectId, { types: [type], scope })
      .map((row) => this.mapLongTermMemoryRow(row));
    const legacy = this.readLegacyItems(projectId, type, scope);
    return this.mergeLongTermMemoryItems(persisted, legacy);
  }

  async list(options?: {
    types?: LongTermMemoryType[];
    scope?: LongTermMemoryScope;
    includeExpired?: boolean;
    staleDays?: number;
  }): Promise<ResolvedLongTermMemoryItem[]> {
    const requestedTypes = options?.types?.length
      ? options.types
      : ([
          'user',
          'feedback',
          'project-state',
          'reference',
          'journal',
          'evidence',
          'temporal-fact',
        ] as LongTermMemoryType[]);
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
    const results: LongTermMemorySearchResult[] = [];
    const requestedTypes = options?.types?.length
      ? options.types
      : ([
          'user',
          'feedback',
          'project-state',
          'reference',
          'journal',
          'evidence',
          'temporal-fact',
        ] as LongTermMemoryType[]);
    const requestedScopes = options?.scope
      ? [options.scope]
      : (['project', 'global-user'] as LongTermMemoryScope[]);
    const limit = options?.limit ?? 20;

    for (const scope of requestedScopes) {
      const projectId = await this.resolveScopeProjectIdFn(scope, false);
      if (!projectId) {
        continue;
      }

      const persistedRows = this.hub.listLongTermMemories(projectId, {
        types: requestedTypes,
        scope,
      });
      const persisted = queryLower.trim().length > 0
        ? this.hub.searchLongTermMemories(projectId, queryLower, {
            types: requestedTypes,
            scope,
            limit: Math.max(limit * 2, 20),
          })
        : [];
      const seen = new Set<string>();

      for (const row of persisted) {
        const resolved = this.resolveLongTermMemory(
          this.mapLongTermMemoryRow(row),
          options?.staleDays,
        );
        if (!options?.includeExpired && resolved.status === 'expired') {
          continue;
        }
        const match = this.calculateLongTermMemoryScore(resolved, queryLower);
        const score = Math.max(match.score + 50, 50);
        results.push({
          memory: resolved,
          score,
          matchFields: ['fts', ...match.matchFields],
          scoreBreakdown: {
            ...match.scoreBreakdown,
            fts: 50,
            total: score,
          },
        });
        seen.add(resolved.id);
      }

      for (const row of persistedRows) {
        const resolved = this.resolveLongTermMemory(
          this.mapLongTermMemoryRow(row),
          options?.staleDays,
        );
        if (seen.has(resolved.id)) {
          continue;
        }
        if (!options?.includeExpired && resolved.status === 'expired') {
          continue;
        }
        const match = this.calculateLongTermMemoryScore(resolved, queryLower);
        if (match.score > 0 && match.matchFields.length > 0) {
          results.push({
            memory: resolved,
            score: match.score,
            matchFields: match.matchFields,
            scoreBreakdown: match.scoreBreakdown,
          });
          seen.add(resolved.id);
        }
      }

      for (const type of requestedTypes) {
        const legacy = this.readLegacyItems(projectId, type, scope)
          .filter((item) => !seen.has(item.id))
          .map((item) => this.resolveLongTermMemory(item, options?.staleDays));
        for (const item of legacy) {
          if (!options?.includeExpired && item.status === 'expired') {
            continue;
          }
          const match = this.calculateLongTermMemoryScore(item, queryLower);
          if (match.score > 0 && match.matchFields.length > 0) {
            results.push({
              memory: item,
              score: match.score,
              matchFields: match.matchFields,
              scoreBreakdown: match.scoreBreakdown,
            });
          }
        }
      }
    }

    const minScore = options?.minScore ?? 0;

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
      : ([
          'user',
          'feedback',
          'project-state',
          'reference',
          'journal',
          'evidence',
          'temporal-fact',
        ] as LongTermMemoryType[]);
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

  async invalidate(
    type: LongTermMemoryType,
    scope: LongTermMemoryScope,
    input: {
      id?: string;
      factKey?: string;
      ended?: string;
      reason?: string;
    },
  ): Promise<{ invalidatedCount: number; memory: LongTermMemoryItem | null }> {
    const ended = input.ended || new Date().toISOString().split('T')[0];
    const now = new Date().toISOString();
    const items = await this.read(type, scope);
    let invalidatedCount = 0;
    let updatedMemory: LongTermMemoryItem | null = null;

    const nextItems = items.map((item) => {
      const matchesById = input.id ? item.id === input.id : false;
      const matchesByFactKey = input.factKey ? item.factKey === input.factKey : false;
      if ((!matchesById && !matchesByFactKey) || item.validUntil) {
        return item;
      }

      invalidatedCount += 1;
      const updated: LongTermMemoryItem = {
        ...item,
        validUntil: ended,
        updatedAt: now,
        provenance: this.mergeStringList(item.provenance, [
          `invalidated-at:${ended}`,
          ...(input.reason ? [`invalidated-reason:${input.reason}`] : []),
        ]),
        history: this.mergeHistoryEvents(item.history, [
          {
            ...this.createHistoryEvent('invalidated', item, now),
            reason: input.reason,
          },
        ]),
      };
      updatedMemory = updated;
      return updated;
    });

    if (invalidatedCount === 0) {
      return { invalidatedCount: 0, memory: null };
    }

    await this.save(type, scope, nextItems);
    return { invalidatedCount, memory: updatedMemory };
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
    this.migrateLegacyItems(projectId, type, scope);

    const existingIds = new Set(
      this.hub.listLongTermMemories(projectId, { types: [type], scope }).map((item) => item.id),
    );
    const nextIds = new Set(items.map((item) => item.id));

    for (const item of items) {
      this.hub.saveLongTermMemory(this.toLongTermMemoryRecord(projectId, item));
    }

    for (const existingId of existingIds) {
      if (!nextIds.has(existingId)) {
        this.hub.deleteLongTermMemory(projectId, existingId);
      }
    }

    this.hub.deleteProjectMeta(projectId, `${this.globalMetaPrefix}${type}`);
    return `sqlite://memory-hub.db#project=${projectId}&long-term=${type}:${scope}`;
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
      const provenanceParts = this.splitProvenanceAndHistory(
        Array.isArray(item.provenance) ? item.provenance.map(String) : [],
      );

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
          factKey: item.factKey ? String(item.factKey) : undefined,
          invalidates: Array.isArray(item.invalidates) ? item.invalidates.map(String) : [],
          invalidatedBy: item.invalidatedBy ? String(item.invalidatedBy) : undefined,
          durability:
            item.durability === 'ephemeral' || item.durability === 'stable'
              ? item.durability
              : 'stable',
          provenance: provenanceParts.provenance,
          history: this.mergeHistoryEvents(
            provenanceParts.history,
            this.normalizeHistoryEvents(item.history),
          ),
          validFrom: item.validFrom ? String(item.validFrom) : undefined,
          validUntil: item.validUntil ? String(item.validUntil) : undefined,
          lastVerifiedAt: item.lastVerifiedAt ? String(item.lastVerifiedAt) : undefined,
          createdAt: item.createdAt ? String(item.createdAt) : globalMemory.lastUpdated,
          updatedAt: item.updatedAt ? String(item.updatedAt) : globalMemory.lastUpdated,
        },
      ];
    });
  }

  private readLegacyItems(
    projectId: string,
    type: LongTermMemoryType,
    scope: LongTermMemoryScope,
  ): LongTermMemoryItem[] {
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

  private migrateLegacyItems(
    projectId: string,
    type: LongTermMemoryType,
    scope: LongTermMemoryScope,
  ): void {
    const legacyItems = this.readLegacyItems(projectId, type, scope);
    if (legacyItems.length === 0) {
      return;
    }

    for (const item of legacyItems) {
      this.hub.saveLongTermMemory(this.toLongTermMemoryRecord(projectId, item));
    }

    this.hub.deleteProjectMeta(projectId, `${this.globalMetaPrefix}${type}`);
  }

  private mapLongTermMemoryRow(row: LongTermMemoryRow): LongTermMemoryItem {
    const provenanceParts = this.splitProvenanceAndHistory(this.parseJsonArray(row.provenance));
    return {
      id: row.id,
      type: row.type,
      title: row.title,
      summary: row.summary,
      why: row.why ?? undefined,
      howToApply: row.how_to_apply ?? undefined,
      tags: this.parseJsonArray(row.tags),
      scope: row.scope,
      source: row.source,
      confidence: row.confidence,
      links: this.parseJsonArray(row.links),
      factKey: row.fact_key ?? undefined,
      invalidates: this.parseJsonArray(row.invalidates),
      invalidatedBy: row.invalidated_by ?? undefined,
      durability: row.durability,
      provenance: provenanceParts.provenance,
      history: provenanceParts.history,
      validFrom: row.valid_from ?? undefined,
      validUntil: row.valid_until ?? undefined,
      lastVerifiedAt: row.last_verified_at ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private toLongTermMemoryRecord(
    projectId: string,
    item: LongTermMemoryItem,
  ): Parameters<MemoryHubDatabase['saveLongTermMemory']>[0] {
    return {
      id: item.id,
      project_id: projectId,
      type: item.type,
      scope: item.scope,
      title: item.title,
      summary: item.summary,
      why: item.why,
      how_to_apply: item.howToApply,
      tags: item.tags,
      source: item.source || 'user-explicit',
      confidence: item.confidence,
      links: item.links,
      fact_key: item.factKey,
      invalidates: item.invalidates,
      invalidated_by: item.invalidatedBy,
      durability: item.durability,
      provenance: this.mergeStringList(item.provenance, this.encodeHistoryEvents(item.history)),
      valid_from: item.validFrom,
      valid_until: item.validUntil,
      last_verified_at: item.lastVerifiedAt,
      created_at: item.createdAt,
      updated_at: item.updatedAt,
    };
  }

  private mergeLongTermMemoryItems(
    primary: LongTermMemoryItem[],
    secondary: LongTermMemoryItem[],
  ): LongTermMemoryItem[] {
    const merged = [...primary];
    for (const candidate of secondary) {
      if (
        merged.some((existing) =>
          existing.id === candidate.id || this.isSameLongTermMemory(existing, candidate),
        )
      ) {
        continue;
      }
      merged.push(candidate);
    }
    return merged.sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }

  private parseJsonArray(input: string | null | undefined): string[] {
    if (!input) {
      return [];
    }

    try {
      const parsed = JSON.parse(input) as unknown;
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }

  private isSameLongTermMemory(a: LongTermMemoryItem, b: LongTermMemoryItem): boolean {
    if (a.factKey && b.factKey) {
      return a.type === b.type
        && a.scope === b.scope
        && this.normalizeFactKey(a.factKey) === this.normalizeFactKey(b.factKey);
    }

    return a.type === b.type
      && a.scope === b.scope
      && this.getMemoryContentHash(a) === this.getMemoryContentHash(b);
  }

  private normalizeMemoryText(input: string): string {
    return input.toLowerCase().trim().replace(/\s+/g, ' ');
  }

  private normalizeFactKey(input: string): string {
    return input
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  private getMemoryContentHash(memory: Pick<LongTermMemoryItem, 'title' | 'summary'>): string {
    const normalized = this.normalizeMemoryText(`${memory.title}\n${memory.summary}`);
    return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  }

  private mergeStringList(a?: string[], b?: string[]): string[] {
    return [...new Set([...(a || []), ...(b || [])].filter(Boolean))];
  }

  private createHistoryEvent(
    action: LongTermMemoryHistoryEvent['action'],
    item: Pick<LongTermMemoryItem, 'source' | 'confidence' | 'provenance' | 'factKey' | 'title' | 'summary'>,
    at: string,
  ): LongTermMemoryHistoryEvent {
    return {
      action,
      at,
      source: item.source,
      confidence: item.confidence,
      provenance: this.mergeStringList(item.provenance),
      factKey: item.factKey,
      summaryHash: this.getMemoryContentHash(item),
    };
  }

  private createVerifiedHistoryEvents(
    item: Pick<LongTermMemoryItem, 'lastVerifiedAt' | 'source' | 'confidence' | 'provenance' | 'factKey' | 'title' | 'summary'>,
    at: string,
  ): LongTermMemoryHistoryEvent[] {
    if (!item.lastVerifiedAt) {
      return [];
    }
    return [
      {
        ...this.createHistoryEvent('verified', item, at),
        at: item.lastVerifiedAt,
      },
    ];
  }

  private mergeHistoryEvents(
    ...eventGroups: Array<LongTermMemoryHistoryEvent[] | undefined>
  ): LongTermMemoryHistoryEvent[] {
    const merged: LongTermMemoryHistoryEvent[] = [];
    const seen = new Set<string>();
    for (const event of eventGroups.flatMap((events) => events || [])) {
      const normalized = this.normalizeHistoryEvent(event);
      if (!normalized) {
        continue;
      }
      const key = JSON.stringify(normalized);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(normalized);
    }
    return merged;
  }

  private normalizeHistoryEvents(events?: unknown): LongTermMemoryHistoryEvent[] {
    if (!Array.isArray(events)) {
      return [];
    }
    return events.flatMap((event) => {
      const normalized = this.normalizeHistoryEvent(event);
      return normalized ? [normalized] : [];
    });
  }

  private normalizeHistoryEvent(event: unknown): LongTermMemoryHistoryEvent | null {
    if (!event || typeof event !== 'object') {
      return null;
    }
    const candidate = event as Partial<LongTermMemoryHistoryEvent>;
    if (
      candidate.action !== 'created'
      && candidate.action !== 'merged'
      && candidate.action !== 'updated'
      && candidate.action !== 'invalidated'
      && candidate.action !== 'verified'
    ) {
      return null;
    }
    if (!candidate.at) {
      return null;
    }
    return {
      action: candidate.action,
      at: String(candidate.at),
      source: candidate.source,
      confidence: typeof candidate.confidence === 'number' ? candidate.confidence : undefined,
      provenance: Array.isArray(candidate.provenance) ? candidate.provenance.map(String) : undefined,
      factKey: candidate.factKey ? String(candidate.factKey) : undefined,
      reason: candidate.reason ? String(candidate.reason) : undefined,
      summaryHash: candidate.summaryHash ? String(candidate.summaryHash) : undefined,
    };
  }

  private encodeHistoryEvents(events?: LongTermMemoryHistoryEvent[]): string[] {
    return this.normalizeHistoryEvents(events).map((event) =>
      `${HISTORY_PROVENANCE_PREFIX}${Buffer.from(JSON.stringify(event), 'utf8').toString('base64url')}`,
    );
  }

  private splitProvenanceAndHistory(provenance: string[]): {
    provenance: string[];
    history: LongTermMemoryHistoryEvent[];
  } {
    const history: LongTermMemoryHistoryEvent[] = [];
    const plain: string[] = [];
    for (const item of provenance) {
      if (!item.startsWith(HISTORY_PROVENANCE_PREFIX)) {
        plain.push(item);
        continue;
      }
      try {
        const decoded = JSON.parse(
          Buffer.from(item.slice(HISTORY_PROVENANCE_PREFIX.length), 'base64url').toString('utf8'),
        ) as unknown;
        const event = this.normalizeHistoryEvent(decoded);
        if (event) {
          history.push(event);
        }
      } catch {
        plain.push(item);
      }
    }
    return {
      provenance: this.mergeStringList(plain),
      history: this.mergeHistoryEvents(history),
    };
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
  ): { score: number; matchFields: string[]; scoreBreakdown: Record<string, number | string> } {
    let score = 0;
    const matchFields: string[] = [];
    const scoreBreakdown: Record<string, number | string> = {
      fts: 0,
      embedding: 'disabled',
    };
    const terms = queryLower
      .split(/[^a-z0-9_\-\u4e00-\u9fff]+/i)
      .map((term) => term.trim())
      .filter(Boolean);
    const hasMatch = (value?: string): boolean => {
      const lower = (value || '').toLowerCase();
      return terms.length === 0 ? lower.includes(queryLower) : terms.some((term) => lower.includes(term));
    };

    if (hasMatch(memory.title)) {
      score += 20;
      scoreBreakdown.title = 20;
      matchFields.push('title');
    }

    if (hasMatch(memory.summary)) {
      score += 12;
      scoreBreakdown.summary = 12;
      matchFields.push('summary');
    }

    if (hasMatch(memory.why)) {
      score += 6;
      scoreBreakdown.why = 6;
      matchFields.push('why');
    }

    if (hasMatch(memory.howToApply)) {
      score += 6;
      scoreBreakdown.howToApply = 6;
      matchFields.push('howToApply');
    }

    const tagMatches = memory.tags.filter((tag) => hasMatch(tag));
    if (tagMatches.length > 0) {
      const value = tagMatches.length * 4;
      score += value;
      scoreBreakdown.tags = value;
      matchFields.push('tags');
    }

    const linkMatches = (memory.links || []).filter((link) => hasMatch(link));
    if (linkMatches.length > 0) {
      const value = linkMatches.length * 2;
      score += value;
      scoreBreakdown.links = value;
      matchFields.push('links');
    }

    if (hasMatch(memory.type)) {
      score += 2;
      scoreBreakdown.type = 2;
      matchFields.push('type');
    }

    if (hasMatch(memory.factKey)) {
      score += 10;
      scoreBreakdown.factKey = 10;
      matchFields.push('factKey');
    }

    const entityMatches = [...memory.tags, ...(memory.links || [])].filter((value) => hasMatch(value)).length;
    if (entityMatches > 0) {
      const entityBoost = Math.min(10, entityMatches * 2);
      score += entityBoost;
      scoreBreakdown.entity = entityBoost;
    }

    const confidenceBoost = Math.round((memory.confidence || 0) * 10);
    score += confidenceBoost;
    scoreBreakdown.confidence = confidenceBoost;

    const statusWeight = this.getStatusScoreWeight(memory.status);
    score += statusWeight;
    scoreBreakdown.status = statusWeight;

    const recencyBoost = this.getRecencyBoost(memory.updatedAt);
    score += recencyBoost;
    scoreBreakdown.recency = recencyBoost;
    scoreBreakdown.total = score;

    return { score, matchFields: Array.from(new Set(matchFields)), scoreBreakdown };
  }

  private getStatusScoreWeight(status: LongTermMemoryStatus): number {
    if (status === 'active') return 8;
    if (status === 'stale') return -8;
    if (status === 'expired') return -20;
    return -16;
  }

  private getRecencyBoost(updatedAt: string): number {
    const updated = this.parseMemoryDate(updatedAt);
    if (!updated) return 0;
    const ageDays = Math.max(0, (Date.now() - updated.getTime()) / (24 * 60 * 60 * 1000));
    if (ageDays <= 7) return 5;
    if (ageDays <= 30) return 2;
    return 0;
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
    if ((memory.provenance || []).some((item) => item.startsWith('superseded-by:'))) {
      return 'superseded';
    }

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

    if (memory.status === 'superseded') {
      return options?.includeExpired ?? true;
    }

    if (memory.status === 'stale') {
      return options?.includeStale ?? false;
    }

    return false;
  }
}
