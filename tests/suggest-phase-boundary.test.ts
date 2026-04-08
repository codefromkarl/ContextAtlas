import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { handleSuggestPhaseBoundary, suggestPhaseBoundarySchema } from '../src/mcp/tools/suggestPhaseBoundary.ts';
import { MemoryHubDatabase } from '../src/memory/MemoryHubDatabase.ts';
import { MemoryStore } from '../src/memory/MemoryStore.ts';
import type { TaskCheckpoint } from '../src/memory/types.ts';

async function withTempProject(
  run: (projectRoot: string, dbPath: string) => Promise<void>,
): Promise<void> {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cw-suggest-phase-boundary-'));
  const projectRoot = path.join(tempDir, 'project');
  const dbPath = path.join(tempDir, 'memory-hub.db');
  mkdirSync(projectRoot, { recursive: true });

  try {
    await run(projectRoot, dbPath);
  } finally {
    MemoryStore.resetSharedHubForTests();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function saveCheckpoint(projectRoot: string, checkpoint: TaskCheckpoint): Promise<string> {
  const store = new MemoryStore(projectRoot);
  return store.saveCheckpoint(checkpoint);
}

function buildCheckpoint(overrides: Partial<TaskCheckpoint> & Pick<TaskCheckpoint, 'id' | 'phase'>): TaskCheckpoint {
  return {
    id: overrides.id,
    repoPath: overrides.repoPath || '/tmp/project',
    title: overrides.title || 'Task checkpoint',
    goal: overrides.goal || 'Evaluate phase boundary',
    phase: overrides.phase,
    summary: overrides.summary || 'Checkpoint summary',
    activeBlockIds: overrides.activeBlockIds || [],
    exploredRefs: overrides.exploredRefs || [],
    keyFindings: overrides.keyFindings || [],
    unresolvedQuestions: overrides.unresolvedQuestions || [],
    nextSteps: overrides.nextSteps || [],
    createdAt: overrides.createdAt || new Date('2026-04-08T00:00:00Z').toISOString(),
    updatedAt: overrides.updatedAt || new Date('2026-04-08T00:00:00Z').toISOString(),
  };
}

test('suggest_phase_boundary fast-tracks overview to implementation when evidence is sufficient', async () => {
  await withTempProject(async (projectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const checkpoint = buildCheckpoint({
      id: 'chk-overview',
      phase: 'overview',
      title: 'Overview checkpoint',
      goal: 'Move from overview to implementation',
      summary: 'We already know which code blocks need to change.',
      keyFindings: ['SearchService owns the retrieval pipeline'],
      unresolvedQuestions: [],
      nextSteps: ['Implement the phase boundary suggestion tool', 'Wire the output into MCP tests'],
    });
    await saveCheckpoint(projectRoot, checkpoint);

    const response = await handleSuggestPhaseBoundary({
      repo_path: projectRoot,
      current_phase: 'overview',
      checkpoint_id: checkpoint.id,
      retrieval_signal: {
        codeBlocks: 2,
        memoryBlocks: 1,
        decisionBlocks: 0,
        nextInspectionSuggestions: 0,
        confidence: 'high',
        mode: 'expanded',
      },
      assembly_signal: {
        profile: 'overview',
        source: 'phase',
        budgetUsed: 7,
        budgetLimit: 10,
        scopeCascadeApplied: true,
      },
      format: 'json',
    });

    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.tool, 'suggest_phase_boundary');
    assert.equal(payload.currentPhase, 'overview');
    assert.equal(payload.recommendedPhase, 'implementation');
    assert.equal(payload.transition, 'advance');
    assert.equal(payload.shouldTransition, true);
    assert.ok(payload.reasons.length > 0);
    assert.deepEqual(payload.blockers, []);
    assert.ok(payload.suggestedActions.some((action: string) => /implement/i.test(action)));

    const textResponse = await handleSuggestPhaseBoundary({
      repo_path: projectRoot,
      current_phase: 'overview',
      checkpoint_id: checkpoint.id,
      retrieval_signal: {
        codeBlocks: 2,
        memoryBlocks: 1,
        decisionBlocks: 0,
        nextInspectionSuggestions: 0,
        confidence: 'high',
        mode: 'expanded',
      },
      assembly_signal: {
        profile: 'overview',
        source: 'phase',
        budgetUsed: 7,
        budgetLimit: 10,
        scopeCascadeApplied: true,
      },
    });

    assert.match(textResponse.content[0].text, /\*\*Recommended Phase\*\*: implementation/);
  });
});

test('suggest_phase_boundary keeps overview when evidence is insufficient', async () => {
  await withTempProject(async (projectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const checkpoint = buildCheckpoint({
      id: 'chk-overview-stay',
      phase: 'overview',
      title: 'Overview checkpoint',
      goal: 'Assess whether to move forward',
      summary: 'We are still collecting evidence.',
    });
    await saveCheckpoint(projectRoot, checkpoint);

    const response = await handleSuggestPhaseBoundary({
      repo_path: projectRoot,
      current_phase: 'overview',
      checkpoint_id: checkpoint.id,
      format: 'json',
    });

    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.currentPhase, 'overview');
    assert.equal(payload.recommendedPhase, 'overview');
    assert.equal(payload.transition, 'stay');
    assert.equal(payload.shouldTransition, false);
    assert.ok(payload.suggestedActions.some((action: string) => /keep|stay|当前/i.test(action)));
  });
});

test('suggest_phase_boundary moves debug to verification when debug evidence is stable', async () => {
  await withTempProject(async (projectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const checkpoint = buildCheckpoint({
      id: 'chk-debug',
      phase: 'debug',
      title: 'Debug checkpoint',
      goal: 'Validate the fix',
      summary: 'The defect has been narrowed to a small area.',
      keyFindings: ['Bug reproduced and isolated'],
      unresolvedQuestions: [],
      nextSteps: ['Run regression tests', 'Collect verification evidence'],
    });
    await saveCheckpoint(projectRoot, checkpoint);

    const response = await handleSuggestPhaseBoundary({
      repo_path: projectRoot,
      current_phase: 'debug',
      checkpoint_id: checkpoint.id,
      retrieval_signal: {
        codeBlocks: 3,
        memoryBlocks: 0,
        decisionBlocks: 1,
        nextInspectionSuggestions: 0,
        confidence: 'high',
        mode: 'expanded',
      },
      assembly_signal: {
        profile: 'debug',
        source: 'phase',
        budgetUsed: 4,
        budgetLimit: 8,
        budgetExhausted: false,
      },
      format: 'json',
    });

    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.currentPhase, 'debug');
    assert.equal(payload.recommendedPhase, 'verification');
    assert.equal(payload.transition, 'advance');
    assert.equal(payload.shouldTransition, true);
    assert.deepEqual(payload.blockers, []);
  });
});

test('suggest_phase_boundary keeps debug when blockers are present', async () => {
  await withTempProject(async (projectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const checkpoint = buildCheckpoint({
      id: 'chk-debug-blocked',
      phase: 'debug',
      title: 'Debug checkpoint',
      goal: 'Validate the fix',
      summary: 'There is still an open question.',
      keyFindings: ['Bug reproduced and isolated'],
      unresolvedQuestions: ['Confirm whether the regression also affects the fallback path'],
      nextSteps: ['Run regression tests', 'Collect verification evidence'],
    });
    await saveCheckpoint(projectRoot, checkpoint);

    const response = await handleSuggestPhaseBoundary({
      repo_path: projectRoot,
      current_phase: 'debug',
      checkpoint_id: checkpoint.id,
      retrieval_signal: {
        codeBlocks: 3,
        memoryBlocks: 1,
        decisionBlocks: 1,
        nextInspectionSuggestions: 0,
        confidence: 'high',
        mode: 'expanded',
      },
      assembly_signal: {
        profile: 'debug',
        source: 'phase',
        budgetUsed: 4,
        budgetLimit: 8,
        budgetExhausted: false,
      },
      format: 'json',
    });

    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.currentPhase, 'debug');
    assert.equal(payload.recommendedPhase, 'debug');
    assert.equal(payload.transition, 'stay');
    assert.equal(payload.shouldTransition, false);
    assert.ok(payload.blockers.some((blocker: string) => blocker.includes('未解决问题')));
  });
});

test('suggest_phase_boundary keeps current phase when checkpoint phase conflicts', async () => {
  await withTempProject(async (projectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const checkpoint = buildCheckpoint({
      id: 'chk-phase-conflict',
      phase: 'verification',
      title: 'Conflicting checkpoint',
      goal: 'Move from overview to implementation',
      summary: 'The checkpoint phase does not match the live phase.',
      keyFindings: ['Implementation path is known'],
      unresolvedQuestions: [],
      nextSteps: ['Implement the phase boundary suggestion tool'],
    });
    await saveCheckpoint(projectRoot, checkpoint);

    const response = await handleSuggestPhaseBoundary({
      repo_path: projectRoot,
      current_phase: 'overview',
      checkpoint_id: checkpoint.id,
      retrieval_signal: {
        codeBlocks: 2,
        memoryBlocks: 1,
        decisionBlocks: 0,
        nextInspectionSuggestions: 0,
        confidence: 'high',
        mode: 'expanded',
      },
      assembly_signal: {
        profile: 'overview',
        source: 'phase',
        budgetUsed: 6,
        budgetLimit: 10,
        scopeCascadeApplied: true,
      },
      format: 'json',
    });

    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.currentPhase, 'overview');
    assert.equal(payload.recommendedPhase, 'overview');
    assert.equal(payload.transition, 'stay');
    assert.equal(payload.shouldTransition, false);
    assert.ok(payload.blockers.some((blocker: string) => /phase|阶段|冲突/.test(blocker)));
  });
});

test('suggest_phase_boundary keeps handoff as handoff', async () => {
  await withTempProject(async (projectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const checkpoint = buildCheckpoint({
      id: 'chk-handoff',
      phase: 'handoff',
      title: 'Handoff checkpoint',
      goal: 'Preserve the current state',
      summary: 'This checkpoint is ready to be transferred.',
      keyFindings: ['The task state is coherent'],
      unresolvedQuestions: ['Confirm who owns the next step'],
      nextSteps: ['Handoff to the next agent', 'Keep the unresolved question visible'],
    });
    await saveCheckpoint(projectRoot, checkpoint);

    const response = await handleSuggestPhaseBoundary({
      repo_path: projectRoot,
      current_phase: 'handoff',
      checkpoint_id: checkpoint.id,
      retrieval_signal: {
        codeBlocks: 1,
        memoryBlocks: 1,
        decisionBlocks: 1,
        nextInspectionSuggestions: 0,
        confidence: 'high',
        mode: 'expanded',
      },
      assembly_signal: {
        profile: 'handoff',
        source: 'profile',
        budgetUsed: 3,
        budgetLimit: 6,
        scopeCascadeApplied: false,
      },
      format: 'json',
    });

    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.currentPhase, 'handoff');
    assert.equal(payload.recommendedPhase, 'handoff');
    assert.equal(payload.transition, 'stay');
    assert.equal(payload.shouldTransition, false);
    assert.ok(payload.reasons.some((reason: string) => reason.includes('handoff')));
    assert.ok(payload.blockers.some((blocker: string) => blocker.includes('Confirm who owns the next step')));
  });
});

test('suggest_phase_boundary schema normalizes markdown alias to text', () => {
  const parsed = suggestPhaseBoundarySchema.parse({
    repo_path: '/tmp/project',
    current_phase: 'overview',
    format: 'markdown',
  });

  assert.equal(parsed.format, 'text');
});

test('suggest_phase_boundary schema rejects research as an assembly profile', () => {
  assert.throws(() =>
    suggestPhaseBoundarySchema.parse({
      repo_path: '/tmp/project',
      current_phase: 'overview',
      assembly_signal: {
        profile: 'research',
      },
    }),
  );
});
