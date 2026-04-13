/**
 * codebase-retrieval MCP Tool
 *
 * 瘦身后的 MCP 协议适配层：
 * - Zod schema 定义
 * - 进度报告器
 * - Thin handler 委托给 application 层 executeRetrieval
 *
 * 业务逻辑已下沉到 src/application/retrieval/。
 */

import { z } from 'zod';
import { responseFormatSchema } from './responseFormat.js';
import { createRetrievalProgressReporter } from '../../application/retrieval/executeRetrieval.js';

// Re-export for backward compatibility
export { createRetrievalProgressReporter };

// ===========================================
// Zod Schema（暴露给 LLM）
// ===========================================

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
  include_graph_context: z
    .boolean()
    .optional()
    .default(true)
    .describe('When true, append a compact direct graph context summary for top matched symbols.'),
});

export type CodebaseRetrievalInput = z.infer<typeof codebaseRetrievalSchema>;

// ===========================================
// 进度回调
// ===========================================

/** 进度回调类型 */
export type ProgressCallback = (current: number, total?: number, message?: string) => void;

// ===========================================
// Thin Handler
// ===========================================

/**
 * 处理 codebase-retrieval 工具调用
 *
 * 仅做参数映射 + 进度适配 + 响应包装。
 * 业务逻辑全部在 application 层 executeRetrieval。
 */
export async function handleCodebaseRetrieval(
  args: CodebaseRetrievalInput,
  onProgress?: ProgressCallback,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const { executeRetrieval } = await import('../../application/retrieval/executeRetrieval.js');
  const reportProgress = createRetrievalProgressReporter(onProgress);

  const result = await executeRetrieval(
    {
      repoPath: args.repo_path,
      informationRequest: args.information_request,
      technicalTerms: args.technical_terms,
      responseFormat: args.response_format,
      responseMode: args.response_mode,
      includeGraphContext: args.include_graph_context,
    },
    (stage, message) => reportProgress(stage, message),
  );

  return {
    content: [{ type: 'text' as const, text: result.text }],
    ...(result.isError ? { isError: true } : {}),
  };
}

// ===========================================
// 向后兼容导出（其他 MCP tool 可能引用）
// ===========================================

export { resolveRetrievalQueries, buildRetrievalTelemetry } from '../../application/retrieval/executeRetrieval.js';
