import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import {
  getEmbeddingGatewayConfig,
  parseEmbeddingGatewayUpstreams,
} from '../src/gateway/config.ts';
import { createEmbeddingGatewayServer } from '../src/gateway/server.ts';

interface TestServerHandle {
  baseUrl: string;
  close: () => Promise<void>;
}

function withEnv(
  entries: Record<string, string | undefined>,
  callback: () => void | Promise<void>,
): Promise<void> | void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(entries)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  const restore = () => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };

  try {
    const result = callback();
    if (result && typeof (result as Promise<void>).then === 'function') {
      return (result as Promise<void>).finally(restore);
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
}

async function startUpstreamServer(
  handler: (body: any, req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>,
): Promise<TestServerHandle> {
  const server = http.createServer(async (req, res) => {
    const body = await readJsonBody(req);
    await handler(body, req, res);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('failed to resolve upstream address');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1/embeddings`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

test('parseEmbeddingGatewayUpstreams 解析 JSON 上游列表并归一化默认值', () => {
  const upstreams = parseEmbeddingGatewayUpstreams(
    JSON.stringify([
      {
        name: 'primary',
        baseUrl: 'https://a.example.com/v1/embeddings',
        apiKey: 'key-a',
        weight: 3,
        models: ['text-embedding-3-large'],
        modelMap: {
          default: 'provider-a-model',
        },
      },
      {
        name: 'secondary',
        baseUrl: 'https://b.example.com/v1/embeddings',
        apiKey: 'key-b',
      },
    ]),
  );

  assert.equal(upstreams.length, 2);
  assert.deepEqual(upstreams[0], {
    name: 'primary',
    baseUrl: 'https://a.example.com/v1/embeddings',
    apiKey: 'key-a',
    weight: 3,
    models: ['text-embedding-3-large'],
    modelMap: {
      default: 'provider-a-model',
    },
    headers: {},
    protocol: 'openai',
  });
  assert.equal(upstreams[1]?.weight, 1);
  assert.deepEqual(upstreams[1]?.models, []);
});

test('parseEmbeddingGatewayUpstreams 支持 Hugging Face feature-extraction 协议', () => {
  const upstreams = parseEmbeddingGatewayUpstreams(
    JSON.stringify([
      {
        name: 'hf',
        baseUrl: 'https://router.huggingface.co/hf-inference/models/BAAI/bge-m3',
        apiKey: 'hf_xxx',
        protocol: 'hf-feature-extraction',
        models: ['BAAI/bge-m3'],
      },
    ]),
  );

  assert.equal(upstreams.length, 1);
  assert.equal(upstreams[0]?.protocol, 'hf-feature-extraction');
  assert.deepEqual(upstreams[0]?.models, ['BAAI/bge-m3']);
});

test('getEmbeddingGatewayConfig 从环境变量读取监听与上游配置', () =>
  withEnv(
    {
      EMBEDDING_GATEWAY_HOST: '0.0.0.0',
      EMBEDDING_GATEWAY_PORT: '9876',
      EMBEDDING_GATEWAY_TIMEOUT_MS: '12000',
      EMBEDDING_GATEWAY_FAILOVER_COOLDOWN_MS: '45000',
      EMBEDDING_GATEWAY_CACHE_TTL_MS: '15000',
      EMBEDDING_GATEWAY_CACHE_MAX_ENTRIES: '64',
      EMBEDDING_GATEWAY_CACHE_BACKEND: 'hybrid',
      EMBEDDING_GATEWAY_REDIS_URL: 'redis://127.0.0.1:6379/2',
      EMBEDDING_GATEWAY_REDIS_KEY_PREFIX: 'ctx:test:',
      EMBEDDING_GATEWAY_COALESCE_IDENTICAL_REQUESTS: 'false',
      EMBEDDING_GATEWAY_VALIDATE_UPSTREAMS: 'true',
      EMBEDDING_GATEWAY_VALIDATE_MODELS: 'text-embedding-3-large, BAAI/bge-m3',
      EMBEDDING_GATEWAY_VALIDATE_INPUT: 'gateway-probe',
      EMBEDDING_GATEWAY_API_KEYS: 'gw-a, gw-b',
      EMBEDDING_GATEWAY_UPSTREAMS: JSON.stringify([
        {
          name: 'primary',
          baseUrl: 'https://a.example.com/v1/embeddings',
          apiKey: 'key-a',
          weight: 2,
        },
      ]),
    },
    () => {
      const config = getEmbeddingGatewayConfig();

      assert.equal(config.host, '0.0.0.0');
      assert.equal(config.port, 9876);
      assert.equal(config.timeoutMs, 12000);
      assert.equal(config.failoverCooldownMs, 45000);
      assert.equal(config.cacheTtlMs, 15000);
      assert.equal(config.cacheMaxEntries, 64);
      assert.equal(config.cacheBackend, 'hybrid');
      assert.equal(config.redisUrl, 'redis://127.0.0.1:6379/2');
      assert.equal(config.redisKeyPrefix, 'ctx:test:');
      assert.equal(config.coalesceIdenticalRequests, false);
      assert.equal(config.validateUpstreams, true);
      assert.deepEqual(config.validateModels, ['text-embedding-3-large', 'BAAI/bge-m3']);
      assert.equal(config.validateInput, 'gateway-probe');
      assert.deepEqual(config.apiKeys, ['gw-a', 'gw-b']);
      assert.equal(config.upstreams.length, 1);
      assert.equal(config.upstreams[0]?.weight, 2);
    },
  ));

test('embedding gateway 轮询可用上游并在失败时切换', async (t) => {
  const calls: string[] = [];
  const upstreamA = await startUpstreamServer(async (body, _req, res) => {
    calls.push(`a:${String(body.model)}`);
    res.statusCode = calls.length === 2 ? 503 : 200;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify(
        res.statusCode === 200
          ? {
              object: 'list',
              data: [{ object: 'embedding', index: 0, embedding: [1, 0, 0] }],
              model: 'provider-a',
              usage: { prompt_tokens: 3, total_tokens: 3 },
            }
          : {
              error: { message: 'provider-a unavailable' },
            },
      ),
    );
  });
  const upstreamB = await startUpstreamServer(async (body, _req, res) => {
    calls.push(`b:${String(body.model)}`);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        object: 'list',
        data: [{ object: 'embedding', index: 0, embedding: [0, 1, 0] }],
        model: 'provider-b',
        usage: { prompt_tokens: 3, total_tokens: 3 },
      }),
    );
  });

  t.after(async () => {
    await upstreamA.close();
    await upstreamB.close();
  });

  const gateway = createEmbeddingGatewayServer({
    host: '127.0.0.1',
    port: 0,
    timeoutMs: 3000,
    failoverCooldownMs: 60000,
    apiKeys: ['gateway-secret'],
    cacheTtlMs: 0,
    cacheMaxEntries: 500,
    cacheBackend: 'memory',
    redisKeyPrefix: 'contextatlas:gateway:embeddings:',
    upstreams: [
      {
        name: 'a',
        baseUrl: upstreamA.baseUrl,
        apiKey: 'key-a',
        weight: 2,
        models: [],
        modelMap: {},
        headers: {},
        protocol: 'openai',
      },
      {
        name: 'b',
        baseUrl: upstreamB.baseUrl,
        apiKey: 'key-b',
        weight: 1,
        models: [],
        modelMap: {},
        headers: {},
        protocol: 'openai',
      },
    ],
    validateUpstreams: false,
    validateModels: [],
    validateInput: 'dimension-probe',
  });

  const { port, close } = await gateway.listen();
  t.after(async () => {
    await close();
  });

  const first = await fetch(`http://127.0.0.1:${port}/v1/embeddings`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer gateway-secret',
    },
    body: JSON.stringify({ model: 'text-embedding-3-large', input: 'alpha' }),
  });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).model, 'provider-a');

  const second = await fetch(`http://127.0.0.1:${port}/v1/embeddings`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer gateway-secret',
    },
    body: JSON.stringify({ model: 'text-embedding-3-large', input: 'beta' }),
  });
  assert.equal(second.status, 200);
  assert.equal((await second.json()).model, 'provider-b');

  assert.deepEqual(calls, ['a:text-embedding-3-large', 'a:text-embedding-3-large', 'b:text-embedding-3-large']);
});

test('embedding gateway healthz 暴露 provider 级成功率、失败率、延迟和冷却状态', async (t) => {
  const upstreamA = await startUpstreamServer(async (_body, _req, res) => {
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: { message: 'provider-a unavailable' } }));
  });
  const upstreamB = await startUpstreamServer(async (_body, _req, res) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        object: 'list',
        data: [{ object: 'embedding', index: 0, embedding: [0, 1, 0] }],
        model: 'provider-b',
        usage: { prompt_tokens: 3, total_tokens: 3 },
      }),
    );
  });

  t.after(async () => {
    await upstreamA.close();
    await upstreamB.close();
  });

  const gateway = createEmbeddingGatewayServer({
    host: '127.0.0.1',
    port: 0,
    timeoutMs: 3000,
    failoverCooldownMs: 60_000,
    apiKeys: [],
    cacheTtlMs: 0,
    cacheMaxEntries: 32,
    cacheBackend: 'memory',
    redisKeyPrefix: 'contextatlas:gateway:embeddings:',
    upstreams: [
      {
        name: 'a',
        baseUrl: upstreamA.baseUrl,
        apiKey: 'key-a',
        weight: 1,
        models: [],
        modelMap: {},
        headers: {},
        protocol: 'openai',
      },
      {
        name: 'b',
        baseUrl: upstreamB.baseUrl,
        apiKey: 'key-b',
        weight: 1,
        models: [],
        modelMap: {},
        headers: {},
        protocol: 'openai',
      },
    ],
    validateUpstreams: false,
    validateModels: [],
    validateInput: 'dimension-probe',
    coalesceIdenticalRequests: true,
  });

  const { port, close } = await gateway.listen();
  t.after(async () => {
    await close();
  });

  const response = await fetch(`http://127.0.0.1:${port}/v1/embeddings`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: 'text-embedding-3-large', input: 'alpha' }),
  });
  assert.equal(response.status, 200);

  const healthz = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(healthz.status, 200);

  const payload = (await healthz.json()) as {
    providerSummary: {
      totalRequests: number;
      successes: number;
      failures: number;
      successRate: number;
      failureRate: number;
      cooldownActive: number;
      available: number;
      avgLatencyMs: number;
    };
    providers: Array<{
      name: string;
      available: boolean;
      cooldownRemainingMs: number;
      metrics: {
        requests: number;
        successes: number;
        failures: number;
        successRate: number;
        failureRate: number;
        avgLatencyMs: number;
        cooldowns: number;
        lastStatus?: number;
      };
    }>;
  };

  assert.equal(payload.providerSummary.totalRequests, 2);
  assert.equal(payload.providerSummary.successes, 1);
  assert.equal(payload.providerSummary.failures, 1);
  assert.equal(payload.providerSummary.successRate, 0.5);
  assert.equal(payload.providerSummary.failureRate, 0.5);
  assert.equal(payload.providerSummary.cooldownActive, 1);
  assert.equal(payload.providerSummary.available, 1);
  assert.ok(payload.providerSummary.avgLatencyMs >= 0);

  const providerA = payload.providers.find((item) => item.name === 'a');
  const providerB = payload.providers.find((item) => item.name === 'b');

  assert.ok(providerA);
  assert.equal(providerA.available, false);
  assert.ok(providerA.cooldownRemainingMs > 0);
  assert.equal(providerA.metrics.requests, 1);
  assert.equal(providerA.metrics.failures, 1);
  assert.equal(providerA.metrics.failureRate, 1);
  assert.equal(providerA.metrics.cooldowns, 1);
  assert.equal(providerA.metrics.lastStatus, 503);

  assert.ok(providerB);
  assert.equal(providerB.available, true);
  assert.equal(providerB.metrics.requests, 1);
  assert.equal(providerB.metrics.successes, 1);
  assert.equal(providerB.metrics.successRate, 1);
  assert.ok(providerB.metrics.avgLatencyMs >= 0);
});

test('embedding gateway 对相同请求命中本地缓存，避免重复访问上游', async (t) => {
  let upstreamCalls = 0;
  const upstream = await startUpstreamServer(async (_body, _req, res) => {
    upstreamCalls += 1;
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        object: 'list',
        data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }],
        model: 'provider-cache',
        usage: { prompt_tokens: 2, total_tokens: 2 },
      }),
    );
  });

  t.after(async () => {
    await upstream.close();
  });

  const gateway = createEmbeddingGatewayServer({
    host: '127.0.0.1',
    port: 0,
    timeoutMs: 3000,
    failoverCooldownMs: 3000,
    cacheTtlMs: 60_000,
    cacheMaxEntries: 32,
    cacheBackend: 'memory',
    redisKeyPrefix: 'contextatlas:gateway:embeddings:',
    coalesceIdenticalRequests: true,
    validateUpstreams: false,
    validateModels: [],
    validateInput: 'dimension-probe',
    apiKeys: [],
    upstreams: [
      {
        name: 'cache',
        baseUrl: upstream.baseUrl,
        apiKey: 'key-cache',
        weight: 1,
        models: [],
        modelMap: {},
        headers: {},
        protocol: 'openai',
      },
    ],
  });

  const { port, close } = await gateway.listen();
  t.after(async () => {
    await close();
  });

  const url = `http://127.0.0.1:${port}/v1/embeddings`;
  const payload = { model: 'text-embedding-3-large', input: ['alpha', 'beta'] };

  const first = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('x-contextatlas-cache'), 'miss');

  const second = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('x-contextatlas-cache'), 'hit');
  assert.equal((await second.json()).model, 'provider-cache');
  assert.equal(upstreamCalls, 1);
});

test('embedding gateway 对并发相同请求执行单次上游调用', async (t) => {
  let upstreamCalls = 0;
  const upstream = await startUpstreamServer(async (_body, _req, res) => {
    upstreamCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 50));
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        object: 'list',
        data: [{ object: 'embedding', index: 0, embedding: [9, 9, 9] }],
        model: 'provider-coalesced',
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }),
    );
  });

  t.after(async () => {
    await upstream.close();
  });

  const gateway = createEmbeddingGatewayServer({
    host: '127.0.0.1',
    port: 0,
    timeoutMs: 3000,
    failoverCooldownMs: 3000,
    cacheTtlMs: 0,
    cacheMaxEntries: 32,
    cacheBackend: 'memory',
    redisKeyPrefix: 'contextatlas:gateway:embeddings:',
    coalesceIdenticalRequests: true,
    validateUpstreams: false,
    validateModels: [],
    validateInput: 'dimension-probe',
    apiKeys: [],
    upstreams: [
      {
        name: 'coalesce',
        baseUrl: upstream.baseUrl,
        apiKey: 'key-coalesce',
        weight: 1,
        models: [],
        modelMap: {},
        headers: {},
        protocol: 'openai',
      },
    ],
  });

  const { port, close } = await gateway.listen();
  t.after(async () => {
    await close();
  });

  const url = `http://127.0.0.1:${port}/v1/embeddings`;
  const payload = JSON.stringify({ model: 'text-embedding-3-small', input: 'same-input' });

  const [first, second] = await Promise.all([
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    }),
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    }),
  ]);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.headers.get('x-contextatlas-cache'), 'miss');
  assert.equal(second.headers.get('x-contextatlas-cache'), 'coalesced');
  assert.equal((await first.json()).model, 'provider-coalesced');
  assert.equal((await second.json()).model, 'provider-coalesced');
  assert.equal(upstreamCalls, 1);
});

test('embedding gateway 可将 Hugging Face feature-extraction 上游适配为 OpenAI-compatible embeddings', async (t) => {
  const upstreamCalls: Array<{ body: unknown; authorization: string | undefined }> = [];
  const upstream = await startUpstreamServer(async (body, req, res) => {
    upstreamCalls.push({
      body,
      authorization: req.headers.authorization,
    });
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify([[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]]));
  });

  t.after(async () => {
    await upstream.close();
  });

  const gateway = createEmbeddingGatewayServer({
    host: '127.0.0.1',
    port: 0,
    timeoutMs: 3000,
    failoverCooldownMs: 3000,
    cacheTtlMs: 0,
    cacheMaxEntries: 32,
    cacheBackend: 'memory',
    redisKeyPrefix: 'contextatlas:gateway:embeddings:',
    coalesceIdenticalRequests: true,
    validateUpstreams: false,
    validateModels: [],
    validateInput: 'dimension-probe',
    apiKeys: ['gateway-secret'],
    upstreams: [
      {
        name: 'hf',
        baseUrl: upstream.baseUrl,
        apiKey: 'hf_test',
        weight: 1,
        models: ['BAAI/bge-m3'],
        modelMap: {},
        headers: {},
        protocol: 'hf-feature-extraction',
      },
    ],
  });

  const { port, close } = await gateway.listen();
  t.after(async () => {
    await close();
  });

  const response = await fetch(`http://127.0.0.1:${port}/v1/embeddings`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer gateway-secret',
    },
    body: JSON.stringify({
      model: 'BAAI/bge-m3',
      input: ['alpha', 'beta'],
      encoding_format: 'float',
      user: 'ctx-test',
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.deepEqual(upstreamCalls, [
    {
      body: {
        inputs: ['alpha', 'beta'],
      },
      authorization: 'Bearer hf_test',
    },
  ]);
  assert.deepEqual(await response.json(), {
    object: 'list',
    data: [
      { object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] },
      { object: 'embedding', index: 1, embedding: [0.4, 0.5, 0.6] },
    ],
    model: 'BAAI/bge-m3',
    usage: {
      prompt_tokens: 0,
      total_tokens: 0,
    },
  });
});

test('embedding gateway 启动时校验同一逻辑模型的上游维度一致性', async (t) =>
  withEnv(
    {
      EMBEDDINGS_MODEL: 'text-embedding-3-large',
      EMBEDDINGS_DIMENSIONS: '3',
    },
    async () => {
      const upstreamA = await startUpstreamServer(async (_body, _req, res) => {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            object: 'list',
            data: [{ object: 'embedding', index: 0, embedding: [1, 2, 3] }],
            model: 'provider-a',
            usage: { prompt_tokens: 1, total_tokens: 1 },
          }),
        );
      });
      const upstreamB = await startUpstreamServer(async (_body, _req, res) => {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            object: 'list',
            data: [{ object: 'embedding', index: 0, embedding: [1, 2, 3, 4] }],
            model: 'provider-b',
            usage: { prompt_tokens: 1, total_tokens: 1 },
          }),
        );
      });

      t.after(async () => {
        await upstreamA.close();
        await upstreamB.close();
      });

      const gateway = createEmbeddingGatewayServer({
        host: '127.0.0.1',
        port: 0,
        timeoutMs: 3000,
        failoverCooldownMs: 3000,
        cacheTtlMs: 0,
        cacheMaxEntries: 32,
        cacheBackend: 'memory',
        redisKeyPrefix: 'contextatlas:gateway:embeddings:',
        coalesceIdenticalRequests: true,
        validateUpstreams: true,
        validateModels: [],
        validateInput: 'dimension-probe',
        apiKeys: [],
        upstreams: [
          {
            name: 'a',
            baseUrl: upstreamA.baseUrl,
            apiKey: 'key-a',
            weight: 1,
            models: [],
            modelMap: {},
            headers: {},
            protocol: 'openai',
          },
          {
            name: 'b',
            baseUrl: upstreamB.baseUrl,
            apiKey: 'key-b',
            weight: 1,
            models: [],
            modelMap: {},
            headers: {},
            protocol: 'openai',
          },
        ],
      });

      await assert.rejects(
        () => gateway.listen(),
        /上游 embedding 维度不一致|expected 3/,
      );
    },
  ));
