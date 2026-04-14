/**
 * suggest_phase_boundary MCP Tool（Thin Adapter）
 *
 * Zod schema + 协议适配，业务逻辑在 application 层。
 */

import { z } from 'zod';
import { responseFormatSchema } from './responseFormat.js';

const phaseSchema = z.enum(['overview', 'research', 'debug', 'implementation', 'verification', 'handoff']);
const assemblyProfileSchema = phaseSchema.exclude(['research']);

const taskCheckpointSchema = z.object({
  id: z.string(),
  repoPath: z.string().optional().default(''),
  title: z.string().optional().default(''),
  goal: z.string().optional().default(''),
  phase: phaseSchema,
  summary: z.string().optional().default(''),
  activeBlockIds: z.array(z.string()).optional().default([]),
  exploredRefs: z.array(z.string()).optional().default([]),
  keyFindings: z.array(z.string()).optional().default([]),
  unresolvedQuestions: z.array(z.string()).optional().default([]),
  nextSteps: z.array(z.string()).optional().default([]),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

const retrievalSignalSchema = z.object({
  codeBlocks: z.number().int().min(0).optional().default(0),
  memoryBlocks: z.number().int().min(0).optional().default(0),
  decisionBlocks: z.number().int().min(0).optional().default(0),
  nextInspectionSuggestions: z.number().int().min(0).optional().default(0),
  confidence: z.enum(['low', 'medium', 'high']).optional(),
  mode: z.enum(['overview', 'expanded']).optional(),
  note: z.string().optional(),
});

const assemblySignalSchema = z.object({
  profile: assemblyProfileSchema.optional(),
  source: z.enum(['default', 'phase', 'profile']).optional(),
  budgetUsed: z.number().int().min(0).optional(),
  budgetLimit: z.number().int().min(0).optional(),
  budgetExhausted: z.boolean().optional(),
  scopeCascadeApplied: z.boolean().optional(),
  selectionStrategy: z.enum(['mmr', 'ranked']).optional(),
});

export const suggestPhaseBoundarySchema = z.object({
  repo_path: z.string().describe('Absolute repository root path'),
  current_phase: phaseSchema.describe('Current task phase'),
  checkpoint_id: z.string().optional().describe('Checkpoint id to load from the project store'),
  checkpoint: taskCheckpointSchema.optional().describe('Optional explicit checkpoint payload'),
  retrieval_signal: retrievalSignalSchema.optional().describe('Optional retrieval quality / density signal'),
  assembly_signal: assemblySignalSchema.optional().describe('Optional context assembly signal'),
  format: responseFormatSchema.optional().default('text'),
});

export type SuggestPhaseBoundaryInput = z.infer<typeof suggestPhaseBoundarySchema>;

export async function handleSuggestPhaseBoundary(
  args: SuggestPhaseBoundaryInput,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const { executeSuggestPhaseBoundary } = await import('../../application/memory/executeSuggestPhaseBoundary.js');
  return executeSuggestPhaseBoundary(args);
}
