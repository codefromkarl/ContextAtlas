import { closeSync, mkdirSync, openSync } from 'node:fs';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { resolveBaseDir } from '../../runtimePaths.js';
import { logger } from '../../utils/logger.js';

const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 250;

export interface LocalEmbeddingGatewayTarget {
  host: string;
  port: number;
}

export type AutoStartEmbeddingGatewayResult =
  | { status: 'skipped' }
  | { status: 'reused'; host: string; port: number }
  | { status: 'spawned'; host: string; port: number; pid: number | null };

interface SpawnGatewayInput {
  host: string;
  port: number;
  env: NodeJS.ProcessEnv;
  cliEntryPath: string;
}

interface EnsureEmbeddingGatewayDependencies {
  env?: NodeJS.ProcessEnv;
  cliEntryPath?: string;
  isPortListening?: (target: LocalEmbeddingGatewayTarget, timeoutMs: number) => Promise<boolean>;
  waitForPort?: (target: LocalEmbeddingGatewayTarget, timeoutMs: number) => Promise<boolean>;
  spawnGateway?: (input: SpawnGatewayInput) => Promise<{ pid: number | null }>;
}

export function resolveAutoStartEmbeddingGatewayTarget(
  env: NodeJS.ProcessEnv = process.env,
): LocalEmbeddingGatewayTarget | null {
  if (!shouldAutoStartEmbeddingGateway(env)) {
    return null;
  }

  const rawBaseUrl = env.EMBEDDINGS_BASE_URL?.trim();
  if (!rawBaseUrl) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(rawBaseUrl);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:') {
    return null;
  }

  const normalizedHost = normalizeLoopbackHost(parsed.hostname);
  if (!normalizedHost) {
    return null;
  }

  const normalizedPath = parsed.pathname.replace(/\/+$/, '');
  if (normalizedPath !== '/v1/embeddings') {
    return null;
  }

  const port = parsed.port ? Number.parseInt(parsed.port, 10) : 80;
  if (!Number.isInteger(port) || port <= 0) {
    return null;
  }

  return {
    host: normalizedHost,
    port,
  };
}

export async function ensureEmbeddingGatewayForMcp(
  dependencies: EnsureEmbeddingGatewayDependencies = {},
): Promise<AutoStartEmbeddingGatewayResult> {
  const env = dependencies.env ?? process.env;
  const target = resolveAutoStartEmbeddingGatewayTarget(env);
  if (!target) {
    return { status: 'skipped' };
  }

  const isPortListening = dependencies.isPortListening ?? defaultIsPortListening;
  const waitForPort = dependencies.waitForPort ?? waitForListeningPort;

  if (await isPortListening(target, DEFAULT_CONNECT_TIMEOUT_MS)) {
    logger.info(target, '检测到本地 embedding gateway 已在运行，直接复用');
    return { status: 'reused', ...target };
  }

  const cliEntryPath = dependencies.cliEntryPath || process.argv[1];
  if (!cliEntryPath) {
    logger.warn(target, '无法解析当前 CLI 入口，跳过本地 embedding gateway 自动启动');
    return { status: 'skipped' };
  }

  const spawnGateway = dependencies.spawnGateway ?? defaultSpawnGateway;
  const spawnEnv = withNodeProxyIfNeeded(env);
  const started = await spawnGateway({
    host: target.host,
    port: target.port,
    env: spawnEnv,
    cliEntryPath,
  });

  const ready = await waitForPort(target, DEFAULT_WAIT_TIMEOUT_MS);
  if (!ready) {
    logger.warn(
      { ...target, pid: started.pid },
      '本地 embedding gateway 自动启动后未在超时时间内完成监听',
    );
  } else {
    logger.info(
      { ...target, pid: started.pid },
      'MCP 已自动启动本地 embedding gateway',
    );
  }

  return {
    status: 'spawned',
    ...target,
    pid: started.pid,
  };
}

function shouldAutoStartEmbeddingGateway(env: NodeJS.ProcessEnv): boolean {
  const raw = env.CONTEXTATLAS_AUTO_START_EMBEDDING_GATEWAY?.trim().toLowerCase();
  if (!raw) {
    return true;
  }
  return !['0', 'false', 'no', 'off'].includes(raw);
}

function normalizeLoopbackHost(hostname: string): string | null {
  const normalized = hostname.trim().toLowerCase();
  if (normalized === 'localhost' || normalized === '127.0.0.1') {
    return '127.0.0.1';
  }
  if (normalized === '::1' || normalized === '[::1]') {
    return '::1';
  }
  return null;
}

function withNodeProxyIfNeeded(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.NODE_USE_ENV_PROXY?.trim()) {
    return { ...env };
  }

  const proxyKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];
  const hasProxy = proxyKeys.some((key) => env[key]?.trim());
  if (!hasProxy) {
    return { ...env };
  }

  return {
    ...env,
    NODE_USE_ENV_PROXY: '1',
  };
}

async function defaultIsPortListening(
  target: LocalEmbeddingGatewayTarget,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: target.host, port: target.port });

    const finish = (result: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function waitForListeningPort(
  target: LocalEmbeddingGatewayTarget,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await defaultIsPortListening(target, DEFAULT_CONNECT_TIMEOUT_MS)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

async function defaultSpawnGateway(input: SpawnGatewayInput): Promise<{ pid: number | null }> {
  const logPath = resolveGatewayAutostartLogPath();
  mkdirSync(path.dirname(logPath), { recursive: true });
  const fd = openSync(logPath, 'a');

  const child = spawn(
    process.execPath,
    [
      path.resolve(input.cliEntryPath),
      'gateway:embeddings',
      '--host',
      input.host,
      '--port',
      String(input.port),
    ],
    {
      detached: true,
      stdio: ['ignore', fd, fd],
      env: input.env,
    },
  );

  closeSync(fd);
  child.unref();
  return { pid: child.pid ?? null };
}

function resolveGatewayAutostartLogPath(now: Date = new Date()): string {
  const timestamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '-',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');
  return path.join(resolveBaseDir(), 'logs', `gateway-autostart-${timestamp}.log`);
}
