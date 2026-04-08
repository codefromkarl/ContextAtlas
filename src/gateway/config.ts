export interface EmbeddingGatewayUpstreamConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  weight: number;
  models: string[];
  modelMap: Record<string, string>;
  headers: Record<string, string>;
}

export interface EmbeddingGatewayConfig {
  host: string;
  port: number;
  timeoutMs: number;
  failoverCooldownMs: number;
  cacheTtlMs: number;
  cacheMaxEntries: number;
  cacheBackend: 'memory' | 'redis';
  redisUrl?: string;
  redisKeyPrefix: string;
  coalesceIdenticalRequests: boolean;
  apiKeys: string[];
  upstreams: EmbeddingGatewayUpstreamConfig[];
}

interface RawEmbeddingGatewayUpstream {
  name?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
  weight?: unknown;
  models?: unknown;
  modelMap?: unknown;
  headers?: unknown;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parseCacheBackend(value: string | undefined): 'memory' | 'redis' {
  return value?.trim().toLowerCase() === 'redis' ? 'redis' : 'memory';
}

function parseStringRecord(value: unknown, field: string): Record<string, string> {
  if (value === undefined) {
    return {};
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} 必须是对象`);
  }

  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      throw new Error(`${field}.${key} 必须是非空字符串`);
    }
    result[key] = raw;
  }
  return result;
}

export function parseEmbeddingGatewayUpstreams(
  raw: string | undefined,
): EmbeddingGatewayUpstreamConfig[] {
  if (!raw) {
    throw new Error('EMBEDDING_GATEWAY_UPSTREAMS 环境变量未设置');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`EMBEDDING_GATEWAY_UPSTREAMS 不是合法 JSON: ${message}`);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('EMBEDDING_GATEWAY_UPSTREAMS 必须是非空数组');
  }

  return parsed.map((item, index) => {
    const upstream = item as RawEmbeddingGatewayUpstream;
    const name =
      typeof upstream.name === 'string' && upstream.name.trim().length > 0
        ? upstream.name.trim()
        : `upstream-${index + 1}`;
    const baseUrl =
      typeof upstream.baseUrl === 'string' && upstream.baseUrl.trim().length > 0
        ? upstream.baseUrl.trim()
        : null;
    const apiKey =
      typeof upstream.apiKey === 'string' && upstream.apiKey.trim().length > 0
        ? upstream.apiKey.trim()
        : null;

    if (!baseUrl) {
      throw new Error(`EMBEDDING_GATEWAY_UPSTREAMS[${index}].baseUrl 未设置`);
    }
    if (!apiKey) {
      throw new Error(`EMBEDDING_GATEWAY_UPSTREAMS[${index}].apiKey 未设置`);
    }

    const models = Array.isArray(upstream.models)
      ? upstream.models.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : [];
    const weight =
      typeof upstream.weight === 'number' && Number.isFinite(upstream.weight)
        ? Math.max(1, Math.floor(upstream.weight))
        : 1;

    return {
      name,
      baseUrl,
      apiKey,
      weight,
      models,
      modelMap: parseStringRecord(upstream.modelMap, `EMBEDDING_GATEWAY_UPSTREAMS[${index}].modelMap`),
      headers: parseStringRecord(upstream.headers, `EMBEDDING_GATEWAY_UPSTREAMS[${index}].headers`),
    };
  });
}

export function getEmbeddingGatewayConfig(
  overrides: Partial<
    Pick<
      EmbeddingGatewayConfig,
      | 'host'
      | 'port'
      | 'timeoutMs'
      | 'failoverCooldownMs'
      | 'cacheTtlMs'
      | 'cacheMaxEntries'
      | 'cacheBackend'
      | 'redisUrl'
      | 'redisKeyPrefix'
      | 'coalesceIdenticalRequests'
    >
  > = {},
): EmbeddingGatewayConfig {
  const host = overrides.host || process.env.EMBEDDING_GATEWAY_HOST || '127.0.0.1';
  const port = overrides.port ?? parsePositiveInt(process.env.EMBEDDING_GATEWAY_PORT, 8787);
  const timeoutMs =
    overrides.timeoutMs ?? parsePositiveInt(process.env.EMBEDDING_GATEWAY_TIMEOUT_MS, 30000);
  const failoverCooldownMs =
    overrides.failoverCooldownMs ??
    parsePositiveInt(process.env.EMBEDDING_GATEWAY_FAILOVER_COOLDOWN_MS, 30000);
  const cacheTtlMs =
    overrides.cacheTtlMs ?? parseNonNegativeInt(process.env.EMBEDDING_GATEWAY_CACHE_TTL_MS, 0);
  const cacheMaxEntries =
    overrides.cacheMaxEntries ??
    parsePositiveInt(process.env.EMBEDDING_GATEWAY_CACHE_MAX_ENTRIES, 500);
  const cacheBackend =
    overrides.cacheBackend ?? parseCacheBackend(process.env.EMBEDDING_GATEWAY_CACHE_BACKEND);
  const redisUrl = overrides.redisUrl ?? process.env.EMBEDDING_GATEWAY_REDIS_URL;
  const redisKeyPrefix =
    overrides.redisKeyPrefix ??
    process.env.EMBEDDING_GATEWAY_REDIS_KEY_PREFIX ??
    'contextatlas:gateway:embeddings:';
  const coalesceIdenticalRequests =
    overrides.coalesceIdenticalRequests ??
    parseBoolean(process.env.EMBEDDING_GATEWAY_COALESCE_IDENTICAL_REQUESTS, true);
  const apiKeys = (process.env.EMBEDDING_GATEWAY_API_KEYS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  if (cacheBackend === 'redis' && (!redisUrl || redisUrl.trim().length === 0)) {
    throw new Error('EMBEDDING_GATEWAY_REDIS_URL 环境变量未设置');
  }

  return {
    host,
    port,
    timeoutMs,
    failoverCooldownMs,
    cacheTtlMs,
    cacheMaxEntries,
    cacheBackend,
    redisUrl,
    redisKeyPrefix,
    coalesceIdenticalRequests,
    apiKeys,
    upstreams: parseEmbeddingGatewayUpstreams(process.env.EMBEDDING_GATEWAY_UPSTREAMS),
  };
}
