/**
 * AutoRecord MCP Tool（Thin Adapter）
 *
 * Zod schema + 协议适配，业务逻辑在 application 层。
 */

import { z } from 'zod';

export const sessionEndSchema = z.object({
  summary: z.string().describe('Session summary or conversation transcript'),
  project: z
    .string()
    .optional()
    .describe('Deprecated project label; project identity is now derived from path'),
  autoRecord: z
    .boolean()
    .optional()
    .default(false)
    .describe('Whether to auto-record without confirmation'),
});

export const suggestMemorySchema = z.object({
  project: z
    .string()
    .optional()
    .describe('Deprecated project label; project identity is now derived from path'),
  moduleName: z.string().describe('Module name'),
  files: z.array(z.string()).optional().describe('Related file paths'),
});

export type SessionEndInput = z.infer<typeof sessionEndSchema>;
export type SuggestMemoryInput = z.infer<typeof suggestMemorySchema>;

export async function handleSessionEnd(
  args: SessionEndInput,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const { executeSessionEnd } = await import('../../application/memory/executeAutoRecord.js');
  return executeSessionEnd(args);
}

export async function handleSuggestMemory(
  args: SuggestMemoryInput,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const { executeSuggestMemory } = await import('../../application/memory/executeAutoRecord.js');
  return executeSuggestMemory(args);
}
