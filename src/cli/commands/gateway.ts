import { exitWithError } from '../helpers.js';
import type { CommandRegistrar } from '../types.js';
import { getEmbeddingGatewayConfig } from '../../gateway/config.js';
import { createEmbeddingGatewayServer } from '../../gateway/server.js';
import { logger } from '../../utils/logger.js';

export function registerGatewayCommands(cli: CommandRegistrar): void {
  cli
    .command('gateway:embeddings', '启动 OpenAI-compatible Embedding Gateway')
    .option('--host <host>', '监听地址，默认读取 EMBEDDING_GATEWAY_HOST')
    .option('--port <port>', '监听端口，默认读取 EMBEDDING_GATEWAY_PORT')
    .option('--timeout-ms <ms>', '上游请求超时')
    .option('--failover-cooldown-ms <ms>', '上游失败后的摘除时间')
    .option('--cache-ttl-ms <ms>', '本地内存缓存 TTL，0 表示关闭')
    .option('--cache-max-entries <count>', '本地内存缓存最多保留多少条记录')
    .option('--cache-backend <backend>', '缓存后端：memory、redis 或 hybrid')
    .option('--redis-url <url>', 'Redis 连接串，默认读取 EMBEDDING_GATEWAY_REDIS_URL')
    .option('--redis-key-prefix <prefix>', 'Redis key 前缀')
    .option('--no-coalesce-identical-requests', '关闭并发相同请求合并')
    .action(
      async (options: {
        host?: string;
        port?: string | number;
        timeoutMs?: string | number;
        failoverCooldownMs?: string | number;
        cacheTtlMs?: string | number;
        cacheMaxEntries?: string | number;
        cacheBackend?: 'memory' | 'redis' | 'hybrid';
        redisUrl?: string;
        redisKeyPrefix?: string;
        coalesceIdenticalRequests?: boolean;
      }) => {
        const parseNumber = (value: string | number | undefined): number | undefined => {
          if (value === undefined) {
            return undefined;
          }
          const parsed = Number.parseInt(String(value), 10);
          return Number.isFinite(parsed) ? parsed : undefined;
        };

        try {
          const config = getEmbeddingGatewayConfig({
            host: options.host,
            port: parseNumber(options.port),
            timeoutMs: parseNumber(options.timeoutMs),
            failoverCooldownMs: parseNumber(options.failoverCooldownMs),
            cacheTtlMs: parseNumber(options.cacheTtlMs),
            cacheMaxEntries: parseNumber(options.cacheMaxEntries),
            cacheBackend: options.cacheBackend,
            redisUrl: options.redisUrl,
            redisKeyPrefix: options.redisKeyPrefix,
            coalesceIdenticalRequests: options.coalesceIdenticalRequests,
          });
          const server = createEmbeddingGatewayServer(config);
          const handle = await server.listen();

          logger.info(
            {
              host: config.host,
              port: handle.port,
              cache: {
                backend: config.cacheBackend,
                ttlMs: config.cacheTtlMs,
                maxEntries: config.cacheMaxEntries,
                redisKeyPrefix:
                  config.cacheBackend === 'redis' || config.cacheBackend === 'hybrid'
                    ? config.redisKeyPrefix
                    : undefined,
                coalescing: config.coalesceIdenticalRequests,
              },
              upstreams: config.upstreams.map((item) => ({
                name: item.name,
                baseUrl: item.baseUrl,
                weight: item.weight,
              })),
            },
            'Embedding gateway 已启动',
          );

          await new Promise<void>((resolve, reject) => {
            const shutdown = async () => {
              process.off('SIGINT', shutdown);
              process.off('SIGTERM', shutdown);
              try {
                await handle.close();
                resolve();
              } catch (error) {
                reject(error);
              }
            };

            process.on('SIGINT', shutdown);
            process.on('SIGTERM', shutdown);
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          exitWithError(`Embedding gateway 启动失败: ${message}`);
        }
      },
    );
}
