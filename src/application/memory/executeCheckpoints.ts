/**
 * Checkpoints Application Layer
 *
 * CLI 和 MCP adapter 统一通过此入口调用 checkpoint 业务逻辑。
 */

import crypto from 'node:crypto';
import { MemoryStore } from '../../memory/MemoryStore.js';
import type {
  CheckpointListPayload,
  ContextBlock,
  TaskCheckpoint,
} from '../../memory/types.js';
import {
  buildCheckpointContextBlock,
  buildCheckpointJsonPayload,
} from '../../mcp/tools/checkpointBundles.js';
import type { ResponseFormat, MemoryToolResponse } from './memoryTypes.js';

// ===========================================
// Input 类型
// ===========================================

export interface CreateCheckpointInput {
  repo_path: string;
  title: string;
  goal: string;
  phase: TaskCheckpoint['phase'];
  summary: string;
  activeBlockIds?: string[];
  exploredRefs?: string[];
  supportingRefs?: string[];
  keyFindings?: string[];
  unresolvedQuestions?: string[];
  nextSteps?: string[];
  format: ResponseFormat;
}

export interface LoadCheckpointInput {
  repo_path: string;
  checkpoint_id: string;
  format: ResponseFormat;
}

export interface ListCheckpointsInput {
  repo_path: string;
  format: ResponseFormat;
}

// ===========================================
// Helpers
// ===========================================

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
    `- **Supporting Refs**: ${checkpoint.supportingRefs?.length || 0}`,
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

// ===========================================
// Handlers
// ===========================================

export async function executeCreateCheckpoint(
  args: CreateCheckpointInput,
): Promise<MemoryToolResponse> {
  const store = new MemoryStore(args.repo_path);
  const now = new Date().toISOString();
  const checkpoint: TaskCheckpoint = {
    id: `chk_${crypto.createHash('sha1').update(`${args.repo_path}:${args.title}:${args.goal}:${now}`).digest('hex').slice(0, 12)}`,
    repoPath: args.repo_path,
    title: args.title,
    goal: args.goal,
    phase: args.phase,
    summary: args.summary,
    activeBlockIds: args.activeBlockIds ?? [],
    exploredRefs: args.exploredRefs ?? [],
    supportingRefs: args.supportingRefs ?? [],
    keyFindings: args.keyFindings ?? [],
    unresolvedQuestions: args.unresolvedQuestions ?? [],
    nextSteps: args.nextSteps ?? [],
    createdAt: now,
    updatedAt: now,
  };
  const savedTo = await store.saveCheckpoint(checkpoint);
  const contextBlock = buildCheckpointContextBlock(checkpoint, savedTo || `checkpoint:${checkpoint.id}`);
  if (args.format === 'json') {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(buildCheckpointJsonPayload('create_checkpoint', checkpoint, [contextBlock], savedTo), null, 2),
      }],
    };
  }
  return {
    content: [{ type: 'text', text: `${formatCheckpointText(checkpoint)}\n\n- **Saved to**: ${savedTo}` }],
  };
}

export async function executeLoadCheckpoint(
  args: LoadCheckpointInput,
): Promise<MemoryToolResponse> {
  const store = new MemoryStore(args.repo_path);
  const checkpoint = await store.readCheckpoint(args.checkpoint_id);
  if (!checkpoint) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Checkpoint not found: ${args.checkpoint_id}` }],
    };
  }
  if (args.format === 'json') {
    const contextBlock = buildCheckpointContextBlock(checkpoint, `checkpoint:${checkpoint.id}`);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(buildCheckpointJsonPayload('load_checkpoint', checkpoint, [contextBlock]), null, 2),
      }],
    };
  }
  return { content: [{ type: 'text', text: formatCheckpointText(checkpoint) }] };
}

export async function executeListCheckpoints(
  args: ListCheckpointsInput,
): Promise<MemoryToolResponse> {
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
