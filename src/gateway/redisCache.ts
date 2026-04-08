import type {
  EmbeddingGatewayCachedResponse,
  EmbeddingGatewayCacheStore,
  EmbeddingGatewayCacheStoreStats,
} from './cache.js';

export interface EmbeddingGatewayRedisClient {
  isOpen?: boolean;
  connect?(): Promise<void>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { PX?: number }): Promise<unknown>;
  quit?(): Promise<void>;
}

interface RedisCacheStoreInput {
  ttlMs: number;
  keyPrefix: string;
  url?: string;
  client?: EmbeddingGatewayRedisClient;
  createClient?: (url: string) => Promise<EmbeddingGatewayRedisClient> | EmbeddingGatewayRedisClient;
}

async function defaultCreateRedisClient(url: string): Promise<EmbeddingGatewayRedisClient> {
  const { createClient } = await import('redis');
  return createClient({ url }) as EmbeddingGatewayRedisClient;
}

export class RedisEmbeddingGatewayCacheStore implements EmbeddingGatewayCacheStore {
  private readonly ttlMs: number;
  private readonly keyPrefix: string;
  private readonly enabled: boolean;
  private readonly url?: string;
  private readonly createClient: (url: string) => Promise<EmbeddingGatewayRedisClient> | EmbeddingGatewayRedisClient;
  private client?: EmbeddingGatewayRedisClient;
  private connected = false;

  constructor(input: RedisCacheStoreInput) {
    this.ttlMs = Math.max(0, input.ttlMs);
    this.keyPrefix = input.keyPrefix;
    this.enabled = this.ttlMs > 0;
    this.url = input.url;
    this.client = input.client;
    this.createClient = input.createClient ?? defaultCreateRedisClient;
  }

  private resolveKey(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  async connect(): Promise<void> {
    if (!this.enabled || this.connected) {
      return;
    }

    if (!this.client) {
      if (!this.url) {
        throw new Error('EMBEDDING_GATEWAY_REDIS_URL 环境变量未设置');
      }
      this.client = await this.createClient(this.url);
    }

    if (this.client.connect && !this.client.isOpen) {
      await this.client.connect();
    }

    this.connected = true;
  }

  async get(key: string): Promise<EmbeddingGatewayCachedResponse | null> {
    if (!this.enabled) {
      return null;
    }

    await this.connect();
    const raw = await this.client?.get(this.resolveKey(key));
    if (!raw) {
      return null;
    }

    return JSON.parse(raw) as EmbeddingGatewayCachedResponse;
  }

  async set(key: string, value: EmbeddingGatewayCachedResponse): Promise<void> {
    if (!this.enabled) {
      return;
    }

    await this.connect();
    await this.client?.set(this.resolveKey(key), JSON.stringify(value), {
      PX: this.ttlMs,
    });
  }

  getStats(): EmbeddingGatewayCacheStoreStats {
    return {
      kind: 'redis',
      enabled: this.enabled,
      ttlMs: this.ttlMs,
      connected: this.connected || this.client?.isOpen || false,
      keyPrefix: this.keyPrefix,
    };
  }

  async close(): Promise<void> {
    if (!this.client?.quit) {
      this.connected = false;
      return;
    }

    await this.client.quit();
    this.connected = false;
  }
}
