import { promises as fs } from 'node:fs';
import path from 'node:path';
import { defaultConfigEnvPath } from '../../runtimePaths.js';
import { exitWithError, writeText } from '../helpers.js';
import { logger } from '../../utils/logger.js';
import type { CommandRegistrar } from '../types.js';

export function buildDefaultEnvContent(): string {
  return `# ContextAtlas 示例环境变量配置文件

# Embedding API 配置（必需）
EMBEDDINGS_API_KEY=your-api-key-here
EMBEDDINGS_BASE_URL=https://api.siliconflow.cn/v1/embeddings
EMBEDDINGS_MODEL=BAAI/bge-m3
EMBEDDINGS_MAX_CONCURRENCY=10
EMBEDDINGS_BATCH_SIZE=20
EMBEDDINGS_GLOBAL_MIN_INTERVAL_MS=200
EMBEDDINGS_DIMENSIONS=1024

# Reranker 配置（必需）
RERANK_API_KEY=your-api-key-here
RERANK_BASE_URL=https://api.siliconflow.cn/v1/rerank
RERANK_MODEL=BAAI/bge-reranker-v2-m3
RERANK_TOP_N=20

# Embedding Gateway（可选）
# 使用 contextatlas gateway:embeddings 启动本地 OpenAI-compatible 网关。
# 如果你先接 SiliconFlow，可以直接取消下面这些注释并替换 API Key。
# EMBEDDING_GATEWAY_HOST=127.0.0.1
# EMBEDDING_GATEWAY_PORT=8787
# EMBEDDING_GATEWAY_TIMEOUT_MS=30000
# EMBEDDING_GATEWAY_FAILOVER_COOLDOWN_MS=30000
# EMBEDDING_GATEWAY_CACHE_TTL_MS=60000
# EMBEDDING_GATEWAY_CACHE_MAX_ENTRIES=500
# EMBEDDING_GATEWAY_CACHE_BACKEND=memory
# EMBEDDING_GATEWAY_REDIS_URL=redis://127.0.0.1:6379/0
# EMBEDDING_GATEWAY_REDIS_KEY_PREFIX=contextatlas:gateway:embeddings:
# EMBEDDING_GATEWAY_COALESCE_IDENTICAL_REQUESTS=true
# EMBEDDING_GATEWAY_VALIDATE_UPSTREAMS=true
# EMBEDDING_GATEWAY_VALIDATE_MODELS=BAAI/bge-m3
# EMBEDDING_GATEWAY_VALIDATE_INPUT=dimension-probe
# EMBEDDING_GATEWAY_API_KEYS=local-gateway-token
# EMBEDDING_GATEWAY_UPSTREAMS=[{"name":"siliconflow-primary","baseUrl":"https://api.siliconflow.cn/v1/embeddings","apiKey":"your-api-key-here","weight":1,"models":["BAAI/bge-m3"]}]

# 索引忽略模式（可选，逗号分隔，默认已包含常见忽略项）
# IGNORE_PATTERNS=.venv,node_modules
`;
}

export function registerBootstrapCommands(cli: CommandRegistrar): void {
  cli.command('init', '初始化 ContextAtlas 配置').action(async () => {
    const envFile = defaultConfigEnvPath();
    const configDir = path.dirname(envFile);

    logger.info('开始初始化 ContextAtlas...');

    try {
      await fs.mkdir(configDir, { recursive: true });
      logger.info(`创建配置目录: ${configDir}`);
    } catch (err) {
      const error = err as { code?: string; message?: string; stack?: string };
      if (error.code !== 'EEXIST') {
        exitWithError(`创建配置目录失败: ${error.message}`, { err, stack: error.stack });
      }
      logger.info(`配置目录已存在: ${configDir}`);
    }

    try {
      await fs.access(envFile);
      logger.warn(`.env 文件已存在: ${envFile}`);
      logger.info('初始化完成！');
      return;
    } catch {
      // 文件不存在，继续创建
    }

    const defaultEnvContent = buildDefaultEnvContent();
    try {
      await fs.writeFile(envFile, defaultEnvContent);
      logger.info(`创建 .env 文件: ${envFile}`);
    } catch (err) {
      const error = err as { message?: string; stack?: string };
      exitWithError(`创建 .env 文件失败: ${error.message}`, { err, stack: error.stack });
    }

    logger.info('下一步操作:');
    logger.info(`   1. 编辑配置文件: ${envFile}`);
    logger.info('   2. 填写你的 API Key 和其他配置');
    logger.info('初始化完成！');
  });

  cli
    .command('start [path]', '显示默认主路径入口与当前仓库索引状态')
    .action(async (targetPath: string | undefined) => {
      const repoPath = targetPath ? path.resolve(targetPath) : process.cwd();

      try {
        const { buildStartGuide } = await import('../../workflow/start.js');
        const guide = await buildStartGuide(repoPath);
        writeText(guide);
      } catch (err) {
        const error = err as { message?: string; stack?: string };
        exitWithError(`生成 start guide 失败: ${error.message}`, { err, stack: error.stack });
      }
    });

  cli.command('mcp', '启动 MCP 服务器').action(async () => {
    const { startMcpServer } = await import('../../mcp/server.js');
    try {
      await startMcpServer();
    } catch (err) {
      const error = err as { message?: string; stack?: string };
      exitWithError(`MCP 服务器启动失败: ${error.message}`, {
        error: error.message,
        stack: error.stack,
      });
    }
  });
}
