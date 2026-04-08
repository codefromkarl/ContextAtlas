import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EmbeddingGatewayCacheManager,
  LayeredEmbeddingGatewayCacheStore,
  MemoryEmbeddingGatewayCacheStore,
  type EmbeddingGatewayCachedResponse,
  type EmbeddingGatewayCacheStore,
} from '../src/gateway/cache.ts';
import { RedisEmbeddingGatewayCacheStore } from '../src/gateway/redisCache.ts';

class FakeRedisClient {
  readonly values = new Map<string, string>();
  readonly setCalls: Array<{ key: string; value: string; options?: { PX?: number } }> = [];
  connectCalls = 0;
  quitCalls = 0;
  isOpen = false;

  async connect(): Promise<void> {
    this.connectCalls += 1;
    this.isOpen = true;
  }

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string, options?: { PX?: number }): Promise<void> {
    this.setCalls.push({ key, value, options });
    this.values.set(key, value);
  }

  async quit(): Promise<void> {
    this.quitCalls += 1;
    this.isOpen = false;
  }
}

class FakeAsyncStore implements EmbeddingGatewayCacheStore {
  private readonly values = new Map<string, EmbeddingGatewayCachedResponse>();

  async get(key: string): Promise<EmbeddingGatewayCachedResponse | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: EmbeddingGatewayCachedResponse): Promise<void> {
    this.values.set(key, value);
  }

  getStats() {
    return {
      kind: 'fake' as const,
      enabled: true,
      ttlMs: 1000,
    };
  }
}

class SpyStore implements EmbeddingGatewayCacheStore {
  readonly values = new Map<string, EmbeddingGatewayCachedResponse>();
  readonly getCalls: string[] = [];
  readonly setCalls: Array<{ key: string; value: EmbeddingGatewayCachedResponse }> = [];

  constructor(
    private readonly stats: {
      kind: string;
      enabled: boolean;
      ttlMs: number;
      entries?: number;
      maxEntries?: number;
      connected?: boolean;
      keyPrefix?: string;
    },
  ) {}

  async get(key: string): Promise<EmbeddingGatewayCachedResponse | null> {
    this.getCalls.push(key);
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: EmbeddingGatewayCachedResponse): Promise<void> {
    this.setCalls.push({ key, value });
    this.values.set(key, value);
  }

  getStats() {
    return {
      ...this.stats,
      entries: this.values.size,
    };
  }
}

test('RedisEmbeddingGatewayCacheStore 使用前缀和 TTL 读写缓存', async () => {
  const client = new FakeRedisClient();
  const store = new RedisEmbeddingGatewayCacheStore({
    client,
    ttlMs: 5000,
    keyPrefix: 'ctx:test:',
  });

  await store.connect();

  const value: EmbeddingGatewayCachedResponse = {
    status: 200,
    body: '{"ok":true}',
    contentType: 'application/json',
  };

  await store.set('abc', value);

  assert.equal(client.connectCalls, 1);
  assert.deepEqual(client.setCalls, [
    {
      key: 'ctx:test:abc',
      value: JSON.stringify(value),
      options: { PX: 5000 },
    },
  ]);
  assert.deepEqual(await store.get('abc'), value);

  const stats = store.getStats();
  assert.equal(stats.kind, 'redis');
  assert.equal(stats.connected, true);
  assert.equal(stats.keyPrefix, 'ctx:test:');

  await store.close();
  assert.equal(client.quitCalls, 1);
});

test('EmbeddingGatewayCacheManager 在异步 store 上保持缓存命中与并发合并统计', async () => {
  const manager = new EmbeddingGatewayCacheManager(new FakeAsyncStore());

  const first = await manager.get('k1');
  assert.equal(first, null);

  await manager.set('k1', {
    status: 200,
    body: '{"cached":true}',
    contentType: 'application/json',
  });

  const second = await manager.get('k1');
  assert.deepEqual(second, {
    status: 200,
    body: '{"cached":true}',
    contentType: 'application/json',
  });

  let executions = 0;
  const [left, right] = await Promise.all([
    manager.runCoalesced('same', async () => {
      executions += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { status: 200, body: 'left', contentType: 'text/plain' };
    }),
    manager.runCoalesced('same', async () => {
      executions += 1;
      return { status: 200, body: 'right', contentType: 'text/plain' };
    }),
  ]);

  assert.deepEqual(left.response, { status: 200, body: 'left', contentType: 'text/plain' });
  assert.deepEqual(right.response, { status: 200, body: 'left', contentType: 'text/plain' });
  assert.equal(left.shared, false);
  assert.equal(right.shared, true);
  assert.equal(executions, 1);

  const stats = manager.getStats();
  assert.equal(stats.hits, 1);
  assert.equal(stats.misses, 1);
  assert.equal(stats.writes, 1);
  assert.equal(stats.coalesced, 1);
  assert.equal(stats.store.kind, 'fake');
});

test('MemoryEmbeddingGatewayCacheStore 维持 TTL 和最大条目限制', async () => {
  const store = new MemoryEmbeddingGatewayCacheStore({
    ttlMs: 1000,
    maxEntries: 1,
  });

  await store.set('a', { status: 200, body: 'a', contentType: 'text/plain' });
  await store.set('b', { status: 200, body: 'b', contentType: 'text/plain' });

  assert.equal(await store.get('a'), null);
  assert.deepEqual(await store.get('b'), { status: 200, body: 'b', contentType: 'text/plain' });
  assert.equal(store.getStats().entries, 1);
});

test('LayeredEmbeddingGatewayCacheStore 在 L2 命中后回填 L1，并同步写入双层缓存', async () => {
  const l1 = new SpyStore({
    kind: 'memory',
    enabled: true,
    ttlMs: 1000,
    maxEntries: 16,
  });
  const l2 = new SpyStore({
    kind: 'redis',
    enabled: true,
    ttlMs: 1000,
    connected: true,
    keyPrefix: 'ctx:test:',
  });
  const layered = new LayeredEmbeddingGatewayCacheStore({
    l1,
    l2,
  });

  const cachedValue: EmbeddingGatewayCachedResponse = {
    status: 200,
    body: '{"from":"redis"}',
    contentType: 'application/json',
  };
  l2.values.set('warm-key', cachedValue);

  assert.deepEqual(await layered.get('warm-key'), cachedValue);
  assert.deepEqual(await l1.get('warm-key'), cachedValue);

  const freshValue: EmbeddingGatewayCachedResponse = {
    status: 200,
    body: '{"from":"write"}',
    contentType: 'application/json',
  };
  await layered.set('fresh-key', freshValue);

  assert.deepEqual(l1.values.get('fresh-key'), freshValue);
  assert.deepEqual(l2.values.get('fresh-key'), freshValue);

  const stats = layered.getStats();
  assert.equal(stats.kind, 'hybrid');
  assert.equal(stats.enabled, true);
  assert.equal(stats.layers?.length, 2);
  assert.equal(stats.layers?.[0]?.kind, 'memory');
  assert.equal(stats.layers?.[1]?.kind, 'redis');
});
