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
import { responseFormatSchema } from './responseFormat.js';
import { generateProjectId } from '../../db/index.js';
import type {
  BlockFirstPayload,
  CheckpointCandidate,
  ContextBlock,
  DecisionRecord,
  FeatureMemory,
  ResolvedLongTermMemoryItem,
} from '../../memory/types.js';
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
  response_format: responseFormatSchema
    .optional()
    .describe('Response format: text, markdown(alias of text), or json'),
  response_mode: z
    .enum(['overview', 'expanded'])
    .optional()
    .default('expanded')
    .describe('Whether to return a lightweight overview or the expanded full retrieval payload'),
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

interface ResultCardFeatureMemoryMatch {
  memory: FeatureMemory;
  score: number;
  reasons: string[];
  freshness: FeatureMemoryFreshness;
  feedbackSignals?: ResultCardFeedbackMatch[];
}

interface ResultCardDecisionMatch {
  decision: DecisionRecord;
  score: number;
  reasons: string[];
  fallback: boolean;
}

interface ResultCardLongTermMemoryMatch {
  memory: ResolvedLongTermMemoryItem;
  score: number;
  reasons: string[];
}

interface ParsedFeedbackSignal {
  outcome: 'helpful' | 'not-helpful' | 'memory-stale' | 'wrong-module';
  targetType?: 'code' | 'feature-memory' | 'decision-record' | 'long-term-memory';
  targetId?: string;
  query?: string;
  details?: string;
}

interface ResultCardFeedbackMatch {
  memory: ResolvedLongTermMemoryItem;
  score: number;
  reasons: string[];
  signal: ParsedFeedbackSignal;
}

interface FeatureMemoryFreshness {
  status: Array<'active' | 'stale' | 'conflict'>;
  lastVerifiedAt: string;
  confidence: 'high' | 'medium' | 'low';
  reviewStatus: 'verified' | 'needs-review';
  reviewReason?: string;
}

interface RetrievalResultCard {
  memories: ResultCardFeatureMemoryMatch[];
  decisions: ResultCardDecisionMatch[];
  longTermMemories: ResultCardLongTermMemoryMatch[];
  feedbackSignals: ResultCardFeedbackMatch[];
  reasoning: string[];
  trustRules: string[];
  nextActions: string[];
  status?: {
    headline: string;
    details: string[];
  };
}

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
  const { repo_path, information_request, technical_terms, response_format, response_mode } = args;
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

  // 0. 生成项目 ID（与 CLI 保持一致：路径 + 目录创建时间）
  const projectId = generateProjectId(repo_path);

  // 1. MCP 索引策略（查询阶段不再同步执行索引，而是入队异步任务）
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
        statusDetails.push(`可手动执行: contextatlas index ${repo_path}`);
        indexAction = 'queue_error';
      }
    } else {
      logger.info(
        { requestId, projectId: projectId.slice(0, 10) },
        'MCP_AUTO_INDEX=false，未索引仓库直接进入词法降级结果',
      );
      statusDetails.push(`可手动执行: contextatlas index ${repo_path}`);
    }

    const fallbackPack = await buildColdStartLexicalFallbackPack({
      repoPath: repo_path,
      informationRequest: information_request,
      technicalTerms: technical_terms || [],
    });
    const resultCard = await buildRetrievalResultCard({
      repoPath: repo_path,
      informationRequest: information_request,
      technicalTerms: technical_terms || [],
      pack: fallbackPack,
      status: {
        headline: statusHeadline,
        details: statusDetails,
      },
    });
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
      indexAction,
    });
    reportProgress('done', '未索引仓库已返回词法降级结果');
    return formatMcpResponse(fallbackPack, resultCard, {
      responseFormat: response_format || 'text',
      responseMode: response_mode || 'expanded',
      repoPath: repo_path,
      informationRequest: information_request,
    });
  }

  // 2. 检查必需的环境变量是否已配置（Embedding + Reranker 都是必需的）
  const { checkEmbeddingEnv, checkRerankerEnv } = await import('../../config.js');
  const embeddingCheck = checkEmbeddingEnv();
  const rerankerCheck = checkRerankerEnv();
  const allMissingVars = [...embeddingCheck.missingVars, ...rerankerCheck.missingVars];

  if (allMissingVars.length > 0) {
    logger.warn({ requestId, missingVars: allMissingVars }, 'MCP 环境变量未配置');
    await ensureDefaultEnvFile();
    await safeRecordToolUsage({
      source: 'mcp',
      toolName: 'codebase-retrieval',
      repoPath: repo_path,
      requestId,
      status: 'error',
      durationMs: Date.now() - startedAt,
      queryLength: information_request.length,
      indexState: 'ready',
      indexAction: 'none',
      error: `missing_env:${allMissingVars.join(',')}`,
    });
    reportProgress('done', '环境变量未配置');
    return formatEnvMissingResponse(allMissingVars);
  }

  // 3. 已有索引时走完整模式
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
      responseMode: response_mode || 'expanded',
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
  const resultCard = await buildRetrievalResultCard({
    repoPath: repo_path,
    informationRequest: information_request,
    technicalTerms: technical_terms || [],
    pack: contextPack,
    status: {
      headline: '索引状态: 完整模式已就绪',
      details: ['当前结果来自已建立索引的混合检索链路'],
    },
  });
  return formatMcpResponse(contextPack, resultCard, {
    responseFormat: response_format || 'text',
    responseMode: response_mode || 'expanded',
    repoPath: repo_path,
    informationRequest: information_request,
  });
}

// 响应格式化

/**
 * 格式化为 MCP 响应格式
 */
function formatMcpResponse(
  pack: ContextPack,
  resultCard: RetrievalResultCard,
  options: {
    responseFormat: 'text' | 'json';
    responseMode: 'overview' | 'expanded';
    repoPath: string;
    informationRequest: string;
  },
): { content: Array<{ type: 'text'; text: string }> } {
  const { files, seeds } = pack;
  const contextBlocks = buildContextBlocks(pack, resultCard);
  const checkpointCandidate = buildCheckpointCandidate(options.repoPath, options.informationRequest, contextBlocks, resultCard);
  const overview = buildOverviewData(pack, resultCard, contextBlocks);
  const blockFirst = buildBlockFirstPayload(contextBlocks, checkpointCandidate, resultCard.nextActions);

  if (options.responseFormat === 'json') {
    const payload = options.responseMode === 'overview'
      ? {
          responseMode: options.responseMode,
          summary: overview.summary,
          topFiles: overview.topFiles,
          contextBlocks,
          references: overview.references,
          expansionCandidates: overview.expansionCandidates,
          nextInspectionSuggestions: overview.nextInspectionSuggestions,
          checkpointCandidate,
          blockFirst,
        }
      : {
          responseMode: options.responseMode,
          summary: {
            codeBlocks: seeds.length,
            files: files.length,
            totalSegments: files.reduce((acc, f) => acc + f.segments.length, 0),
          },
          contextBlocks,
          references: contextBlocks.flatMap((block) => block.provenance.map((item) => ({ blockId: block.id, ...item }))),
          expansionCandidates: overview.expansionCandidates,
          nextInspectionSuggestions: resultCard.nextActions,
          checkpointCandidate,
          blockFirst,
        };
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  }

  if (options.responseMode === 'overview') {
    const lines = [
      '## Retrieval Overview',
      `Files: ${overview.summary.files} | Code Blocks: ${overview.summary.codeBlocks} | Segments: ${overview.summary.totalSegments}`,
      '',
      '### Top Files',
      ...(overview.topFiles.length > 0 ? overview.topFiles.map((item) => `- ${item.filePath} (${item.segmentCount} segments)`) : ['- None']),
      '',
      '### Expansion Candidates',
      ...(overview.expansionCandidates.length > 0
        ? overview.expansionCandidates.map((item) => `- ${item.filePath} | ${item.reason} | priority=${item.priority}`)
        : ['- None']),
      '',
      '### Next Inspection Suggestions',
      ...(overview.nextInspectionSuggestions.length > 0 ? overview.nextInspectionSuggestions.map((item) => `- ${item}`) : ['- None']),
    ];
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

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

  const sections = [
    '## 结果卡片',
    summary,
    '',
    ...(resultCard.status
      ? ['### 索引状态', `- ${resultCard.status.headline}`, ...resultCard.status.details.map((detail) => `- ${detail}`), '']
      : []),
    '### 代码命中 (Source: Code)',
    fileBlocks || '- 未命中代码片段',
    '',
    '### 相关模块记忆 (Source: Feature Memory)',
    formatFeatureMemoryMatches(resultCard.memories),
    '',
    '### 相关决策记录 (Source: Decision Record)',
    formatDecisionMatches(resultCard.decisions),
    '',
    '### 相关长期记忆 (Source: Long-term Memory)',
    formatLongTermMemoryMatches(resultCard.longTermMemories),
    '',
    '### 近期反馈信号 (Source: Feedback Loop)',
    formatFeedbackMatches(resultCard.feedbackSignals),
    '',
    '### 跨项目参考 (Source: Cross-project Hub)',
    '- 暂无相关跨项目记忆',
    '',
    '### 来源层级与可信规则',
    ...resultCard.trustRules.map((line) => `- ${line}`),
    '',
    '### 下一步动作',
    ...resultCard.nextActions.map((line) => `- ${line}`),
    '',
    '### 为什么命中这些结果',
    formatReasoning(resultCard.reasoning),
  ];
  const text = sections.join('\n');

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

async function buildRetrievalResultCard({
  repoPath,
  informationRequest,
  technicalTerms,
  pack,
  status,
}: {
  repoPath: string;
  informationRequest: string;
  technicalTerms: string[];
  pack: ContextPack;
  status?: RetrievalResultCard['status'];
}): Promise<RetrievalResultCard> {
  try {
    const { MemoryStore } = await import('../../memory/MemoryStore.js');
    const store = new MemoryStore(repoPath);
    const [featureMemories, decisions, longTermMemories] = await Promise.all([
      store.listFeatures(),
      store.listDecisions(),
      store.listLongTermMemories({ includeExpired: false, staleDays: 30 }),
    ]);

    const memoryMatches = rankFeatureMemoryMatches(featureMemories, informationRequest, technicalTerms, pack);
    await syncMemoryReviewStatus(store, memoryMatches);
    const feedbackSignals = rankFeedbackMatches(
      longTermMemories.filter((memory) => memory.type === 'feedback'),
      informationRequest,
      technicalTerms,
      memoryMatches,
    );
    const memoryMatchesWithFeedback = attachFeedbackToMemoryMatches(memoryMatches, feedbackSignals);
    const decisionMatches = rankDecisionMatches(
      decisions,
      informationRequest,
      technicalTerms,
      memoryMatchesWithFeedback,
    );
    const directLongTermMatches = rankLongTermMemoryMatches(
      longTermMemories.filter((memory) => memory.type !== 'feedback'),
      informationRequest,
      technicalTerms,
    );
    const longTermMatches = mergeLongTermMemoryMatches(
      directLongTermMatches,
      resolveReferencedEvidenceMatches(
        longTermMemories,
        memoryMatchesWithFeedback,
        decisionMatches,
      ),
    );

    return {
      memories: memoryMatchesWithFeedback,
      decisions: decisionMatches,
      longTermMemories: longTermMatches,
      feedbackSignals,
      reasoning: buildReasoningLines(
        informationRequest,
        technicalTerms,
        pack,
        memoryMatchesWithFeedback,
        decisionMatches,
        longTermMatches,
        feedbackSignals,
      ),
      trustRules: buildTrustRules(),
      nextActions: buildNextActions({
        informationRequest,
        memoryMatches,
        decisionMatches,
      }),
      status,
    };
  } catch (err) {
    logger.debug({ error: (err as Error).message }, '构建检索结果卡片上下文失败，回退到代码结果');
    return {
      memories: [],
      decisions: [],
      longTermMemories: [],
      feedbackSignals: [],
      reasoning: buildReasoningLines(informationRequest, technicalTerms, pack, [], [], [], []),
      trustRules: buildTrustRules(),
      nextActions: buildNextActions({
        informationRequest,
        memoryMatches: [],
        decisionMatches: [],
      }),
      status,
    };
  }
}

function rankFeatureMemoryMatches(
  memories: FeatureMemory[],
  informationRequest: string,
  technicalTerms: string[],
  pack: ContextPack,
): ResultCardFeatureMemoryMatch[] {
  const queryTerms = extractQueryTerms(informationRequest, technicalTerms);
  const fileSignals = buildFileSignals(pack);

  return memories
    .map((memory) => {
      if (memory.confirmationStatus === 'suggested') {
        return null;
      }
      let score = 0;
      const reasons: string[] = [];
      const searchableFields = [
        memory.name,
        memory.responsibility,
        memory.dataFlow,
        ...memory.api.exports,
        ...memory.keyPatterns,
        ...memory.dependencies.imports,
      ]
        .join(' ')
        .toLowerCase();

      const matchedTerms = queryTerms.filter((term) => searchableFields.includes(term));
      if (matchedTerms.length > 0) {
        score += 6 + matchedTerms.length * 2;
        reasons.push(`关键词匹配: ${matchedTerms.slice(0, 4).join(', ')}`);
      }

      const exactNames = [memory.name, ...memory.api.exports].map(normalizeToken);
      const matchedTechnicalTerms = technicalTerms
        .map(normalizeToken)
        .filter((term) => exactNames.includes(term));
      if (matchedTechnicalTerms.length > 0) {
        score += 12;
        reasons.push(`technical terms 精确命中: ${matchedTechnicalTerms.join(', ')}`);
      }

      const normalizedDir = normalizePath(memory.location.dir);
      const normalizedFiles = memory.location.files.map((file) =>
        normalizePath(path.posix.join(normalizedDir, normalizePath(file))),
      );
      const pathMatches = normalizedFiles.filter((file) => fileSignals.files.has(file));
      if (pathMatches.length > 0) {
        score += 16;
        reasons.push(`文件路径匹配: ${pathMatches.slice(0, 2).join(', ')}`);
      } else if (fileSignals.dirs.has(normalizedDir)) {
        score += 8;
        reasons.push(`目录匹配: ${normalizedDir}`);
      }

      score += getConfirmationStatusWeight(memory.confirmationStatus);
      reasons.push(`确认状态加权: ${memory.confirmationStatus || 'human-confirmed'}`);

      return {
        memory,
        score,
        reasons,
        freshness: resolveFeatureMemoryFreshness(memory, fileSignals),
      };
    })
    .filter((match): match is ResultCardFeatureMemoryMatch => Boolean(match && match.score > 0))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

function rankLongTermMemoryMatches(
  memories: ResolvedLongTermMemoryItem[],
  informationRequest: string,
  technicalTerms: string[],
): ResultCardLongTermMemoryMatch[] {
  const queryTerms = extractQueryTerms(informationRequest, technicalTerms);

  return memories
    .map((memory) => {
      let score = 0;
      const reasons: string[] = [];
      const searchable = [
        memory.title,
        memory.summary,
        memory.why || '',
        memory.howToApply || '',
        memory.factKey || '',
        ...memory.tags,
      ]
        .join(' ')
        .toLowerCase();

      const matchedTerms = queryTerms.filter((term) => searchable.includes(term));
      if (matchedTerms.length > 0) {
        score += 6 + matchedTerms.length * 2;
        reasons.push(`关键词匹配: ${matchedTerms.slice(0, 4).join(', ')}`);
      }

      if (memory.status === 'active') {
        score += 2;
        reasons.push('当前有效');
      }

      if (memory.type === 'temporal-fact') {
        score += memory.status === 'active' ? 8 : 4;
        reasons.push(memory.factKey ? `时态事实: ${memory.factKey}` : '时态事实');
      }

      return { memory, score, reasons };
    })
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score)
    .filter((match, index, list) => {
      const groupKey = buildLongTermMemoryDedupKey(match.memory);
      return list.findIndex((entry) => buildLongTermMemoryDedupKey(entry.memory) === groupKey) === index;
    })
    .slice(0, 3);
}

function resolveReferencedEvidenceMatches(
  memories: ResolvedLongTermMemoryItem[],
  memoryMatches: ResultCardFeatureMemoryMatch[],
  decisionMatches: ResultCardDecisionMatch[],
): ResultCardLongTermMemoryMatch[] {
  const evidenceById = new Map(
    memories
      .filter((memory) => memory.type === 'evidence')
      .map((memory) => [memory.id, memory] as const),
  );
  const referencedIds = new Set<string>();

  for (const match of memoryMatches) {
    for (const ref of match.memory.evidenceRefs || []) {
      const parsed = parseEvidenceRef(ref);
      if (parsed) {
        referencedIds.add(parsed);
      }
    }
  }

  for (const match of decisionMatches) {
    for (const ref of match.decision.evidenceRefs || []) {
      const parsed = parseEvidenceRef(ref);
      if (parsed) {
        referencedIds.add(parsed);
      }
    }
  }

  return [...referencedIds]
    .map((id) => evidenceById.get(id))
    .filter((memory): memory is ResolvedLongTermMemoryItem => Boolean(memory))
    .map((memory) => ({
      memory,
      score: 100,
      reasons: ['由命中的 feature memory / decision record 证据引用回链'],
    }));
}

function mergeLongTermMemoryMatches(
  ...groups: ResultCardLongTermMemoryMatch[][]
): ResultCardLongTermMemoryMatch[] {
  const merged = new Map<string, ResultCardLongTermMemoryMatch>();

  for (const group of groups) {
    for (const match of group) {
      const key = buildLongTermMemoryDedupKey(match.memory);
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, match);
        continue;
      }

      merged.set(key, {
        memory: existing.score >= match.score ? existing.memory : match.memory,
        score: Math.max(existing.score, match.score),
        reasons: [...new Set([...existing.reasons, ...match.reasons])],
      });
    }
  }

  return [...merged.values()]
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return new Date(b.memory.updatedAt).getTime() - new Date(a.memory.updatedAt).getTime();
    })
    .slice(0, 4);
}

function buildLongTermMemoryDedupKey(memory: ResolvedLongTermMemoryItem): string {
  if (memory.type === 'temporal-fact' && memory.factKey) {
    return `temporal-fact:${normalizeToken(memory.factKey)}`;
  }
  return `${memory.type}:${memory.id}`;
}

function parseEvidenceRef(ref: string): string | null {
  const trimmed = ref.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith('evidence:')) {
    return trimmed.slice('evidence:'.length) || null;
  }
  return null;
}

function rankFeedbackMatches(
  memories: ResolvedLongTermMemoryItem[],
  informationRequest: string,
  technicalTerms: string[],
  memoryMatches: ResultCardFeatureMemoryMatch[],
): ResultCardFeedbackMatch[] {
  const queryTerms = extractQueryTerms(informationRequest, technicalTerms);
  const matchedMemoryNames = new Set(memoryMatches.map((match) => normalizeToken(match.memory.name)));

  return memories
    .map((memory) => {
      const signal = parseFeedbackSignal(memory);
      if (!signal) {
        return null;
      }

      let score = 0;
      const reasons: string[] = [];
      const searchable = [
        memory.title,
        memory.summary,
        signal.query || '',
        signal.details || '',
        ...memory.tags,
      ]
        .join(' ')
        .toLowerCase();

      const matchedTerms = queryTerms.filter((term) => searchable.includes(term));
      if (matchedTerms.length > 0) {
        score += 6 + matchedTerms.length * 2;
        reasons.push(`关键词匹配: ${matchedTerms.slice(0, 4).join(', ')}`);
      }

      if (signal.targetType === 'feature-memory' && signal.targetId) {
        const normalizedTarget = normalizeToken(signal.targetId);
        if (matchedMemoryNames.has(normalizedTarget)) {
          score += 14;
          reasons.push(`关联模块反馈: ${signal.targetId}`);
        }
      }

      if (signal.query && normalizeToken(signal.query) === normalizeToken(informationRequest)) {
        score += 8;
        reasons.push('同查询历史反馈');
      }

      if (signal.outcome === 'memory-stale' || signal.outcome === 'wrong-module') {
        score += 4;
        reasons.push(`负反馈: ${signal.outcome}`);
      }

      return { memory, score, reasons, signal };
    })
    .filter((match): match is ResultCardFeedbackMatch => Boolean(match && match.score > 0))
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return new Date(b.memory.updatedAt).getTime() - new Date(a.memory.updatedAt).getTime();
    })
    .slice(0, 3);
}

function rankDecisionMatches(
  decisions: DecisionRecord[],
  informationRequest: string,
  technicalTerms: string[],
  memoryMatches: ResultCardFeatureMemoryMatch[],
): ResultCardDecisionMatch[] {
  const queryTerms = extractQueryTerms(informationRequest, technicalTerms);
  const memoryTerms = memoryMatches.flatMap((match) =>
    [match.memory.name, ...match.memory.api.exports].map(normalizeToken),
  );

  const scored = decisions
    .map((decision) => {
      let score = 0;
      const reasons: string[] = [];
      const searchableFields = [
        decision.title,
        decision.context,
        decision.decision,
        decision.rationale,
        ...decision.consequences,
      ]
        .join(' ')
        .toLowerCase();

      const matchedQueryTerms = queryTerms.filter((term) => searchableFields.includes(term));
      if (matchedQueryTerms.length > 0) {
        score += 5 + matchedQueryTerms.length * 2;
        reasons.push(`关键词匹配: ${matchedQueryTerms.slice(0, 4).join(', ')}`);
      }

      const matchedMemoryTerms = memoryTerms.filter((term) => searchableFields.includes(term));
      if (matchedMemoryTerms.length > 0) {
        score += 8;
        reasons.push(`关联模块提及: ${matchedMemoryTerms.slice(0, 3).join(', ')}`);
      }

      return { decision, score, reasons, fallback: false };
    })
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);

  if (scored.length > 0) {
    return scored;
  }

  return decisions.slice(0, 1).map((decision) => ({
    decision,
    score: 0,
    reasons: ['未找到直接关键词命中，回退展示最近决策记录'],
    fallback: true,
  }));
}

function buildReasoningLines(
  informationRequest: string,
  technicalTerms: string[],
  pack: ContextPack,
  memoryMatches: ResultCardFeatureMemoryMatch[],
  decisionMatches: ResultCardDecisionMatch[],
  longTermMatches: ResultCardLongTermMemoryMatch[],
  feedbackMatches: ResultCardFeedbackMatch[],
): string[] {
  const reasoning: string[] = [];
  const seedSources = Array.from(new Set(pack.seeds.map((seed) => seed.source)));
  const fileSignals = buildFileSignals(pack);

  reasoning.push(`问题语义: ${informationRequest.trim()}`);

  if (technicalTerms.length > 0) {
    reasoning.push(`technical terms 参与精确匹配: ${technicalTerms.join(', ')}`);
  }

  if (seedSources.length > 0) {
    reasoning.push(`代码片段来自 ${seedSources.join(' + ')} 召回，并经过 rerank/pack 输出`);
  }

  if (fileSignals.files.size > 0) {
    reasoning.push(`优先保留命中文件: ${Array.from(fileSignals.files).slice(0, 3).join(', ')}`);
  }

  if (memoryMatches.length > 0) {
    reasoning.push('模块记忆按关键词、technical terms 和文件路径相关性排序');
    if (memoryMatches.some((match) => match.freshness.status.includes('stale') || match.freshness.status.includes('conflict'))) {
      reasoning.push('代码优先于 stale/conflict memory，冲突记忆只作为辅助背景展示');
    }
  } else {
    reasoning.push('当前项目没有命中可复用的模块记忆');
  }

  if (decisionMatches.length > 0) {
    reasoning.push(
      decisionMatches.some((match) => match.fallback)
        ? '决策记录没有直接命中时，回退展示最近记录，避免结果上下文断裂'
        : '决策记录按关键词和关联模块提及进行排序',
    );
  } else {
    reasoning.push('当前项目没有可展示的决策记录');
  }

  if (longTermMatches.length > 0) {
    reasoning.push('长期记忆只补充代码中推不出来的项目状态或协作约束');
    if (longTermMatches.some((match) => match.memory.type === 'temporal-fact')) {
      reasoning.push('时态事实会优先暴露当前仍有效的迁移窗口、兼容窗口和临时约束');
    }
    if (longTermMatches.some((match) => match.memory.type === 'evidence')) {
      reasoning.push('命中的记忆和决策若带有 evidenceRefs，会自动回链原始证据块');
    }
  } else {
    reasoning.push('当前项目没有命中相关长期记忆');
  }

  if (feedbackMatches.length > 0) {
    reasoning.push('近期反馈会直接外显，并为相关模块补充风险提示');
    if (
      feedbackMatches.some(
        (match) => match.signal.outcome === 'memory-stale' || match.signal.outcome === 'wrong-module',
      )
    ) {
      reasoning.push('负反馈不会覆盖代码命中，但会提示当前结果需要额外复核');
    }
  } else {
    reasoning.push('当前项目没有命中相关反馈记录');
  }

  return reasoning;
}

function buildTrustRules(): string[] {
  return [
    'Code > Feature Memory > Decision Record > Long-term Memory',
    '代码优先于旧 memory；记忆和决策只补充代码上下文，不覆盖代码事实',
    '新 decision record 优先于旧 profile，用于解释当前设计意图',
    'Long-term Memory 只补充代码中推不出来的项目状态、协作约束和外部引用',
    '发生冲突时直接展示冲突状态，而不是静默覆盖',
    '近期反馈会直接外显，用于提示结果风险和记忆复核优先级',
  ];
}

function buildNextActions({
  informationRequest,
  memoryMatches,
  decisionMatches,
}: {
  informationRequest: string;
  memoryMatches: ResultCardFeatureMemoryMatch[];
  decisionMatches: ResultCardDecisionMatch[];
}): string[] {
  const escapedQuery = informationRequest.replace(/"/g, '\\"');
  const actions = [
    `\`contextatlas feedback:record --outcome helpful --target-type code --query "${escapedQuery}"\``,
    `\`contextatlas feedback:record --outcome not-helpful --target-type code --query "${escapedQuery}"\``,
  ];

  const primaryMemory = memoryMatches[0];
  if (primaryMemory) {
    actions.push(
      `\`contextatlas feedback:record --outcome memory-stale --target-type feature-memory --query "${escapedQuery}" --target-id "${primaryMemory.memory.name}"\``,
    );
    actions.push(
      `\`contextatlas feedback:record --outcome wrong-module --target-type feature-memory --query "${escapedQuery}" --target-id "${primaryMemory.memory.name}"\``,
    );
    actions.push(
      `\`contextatlas memory:suggest ${primaryMemory.memory.name} --files "${primaryMemory.memory.location.files.join(',') || '<files>'}"\``,
    );
  } else {
    actions.push('`contextatlas memory:suggest <module> --files "src/.../file.ts"`');
  }

  const decisionSeed = decisionMatches[0]?.decision.id || '<id>';
  actions.push(
    `\`contextatlas decision:record ${decisionSeed} --title "<标题>" --owner "<责任人>" --reviewer "<审核人>" --context "<背景>" --decision "<决策>" --rationale "<原因>"\``,
  );
  actions.push(
    '`contextatlas memory:record-long-term --type reference --title "<标题>" --summary "<摘要>"`',
  );

  return actions;
}

function buildFileSignals(pack: ContextPack): { files: Set<string>; dirs: Set<string> } {
  const files = new Set<string>();
  const dirs = new Set<string>();

  for (const file of pack.files) {
    const normalized = normalizePath(file.filePath);
    files.add(normalized);
    dirs.add(path.posix.dirname(normalized));
  }

  return { files, dirs };
}

function extractQueryTerms(informationRequest: string, technicalTerms: string[]): string[] {
  const rawTerms = [
    ...technicalTerms.map((term) => term.trim()),
    ...tokenizeForMatching(informationRequest),
  ].filter(Boolean);

  return Array.from(new Set(rawTerms.map(normalizeToken)));
}

function tokenizeForMatching(text: string): string[] {
  return (text.match(/[\p{L}\p{N}_-]+/gu) || []).filter((token) => {
    if (/[\u4e00-\u9fff]/u.test(token)) return true;
    return token.length >= 3;
  });
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase();
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.?\//, '');
}

function getConfirmationStatusWeight(
  status: FeatureMemory['confirmationStatus'],
): number {
  switch (status) {
    case 'human-confirmed':
      return 6;
    case 'agent-inferred':
      return 2;
    case 'suggested':
      return -100;
    default:
      return 4;
  }
}

function resolveFeatureMemoryFreshness(
  memory: FeatureMemory,
  fileSignals: { files: Set<string>; dirs: Set<string> },
): FeatureMemoryFreshness {
  const status: Array<'active' | 'stale' | 'conflict'> = ['active'];
  const updatedTime = Date.parse(memory.lastUpdated);
  const ageDays = Number.isNaN(updatedTime)
    ? 0
    : (Date.now() - updatedTime) / (1000 * 60 * 60 * 24);

  if (!Number.isNaN(updatedTime) && ageDays > 180) {
    status[0] = 'stale';
  }

  const normalizedDir = normalizePath(memory.location.dir);
  const normalizedFiles = memory.location.files.map((file) =>
    normalizePath(path.posix.join(normalizedDir, normalizePath(file))),
  );
  const hasConflict = normalizedFiles.length > 0
    && normalizedFiles.every((file) => !fileSignals.files.has(file))
    && !fileSignals.dirs.has(normalizedDir);

  if (hasConflict) {
    if (!status.includes('conflict')) {
      status.push('conflict');
    }
  }

  let confidence: FeatureMemoryFreshness['confidence'] = 'high';
  if (memory.reviewStatus === 'needs-review' || status.includes('conflict')) {
    confidence = 'low';
  } else if (status.includes('stale')) {
    confidence = 'medium';
  }

  return {
    status,
    lastVerifiedAt: memory.lastUpdated,
    confidence,
    reviewStatus: memory.reviewStatus || (status.includes('conflict') ? 'needs-review' : 'verified'),
    reviewReason:
      memory.reviewReason
      || (status.includes('conflict') ? '当前查询命中的代码路径与记忆记录不一致' : undefined),
  };
}

function formatFeatureMemoryMatches(matches: ResultCardFeatureMemoryMatch[]): string {
  if (matches.length === 0) {
    return '- 暂无相关模块记忆';
  }

  return matches
    .map(
      ({ memory, reasons, freshness, feedbackSignals = [] }) =>
        `#### ${memory.name}
- 职责: ${memory.responsibility}
- 位置: ${memory.location.dir}/${memory.location.files.join(', ')}
- 导出: ${memory.api.exports.join(', ') || 'N/A'}
- 类型: ${memory.memoryType || 'local'}
- 来源项目: ${memory.sourceProjectId || 'current-project'}
- 确认状态: ${memory.confirmationStatus || 'human-confirmed'}
- 复核状态: ${freshness.reviewStatus}${freshness.reviewReason ? ` (${freshness.reviewReason})` : ''}
- 状态: ${freshness.status.join(', ')}
- 最后核验: ${freshness.lastVerifiedAt}
- 可信度: ${freshness.confidence}
- 反馈信号: ${formatFeatureFeedbackSummary(feedbackSignals)}
- 数据流: ${memory.dataFlow || 'N/A'}
- 命中原因: ${reasons.join('；')}`,
    )
    .join('\n\n');
}

function formatDecisionMatches(matches: ResultCardDecisionMatch[]): string {
  if (matches.length === 0) {
    return '- 暂无相关决策记录';
  }

  return matches
    .map(
      ({ decision, reasons, fallback }) => {
        const governanceState = decision.owner
          ? decision.reviewer
            ? 'reviewed'
            : 'owner-owned'
          : 'unowned';
        return (
        `#### ${decision.title}
- 状态: ${decision.status}
- Owner: ${decision.owner || 'N/A'}
- Reviewer: ${decision.reviewer || 'N/A'}
- 治理状态: ${governanceState}
- 决策: ${decision.decision}
- 理由: ${decision.rationale || 'N/A'}
- 命中原因: ${reasons.join('；')}${fallback ? '（fallback）' : ''}`
        );
      },
    )
    .join('\n\n');
}

function formatLongTermMemoryMatches(matches: ResultCardLongTermMemoryMatch[]): string {
  if (matches.length === 0) {
    return '- 暂无相关长期记忆';
  }

  return matches
    .map(
      ({ memory, reasons }) =>
        `#### ${memory.title}
- 类型: ${memory.type}
- 状态: ${memory.status}
- Fact Key: ${memory.factKey || 'N/A'}
- 生效区间: ${memory.validFrom || 'N/A'} -> ${memory.validUntil || 'active'}
- 来源: ${memory.source}
- 可信度: ${Math.round(memory.confidence * 100)}%
- 最后核验: ${memory.lastVerifiedAt || memory.updatedAt}
- 摘要: ${memory.summary}
- 命中原因: ${reasons.join('；')}`,
    )
    .join('\n\n');
}

function formatFeedbackMatches(matches: ResultCardFeedbackMatch[]): string {
  if (matches.length === 0) {
    return '- 暂无相关反馈信号';
  }

  return matches
    .map(
      ({ memory, reasons, signal }) =>
        `#### ${memory.title}
- Outcome: ${signal.outcome}
- Target Type: ${signal.targetType || 'unknown'}
- Target ID: ${signal.targetId || 'N/A'}
- Query: ${signal.query || 'N/A'}
- 状态: ${memory.status}
- 最后核验: ${memory.lastVerifiedAt || memory.updatedAt}
- 摘要: ${memory.summary}
- 命中原因: ${reasons.join('；')}`,
    )
    .join('\n\n');
}

function formatReasoning(lines: string[]): string {
  return lines.map((line) => `- ${line}`).join('\n');
}

function buildContextBlocks(pack: ContextPack, resultCard: RetrievalResultCard): ContextBlock[] {
  const blocks: ContextBlock[] = [];

  for (const file of pack.files) {
    for (const segment of file.segments) {
      blocks.push({
        id: `code:${segment.filePath}:${segment.startLine}-${segment.endLine}`,
        type: 'code-evidence',
        title: segment.filePath,
        purpose: 'Provide directly relevant code evidence for the current query',
        content: segment.text,
        priority: 'high',
        pinned: false,
        expandable: true,
        budgetChars: segment.text.length,
        memoryKind: 'semantic',
        provenance: [{ source: 'code', ref: `${segment.filePath}:L${segment.startLine}-L${segment.endLine}` }],
      });
    }
  }

  for (const match of resultCard.memories) {
    blocks.push({
      id: `memory:${match.memory.name}`,
      type: 'module-summary',
      title: match.memory.name,
      purpose: 'Summarize stable module responsibilities and interfaces',
      content: [
        match.memory.responsibility,
        `Memory Type: ${match.memory.memoryType || 'local'}`,
        `Source Project: ${match.memory.sourceProjectId || 'current-project'}`,
      ].join('\n'),
      priority: 'high',
      pinned: true,
      expandable: true,
      memoryKind: 'semantic',
      provenance: [{ source: 'feature-memory', ref: match.memory.name }],
      freshness: {
        lastVerifiedAt: match.freshness.lastVerifiedAt,
        stale: match.freshness.status.includes('stale') || match.freshness.status.includes('conflict'),
        confidence: match.freshness.confidence,
      },
    });
  }

  for (const match of resultCard.decisions) {
    const governanceState = match.decision.owner
      ? match.decision.reviewer
        ? 'reviewed'
        : 'owner-owned'
      : 'unowned';
    blocks.push({
      id: `decision:${match.decision.id}`,
      type: 'decision-context',
      title: match.decision.title,
      purpose: 'Capture relevant architecture and product decisions',
      content: [
        match.decision.decision,
        `Owner: ${match.decision.owner || 'N/A'}`,
        `Reviewer: ${match.decision.reviewer || 'N/A'}`,
        `Governance: ${governanceState}`,
      ].join('\n'),
      priority: 'medium',
      pinned: false,
      expandable: true,
      memoryKind: 'procedural',
      provenance: [{ source: 'decision-record', ref: match.decision.id }],
    });
  }

  for (const match of resultCard.longTermMemories) {
    if (match.memory.type === 'evidence') {
      blocks.push({
        id: `evidence:${match.memory.id}`,
        type: 'recent-findings',
        title: match.memory.title,
        purpose: 'Surface raw supporting evidence that explains why a conclusion should be trusted',
        content: match.memory.summary,
        priority: 'medium',
        pinned: false,
        expandable: true,
        memoryKind: 'episodic',
        provenance: [{ source: 'evidence', ref: match.memory.id }],
        freshness: {
          lastVerifiedAt: match.memory.lastVerifiedAt || match.memory.updatedAt,
        },
      });
      continue;
    }

    if (match.memory.type === 'temporal-fact') {
      blocks.push({
        id: `temporal:${match.memory.factKey || match.memory.id}`,
        type: 'recent-findings',
        title: match.memory.title,
        purpose: 'Surface time-bounded project facts that may expire or be invalidated later',
        content: [
          match.memory.summary,
          match.memory.factKey ? `Fact Key: ${match.memory.factKey}` : '',
          match.memory.validFrom ? `Valid From: ${match.memory.validFrom}` : '',
          match.memory.validUntil ? `Valid Until: ${match.memory.validUntil}` : '',
        ].filter(Boolean).join('\n'),
        priority: 'medium',
        pinned: false,
        expandable: true,
        memoryKind: 'episodic',
        provenance: [{ source: 'long-term-memory', ref: match.memory.id }],
        freshness: {
          lastVerifiedAt: match.memory.lastVerifiedAt || match.memory.updatedAt,
          stale: match.memory.status !== 'active',
        },
      });
      continue;
    }

    blocks.push({
      id: `ltm:${match.memory.id}`,
      type: 'repo-rules',
      title: match.memory.title,
      purpose: 'Provide non-code project state or durable repo rules',
      content: match.memory.summary,
      priority: 'medium',
      pinned: false,
      expandable: true,
      memoryKind: 'procedural',
      provenance: [{ source: 'long-term-memory', ref: match.memory.id }],
      freshness: {
        lastVerifiedAt: match.memory.lastVerifiedAt || match.memory.updatedAt,
        stale: match.memory.status !== 'active',
      },
    });
  }

  for (const match of resultCard.feedbackSignals) {
    blocks.push({
      id: `feedback:${match.memory.id}`,
      type: 'feedback-signals',
      title: match.memory.title,
      purpose: 'Surface recent feedback that may reduce trust in related context',
      content: match.memory.summary,
      priority: 'medium',
      pinned: false,
      expandable: false,
      memoryKind: 'episodic',
      provenance: [{ source: 'feedback', ref: match.memory.id }],
      freshness: {
        lastVerifiedAt: match.memory.lastVerifiedAt || match.memory.updatedAt,
      },
    });
  }

  blocks.push({
    id: 'task:open-questions',
    type: 'open-questions',
    title: 'Next actions',
    purpose: 'Capture immediate follow-up directions for the agent',
    content: resultCard.nextActions.join('\n'),
    priority: 'medium',
    pinned: true,
    expandable: false,
    memoryKind: 'task-state',
    provenance: [{ source: 'code', ref: 'result-card:next-actions' }],
  });

  return blocks;
}

function buildOverviewData(
  pack: ContextPack,
  resultCard: RetrievalResultCard,
  contextBlocks: ContextBlock[],
): {
  summary: { codeBlocks: number; files: number; totalSegments: number };
  topFiles: Array<{ filePath: string; segmentCount: number }>;
  references: Array<{ blockId: string; source: string; ref: string }>;
  expansionCandidates: Array<{ filePath: string; reason: string; priority: 'high' | 'medium' | 'low' }>;
  nextInspectionSuggestions: string[];
} {
  const topFiles = pack.files
    .map((file) => ({ filePath: file.filePath, segmentCount: file.segments.length }))
    .sort((a, b) => b.segmentCount - a.segmentCount)
    .slice(0, 5);

  const expansionCandidates = pack.expansionCandidates
    ? pack.expansionCandidates.slice(0, 5).map((candidate) => ({
        filePath: candidate.filePath,
        reason: candidate.reason,
        priority: candidate.priority,
      }))
    : (() => {
        const seen = new Set<string>();
        return [...pack.expanded]
          .sort((a, b) => b.score - a.score)
          .filter((chunk) => {
            const key = chunk.filePath;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .slice(0, 5)
          .map((chunk) => ({
            filePath: chunk.filePath,
            reason: `expanded via ${chunk.source}`,
            priority: chunk.source === 'import' ? 'high' : chunk.source === 'breadcrumb' ? 'medium' : 'low',
          }));
      })();

  const references = contextBlocks
    .flatMap((block) => block.provenance.map((item) => ({ blockId: block.id, source: item.source, ref: item.ref })))
    .slice(0, 20);

  return {
    summary: {
      codeBlocks: pack.seeds.length,
      files: pack.files.length,
      totalSegments: pack.files.reduce((acc, file) => acc + file.segments.length, 0),
    },
    topFiles,
    references,
    expansionCandidates,
    nextInspectionSuggestions:
      pack.nextInspectionSuggestions && pack.nextInspectionSuggestions.length > 0
        ? pack.nextInspectionSuggestions
        : resultCard.nextActions,
  };
}

function buildCheckpointCandidate(
  repoPath: string,
  informationRequest: string,
  contextBlocks: ReturnType<typeof buildContextBlocks>,
  resultCard: RetrievalResultCard,
): CheckpointCandidate {
  const now = new Date().toISOString();
  return {
    id: `checkpoint:${crypto.createHash('sha1').update(`${repoPath}:${informationRequest}`).digest('hex').slice(0, 12)}`,
    repoPath,
    title: informationRequest,
    goal: informationRequest,
    phase: 'overview',
    summary: resultCard.reasoning[0] || informationRequest,
    activeBlockIds: contextBlocks.filter((block) => block.pinned).map((block) => block.id),
    supportingRefs: contextBlocks
      .filter((block) => block.provenance.some((item) => item.source === 'evidence'))
      .map((block) => block.id)
      .slice(0, 20),
    exploredRefs: contextBlocks.flatMap((block) => block.provenance.map((item) => item.ref)).slice(0, 20),
    keyFindings: resultCard.reasoning.slice(0, 5),
    unresolvedQuestions: [],
    nextSteps: resultCard.nextActions,
    createdAt: now,
    updatedAt: now,
    source: 'retrieval',
    confidence: 'high',
    reason: 'Generated from retrieval context blocks and result-card reasoning',
  };
}

function buildBlockFirstPayload(
  contextBlocks: ContextBlock[],
  checkpointCandidate: CheckpointCandidate,
  nextInspectionSuggestions: string[],
): BlockFirstPayload {
  return {
    schemaVersion: 1,
    contextBlocks,
    references: contextBlocks.flatMap((block) =>
      block.provenance.map((item) => ({
        blockId: block.id,
        source: item.source,
        ref: item.ref,
      })),
    ),
    checkpointCandidate,
    nextInspectionSuggestions,
  };
}

async function syncMemoryReviewStatus(
  store: { markFeatureNeedsReview: (moduleName: string, reason: string) => Promise<FeatureMemory | null> },
  memoryMatches: ResultCardFeatureMemoryMatch[],
): Promise<void> {
  for (const match of memoryMatches) {
    if (
      !match.freshness.status.includes('conflict')
      || match.memory.reviewStatus === 'needs-review'
    ) {
      continue;
    }

    const reason = '当前查询命中的代码路径与记忆记录不一致';
    match.memory.reviewStatus = 'needs-review';
    match.memory.reviewReason = reason;
    match.memory.reviewMarkedAt = new Date().toISOString();
    match.freshness.reviewStatus = 'needs-review';
    match.freshness.reviewReason = reason;

    try {
      await store.markFeatureNeedsReview(match.memory.name, reason);
    } catch (err) {
      logger.debug(
        { memory: match.memory.name, error: (err as Error).message },
        '自动标记功能记忆待复核失败',
      );
    }
  }
}

function attachFeedbackToMemoryMatches(
  memoryMatches: ResultCardFeatureMemoryMatch[],
  feedbackMatches: ResultCardFeedbackMatch[],
): ResultCardFeatureMemoryMatch[] {
  return memoryMatches.map((match) => ({
    ...match,
    feedbackSignals: feedbackMatches.filter(
      (feedback) =>
        feedback.signal.targetType === 'feature-memory'
        && normalizeToken(feedback.signal.targetId || '') === normalizeToken(match.memory.name),
    ),
  }));
}

function parseFeedbackSignal(memory: ResolvedLongTermMemoryItem): ParsedFeedbackSignal | null {
  if (memory.type !== 'feedback') {
    return null;
  }

  const pairs = memory.summary.split('|').map((part) => part.trim());
  const parsed = new Map<string, string>();
  for (const pair of pairs) {
    const [rawKey, ...rawValue] = pair.split('=');
    if (!rawKey || rawValue.length === 0) continue;
    parsed.set(rawKey.trim(), rawValue.join('=').trim());
  }

  const outcome = parsed.get('outcome') as ParsedFeedbackSignal['outcome'] | undefined;
  if (
    outcome !== 'helpful'
    && outcome !== 'not-helpful'
    && outcome !== 'memory-stale'
    && outcome !== 'wrong-module'
  ) {
    return null;
  }

  return {
    outcome,
    targetType: parsed.get('targetType') as ParsedFeedbackSignal['targetType'] | undefined,
    targetId: parsed.get('target'),
    query: parsed.get('query'),
    details: parsed.get('details'),
  };
}

function formatFeatureFeedbackSummary(feedbackSignals: ResultCardFeedbackMatch[]): string {
  if (feedbackSignals.length === 0) {
    return '无';
  }

  const counts = feedbackSignals.reduce<Record<string, number>>((acc, feedback) => {
    acc[feedback.signal.outcome] = (acc[feedback.signal.outcome] || 0) + 1;
    return acc;
  }, {});
  const labels = Object.entries(counts).map(([outcome, count]) =>
    count > 1 ? `${outcome} x${count}` : outcome,
  );

  return `近期存在 ${labels.join(', ')} 反馈`;
}

async function buildColdStartLexicalFallbackPack({
  repoPath,
  informationRequest,
  technicalTerms,
}: {
  repoPath: string;
  informationRequest: string;
  technicalTerms: string[];
}): Promise<ContextPack> {
  const { crawl } = await import('../../scanner/crawler.js');
  const { initFilter } = await import('../../scanner/filter.js');

  await initFilter(repoPath);
  const filePaths = await crawl(repoPath);
  const queryTerms = extractQueryTerms(informationRequest, technicalTerms);
  const matches: Array<{
    filePath: string;
    relPath: string;
    score: number;
    snippetStart: number;
    snippetEnd: number;
    text: string;
    startLine: number;
    endLine: number;
    matchedToken: string;
  }> = [];

  for (const filePath of filePaths) {
    const stat = await fs.promises.stat(filePath);
    if (stat.size > 256 * 1024) {
      continue;
    }

    let content: string;
    try {
      content = await fs.promises.readFile(filePath, 'utf-8');
    } catch {
      continue;
    }

    const relPath = normalizePath(path.relative(repoPath, filePath));
    const match = computeColdStartLexicalMatch(content, relPath, queryTerms, technicalTerms);
    if (!match) continue;

    const snippet = sliceSnippet(content, match.offset);
    matches.push({
      filePath,
      relPath,
      score: match.score,
      snippetStart: snippet.start,
      snippetEnd: snippet.end,
      text: snippet.text,
      startLine: snippet.startLine,
      endLine: snippet.endLine,
      matchedToken: match.token,
    });
  }

  matches.sort((a, b) => b.score - a.score);
  const topMatches = matches.slice(0, 5);

  return {
    query: [informationRequest, ...technicalTerms].filter(Boolean).join(' '),
    seeds: topMatches.map((match, index) => ({
      filePath: match.relPath,
      chunkIndex: index,
      score: match.score,
      source: 'lexical' as const,
      record: {
        chunk_id: `${match.relPath}#cold-start#${index}`,
        file_path: match.relPath,
        file_hash: 'cold-start',
        chunk_index: index,
        vector: [],
        display_code: match.text,
        vector_text: match.text,
        language: detectLanguage(match.relPath),
        breadcrumb: `${match.relPath} > lexical fallback`,
        start_index: match.snippetStart,
        end_index: match.snippetEnd,
        raw_start: match.snippetStart,
        raw_end: match.snippetEnd,
        vec_start: match.snippetStart,
        vec_end: match.snippetEnd,
        _distance: 0,
      },
    })),
    expanded: [],
    files: topMatches.map((match) => ({
      filePath: match.relPath,
      segments: [
        {
          filePath: match.relPath,
          rawStart: match.snippetStart,
          rawEnd: match.snippetEnd,
          startLine: match.startLine,
          endLine: match.endLine,
          score: match.score,
          breadcrumb: `${match.relPath} > lexical fallback (${match.matchedToken})`,
          text: match.text,
        },
      ],
    })),
    debug: {
      wVec: 0,
      wLex: 1,
      timingMs: {},
      retrievalStats: {
        queryIntent: technicalTerms.length > 0 ? 'symbol_lookup' : 'balanced',
        lexicalStrategy: 'files_fts',
        vectorCount: 0,
        lexicalCount: topMatches.length,
        fusedCount: topMatches.length,
        topMCount: topMatches.length,
        rerankInputCount: 0,
        rerankedCount: 0,
      },
      resultStats: {
        seedCount: topMatches.length,
        expandedCount: 0,
        fileCount: topMatches.length,
        segmentCount: topMatches.length,
        totalChars: topMatches.reduce((sum, match) => sum + match.text.length, 0),
        budgetLimitChars: 0,
        budgetUsedChars: topMatches.reduce((sum, match) => sum + match.text.length, 0),
        budgetExhausted: false,
        filesConsidered: filePaths.length,
        filesIncluded: topMatches.length,
      },
    },
  };
}

function computeColdStartLexicalMatch(
  content: string,
  relPath: string,
  queryTerms: string[],
  technicalTerms: string[],
): { score: number; offset: number; token: string } | null {
  const lowerContent = content.toLowerCase();
  const lowerPath = relPath.toLowerCase();
  let score = 0;
  let bestOffset = -1;
  let bestToken = '';

  for (const technicalTerm of technicalTerms.map(normalizeToken).filter(Boolean)) {
    const pathIndex = lowerPath.indexOf(technicalTerm);
    if (pathIndex >= 0) {
      score += 10;
      if (bestOffset < 0) {
        bestOffset = 0;
        bestToken = technicalTerm;
      }
    }

    const contentIndex = lowerContent.indexOf(technicalTerm);
    if (contentIndex >= 0) {
      score += 20;
      if (bestOffset < 0 || contentIndex < bestOffset) {
        bestOffset = contentIndex;
        bestToken = technicalTerm;
      }
    }
  }

  for (const term of queryTerms) {
    if (!term) continue;
    const pathIndex = lowerPath.indexOf(term);
    if (pathIndex >= 0) {
      score += 3;
      if (bestOffset < 0) {
        bestOffset = 0;
        bestToken = term;
      }
    }

    const contentIndex = lowerContent.indexOf(term);
    if (contentIndex >= 0) {
      score += 5;
      if (bestOffset < 0 || contentIndex < bestOffset) {
        bestOffset = contentIndex;
        bestToken = term;
      }
    }
  }

  if (score <= 0) {
    return null;
  }

  return {
    score,
    offset: Math.max(bestOffset, 0),
    token: bestToken || normalizeToken(relPath),
  };
}

function sliceSnippet(
  content: string,
  offset: number,
): { start: number; end: number; startLine: number; endLine: number; text: string } {
  const lines = content.split('\n');
  let runningOffset = 0;
  let lineIndex = 0;

  for (let index = 0; index < lines.length; index++) {
    const lineLength = lines[index].length + 1;
    if (runningOffset + lineLength > offset) {
      lineIndex = index;
      break;
    }
    runningOffset += lineLength;
  }

  const startLineIndex = Math.max(0, lineIndex - 3);
  const endLineIndex = Math.min(lines.length - 1, lineIndex + 4);
  const start = lines.slice(0, startLineIndex).join('\n').length + (startLineIndex > 0 ? 1 : 0);
  const end = lines.slice(0, endLineIndex + 1).join('\n').length;

  return {
    start,
    end,
    startLine: startLineIndex + 1,
    endLine: endLineIndex + 1,
    text: lines.slice(startLineIndex, endLineIndex + 1).join('\n'),
  };
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
