/**
 * AgentDiary MCP Tool（Thin Adapter）
 *
 * Zod schema + 协议适配，业务逻辑在 application 层。
 */

import { z } from 'zod';
import { responseFormatSchema } from './responseFormat.js';

const diaryScopeSchema = z.enum(['project', 'global-user']);

export const recordAgentDiarySchema = z.object({
  agent_name: z.string().describe('Agent name'),
  entry: z.string().describe('Diary entry content'),
  topic: z.string().optional().default('general').describe('Diary topic'),
  scope: diaryScopeSchema.optional().default('project').describe('Diary scope'),
  tags: z.array(z.string()).optional().default([]).describe('Diary tags'),
  provenance: z.array(z.string()).optional().default([]).describe('Optional provenance refs'),
  format: responseFormatSchema,
});

export const readAgentDiarySchema = z.object({
  agent_name: z.string().describe('Agent name'),
  last_n: z.number().int().min(1).max(100).optional().default(10).describe('How many recent entries to read'),
  topic: z.string().optional().describe('Optional topic filter'),
  scope: diaryScopeSchema.optional().default('project').describe('Diary scope'),
  format: responseFormatSchema,
});

export const findAgentDiarySchema = z.object({
  query: z.string().describe('Search query'),
  agent_name: z.string().optional().describe('Optional agent name filter'),
  topic: z.string().optional().describe('Optional topic filter'),
  scope: diaryScopeSchema.optional().default('project').describe('Diary scope'),
  limit: z.number().int().min(1).max(50).optional().default(10).describe('Maximum results'),
  format: responseFormatSchema,
});

export type RecordAgentDiaryInput = z.infer<typeof recordAgentDiarySchema>;
export type ReadAgentDiaryInput = z.infer<typeof readAgentDiarySchema>;
export type FindAgentDiaryInput = z.infer<typeof findAgentDiarySchema>;

export async function handleRecordAgentDiary(
  args: RecordAgentDiaryInput,
  projectRoot: string,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const { executeRecordAgentDiary } = await import('../../application/memory/executeAgentDiary.js');
  return executeRecordAgentDiary(args, projectRoot);
}

export async function handleReadAgentDiary(
  args: ReadAgentDiaryInput,
  projectRoot: string,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const { executeReadAgentDiary } = await import('../../application/memory/executeAgentDiary.js');
  return executeReadAgentDiary(args, projectRoot);
}

export async function handleFindAgentDiary(
  args: FindAgentDiaryInput,
  projectRoot: string,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const { executeFindAgentDiary } = await import('../../application/memory/executeAgentDiary.js');
  return executeFindAgentDiary(args, projectRoot);
}
