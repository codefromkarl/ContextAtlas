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
import { MemoryStore } from '../../memory/MemoryStore.js';
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

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-');
}

function buildReferencedBlockIds(checkpoint: TaskCheckpoint, contextBlockId: string): string[] {
  const blockIds = new Set<string>([...checkpoint.activeBlockIds, contextBlockId]);
  return [...blockIds];
}

function buildFeatureMemoryContextBlock(memory: FeatureMemory): ContextBlock {
  return {
    id: `memory:${normalizeName(memory.name)}`,
    type: 'module-summary',
    title: memory.name,
    purpose: 'Summarize stable module responsibilities and interfaces referenced by the checkpoint',
    content: [
      `Responsibility: ${memory.responsibility}`,
      `Location: ${memory.location.dir}`,
      `Files: ${memory.location.files.length > 0 ? memory.location.files.join(', ') : 'N/A'}`,
      `Exports: ${memory.api.exports.length > 0 ? memory.api.exports.join(', ') : 'N/A'}`,
      `Data Flow: ${memory.dataFlow || 'N/A'}`,
      `Key Patterns: ${memory.keyPatterns.length > 0 ? memory.keyPatterns.join(', ') : 'N/A'}`,
    ].join('\n'),
    priority: 'high',
    pinned: true,
    expandable: true,
    memoryKind: 'semantic',
    provenance: [{ source: 'feature-memory', ref: memory.name }],
    freshness: {
      lastVerifiedAt: memory.lastUpdated,
      stale: memory.reviewStatus === 'needs-review',
      confidence:
        memory.confirmationStatus === 'human-confirmed'
          ? 'high'
          : memory.confirmationStatus === 'agent-inferred'
            ? 'medium'
            : 'low',
    },
  };
}

function buildFeatureAliasContextBlock(memory: FeatureMemory): ContextBlock {
  return {
    ...buildFeatureMemoryContextBlock(memory),
    id: `feature:${memory.name}`,
  };
}

function buildLongTermMemoryContextBlock(memory: ResolvedLongTermMemoryItem): ContextBlock {
  return {
    id: `long-term:${memory.type}:${memory.id}`,
    type: 'repo-rules',
    title: memory.title,
    purpose: 'Surface durable long-term guidance referenced by the checkpoint',
    content: memory.summary,
    priority: 'medium',
    pinned: false,
    expandable: true,
    memoryKind: memory.type === 'reference' ? 'procedural' : 'episodic',
    provenance: [{ source: 'long-term-memory', ref: memory.id }],
    freshness: {
      lastVerifiedAt: memory.lastVerifiedAt || memory.updatedAt,
      stale: memory.status === 'stale' || memory.status === 'expired' || memory.status === 'superseded',
      confidence: memory.confidence >= 0.8 ? 'high' : memory.confidence >= 0.5 ? 'medium' : 'low',
    },
  };
}

function buildDecisionContextBlock(decision: DecisionRecord): ContextBlock {
  return {
    id: `decision:${decision.id}`,
    type: 'decision-context',
    title: decision.title,
    purpose: 'Preserve architectural decisions referenced by the checkpoint',
    content: [decision.context, decision.decision, `Rationale: ${decision.rationale}`].join('\n'),
    priority: 'medium',
    pinned: false,
    expandable: true,
    memoryKind: 'semantic',
    provenance: [{ source: 'decision-record', ref: decision.id }],
  };
}

function buildCodeReferenceBlock(blockId: string, checkpoint: TaskCheckpoint): ContextBlock {
  const codeRef = blockId.slice('code:'.length);
  const knownRef = checkpoint.exploredRefs.find((ref) => ref === codeRef) || codeRef;
  return {
    id: blockId,
    type: 'code-evidence',
    title: knownRef,
    purpose: 'Preserve a referenced code block that was pinned into the checkpoint',
    content: knownRef,
    priority: 'medium',
    pinned: true,
    expandable: false,
    memoryKind: 'semantic',
    provenance: [{ source: 'code', ref: knownRef }],
  };
}

function buildOpenQuestionsBlock(checkpoint: TaskCheckpoint): ContextBlock {
  return {
    id: 'task:open-questions',
    type: 'open-questions',
    title: 'Next actions',
    purpose: 'Capture immediate follow-up directions for the next agent',
    content: checkpoint.nextSteps.length > 0 ? checkpoint.nextSteps.join('\n') : 'None',
    priority: 'medium',
    pinned: true,
    expandable: false,
    memoryKind: 'task-state',
    provenance: [{ source: 'code', ref: 'result-card:next-actions' }],
  };
}

function buildRecentFindingsBlock(checkpoint: TaskCheckpoint): ContextBlock | null {
  if (checkpoint.keyFindings.length === 0) {
    return null;
  }

  return {
    id: `checkpoint-findings:${checkpoint.id}`,
    type: 'recent-findings',
    title: `${checkpoint.title} Findings`,
    purpose: 'Surface the most important findings that the next agent should retain',
    content: checkpoint.keyFindings.join('\n'),
    priority: 'high',
    pinned: true,
    expandable: false,
    memoryKind: 'episodic',
    provenance: [{ source: 'long-term-memory', ref: `checkpoint:${checkpoint.id}` }],
    freshness: {
      lastVerifiedAt: checkpoint.updatedAt,
      stale: false,
      confidence: 'high',
    },
  };
}

function buildExploredRefsBlock(checkpoint: TaskCheckpoint): ContextBlock | null {
  if (checkpoint.exploredRefs.length === 0) {
    return null;
  }

  return {
    id: `checkpoint-evidence:${checkpoint.id}`,
    type: 'code-evidence',
    title: `${checkpoint.title} Evidence`,
    purpose: 'Preserve the code references already inspected for the task',
    content: checkpoint.exploredRefs.join('\n'),
    priority: 'medium',
    pinned: false,
    expandable: false,
    memoryKind: 'episodic',
    provenance: checkpoint.exploredRefs.map((ref) => ({ source: 'code' as const, ref })),
    freshness: {
      lastVerifiedAt: checkpoint.updatedAt,
      stale: false,
      confidence: 'medium',
    },
  };
}

async function resolveReferencedContextBlocks(
  store: MemoryStore,
  checkpoint: TaskCheckpoint,
): Promise<{ contextBlocks: ContextBlock[]; unresolvedBlockIds: string[] }> {
  const unresolvedBlockIds: string[] = [];
  const resolvedBlocks: ContextBlock[] = [];
  const features = await store.listFeatures();
  const featureByBlockId = new Map(
    features.map((feature) => [`memory:${normalizeName(feature.name)}`, feature] as const),
  );
  const featureByAliasBlockId = new Map(
    features.map((feature) => [`feature:${feature.name}`, feature] as const),
  );

  for (const blockId of checkpoint.activeBlockIds) {
    if (blockId.startsWith('memory:')) {
      const memory = featureByBlockId.get(blockId);
      if (!memory) {
        unresolvedBlockIds.push(blockId);
        continue;
      }

      resolvedBlocks.push(buildFeatureMemoryContextBlock(memory));
      continue;
    }

    if (blockId.startsWith('feature:')) {
      const memory = featureByAliasBlockId.get(blockId);
      if (!memory) {
        unresolvedBlockIds.push(blockId);
        continue;
      }

      resolvedBlocks.push(buildFeatureAliasContextBlock(memory));
      continue;
    }

    if (blockId.startsWith('long-term:')) {
      const [, type, id] = blockId.split(':');
      const matches = await store.listLongTermMemories({
        types: type ? [type as ResolvedLongTermMemoryItem['type']] : undefined,
        includeExpired: true,
      });
      const memory = matches.find((item) => item.id === id);
      if (!memory) {
        unresolvedBlockIds.push(blockId);
        continue;
      }

      resolvedBlocks.push(buildLongTermMemoryContextBlock(memory));
      continue;
    }

    if (blockId.startsWith('decision:')) {
      const decisionId = blockId.slice('decision:'.length);
      const decision = await store.readDecision(decisionId);
      if (!decision) {
        unresolvedBlockIds.push(blockId);
        continue;
      }

      resolvedBlocks.push(buildDecisionContextBlock(decision));
      continue;
    }

    if (blockId.startsWith('code:')) {
      resolvedBlocks.push(buildCodeReferenceBlock(blockId, checkpoint));
      continue;
    }

    if (blockId === 'task:open-questions') {
      resolvedBlocks.push(buildOpenQuestionsBlock(checkpoint));
      continue;
    }

    unresolvedBlockIds.push(blockId);
  }

  const findingsBlock = buildRecentFindingsBlock(checkpoint);
  if (findingsBlock) {
    resolvedBlocks.push(findingsBlock);
  }

  const exploredRefsBlock = buildExploredRefsBlock(checkpoint);
  if (exploredRefsBlock) {
    resolvedBlocks.push(exploredRefsBlock);
  }

  return {
    contextBlocks: resolvedBlocks,
    unresolvedBlockIds: Array.from(new Set(unresolvedBlockIds)),
  };
}

async function buildPrepareHandoffJsonPayload(
  store: MemoryStore,
  checkpoint: TaskCheckpoint,
): Promise<PrepareHandoffPayload> {
  const contextBlock = buildCheckpointContextBlock(checkpoint, `checkpoint:${checkpoint.id}`);
  const resolved = await resolveReferencedContextBlocks(store, checkpoint);
  const contextBlocks = [contextBlock, ...resolved.contextBlocks];
  const referencedBlockIds = buildReferencedBlockIds(checkpoint, contextBlock.id);
  const handoff = buildCheckpointHandoff(checkpoint, contextBlock.id);
  const handoffBundle: CheckpointHandoffBundle = buildCheckpointHandoffBundle(checkpoint, contextBlocks);
  const resumeBundle: CheckpointResumeBundle = buildCheckpointResumeBundle(checkpoint, contextBlocks);

  return {
    tool: 'prepare_handoff',
    checkpoint,
    contextBlocks,
    handoff,
    handoffBundle,
    resumeBundle,
    handoffSummary: {
      checkpointId: checkpoint.id,
      title: checkpoint.title,
      goal: checkpoint.goal,
      phase: checkpoint.phase,
      summary: checkpoint.summary,
      referencedBlockIds,
      resolvedBlockCount: contextBlocks.length,
      unresolvedBlockIds: resolved.unresolvedBlockIds,
      unresolvedQuestions: checkpoint.unresolvedQuestions,
      nextSteps: checkpoint.nextSteps,
      keyFindings: checkpoint.keyFindings,
      activeBlockCount: checkpoint.activeBlockIds.length,
      exploredRefCount: checkpoint.exploredRefs.length,
      keyFindingCount: checkpoint.keyFindings.length,
      unresolvedQuestionCount: checkpoint.unresolvedQuestions.length,
      nextStepCount: checkpoint.nextSteps.length,
    },
    referencedBlockIds,
    unresolvedBlockIds: resolved.unresolvedBlockIds,
    summary: buildCheckpointSummary(checkpoint),
    nextSteps: checkpoint.nextSteps,
  };
}

function formatList(items: string[]): string[] {
  return items.length > 0 ? items.map((item) => `- ${item}`) : ['- None'];
}

function formatPrepareHandoffText(checkpoint: TaskCheckpoint, payload: PrepareHandoffPayload): string {
  const contextBlock = payload.contextBlocks[0];
  return [
    '## Prepare Handoff',
    `- **Checkpoint**: ${checkpoint.id}`,
    `- **Title**: ${checkpoint.title}`,
    `- **Repo**: ${checkpoint.repoPath}`,
    `- **Goal**: ${checkpoint.goal}`,
    `- **Phase**: ${checkpoint.phase}`,
    `- **Summary**: ${checkpoint.summary}`,
    '',
    '### Handoff Summary',
    `- **Referenced Blocks**: ${payload.handoffSummary.referencedBlockIds.join(', ')}`,
    `- **Resolved Context Blocks**: ${payload.handoffSummary.resolvedBlockCount}`,
    `- **Unresolved Block References**: ${payload.handoffSummary.unresolvedBlockIds.length > 0 ? payload.handoffSummary.unresolvedBlockIds.join(', ') : 'None'}`,
    `- **Key Findings**: ${payload.handoffSummary.keyFindings.length > 0 ? payload.handoffSummary.keyFindings.join(' | ') : 'None'}`,
    '',
    '### Active Block References',
    ...formatList(checkpoint.activeBlockIds),
    '',
    '### Unresolved Block References',
    ...formatList(payload.unresolvedBlockIds),
    '',
    '### Unresolved Questions',
    ...formatList(checkpoint.unresolvedQuestions),
    '',
    '### Next Steps',
    ...formatList(payload.nextSteps),
    '',
    '### Context Block',
    `- **ID**: ${contextBlock.id}`,
    `- **Purpose**: ${contextBlock.purpose}`,
    `- **Content**:`,
    ...contextBlock.content.split('\n').map((line) => `  - ${line}`),
    '',
    '### Handoff Bundle',
    `- **Kind**: ${payload.handoffBundle.kind}`,
    `- **Checkpoint**: ${payload.handoffBundle.checkpointId}`,
    `- **Context Block**: ${payload.handoffBundle.contextBlocks[0]?.id || contextBlock.id}`,
    '',
    '### Resume Bundle',
    `- **Kind**: ${payload.resumeBundle.kind}`,
    `- **Resume From**: ${payload.resumeBundle.resumeFromCheckpointId}`,
    `- **Active Blocks**: ${checkpoint.activeBlockIds.length > 0 ? checkpoint.activeBlockIds.join(', ') : 'None'}`,
    `- **Explored Refs**: ${checkpoint.exploredRefs.length > 0 ? checkpoint.exploredRefs.join(', ') : 'None'}`,
  ].join('\n');
}

export async function handlePrepareHandoff(
  args: PrepareHandoffInput,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const store = new MemoryStore(args.repo_path);
  const checkpoint = await store.readCheckpoint(args.checkpoint_id);

  if (!checkpoint) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Checkpoint not found: ${args.checkpoint_id}` }],
    };
  }

  const payload = await buildPrepareHandoffJsonPayload(store, checkpoint);

  if (args.format === 'json') {
    return {
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    };
  }

  return {
    content: [{ type: 'text', text: formatPrepareHandoffText(checkpoint, payload) }],
  };
}
