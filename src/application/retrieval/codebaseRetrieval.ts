/**
 * Application 层检索入口
 *
 * MCP adapter 和 CLI adapter 统一通过此入口调用检索编排。
 * 不再是 MCP 代理，而是真正的 application 层入口。
 */

import type { RetrievalInput, RetrievalOutput } from './retrievalTypes.js';
import { executeRetrieval } from './executeRetrieval.js';

export type ExecuteCodebaseRetrievalInput = RetrievalInput;
export type ExecuteCodebaseRetrievalOutput = RetrievalOutput;

/**
 * 执行代码库检索
 *
 * 保持向后兼容的入口函数。
 * 新代码建议直接使用 executeRetrieval。
 */
export async function executeCodebaseRetrieval(
  input: ExecuteCodebaseRetrievalInput,
): Promise<ExecuteCodebaseRetrievalOutput> {
  return executeRetrieval(input);
}
