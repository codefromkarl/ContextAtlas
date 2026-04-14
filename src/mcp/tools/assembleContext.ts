/**
 * assemble_context MCP Tool（Thin Adapter）
 *
 * Zod schema + 协议适配，业务逻辑在 application 层。
 */

import { z } from 'zod';
import { responseFormatSchema } from './responseFormat.js';

const phaseSchema = z.enum([
  'overview',
  'research',
  'debug',
  'implementation',
  'verification',
  'handoff',
]);

export const assembleContextSchema = z.object({
  repo_path: z.string().describe('Absolute repository root path'),
  phase: phaseSchema.optional().describe('Task phase used to choose the assembly stage'),
  profile: phaseSchema
    .exclude(['research'])
    .optional()
    .describe('Assembly profile alias; overrides phase when provided'),
  query: z.string().optional().describe('Semantic retrieval query for the current task'),
  moduleName: z.string().optional().describe('Exact module name to route memory loading'),
  filePaths: z.array(z.string()).optional().describe('File paths used for module memory routing'),
  checkpoint_id: z.string().optional().describe('Checkpoint id to seed task-state assembly'),
  includeDiary: z.boolean().optional().default(false).describe('Whether to include recent agent diary entries'),
  agentName: z.string().optional().describe('Optional agent name for diary lookup'),
  diaryTopic: z.string().optional().describe('Optional diary topic filter'),
  diaryLimit: z.number().int().min(1).max(10).optional().default(3).describe('Maximum number of diary entries to include'),
  format: responseFormatSchema.optional().default('text'),
});

export type AssembleContextInput = z.infer<typeof assembleContextSchema>;

export async function handleAssembleContext(
  args: AssembleContextInput,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const { executeAssembleContext } = await import('../../application/memory/executeAssembleContext.js');
  return executeAssembleContext(args);
}
