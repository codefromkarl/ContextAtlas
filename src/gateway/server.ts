import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { logger } from '../utils/logger.js';
import {
  buildEmbeddingGatewayCacheKey,
  EmbeddingGatewayCacheManager,
  LayeredEmbeddingGatewayCacheStore,
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

function selectCompatibleProviders(
  providers: EmbeddingGatewayProvider[],
  logicalModel: string,
): EmbeddingGatewayProvider[] {
  return providers.filter((provider) => provider.models.length === 0 || provider.models.includes(logicalModel));
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'number' && Number.isFinite(item));
}

function normalizeHfFeatureExtractionEmbeddings(
  input: string | string[],
  body: string,
): number[][] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`feature-extraction 响应不是合法 JSON: ${message}`);
  }

  if (isNumberArray(parsed)) {
    if (typeof input === 'string' || input.length === 1) {
      return [parsed];
    }
    throw new Error('feature-extraction 返回单个向量，但请求包含多条输入');
  }

  if (!Array.isArray(parsed) || !parsed.every(isNumberArray)) {
    throw new Error('feature-extraction 响应格式无效，期望 number[] 或 number[][]');
  }

  if (typeof input === 'string') {
    if (parsed.length === 1) {
      return [parsed[0]];
    }
    throw new Error('feature-extraction 返回多条向量，但请求仅包含单条输入');
  }

  if (parsed.length !== input.length) {
    throw new Error(
      `feature-extraction 返回向量数 ${parsed.length} 与输入数 ${input.length} 不一致`,
    );
  }

  return parsed;
}

function buildOpenAiEmbeddingResponse(input: string | string[], model: string, embeddings: number[][]): string {
  return JSON.stringify({
    object: 'list',
    data: embeddings.map((embedding, index) => ({
      object: 'embedding',
      index,
      embedding,
    })),
    model,
    usage: {
      prompt_tokens: 0,
      total_tokens: 0,
    },
  });
}

function buildUpstreamRequestBody(
  provider: EmbeddingGatewayProvider,
  requestBody: GatewayRequestBody,
): Record<string, unknown> {
  if (provider.protocol === 'hf-feature-extraction') {
    return {
      inputs: requestBody.input,
    };
  }

  return {
    ...requestBody,
    model: resolveUpstreamModel(provider, requestBody.model),
  };
}

function normalizeUpstreamSuccessResponse(
  provider: EmbeddingGatewayProvider,
  requestBody: GatewayRequestBody,
  upstream: UpstreamResult,
): EmbeddingGatewayCachedResponse {
  if (provider.protocol === 'hf-feature-extraction') {
    return {
      status: upstream.status,
      contentType: 'application/json',
      body: buildOpenAiEmbeddingResponse(
        requestBody.input,
        requestBody.model,
        normalizeHfFeatureExtractionEmbeddings(requestBody.input, upstream.body),
      ),
    };
  }

  return {
    status: upstream.status,
    contentType: upstream.contentType,
    body: upstream.body,
  };
}

async function forwardEmbeddingRequest(input: {
  provider: EmbeddingGatewayProvider;
  requestBody: Record<string, unknown>;
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

function extractEmbeddingDimensions(
  provider: EmbeddingGatewayProvider,
  requestBody: GatewayRequestBody,
  body: string,
): number {
  if (provider.protocol === 'hf-feature-extraction') {
    const embeddings = normalizeHfFeatureExtractionEmbeddings(requestBody.input, body);
    if (embeddings.length === 0) {
      throw new Error('probe 响应缺少 embedding 向量');
    }
    return embeddings[0].length;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`probe 响应不是合法 JSON: ${message}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('probe 响应格式无效');
  }

  const data = (parsed as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('probe 响应缺少 data[0]');
  }

  const embedding = (data[0] as { embedding?: unknown }).embedding;
  if (!Array.isArray(embedding)) {
    throw new Error('probe 响应缺少 embedding 向量');
  }

  return embedding.length;
}

function resolveValidationModels(config: EmbeddingGatewayConfig): string[] {
  if (config.validateModels.length > 0) {
    return config.validateModels;
  }

  return Array.from(
    new Set([
      ...(process.env.EMBEDDINGS_MODEL ? [process.env.EMBEDDINGS_MODEL.trim()] : []),
      ...config.upstreams.flatMap((item) => item.models),
      ...config.upstreams.flatMap((item) =>
        Object.keys(item.modelMap).filter((key) => key !== 'default' && key.trim().length > 0),
      ),
    ].filter(Boolean)),
  );
}

function resolveExpectedDimensions(config: EmbeddingGatewayConfig): number | undefined {
  if (config.expectedDimensions !== undefined) {
    return config.expectedDimensions;
  }

  const parsed = Number.parseInt(process.env.EMBEDDINGS_DIMENSIONS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

async function validateGatewayUpstreams(config: EmbeddingGatewayConfig): Promise<void> {
  if (!config.validateUpstreams) {
    return;
  }

  const validationModels = resolveValidationModels(config);
  const expectedDimensions = resolveExpectedDimensions(config);

  if (validationModels.length === 0) {
    logger.warn('Embedding gateway 启动校验已跳过：未发现可探测的逻辑模型');
    return;
  }

  const providers = config.upstreams.map((provider) => ({
    ...provider,
    disabledUntil: 0,
  }));

  for (const logicalModel of validationModels) {
    const compatible = selectCompatibleProviders(providers, logicalModel);
    if (compatible.length === 0) {
      logger.warn({ logicalModel }, 'Embedding gateway 启动校验已跳过：没有兼容的上游 provider');
      continue;
    }

    const probedDimensions = new Map<string, number>();

    for (const provider of compatible) {
      try {
        const probeRequestBody: GatewayRequestBody = {
          model: logicalModel,
          input: config.validateInput,
        };
        const upstream = await forwardEmbeddingRequest({
          provider,
          requestBody: buildUpstreamRequestBody(provider, probeRequestBody),
          timeoutMs: config.timeoutMs,
        });

        if (!upstream.ok) {
          logger.warn(
            { provider: provider.name, logicalModel, status: upstream.status },
            'Embedding gateway 启动校验探测失败，已跳过该上游',
          );
          continue;
        }

        const dimensions = extractEmbeddingDimensions(provider, probeRequestBody, upstream.body);
        if (expectedDimensions !== undefined && dimensions !== expectedDimensions) {
          throw new Error(
            `上游 ${provider.name} 对模型 ${logicalModel} 返回维度 ${dimensions}，expected ${expectedDimensions}`,
          );
        }
        probedDimensions.set(provider.name, dimensions);
      } catch (error) {
        if (error instanceof Error && error.message.includes('expected ')) {
          throw error;
        }

        const message = error instanceof Error ? error.message : String(error);
        logger.warn(
          { provider: provider.name, logicalModel, error: message },
          'Embedding gateway 启动校验探测异常，已跳过该上游',
        );
      }
    }

    const uniqueDimensions = new Set(probedDimensions.values());
    if (uniqueDimensions.size > 1) {
      const details = Array.from(probedDimensions.entries())
        .map(([name, dimensions]) => `${name}=${dimensions}`)
        .join(', ');
      throw new Error(`上游 embedding 维度不一致: model=${logicalModel}, ${details}`);
    }

    logger.info(
      {
        logicalModel,
        providers: Array.from(probedDimensions.keys()),
        dimensions: uniqueDimensions.size === 1 ? Array.from(uniqueDimensions)[0] : undefined,
      },
      'Embedding gateway 启动校验完成',
    );
  }
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
    config.cacheBackend === 'hybrid'
      ? new LayeredEmbeddingGatewayCacheStore({
          l1: new MemoryEmbeddingGatewayCacheStore({
            ttlMs: config.cacheTtlMs,
            maxEntries: config.cacheMaxEntries,
          }),
          l2: new RedisEmbeddingGatewayCacheStore({
            ttlMs: config.cacheTtlMs,
            keyPrefix: config.redisKeyPrefix,
            url: config.redisUrl,
          }),
        })
      : config.cacheBackend === 'redis'
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
          providerSummary: pool.getSummary(),
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
          const startedAt = Date.now();
          try {
            const upstream = await forwardEmbeddingRequest({
              provider,
              requestBody: buildUpstreamRequestBody(provider, payload),
              timeoutMs: config.timeoutMs,
            });
            const latencyMs = Date.now() - startedAt;

            if (upstream.ok) {
              pool.markSuccess(provider.name, {
                latencyMs,
                status: upstream.status,
              });
              const response = normalizeUpstreamSuccessResponse(provider, payload, upstream);
              await cache.set(cacheKey, response);
              return response;
            }

            pool.markFailure(provider.name, {
              latencyMs,
              status: upstream.status,
              error: `upstream returned ${upstream.status}`,
              cooldown: upstream.retriable,
            });

            if (!upstream.retriable) {
              return {
                status: upstream.status,
                contentType: upstream.contentType,
                body: upstream.body,
              };
            }

            lastRetriableMessage = `upstream ${provider.name} returned ${upstream.status}`;
            logger.warn(
              { provider: provider.name, status: upstream.status },
              'Embedding gateway retriable upstream failure',
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            pool.markFailure(provider.name, {
              latencyMs: Date.now() - startedAt,
              error: message,
              cooldown: true,
            });
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
      try {
        await validateGatewayUpstreams(config);
      } catch (error) {
        await cache.close();
        throw error;
      }

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
