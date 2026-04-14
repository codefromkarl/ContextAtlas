/**
 * Checkpoints MCP Tool（Thin Adapter）
 *
 * Zod schema + 协议适配，业务逻辑在 application 层。
 */

import { z } from 'zod';
import { responseFormatSchema } from './responseFormat.js';

export const createCheckpointSchema = z.object({
  repo_path: z.string().describe('Absolute repository root path'),
  title: z.string().describe('Checkpoint title'),
  goal: z.string().describe('Task goal'),
  phase: z.enum(['overview', 'research', 'debug', 'implementation', 'verification', 'handoff']),
  summary: z.string().describe('Compact checkpoint summary'),
  activeBlockIds: z.array(z.string()).optional().default([]),
  exploredRefs: z.array(z.string()).optional().default([]),
  supportingRefs: z.array(z.string()).optional().default([]),
  keyFindings: z.array(z.string()).optional().default([]),
  unresolvedQuestions: z.array(z.string()).optional().default([]),
  nextSteps: z.array(z.string()).optional().default([]),
  format: responseFormatSchema.optional().default('text'),
});

export const loadCheckpointSchema = z.object({
  repo_path: z.string().describe('Absolute repository root path'),
  checkpoint_id: z.string().describe('Checkpoint id'),
  format: responseFormatSchema.optional().default('text'),
});

export const listCheckpointsSchema = z.object({
  repo_path: z.string().describe('Absolute repository root path'),
  format: responseFormatSchema.optional().default('text'),
});

export type CreateCheckpointInput = z.infer<typeof createCheckpointSchema>;
export type LoadCheckpointInput = z.infer<typeof loadCheckpointSchema>;
export type ListCheckpointsInput = z.infer<typeof listCheckpointsSchema>;

export async function handleCreateCheckpoint(
  args: CreateCheckpointInput,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const { executeCreateCheckpoint } = await import('../../application/memory/executeCheckpoints.js');
  return executeCreateCheckpoint(args);
}

export async function handleLoadCheckpoint(
  args: LoadCheckpointInput,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const { executeLoadCheckpoint } = await import('../../application/memory/executeCheckpoints.js');
  return executeLoadCheckpoint(args);
}

export async function handleListCheckpoints(
  args: ListCheckpointsInput,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const { executeListCheckpoints } = await import('../../application/memory/executeCheckpoints.js');
  return executeListCheckpoints(args);
}
