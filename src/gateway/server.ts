import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { logger } from '../utils/logger.js';
import {
  buildEmbeddingGatewayCacheKey,
  EmbeddingGatewayCacheManager,
  MemoryEmbeddingGatewayCacheStore,
  type EmbeddingGatewayCacheStore,
  type EmbeddingGatewayCachedResponse,
} from './cache.js';
import type { EmbeddingGatewayConfig } from './config.js';
import { EmbeddingGatewayProviderPool, type EmbeddingGatewayProvider } from './providerPool.js';
import { RedisEmbeddingGatewayCacheStore } from './redisCache.js';

interface GatewayRequestBody {
  input: string | string[];
  model: string;
  encoding_format?: string;
  dimensions?: number;
  user?: string;
}

interface UpstreamResult {
  ok: boolean;
  status: number;
  body: string;
  contentType: string;
  retriable: boolean;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString('utf-8');
  return raw.length === 0 ? {} : JSON.parse(raw);
}

function getBearerToken(req: http.IncomingMessage): string | null {
  const raw = req.headers.authorization;
  if (!raw) {
    return null;
  }

  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function isValidEmbeddingRequest(value: unknown): value is GatewayRequestBody {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const request = value as Partial<GatewayRequestBody>;
  const hasValidInput =
    typeof request.input === 'string' ||
    (Array.isArray(request.input) && request.input.every((item) => typeof item === 'string'));
  return typeof request.model === 'string' && request.model.length > 0 && hasValidInput;
}

function resolveUpstreamModel(provider: EmbeddingGatewayProvider, requestedModel: string): string {
  return provider.modelMap[requestedModel] || provider.modelMap.default || requestedModel;
}

async function forwardEmbeddingRequest(input: {
  provider: EmbeddingGatewayProvider;
  requestBody: GatewayRequestBody;
  timeoutMs: number;
}): Promise<UpstreamResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);

  try {
    const response = await fetch(input.provider.baseUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${input.provider.apiKey}`,
        ...input.provider.headers,
      },
      body: JSON.stringify(input.requestBody),
      signal: controller.signal,
    });
    const body = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      body,
      contentType: response.headers.get('content-type') || 'application/json',
      retriable: response.status === 429 || response.status >= 500,
    };
  } finally {
    clearTimeout(timer);
  }
}

function sendResponse(
  res: http.ServerResponse,
  response: EmbeddingGatewayCachedResponse,
  cacheStatus?: 'miss' | 'hit' | 'coalesced',
): void {
  res.statusCode = response.status;
  res.setHeader('content-type', response.contentType);
  if (cacheStatus) {
    res.setHeader('x-contextatlas-cache', cacheStatus);
  }
  res.end(response.body);
}

export interface EmbeddingGatewayServer {
  listen(): Promise<{ port: number; close: () => Promise<void> }>;
}

export interface EmbeddingGatewayServerDependencies {
  cacheManager?: EmbeddingGatewayCacheManager;
  cacheStore?: EmbeddingGatewayCacheStore;
}

function createCacheManager(
  config: EmbeddingGatewayConfig,
  deps: EmbeddingGatewayServerDependencies,
): EmbeddingGatewayCacheManager {
  if (deps.cacheManager) {
    return deps.cacheManager;
  }

  if (deps.cacheStore) {
    return new EmbeddingGatewayCacheManager(deps.cacheStore);
  }

  const store =
    config.cacheBackend === 'redis'
      ? new RedisEmbeddingGatewayCacheStore({
          ttlMs: config.cacheTtlMs,
          keyPrefix: config.redisKeyPrefix,
          url: config.redisUrl,
        })
      : new MemoryEmbeddingGatewayCacheStore({
          ttlMs: config.cacheTtlMs,
          maxEntries: config.cacheMaxEntries,
        });

  return new EmbeddingGatewayCacheManager(store);
}

export function createEmbeddingGatewayServer(
  config: EmbeddingGatewayConfig,
  deps: EmbeddingGatewayServerDependencies = {},
): EmbeddingGatewayServer {
  const pool = new EmbeddingGatewayProviderPool(config.upstreams, config.failoverCooldownMs);
  const cache = createCacheManager(config, deps);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

      if (req.method === 'GET' && url.pathname === '/healthz') {
        json(res, 200, {
          ok: true,
          providers: pool.getSnapshots(),
          cache: cache.getStats(),
        });
        return;
      }

      if (req.method !== 'POST' || url.pathname !== '/v1/embeddings') {
        json(res, 404, {
          error: {
            message: 'not found',
            type: 'invalid_request_error',
          },
        });
        return;
      }

      if (config.apiKeys.length > 0) {
        const token = getBearerToken(req);
        if (!token || !config.apiKeys.includes(token)) {
          json(res, 401, {
            error: {
              message: 'unauthorized',
              type: 'authentication_error',
            },
          });
          return;
        }
      }

      let payload: unknown;
      try {
        payload = await readJsonBody(req);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        json(res, 400, {
          error: {
            message: `invalid json: ${message}`,
            type: 'invalid_request_error',
          },
        });
        return;
      }

      if (!isValidEmbeddingRequest(payload)) {
        json(res, 400, {
          error: {
            message: 'request body must include model and string/string[] input',
            type: 'invalid_request_error',
          },
        });
        return;
      }

      const cacheKey = buildEmbeddingGatewayCacheKey(payload as Record<string, unknown>);
      const cached = await cache.get(cacheKey);
      if (cached) {
        sendResponse(res, cached, 'hit');
        return;
      }

      const execute = async (): Promise<EmbeddingGatewayCachedResponse> => {
        const candidates = pool.selectCandidates(payload.model);
        if (candidates.length === 0) {
          return {
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({
              error: {
                message: `no upstream available for model ${payload.model}`,
                type: 'service_unavailable',
              },
            }),
          };
        }

        let lastRetriableMessage = 'all upstreams failed';
        for (const provider of candidates) {
          const upstreamBody = {
            ...payload,
            model: resolveUpstreamModel(provider, payload.model),
          };

          try {
            const upstream = await forwardEmbeddingRequest({
              provider,
              requestBody: upstreamBody,
              timeoutMs: config.timeoutMs,
            });

            if (upstream.ok) {
              pool.markSuccess(provider.name);
              const response = {
                status: upstream.status,
                contentType: upstream.contentType,
                body: upstream.body,
              };
              await cache.set(cacheKey, response);
              return response;
            }

            if (!upstream.retriable) {
              return {
                status: upstream.status,
                contentType: upstream.contentType,
                body: upstream.body,
              };
            }

            pool.markFailure(provider.name);
            lastRetriableMessage = `upstream ${provider.name} returned ${upstream.status}`;
            logger.warn(
              { provider: provider.name, status: upstream.status },
              'Embedding gateway retriable upstream failure',
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            pool.markFailure(provider.name);
            lastRetriableMessage = `upstream ${provider.name} failed: ${message}`;
            logger.warn(
              { provider: provider.name, error: message },
              'Embedding gateway upstream request failed',
            );
          }
        }

        return {
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            error: {
              message: lastRetriableMessage,
              type: 'service_unavailable',
            },
          }),
        };
      };

      if (!config.coalesceIdenticalRequests) {
        sendResponse(res, await execute(), 'miss');
        return;
      }

      const inflight = await cache.runCoalesced(cacheKey, execute);
      sendResponse(res, inflight.response, inflight.shared ? 'coalesced' : 'miss');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ error: message }, 'Embedding gateway internal error');
      json(res, 500, {
        error: {
          message,
          type: 'internal_server_error',
        },
      });
    }
  });

  return {
    async listen() {
      await cache.connect();

      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
          server.off('error', reject);
          resolve();
        });
      });

      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('embedding gateway 启动后无法获取监听地址');
      }

      return {
        port: (address as AddressInfo).port,
        close: () =>
          new Promise<void>((resolve, reject) => {
            server.close(async (error) => {
              if (error) {
                reject(error);
                return;
              }

              try {
                await cache.close();
                resolve();
              } catch (closeError) {
                reject(closeError);
              }
            });
          }),
      };
    },
  };
}
