import crypto from 'node:crypto';
import { z } from 'zod';
import type {
  CheckpointHandoffBundle,
  CheckpointHandoff,
  CheckpointListPayload,
  CheckpointResumeBundle,
  CheckpointSummary,
  CheckpointToolPayload,
  CheckpointToolPayloadWithBundles,
  ContextBlock,
  TaskCheckpoint,
} from '../../memory/types.js';
import { MemoryStore } from '../../memory/MemoryStore.js';
import { responseFormatSchema } from './responseFormat.js';

export const createCheckpointSchema = z.object({
  repo_path: z.string().describe('Absolute repository root path'),
  title: z.string().describe('Checkpoint title'),
  goal: z.string().describe('Task goal'),
  phase: z.enum(['overview', 'research', 'debug', 'implementation', 'verification', 'handoff']),
  summary: z.string().describe('Compact checkpoint summary'),
  activeBlockIds: z.array(z.string()).optional().default([]),
  exploredRefs: z.array(z.string()).optional().default([]),
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

function buildCheckpointContextBlock(
  checkpoint: TaskCheckpoint,
  provenanceRef: string,
): ContextBlock {
  return {
    id: `checkpoint-block:${checkpoint.id}`,
    type: 'task-state',
    title: checkpoint.title,
    purpose: 'Preserve task state for handoff and resume',
    content: [
      `Goal: ${checkpoint.goal}`,
      `Phase: ${checkpoint.phase}`,
      `Summary: ${checkpoint.summary}`,
      `Active blocks: ${checkpoint.activeBlockIds.length > 0 ? checkpoint.activeBlockIds.join(', ') : 'None'}`,
      `Explored refs: ${checkpoint.exploredRefs.length > 0 ? checkpoint.exploredRefs.join(', ') : 'None'}`,
      `Key findings: ${checkpoint.keyFindings.length > 0 ? checkpoint.keyFindings.join(' | ') : 'None'}`,
      `Unresolved questions: ${checkpoint.unresolvedQuestions.length > 0 ? checkpoint.unresolvedQuestions.join(' | ') : 'None'}`,
      `Next steps: ${checkpoint.nextSteps.length > 0 ? checkpoint.nextSteps.join(' | ') : 'None'}`,
    ].join('\n'),
    priority: 'high',
    pinned: true,
    expandable: false,
    budgetChars: 1200,
    memoryKind: 'task-state',
    provenance: [{ source: 'long-term-memory', ref: provenanceRef }],
    freshness: {
      lastVerifiedAt: checkpoint.updatedAt,
      stale: false,
      confidence: 'high',
    },
  };
}

function buildCheckpointHandoff(
  checkpoint: TaskCheckpoint,
  contextBlockId: string,
): CheckpointHandoff {
  return {
    checkpointId: checkpoint.id,
    repoPath: checkpoint.repoPath,
    title: checkpoint.title,
    goal: checkpoint.goal,
    phase: checkpoint.phase,
    summary: checkpoint.summary,
    activeBlockIds: checkpoint.activeBlockIds,
    exploredRefs: checkpoint.exploredRefs,
    keyFindings: checkpoint.keyFindings,
    unresolvedQuestions: checkpoint.unresolvedQuestions,
    nextSteps: checkpoint.nextSteps,
    contextBlockId,
  };
}

function buildCheckpointSummary(checkpoint: TaskCheckpoint): CheckpointSummary {
  return {
    activeBlockCount: checkpoint.activeBlockIds.length,
    exploredRefCount: checkpoint.exploredRefs.length,
    keyFindingCount: checkpoint.keyFindings.length,
    unresolvedQuestionCount: checkpoint.unresolvedQuestions.length,
    nextStepCount: checkpoint.nextSteps.length,
  };
}

function buildCheckpointJsonPayload(
  tool: 'create_checkpoint' | 'load_checkpoint',
  checkpoint: TaskCheckpoint,
  savedTo?: string,
): CheckpointToolPayloadWithBundles {
  const contextBlock = buildCheckpointContextBlock(
    checkpoint,
    savedTo || `checkpoint:${checkpoint.id}`,
  );
  return {
    tool,
    checkpoint,
    contextBlocks: [contextBlock],
    handoff: buildCheckpointHandoff(checkpoint, contextBlock.id),
    handoffBundle: buildCheckpointHandoffBundle(checkpoint, [contextBlock]),
    resumeBundle: buildCheckpointResumeBundle(checkpoint, [contextBlock]),
    summary: buildCheckpointSummary(checkpoint),
    ...(savedTo ? { savedTo } : {}),
  };
}

function buildCheckpointListJsonPayload(checkpoints: TaskCheckpoint[]): CheckpointListPayload {
  const contextBlocks = checkpoints.map((checkpoint) =>
    buildCheckpointContextBlock(checkpoint, `checkpoint:${checkpoint.id}`),
  );
  const phaseCounts = checkpoints.reduce<Record<TaskCheckpoint['phase'], number>>(
    (acc, checkpoint) => {
      acc[checkpoint.phase] = (acc[checkpoint.phase] || 0) + 1;
      return acc;
    },
    {
      overview: 0,
      research: 0,
      debug: 0,
      implementation: 0,
      verification: 0,
      handoff: 0,
    },
  );

  return {
    tool: 'list_checkpoints',
    total: checkpoints.length,
    checkpoints,
    contextBlocks,
    summary: {
      total: checkpoints.length,
      phaseCounts,
    },
  };
}

function buildCheckpointHandoffBundle(
  checkpoint: TaskCheckpoint,
  contextBlocks: ContextBlock[],
): CheckpointHandoffBundle {
  const handoff = buildCheckpointHandoff(checkpoint, contextBlocks[0]?.id || `checkpoint-block:${checkpoint.id}`);
  return {
    bundleVersion: 1,
    kind: 'handoff-bundle',
    checkpointId: checkpoint.id,
    repoPath: checkpoint.repoPath,
    title: checkpoint.title,
    goal: checkpoint.goal,
    phase: checkpoint.phase,
    summary: checkpoint.summary,
    contextBlocks,
    handoff,
    nextSteps: checkpoint.nextSteps,
  };
}

function buildCheckpointResumeBundle(
  checkpoint: TaskCheckpoint,
  contextBlocks: ContextBlock[],
): CheckpointResumeBundle {
  return {
    bundleVersion: 1,
    kind: 'resume-bundle',
    checkpointId: checkpoint.id,
    repoPath: checkpoint.repoPath,
    title: checkpoint.title,
    goal: checkpoint.goal,
    phase: checkpoint.phase,
    summary: checkpoint.summary,
    contextBlocks,
    resumeFromCheckpointId: checkpoint.id,
    activeBlockIds: checkpoint.activeBlockIds,
    exploredRefs: checkpoint.exploredRefs,
    keyFindings: checkpoint.keyFindings,
    unresolvedQuestions: checkpoint.unresolvedQuestions,
  };
}

function formatCheckpointText(checkpoint: TaskCheckpoint): string {
  return [
    '## Task Checkpoint',
    `- **ID**: ${checkpoint.id}`,
    `- **Title**: ${checkpoint.title}`,
    `- **Goal**: ${checkpoint.goal}`,
    `- **Phase**: ${checkpoint.phase}`,
    `- **Summary**: ${checkpoint.summary}`,
    `- **Active Blocks**: ${checkpoint.activeBlockIds.length}`,
    `- **Explored Refs**: ${checkpoint.exploredRefs.length}`,
    '',
    '### Key Findings',
    ...(checkpoint.keyFindings.length > 0 ? checkpoint.keyFindings.map((item) => `- ${item}`) : ['- None']),
    '',
    '### Unresolved Questions',
    ...(checkpoint.unresolvedQuestions.length > 0
      ? checkpoint.unresolvedQuestions.map((item) => `- ${item}`)
      : ['- None']),
    '',
    '### Next Steps',
    ...(checkpoint.nextSteps.length > 0 ? checkpoint.nextSteps.map((item) => `- ${item}`) : ['- None']),
  ].join('\n');
}

export async function handleCreateCheckpoint(
  args: CreateCheckpointInput,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const store = new MemoryStore(args.repo_path);
  const now = new Date().toISOString();
  const checkpoint: TaskCheckpoint = {
    id: `chk_${crypto.createHash('sha1').update(`${args.repo_path}:${args.title}:${args.goal}:${now}`).digest('hex').slice(0, 12)}`,
    repoPath: args.repo_path,
    title: args.title,
    goal: args.goal,
    phase: args.phase,
    summary: args.summary,
    activeBlockIds: args.activeBlockIds,
    exploredRefs: args.exploredRefs,
    keyFindings: args.keyFindings,
    unresolvedQuestions: args.unresolvedQuestions,
    nextSteps: args.nextSteps,
    createdAt: now,
    updatedAt: now,
  };
  const savedTo = await store.saveCheckpoint(checkpoint);
  if (args.format === 'json') {
    return {
      content: [{ type: 'text', text: JSON.stringify(buildCheckpointJsonPayload('create_checkpoint', checkpoint, savedTo), null, 2) }],
    };
  }
  return {
    content: [{ type: 'text', text: `${formatCheckpointText(checkpoint)}

- **Saved to**: ${savedTo}` }],
  };
}

export async function handleLoadCheckpoint(
  args: LoadCheckpointInput,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const store = new MemoryStore(args.repo_path);
  const checkpoint = await store.readCheckpoint(args.checkpoint_id);
  if (!checkpoint) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Checkpoint not found: ${args.checkpoint_id}` }],
    };
  }
  if (args.format === 'json') {
    return {
      content: [{ type: 'text', text: JSON.stringify(buildCheckpointJsonPayload('load_checkpoint', checkpoint), null, 2) }],
    };
  }
  return { content: [{ type: 'text', text: formatCheckpointText(checkpoint) }] };
}

export async function handleListCheckpoints(
  args: ListCheckpointsInput,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const store = new MemoryStore(args.repo_path);
  const checkpoints = await store.listCheckpoints();
  if (args.format === 'json') {
    return {
      content: [{ type: 'text', text: JSON.stringify(buildCheckpointListJsonPayload(checkpoints), null, 2) }],
    };
  }
  const lines = [
    '## Task Checkpoints',
    `- **Total**: ${checkpoints.length}`,
    '',
    ...(checkpoints.length > 0
      ? checkpoints.map((checkpoint) => `- ${checkpoint.id} | ${checkpoint.phase} | ${checkpoint.title}`)
      : ['- None']),
  ];
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}
