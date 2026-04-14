/**
 * LoadModuleMemory MCP Tool（Thin Adapter）
 *
 * Zod schema + 协议适配，业务逻辑在 application 层。
 */

import { z } from 'zod';
import { responseFormatSchema } from './responseFormat.js';

// ===========================================
// Schema 定义
// ===========================================

export const loadModuleMemorySchema = z.object({
  moduleName: z.string().optional().describe('Exact module name to load'),
  query: z.string().optional().describe('Keyword to search for matching modules'),
  scope: z.string().optional().describe('Explicit scope name to load all modules within'),
  filePaths: z.array(z.string()).optional().describe('File paths to match against triggerPaths'),
  phase: z
    .enum(['overview', 'debug', 'implementation', 'verification', 'handoff'])
    .optional()
    .describe('Task phase used to choose context assembly defaults'),
  profile: z
    .enum(['overview', 'debug', 'implementation', 'verification', 'handoff'])
    .optional()
    .describe('Assembly profile alias; overrides phase when provided'),
  enableScopeCascade: z
    .boolean()
    .optional()
    .default(false)
    .describe('Whether to include additional modules from matched scopes'),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(8)
    .describe('Maximum number of module memories to return'),
  useMmr: z
    .boolean()
    .optional()
    .default(true)
    .describe('Whether to apply MMR reranking for novelty/diversity'),
  mmrLambda: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .default(0.65)
    .describe('MMR relevance weight (0=novelty only, 1=relevance only)'),
  format: responseFormatSchema,
});

export type LoadModuleMemoryInput = z.infer<typeof loadModuleMemorySchema>;

// ===========================================
// Thin Handler
// ===========================================

export async function handleLoadModuleMemory(
  args: LoadModuleMemoryInput,
  projectRoot: string,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const { executeLoadModuleMemory } = await import('../../application/memory/executeModuleMemory.js');
  return executeLoadModuleMemory(args, projectRoot);
}
