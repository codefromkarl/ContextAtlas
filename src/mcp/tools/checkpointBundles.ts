import type {
  CheckpointHandoff,
  CheckpointHandoffBundle,
  CheckpointResumeBundle,
  CheckpointSummary,
  CheckpointToolPayloadWithBundles,
  ContextBlock,
  TaskCheckpoint,
} from '../../memory/types.js';

export function buildCheckpointContextBlock(
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

export function buildCheckpointHandoff(
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

export function buildCheckpointSummary(checkpoint: TaskCheckpoint): CheckpointSummary {
  return {
    activeBlockCount: checkpoint.activeBlockIds.length,
    exploredRefCount: checkpoint.exploredRefs.length,
    keyFindingCount: checkpoint.keyFindings.length,
    unresolvedQuestionCount: checkpoint.unresolvedQuestions.length,
    nextStepCount: checkpoint.nextSteps.length,
  };
}

export function buildCheckpointHandoffBundle(
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

export function buildCheckpointResumeBundle(
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

export function buildCheckpointJsonPayload(
  tool: 'create_checkpoint' | 'load_checkpoint',
  checkpoint: TaskCheckpoint,
  contextBlocks: ContextBlock[],
  savedTo?: string,
): CheckpointToolPayloadWithBundles {
  return {
    tool,
    checkpoint,
    contextBlocks,
    handoff: buildCheckpointHandoff(checkpoint, contextBlocks[0]?.id || `checkpoint-block:${checkpoint.id}`),
    handoffBundle: buildCheckpointHandoffBundle(checkpoint, contextBlocks),
    resumeBundle: buildCheckpointResumeBundle(checkpoint, contextBlocks),
    summary: buildCheckpointSummary(checkpoint),
    ...(savedTo ? { savedTo } : {}),
  };
}
