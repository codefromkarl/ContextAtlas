/**
 * 检索核心编排
 *
 * 从 MCP tool 层提取的检索执行流程：
 * 索引检查 → 搜索 → 结果卡片 → 格式化 → 输出
 *
 * MCP adapter 和 CLI adapter 都通过此入口执行检索。
 * 不依赖 mcp/ 目录。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { generateProjectId } from '../../db/index.js';
import { resolveBaseDir } from '../../runtimePaths.js';
import type { ContextPack } from '../../search/types.js';
import { hasIndexedData } from '../../storage/layout.js';
import { logger } from '../../utils/logger.js';
import { getMcpIndexPolicy, resolveAutoIndexScope } from '../../mcp/tools/indexPolicy.js';
import { buildColdStartLexicalFallbackPack } from './coldStartFallback.js';
import {
  buildRetrievalResultCard,
  formatRetrievalResponse,
} from './resultCard.js';
import type {
  RetrievalInput,
  RetrievalOutput,
  RetrievalProgressStage,
} from './retrievalTypes.js';
import { RETRIEVAL_PROGRESS_ORDER } from './retrievalTypes.js';

// ===========================================
// 常量与辅助
// ===========================================

const BASE_DIR = resolveBaseDir();

// ===========================================
// 公开接口
// ===========================================

/**
 * 执行检索的核心编排函数
 *
 * MCP adapter 和 CLI adapter 共用此入口。
 * onProgress 用于 MCP 进度通知（CLI 可忽略）。
 */
export async function executeRetrieval(
  input: RetrievalInput,
  onProgress?: (stage: RetrievalProgressStage, message: string) => void,
): Promise<RetrievalOutput> {
  const {
    repoPath,
    informationRequest,
    technicalTerms,
    responseFormat = 'text',
    responseMode = 'expanded',
    includeGraphContext = true,
  } = input;

  const requestId = crypto.randomUUID().slice(0, 8);
  const startedAt = Date.now();

  onProgress?.('prepare', '检查配置并准备查询');

  logger.info(
    {
      requestId,
      repoPath,
      informationRequest,
      technicalTerms,
    },
    '检索调用开始',
  );

  // 0. 生成项目 ID
  const projectId = generateProjectId(repoPath);

  // 1. 索引策略
  const policy = getMcpIndexPolicy();
  const wasIndexed = isProjectIndexed(projectId);

  if (!wasIndexed) {
    let statusHeadline = '索引状态: 索引缺失，当前返回词法降级结果';
    const statusDetails = [
      '可部分回答: 当前只基于仓库文件做词法命中与片段截取',
      '完整模式未就绪: 混合检索、精排、上下文扩展会在索引完成后自动可用',
    ];
    let indexAction: 'enqueue_full' | 'enqueue_incremental' | 'index_required' | 'queue_error' =
      'index_required';

    if (policy.autoIndex) {
      try {
        const { enqueueIndexTask } = await import('../../indexing/queue.js');
        const scope = resolveAutoIndexScope(wasIndexed);
        const enqueueResult = enqueueIndexTask({
          projectId,
          repoPath: repoPath,
          scope,
          reason: 'mcp-codebase-retrieval',
          requestedBy: 'mcp',
        });

        logger.info(
          {
            requestId,
            projectId: projectId.slice(0, 10),
            taskId: enqueueResult.task.taskId,
            scope,
            reusedExisting: enqueueResult.reusedExisting,
            status: enqueueResult.task.status,
          },
          '查询已提交索引任务到队列',
        );

        statusHeadline = '索引状态: 索引任务已入队，当前返回词法降级结果';
        statusDetails.push(`task_id: ${enqueueResult.task.taskId}`);
        statusDetails.push(`队列状态: ${enqueueResult.task.status}`);
        indexAction = scope === 'full' ? 'enqueue_full' : 'enqueue_incremental';
      } catch (err) {
        const error = err as Error;
        logger.warn(
          { requestId, projectId: projectId.slice(0, 10), error: error.message },
          '提交索引任务失败，改为仅返回词法降级结果',
        );
        statusHeadline = '索引状态: 索引任务提交失败，当前返回词法降级结果';
        statusDetails.push(`索引入队失败: ${error.message}`);
        statusDetails.push(`可手动执行: contextatlas index ${repoPath}`);
        indexAction = 'queue_error';
      }
    } else {
      logger.info(
        { requestId, projectId: projectId.slice(0, 10) },
        'MCP_AUTO_INDEX=false，未索引仓库直接进入词法降级结果',
      );
      statusDetails.push(`可手动执行: contextatlas index ${repoPath}`);
    }

    const fallbackPack = await buildColdStartLexicalFallbackPack({
      repoPath,
      informationRequest,
      technicalTerms: technicalTerms || [],
    });
    const resultCard = await buildRetrievalResultCard({
      repoPath,
      informationRequest,
      technicalTerms: technicalTerms || [],
      pack: fallbackPack,
      includeGraphContext: false,
      status: {
        headline: statusHeadline,
        details: statusDetails,
      },
    });
    await safeRecordToolUsage({
      source: 'mcp',
      toolName: 'codebase-retrieval',
      projectId,
      repoPath,
      requestId,
      status: 'success',
      durationMs: Date.now() - startedAt,
      queryLength: informationRequest.length,
      indexState: 'missing',
      indexAction,
    });
    onProgress?.('done', '未索引仓库已返回词法降级结果');

    const text = formatRetrievalResponse(fallbackPack, resultCard, {
      responseFormat,
      responseMode,
      repoPath,
      informationRequest,
    });

    return { text };
  }

  // 2. 检查环境变量
  const { checkEmbeddingEnv, checkRerankerEnv } = await import('../../config.js');
  const embeddingCheck = checkEmbeddingEnv();
  const rerankerCheck = checkRerankerEnv();
  const allMissingVars = [...embeddingCheck.missingVars, ...rerankerCheck.missingVars];

  if (allMissingVars.length > 0) {
    logger.warn({ requestId, missingVars: allMissingVars }, '环境变量未配置');
    await ensureDefaultEnvFile();
    await safeRecordToolUsage({
      source: 'mcp',
      toolName: 'codebase-retrieval',
      repoPath,
      requestId,
      status: 'error',
      durationMs: Date.now() - startedAt,
      queryLength: informationRequest.length,
      indexState: 'ready',
      indexAction: 'none',
      error: `missing_env:${allMissingVars.join(',')}`,
    });
    onProgress?.('done', '环境变量未配置');

    return { text: buildEnvMissingText(allMissingVars), isError: true };
  }

  // 3. 已有索引时走完整模式 - 自动索引更新
  if (policy.autoIndex) {
    try {
      const { executeIndexUpdatePlan } = await import('../../indexing/updateStrategy.js');
      const enqueueResult = await executeIndexUpdatePlan(repoPath, { requestedBy: 'mcp' });
      if (enqueueResult.enqueued) {
        logger.info(
          {
            requestId,
            projectId: projectId.slice(0, 10),
            taskId: enqueueResult.taskId,
            scope: enqueueResult.plan.mode,
            reusedExisting: enqueueResult.reusedExisting,
          },
          '查询已提交索引任务到队列',
        );
      } else {
        logger.info(
          {
            requestId,
            projectId: projectId.slice(0, 10),
            planMode: enqueueResult.plan.mode,
          },
          '查询检测到当前索引无需更新，跳过自动入队',
        );
      }
    } catch (err) {
      const error = err as Error;
      logger.warn(
        { requestId, projectId: projectId.slice(0, 10), error: error.message },
        '提交索引任务失败，继续按当前索引状态处理查询',
      );
    }
  } else {
    logger.info(
      { requestId, projectId: projectId.slice(0, 10) },
      'MCP_AUTO_INDEX=false，跳过自动索引',
    );
  }

  // 4. 合并查询
  const { semanticQuery, lexicalQuery, combinedQuery } = resolveRetrievalQueries(
    informationRequest,
    technicalTerms || [],
  );

  logger.info(
    {
      requestId,
      projectId: projectId.slice(0, 10),
      semanticQuery,
      lexicalQuery,
      query: combinedQuery,
    },
    '查询构建',
  );

  // 5. 延迟导入 SearchService
  const { SearchService } = await import('../../search/SearchService.js');

  // 6. 创建 SearchService 实例并搜索
  onProgress?.('init', '初始化检索服务');
  let currentStage: RetrievalProgressStage = 'init';
  const { resolveCurrentSnapshotId } = await import('../../storage/layout.js');
  const snapshotId = resolveCurrentSnapshotId(projectId);
  const service = new SearchService(projectId, repoPath, undefined, snapshotId);
  let initMs = 0;
  let contextPack: ContextPack;
  let totalMs = 0;
  try {
    const initStart = Date.now();
    await service.init();
    initMs = Date.now() - initStart;
    logger.debug('SearchService 初始化完成');

    const searchStart = Date.now();
    contextPack = await service.buildContextPack(
      combinedQuery,
      (stage) => {
        currentStage = stage;
        if (stage === 'retrieve') {
          onProgress?.('retrieve', '执行混合召回');
        } else if (stage === 'rerank') {
          onProgress?.('rerank', '执行精排');
        } else if (stage === 'expand') {
          onProgress?.('expand', '执行上下文扩展');
        } else if (stage === 'pack') {
          onProgress?.('pack', '执行上下文打包');
        }
      },
      {
        technicalTerms: technicalTerms || [],
        semanticQuery,
        lexicalQuery,
        responseMode,
      },
    );
    totalMs = initMs + (Date.now() - searchStart);
  } catch (err) {
    const error = err as Error;
    throw new Error(formatStageFailureMessage(currentStage, error.message), { cause: err });
  }
  if (contextPack.debug) {
    contextPack.debug.timingMs.init = initMs;
  }

  // 详细日志
  if (contextPack.seeds.length > 0) {
    logger.info(
      {
        requestId,
        seeds: contextPack.seeds.map((s) => ({
          file: s.filePath,
          chunk: s.chunkIndex,
          score: s.score.toFixed(4),
          source: s.source,
        })),
      },
      '搜索 seeds',
    );
  } else {
    logger.warn({ requestId }, '搜索无 seeds 命中');
  }

  if (contextPack.expanded.length > 0) {
    logger.debug(
      {
        requestId,
        expandedCount: contextPack.expanded.length,
        expanded: contextPack.expanded.slice(0, 5).map((e) => ({
          file: e.filePath,
          chunk: e.chunkIndex,
          score: e.score.toFixed(4),
        })),
      },
      '扩展结果 (前5)',
    );
  }

  // 7. 遥测日志
  const telemetry = buildRetrievalTelemetry({
    requestId,
    projectId,
    query: combinedQuery,
    totalMs,
    contextPack,
  });
  logger.info(
    {
      ...telemetry,
      files: contextPack.files.map((f) => ({
        path: f.filePath,
        segments: f.segments.length,
        lines: f.segments.map((s) => `L${s.startLine}-${s.endLine}`),
      })),
    },
    'codebase-retrieval 完成',
  );

  // 8. 格式化输出
  await safeRecordToolUsage({
    source: 'mcp',
    toolName: 'codebase-retrieval',
    projectId,
    repoPath,
    requestId,
    status: 'success',
    durationMs: Date.now() - startedAt,
    queryLength: combinedQuery.length,
    indexState: wasIndexed ? 'ready' : 'missing',
    indexAction: 'none',
  });
  onProgress?.('done', '检索完成');

  const resultCard = await buildRetrievalResultCard({
    repoPath,
    informationRequest,
    technicalTerms: technicalTerms || [],
    pack: contextPack,
    includeGraphContext,
    status: {
      headline: '索引状态: 完整模式已就绪',
      details: ['当前结果来自已建立索引的混合检索链路'],
    },
  });

  const text = formatRetrievalResponse(contextPack, resultCard, {
    responseFormat,
    responseMode,
    repoPath,
    informationRequest,
  });

  return { text };
}

// ===========================================
// 内部辅助函数
// ===========================================

/**
 * 确保默认 .env 文件存在
 */
async function ensureDefaultEnvFile(): Promise<void> {
  const configDir = BASE_DIR;
  const envFile = path.join(configDir, '.env');

  if (fs.existsSync(envFile)) {
    return;
  }

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
    logger.info({ configDir }, '创建配置目录');
  }

  const defaultEnvContent = `# ContextAtlas 示例环境变量配置文件

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

# 索引忽略模式（可选，逗号分隔，默认已包含常见忽略项）
# IGNORE_PATTERNS=.venv,node_modules

# MCP 查询阶段索引策略（可选）
# MCP_AUTO_INDEX=true
# MCP_FAIL_FAST_ON_LOCK=true
# MCP_INDEX_LOCK_TIMEOUT_MS=600000
`;

  fs.writeFileSync(envFile, defaultEnvContent);
  logger.info({ envFile }, '已创建默认 .env 配置文件');
}

/**
 * 检测代码库是否已初始化
 */
function isProjectIndexed(projectId: string): boolean {
  return hasIndexedData(projectId);
}

async function safeRecordToolUsage(payload: {
  source: string;
  toolName: string;
  projectId?: string;
  repoPath?: string;
  requestId?: string;
  status: 'success' | 'error';
  durationMs?: number;
  queryLength?: number;
  indexState?: 'missing' | 'ready' | 'unknown';
  indexAction?: 'none' | 'enqueue_full' | 'enqueue_incremental' | 'index_required' | 'queue_error';
  error?: string;
}): Promise<void> {
  try {
    const { recordToolUsage } = await import('../../usage/usageTracker.js');
    recordToolUsage(payload);
  } catch (err) {
    logger.debug(
      { error: (err as Error).message, requestId: payload.requestId },
      '记录工具使用失败',
    );
  }
}

export function resolveRetrievalQueries(
  informationRequest: string,
  technicalTerms: string[] = [],
): {
  semanticQuery: string;
  lexicalQuery: string;
  combinedQuery: string;
} {
  const normalizedInformationRequest = informationRequest.trim();
  const normalizedTechnicalTerms = technicalTerms.map((term) => term.trim()).filter(Boolean);
  const semanticQuery =
    normalizedInformationRequest || normalizedTechnicalTerms.join(' ');
  const lexicalQuery =
    normalizedTechnicalTerms.length > 0
      ? normalizedTechnicalTerms.join(' ')
      : semanticQuery;
  const combinedQuery = [semanticQuery, ...normalizedTechnicalTerms].filter(Boolean).join(' ');

  return {
    semanticQuery,
    lexicalQuery,
    combinedQuery,
  };
}

export function buildRetrievalTelemetry({
  requestId,
  projectId,
  query,
  totalMs,
  contextPack,
}: {
  requestId: string;
  projectId: string;
  query: string;
  totalMs: number;
  contextPack: ContextPack;
}) {
  const totalSegments = contextPack.files.reduce((acc, file) => acc + file.segments.length, 0);
  const totalChars = contextPack.files.reduce(
    (acc, file) => acc + file.segments.reduce((sum, segment) => sum + segment.text.length, 0),
    0,
  );

  return {
    requestId,
    projectId: projectId.slice(0, 10),
    queryLength: query.length,
    seedCount: contextPack.seeds.length,
    expandedCount: contextPack.expanded.length,
    fileCount: contextPack.files.length,
    totalSegments,
    totalChars,
    totalMs,
    timingMs: contextPack.debug?.timingMs || {},
    retrievalStats: contextPack.debug?.retrievalStats,
    resultStats: contextPack.debug?.resultStats,
    rerankUsage: contextPack.debug?.rerankUsage,
  };
}

function formatStageFailureMessage(stage: RetrievalProgressStage, message: string): string {
  const stageLabel =
    stage === 'init'
      ? 'initialization'
      : stage === 'done'
        ? 'completion'
        : stage;
  const normalizedMessage = message.trim().toLowerCase();
  if (normalizedMessage === 'fetch failed') {
    return `${stageLabel} stage failed: network request failed (fetch failed)`;
  }
  return `${stageLabel} stage failed: ${message}`;
}

/**
 * 构建环境变量缺失提示文本
 */
function buildEnvMissingText(missingVars: string[]): string {
  const configPath = '~/.contextatlas/.env';

  return `## ⚠️ 配置缺失

ContextAtlas 需要配置 Embedding API 才能工作。

### 缺失的环境变量
${missingVars.map((v) => `- \`${v}\``).join('\n')}

### 配置步骤

已自动创建配置文件：\`${configPath}\`

请编辑该文件，填写你的 API Key：

\`\`\`bash
# Embedding API 配置（必需）
EMBEDDINGS_API_KEY=your-api-key-here  # ← 替换为你的 API Key

# Reranker 配置（必需）
RERANK_API_KEY=your-api-key-here      # ← 替换为你的 API Key
\`\`\`

保存文件后重新调用此工具即可。
`;
}

// Re-export progress utilities for MCP adapter
export { RETRIEVAL_PROGRESS_ORDER };
export type { RetrievalProgressStage };

/**
 * 创建检索进度报告器
 *
 * 将 stage-based 进度转换为 (current, total, message) 回调。
 * MCP adapter 使用此函数桥接 MCP 进度协议。
 */
export function createRetrievalProgressReporter(
  onProgress?: (current: number, total?: number, message?: string) => void,
) {
  return (stage: RetrievalProgressStage, message: string): void => {
    if (!onProgress) return;
    const current = RETRIEVAL_PROGRESS_ORDER.indexOf(stage) + 1;
    if (current <= 0) return;
    onProgress(current, RETRIEVAL_PROGRESS_ORDER.length, message);
  };
}
