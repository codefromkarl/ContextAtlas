import crypto from 'node:crypto';

export interface EmbeddingGatewayCachedResponse {
  status: number;
  body: string;
  contentType: string;
}

interface CacheEntry {
  value: EmbeddingGatewayCachedResponse;
  expiresAt: number;
}

export interface EmbeddingGatewayCacheStoreStats {
  kind: string;
  enabled: boolean;
  ttlMs: number;
  entries?: number;
  maxEntries?: number;
  evictions?: number;
  connected?: boolean;
  keyPrefix?: string;
  layers?: EmbeddingGatewayCacheStoreStats[];
}

export interface EmbeddingGatewayCacheStats {
  hits: number;
  misses: number;
  writes: number;
  coalesced: number;
  inflight: number;
  store: EmbeddingGatewayCacheStoreStats;
}

export interface EmbeddingGatewayCacheStore {
  get(key: string): Promise<EmbeddingGatewayCachedResponse | null>;
  set(key: string, value: EmbeddingGatewayCachedResponse): Promise<void>;
  getStats(): EmbeddingGatewayCacheStoreStats;
  connect?(): Promise<void>;
  close?(): Promise<void>;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`).join(',')}}`;
}

export function buildEmbeddingGatewayCacheKey(payload: unknown): string {
  return crypto.createHash('sha256').update(stableSerialize(payload)).digest('hex');
}

export class MemoryEmbeddingGatewayCacheStore implements EmbeddingGatewayCacheStore {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly enabled: boolean;
  private readonly entries = new Map<string, CacheEntry>();
  private evictions = 0;

  constructor(input: { ttlMs: number; maxEntries: number }) {
    this.ttlMs = Math.max(0, input.ttlMs);
    this.maxEntries = Math.max(1, input.maxEntries);
    this.enabled = this.ttlMs > 0;
  }

  async get(key: string): Promise<EmbeddingGatewayCachedResponse | null> {
    if (!this.enabled) {
      return null;
    }

    const entry = this.entries.get(key);
    if (!entry) {
      return null;
    }

    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }

    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  async set(key: string, value: EmbeddingGatewayCachedResponse): Promise<void> {
    if (!this.enabled) {
      return;
    }

    if (this.entries.has(key)) {
      this.entries.delete(key);
    }

    this.entries.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });

    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (!oldestKey) {
        break;
      }
      this.entries.delete(oldestKey);
      this.evictions += 1;
    }
  }

  getStats(): EmbeddingGatewayCacheStoreStats {
    return {
      kind: 'memory',
      enabled: this.enabled,
      ttlMs: this.ttlMs,
      entries: this.entries.size,
      maxEntries: this.maxEntries,
      evictions: this.evictions,
    };
  }
}

export class EmbeddingGatewayCacheManager {
  private readonly store: EmbeddingGatewayCacheStore;
  private readonly inflight = new Map<string, Promise<EmbeddingGatewayCachedResponse>>();

  private hits = 0;
  private misses = 0;
  private writes = 0;
  private coalesced = 0;

  constructor(store: EmbeddingGatewayCacheStore) {
    this.store = store;
  }

  async connect(): Promise<void> {
    await this.store.connect?.();
  }

  async close(): Promise<void> {
    await this.store.close?.();
  }

  async get(key: string): Promise<EmbeddingGatewayCachedResponse | null> {
    const value = await this.store.get(key);
    if (value) {
      this.hits += 1;
      return value;
    }

    this.misses += 1;
    return null;
  }

  async set(key: string, value: EmbeddingGatewayCachedResponse): Promise<void> {
    await this.store.set(key, value);
    this.writes += 1;
  }

  async runCoalesced(
    key: string,
    factory: () => Promise<EmbeddingGatewayCachedResponse>,
  ): Promise<{ shared: boolean; response: EmbeddingGatewayCachedResponse }> {
    const existing = this.inflight.get(key);
    if (existing) {
      this.coalesced += 1;
      return {
        shared: true,
        response: await existing,
      };
    }

    const promise = factory().finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, promise);

    return {
      shared: false,
      response: await promise,
    };
  }

  getStats(): EmbeddingGatewayCacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      writes: this.writes,
      coalesced: this.coalesced,
      inflight: this.inflight.size,
      store: this.store.getStats(),
    };
  }
}

export class LayeredEmbeddingGatewayCacheStore implements EmbeddingGatewayCacheStore {
  private readonly l1: EmbeddingGatewayCacheStore;
  private readonly l2: EmbeddingGatewayCacheStore;

  constructor(input: { l1: EmbeddingGatewayCacheStore; l2: EmbeddingGatewayCacheStore }) {
    this.l1 = input.l1;
    this.l2 = input.l2;
  }

  async connect(): Promise<void> {
    await this.l1.connect?.();
    await this.l2.connect?.();
  }

  async close(): Promise<void> {
    await this.l1.close?.();
    await this.l2.close?.();
  }

  async get(key: string): Promise<EmbeddingGatewayCachedResponse | null> {
    const local = await this.l1.get(key);
    if (local) {
      return local;
    }

    const remote = await this.l2.get(key);
    if (!remote) {
      return null;
    }

    await this.l1.set(key, remote);
    return remote;
  }

  async set(key: string, value: EmbeddingGatewayCachedResponse): Promise<void> {
    await this.l1.set(key, value);
    await this.l2.set(key, value);
  }

  getStats(): EmbeddingGatewayCacheStoreStats {
    const l1 = this.l1.getStats();
    const l2 = this.l2.getStats();

    return {
      kind: 'hybrid',
      enabled: l1.enabled || l2.enabled,
      ttlMs: Math.max(l1.ttlMs, l2.ttlMs),
      layers: [l1, l2],
    };
  }
}
