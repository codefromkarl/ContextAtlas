/**
 * prepare_handoff MCP Tool（Thin Adapter）
 *
 * Zod schema + 协议适配，业务逻辑在 application 层。
 */

import { z } from 'zod';
import type {
  CheckpointHandoffBundle,
  CheckpointResumeBundle,
  CheckpointToolPayloadWithBundles,
  ContextBlock,
  DecisionRecord,
  FeatureMemory,
  ResolvedLongTermMemoryItem,
  TaskCheckpoint,
} from '../../memory/types.js';
import {
  buildCheckpointContextBlock,
  buildCheckpointHandoff,
  buildCheckpointHandoffBundle,
  buildCheckpointResumeBundle,
  buildCheckpointSummary,
} from './checkpointBundles.js';
import { responseFormatSchema } from './responseFormat.js';

export const prepareHandoffSchema = z.object({
  repo_path: z.string().describe('Absolute repository root path'),
  checkpoint_id: z.string().describe('Checkpoint id'),
  agent_name: z.string().optional().describe('Optional agent name for diary lookup'),
  topic: z.string().optional().describe('Optional diary topic filter'),
  diary_limit: z.number().int().min(1).max(10).optional().default(3).describe('Maximum diary entries to include'),
  format: responseFormatSchema.optional().default('text'),
});

export type PrepareHandoffInput = z.infer<typeof prepareHandoffSchema>;

type PrepareHandoffPayload = Omit<CheckpointToolPayloadWithBundles, 'tool' | 'savedTo'> & {
  tool: 'prepare_handoff';
  handoffSummary: {
    checkpointId: string;
    title: string;
    goal: string;
    phase: TaskCheckpoint['phase'];
    summary: string;
    referencedBlockIds: string[];
    resolvedBlockCount: number;
    unresolvedBlockIds: string[];
    unresolvedQuestions: string[];
    nextSteps: string[];
    keyFindings: string[];
    activeBlockCount: number;
    exploredRefCount: number;
    keyFindingCount: number;
    unresolvedQuestionCount: number;
    nextStepCount: number;
  };
  referencedBlockIds: string[];
  unresolvedBlockIds: string[];
  nextSteps: string[];
};

export async function handlePrepareHandoff(
  args: PrepareHandoffInput,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const { executePrepareHandoff } = await import('../../application/memory/executePrepareHandoff.js');
  return executePrepareHandoff(args);
}
