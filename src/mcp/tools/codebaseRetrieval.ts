/**
 * codebase-retrieval MCP Tool
 *
 * 代码检索工具
 *
 * 设计理念：
 * - 意图与术语分离：LLM 只需区分"语义意图"和"精确术语"
 * - 回归代理本能：工具只负责定位，跨文件探索由 Agent 自主发起
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { generateProjectId } from '../../db/index.js';
import { resolveBaseDir } from '../../runtimePaths.js';
// 注意：SearchService 和 scan 改为延迟导入，避免在 MCP 启动时就加载 native 模块
import type { ContextPack, Segment } from '../../search/types.js';
import { hasIndexedData, resolveCurrentSnapshotId } from '../../storage/layout.js';
import { logger } from '../../utils/logger.js';
import { getMcpIndexPolicy, resolveAutoIndexScope } from './indexPolicy.js';

// 工具 Schema (暴露给 LLM)

export const codebaseRetrievalSchema = z.object({
  repo_path: z
    .string()
    .describe(
      "The absolute file system path to the repository root. (e.g., '/Users/dev/my-project')",
    ),
  information_request: z
    .string()
    .describe(
      "The SEMANTIC GOAL. Describe the functionality, logic, or behavior you are looking for in full natural language sentences. Focus on 'how it works' rather than exact names. (e.g., 'Trace the execution flow of the login process')",
    ),
  technical_terms: z
    .array(z.string())
    .optional()
    .describe(
      'HARD FILTERS. Precise identifiers to narrow down results. Only use symbols KNOWN to exist to avoid false negatives.',
    ),
});

export type CodebaseRetrievalInput = z.infer<typeof codebaseRetrievalSchema>;
export type RetrievalProgressStage =
  | 'prepare'
  | 'init'
  | 'retrieve'
  | 'rerank'
  | 'expand'
  | 'pack'
  | 'done';
const RETRIEVAL_PROGRESS_ORDER: RetrievalProgressStage[] = [
  'prepare',
  'init',
  'retrieve',
  'rerank',
  'expand',
  'pack',
  'done',
];

// ===========================================
// 自动索引逻辑
// ===========================================

const BASE_DIR = resolveBaseDir();

/**
 * 确保默认 .env 文件存在
 *
 * 如果默认配置文件不存在，则创建包含默认配置的文件
 */
async function ensureDefaultEnvFile(): Promise<void> {
  const configDir = BASE_DIR;
  const envFile = path.join(configDir, '.env');

  // 检查文件是否已存在
  if (fs.existsSync(envFile)) {
    return;
  }

  // 创建配置目录
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
    logger.info({ configDir }, '创建配置目录');
  }

  // 写入默认配置
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
 * 检测代码库是否已初始化（数据库是否存在）
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

// 工具处理函数

/** 进度回调类型 */
export type ProgressCallback = (current: number, total?: number, message?: string) => void;

export function createRetrievalProgressReporter(onProgress?: ProgressCallback) {
  return (stage: RetrievalProgressStage, message: string): void => {
    if (!onProgress) return;
    const current = RETRIEVAL_PROGRESS_ORDER.indexOf(stage) + 1;
    if (current <= 0) return;
    onProgress(current, RETRIEVAL_PROGRESS_ORDER.length, message);
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

/**
 * 处理 codebase-retrieval 工具调用
 *
 * @param args 工具输入参数
 * @param onProgress 可选的进度回调（用于 MCP 进度通知）
 */
export async function handleCodebaseRetrieval(
  args: CodebaseRetrievalInput,
  onProgress?: ProgressCallback,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const { repo_path, information_request, technical_terms } = args;
  const requestId = crypto.randomUUID().slice(0, 8);
  const startedAt = Date.now();
  const reportProgress = createRetrievalProgressReporter(onProgress);
  reportProgress('prepare', '检查配置并准备查询');

  logger.info(
    {
      requestId,
      repo_path,
      information_request,
      technical_terms,
    },
    'MCP codebase-retrieval 调用开始',
  );

  // 0. 检查必需的环境变量是否已配置（Embedding + Reranker 都是必需的）
  const { checkEmbeddingEnv, checkRerankerEnv } = await import('../../config.js');
  const embeddingCheck = checkEmbeddingEnv();
  const rerankerCheck = checkRerankerEnv();
  const allMissingVars = [...embeddingCheck.missingVars, ...rerankerCheck.missingVars];

  if (allMissingVars.length > 0) {
    logger.warn({ requestId, missingVars: allMissingVars }, 'MCP 环境变量未配置');
    // 自动创建默认 .env 文件
    await ensureDefaultEnvFile();
    await safeRecordToolUsage({
      source: 'mcp',
      toolName: 'codebase-retrieval',
      repoPath: repo_path,
      requestId,
      status: 'error',
      durationMs: Date.now() - startedAt,
      queryLength: information_request.length,
      indexState: 'unknown',
      indexAction: 'none',
      error: `missing_env:${allMissingVars.join(',')}`,
    });
    reportProgress('done', '环境变量未配置');
    return formatEnvMissingResponse(allMissingVars);
  }

  // 1. 生成项目 ID（与 CLI 保持一致：路径 + 目录创建时间）
  const projectId = generateProjectId(repo_path);

  // 2. MCP 索引策略（查询阶段不再同步执行索引，而是入队异步任务）
  const policy = getMcpIndexPolicy();
  const wasIndexed = isProjectIndexed(projectId);

  if (policy.autoIndex) {
    try {
      const { enqueueIndexTask } = await import('../../indexing/queue.js');
      const scope = resolveAutoIndexScope(wasIndexed);
      const enqueueResult = enqueueIndexTask({
        projectId,
        repoPath: repo_path,
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
        'MCP 查询已提交索引任务到队列',
      );

      if (!wasIndexed) {
        await safeRecordToolUsage({
          source: 'mcp',
          toolName: 'codebase-retrieval',
          projectId,
          repoPath: repo_path,
          requestId,
          status: 'success',
          durationMs: Date.now() - startedAt,
          queryLength: information_request.length,
          indexState: 'missing',
          indexAction: scope === 'full' ? 'enqueue_full' : 'enqueue_incremental',
        });
        reportProgress('done', '索引任务已入队，等待后台完成');
        return formatIndexQueuedResponse(
          repo_path,
          enqueueResult.task.taskId,
          enqueueResult.task.status,
        );
      }
    } catch (err) {
      const error = err as Error;
      logger.warn(
        { requestId, projectId: projectId.slice(0, 10), error: error.message },
        '提交索引任务失败，继续按当前索引状态处理查询',
      );
      if (!wasIndexed) {
        await safeRecordToolUsage({
          source: 'mcp',
          toolName: 'codebase-retrieval',
          projectId,
          repoPath: repo_path,
          requestId,
          status: 'error',
          durationMs: Date.now() - startedAt,
          queryLength: information_request.length,
          indexState: 'missing',
          indexAction: 'queue_error',
          error: error.message,
        });
        reportProgress('done', '索引任务提交失败');
        return formatIndexQueueErrorResponse(repo_path, error.message);
      }
    }
  } else {
    logger.info(
      { requestId, projectId: projectId.slice(0, 10) },
      'MCP_AUTO_INDEX=false，跳过自动索引',
    );
    if (!wasIndexed) {
      await safeRecordToolUsage({
        source: 'mcp',
        toolName: 'codebase-retrieval',
        projectId,
        repoPath: repo_path,
        requestId,
        status: 'success',
        durationMs: Date.now() - startedAt,
        queryLength: information_request.length,
        indexState: 'missing',
        indexAction: 'index_required',
      });
      reportProgress('done', '当前仓库尚未建立索引');
      return formatIndexRequiredResponse(repo_path);
    }
  }

  // 3. 合并查询
  // - information_request 驱动语义向量搜索
  // - technical_terms 增强词法（FTS）匹配
  const { semanticQuery, lexicalQuery, combinedQuery } = resolveRetrievalQueries(
    information_request,
    technical_terms || [],
  );

  logger.info(
    {
      requestId,
      projectId: projectId.slice(0, 10),
      semanticQuery,
      lexicalQuery,
      query: combinedQuery,
    },
    'MCP 查询构建',
  );

  // 4. 延迟导入 SearchService（避免 MCP 启动时加载 native 模块）
  const { SearchService } = await import('../../search/SearchService.js');

  // 5. 创建 SearchService 实例
  reportProgress('init', '初始化检索服务');
  const snapshotId = resolveCurrentSnapshotId(projectId);
  const service = new SearchService(projectId, repo_path, undefined, snapshotId);
  const initStart = Date.now();
  await service.init();
  const initMs = Date.now() - initStart;
  logger.debug('SearchService 初始化完成');

  // 6. 执行搜索
  const searchStart = Date.now();
  const contextPack = await service.buildContextPack(
    combinedQuery,
    (stage) => {
      if (stage === 'retrieve') {
        reportProgress('retrieve', '执行混合召回');
      } else if (stage === 'rerank') {
        reportProgress('rerank', '执行精排');
      } else if (stage === 'expand') {
        reportProgress('expand', '执行上下文扩展');
      } else if (stage === 'pack') {
        reportProgress('pack', '执行上下文打包');
      }
    },
    {
      technicalTerms: technical_terms,
      semanticQuery,
      lexicalQuery,
    },
  );
  const totalMs = initMs + (Date.now() - searchStart);
  if (contextPack.debug) {
    contextPack.debug.timingMs.init = initMs;
  }

  // 详细日志：seeds 信息
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
      'MCP 搜索 seeds',
    );
  } else {
    logger.warn({ requestId }, 'MCP 搜索无 seeds 命中');
  }

  // 详细日志：扩展结果
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
      'MCP 扩展结果 (前5)',
    );
  }

  // 详细日志：打包后的文件段落
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
    'MCP codebase-retrieval 完成',
  );

  // 7. 格式化输出
  await safeRecordToolUsage({
    source: 'mcp',
    toolName: 'codebase-retrieval',
    projectId,
    repoPath: repo_path,
    requestId,
    status: 'success',
    durationMs: Date.now() - startedAt,
    queryLength: combinedQuery.length,
    indexState: wasIndexed ? 'ready' : 'missing',
    indexAction: 'none',
  });
  reportProgress('done', '检索完成');
  return formatMcpResponse(contextPack);
}

// 响应格式化

/**
 * 格式化为 MCP 响应格式
 */
function formatMcpResponse(pack: ContextPack): { content: Array<{ type: 'text'; text: string }> } {
  const { files, seeds } = pack;

  // 构建文件内容块
  const fileBlocks = files
    .map((file) => {
      const segments = file.segments.map((seg) => formatSegment(seg)).join('\n\n');
      return segments;
    })
    .join('\n\n---\n\n');

  // 构建摘要
  const summary = [
    `Found ${seeds.length} relevant code blocks`,
    `Files: ${files.length}`,
    `Total segments: ${files.reduce((acc, f) => acc + f.segments.length, 0)}`,
  ].join(' | ');

  const text = `${summary}\n\n${fileBlocks}`;

  return {
    content: [
      {
        type: 'text',
        text,
      },
    ],
  };
}

/**
 * 格式化单个代码段
 */
function formatSegment(seg: Segment): string {
  const lang = detectLanguage(seg.filePath);
  const header = `## ${seg.filePath} (L${seg.startLine}-${seg.endLine})`;
  const breadcrumb = seg.breadcrumb ? `> ${seg.breadcrumb}` : '';
  const code = `\`\`\`${lang}\n${seg.text}\n\`\`\``;

  return [header, breadcrumb, code].filter(Boolean).join('\n');
}

/**
 * 根据文件扩展名检测语言
 */
function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const langMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    py: 'python',
    rs: 'rust',
    go: 'go',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    cs: 'csharp',
    rb: 'ruby',
    php: 'php',
    swift: 'swift',
    kt: 'kotlin',
    scala: 'scala',
    sql: 'sql',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    xml: 'xml',
    html: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    md: 'markdown',
    toml: 'toml',
  };
  return langMap[ext] || ext || 'plaintext';
}

/**
 * 格式化环境变量缺失的响应
 *
 * 当用户未配置必需的环境变量时，返回友好的提示信息
 */
function formatEnvMissingResponse(missingVars: string[]): {
  content: Array<{ type: 'text'; text: string }>;
} {
  const configPath = '~/.contextatlas/.env';

  const text = `## ⚠️ 配置缺失

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

  return {
    content: [
      {
        type: 'text',
        text,
      },
    ],
  };
}

function formatIndexQueuedResponse(
  repoPath: string,
  taskId: string,
  taskStatus: string,
): {
  content: Array<{ type: 'text'; text: string }>;
} {
  const text = `## ⏳ 索引任务已入队

当前代码库暂无可用索引，本次请求已提交后台索引任务，暂不执行检索。

### 任务信息

- task_id: \`${taskId}\`
- status: \`${taskStatus}\`

### 下一步

- 启动守护进程消费任务：\`contextatlas daemon start\`
- 或手动执行一次索引：\`contextatlas index ${repoPath}\`
- 索引完成后重试 \`codebase-retrieval\`
`;

  return {
    content: [{ type: 'text', text }],
  };
}

function formatIndexQueueErrorResponse(
  repoPath: string,
  errorMessage: string,
): {
  content: Array<{ type: 'text'; text: string }>;
} {
  const text = `## ⚠️ 索引任务提交失败

当前代码库暂无可用索引，且后台索引任务提交失败。

- 错误：\`${errorMessage}\`

### 请先执行

\`\`\`bash
contextatlas index ${repoPath}
\`\`\`

完成后再调用 \`codebase-retrieval\`。
`;

  return {
    content: [{ type: 'text', text }],
  };
}

/**
 * 格式化关闭自动索引且尚未初始化时的响应
 */
function formatIndexRequiredResponse(repoPath: string): {
  content: Array<{ type: 'text'; text: string }>;
} {
  const text = `## 🧭 需要先完成索引

当前已设置 \`MCP_AUTO_INDEX=false\`，不会在查询阶段自动构建索引。

### 请先执行

\`\`\`bash
contextatlas index ${repoPath}
\`\`\`

完成后再调用 \`codebase-retrieval\`。
`;

  return {
    content: [{ type: 'text', text }],
  };
}
