import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ensureEmbeddingGatewayForMcp,
  resolveAutoStartEmbeddingGatewayTarget,
} from '../src/mcp/runtime/autoStartEmbeddingGateway.ts';

test('resolveAutoStartEmbeddingGatewayTarget 仅识别本地 http gateway', () => {
  assert.deepEqual(
    resolveAutoStartEmbeddingGatewayTarget({
      EMBEDDINGS_BASE_URL: 'http://localhost:8787/v1/embeddings',
    }),
    { host: '127.0.0.1', port: 8787 },
  );

  assert.deepEqual(
    resolveAutoStartEmbeddingGatewayTarget({
      EMBEDDINGS_BASE_URL: 'http://127.0.0.1:9000/v1/embeddings/',
    }),
    { host: '127.0.0.1', port: 9000 },
  );

  assert.equal(
    resolveAutoStartEmbeddingGatewayTarget({
      EMBEDDINGS_BASE_URL: 'https://127.0.0.1:8787/v1/embeddings',
    }),
    null,
  );

  assert.equal(
    resolveAutoStartEmbeddingGatewayTarget({
      EMBEDDINGS_BASE_URL: 'https://api.siliconflow.cn/v1/embeddings',
    }),
    null,
  );
});

test('ensureEmbeddingGatewayForMcp 在本地 gateway 未监听时自动启动', async () => {
  let spawnCalls = 0;
  let receivedEnv: NodeJS.ProcessEnv | undefined;
  let receivedHost: string | undefined;
  let receivedPort: number | undefined;

  const result = await ensureEmbeddingGatewayForMcp({
    env: {
      EMBEDDINGS_BASE_URL: 'http://localhost:8787/v1/embeddings',
      HTTP_PROXY: 'http://127.0.0.1:7897',
    },
    cliEntryPath: '/repo/dist/index.js',
    isPortListening: async () => false,
    waitForPort: async () => true,
    spawnGateway: async (input) => {
      spawnCalls += 1;
      receivedEnv = input.env;
      receivedHost = input.host;
      receivedPort = input.port;
      return { pid: 12345 };
    },
  });

  assert.equal(result.status, 'spawned');
  assert.equal(result.pid, 12345);
  assert.equal(spawnCalls, 1);
  assert.equal(receivedHost, '127.0.0.1');
  assert.equal(receivedPort, 8787);
  assert.equal(receivedEnv?.NODE_USE_ENV_PROXY, '1');
});

test('ensureEmbeddingGatewayForMcp 遇到已监听端口时直接复用', async () => {
  let spawnCalls = 0;

  const result = await ensureEmbeddingGatewayForMcp({
    env: {
      EMBEDDINGS_BASE_URL: 'http://127.0.0.1:8787/v1/embeddings',
    },
    cliEntryPath: '/repo/dist/index.js',
    isPortListening: async () => true,
    spawnGateway: async () => {
      spawnCalls += 1;
      return { pid: 1 };
    },
  });

  assert.deepEqual(result, {
    status: 'reused',
    host: '127.0.0.1',
    port: 8787,
  });
  assert.equal(spawnCalls, 0);
});

test('ensureEmbeddingGatewayForMcp 对外部 embeddings URL 跳过自动启动', async () => {
  let spawnCalls = 0;

  const result = await ensureEmbeddingGatewayForMcp({
    env: {
      EMBEDDINGS_BASE_URL: 'https://api.siliconflow.cn/v1/embeddings',
    },
    cliEntryPath: '/repo/dist/index.js',
    spawnGateway: async () => {
      spawnCalls += 1;
      return { pid: 1 };
    },
  });

  assert.deepEqual(result, { status: 'skipped' });
  assert.equal(spawnCalls, 0);
});
