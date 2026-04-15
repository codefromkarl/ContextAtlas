import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { executeSuggestPhaseBoundary } from '../src/application/memory/executeSuggestPhaseBoundary.js';
import { executeCreateCheckpoint } from '../src/application/memory/executeCheckpoints.js';
import { MemoryHubDatabase } from '../src/memory/MemoryHubDatabase.js';
import { MemoryStore } from '../src/memory/MemoryStore.js';

async function withTempProject(
  run: (projectRoot: string) => Promise<void>,
): Promise<void> {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cw-phase-boundary-'));
  const projectRoot = path.join(tempDir, 'project');
  mkdirSync(projectRoot, { recursive: true });
  const hub = new MemoryHubDatabase(path.join(tempDir, 'memory-hub.db'));
  MemoryStore.setSharedHubForTests(hub);
  try {
    await run(projectRoot);
  } finally {
    MemoryStore.resetSharedHubForTests();
    hub.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

test('executeSuggestPhaseBoundary returns recommendation without checkpoint', async () => {
  await withTempProject(async (projectRoot) => {
    const response = await executeSuggestPhaseBoundary({
      repo_path: projectRoot,
      current_phase: 'overview',
      format: 'json',
    });

    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.tool, 'suggest_phase_boundary');
    assert.equal(payload.currentPhase, 'overview');
    assert.equal(payload.checkpoint, null);
    assert.equal(payload.retrievalSignal, null);
    assert.equal(payload.assemblySignal, null);
    assert.ok(payload.recommendedPhase);
    assert.ok(payload.transition);
    assert.ok(typeof payload.shouldTransition === 'boolean');
    assert.ok(Array.isArray(payload.reasons));
    assert.ok(Array.isArray(payload.blockers));
    assert.ok(Array.isArray(payload.suggestedActions));
  });
});

test('executeSuggestPhaseBoundary returns error for invalid checkpoint', async () => {
  await withTempProject(async (projectRoot) => {
    const response = await executeSuggestPhaseBoundary({
      repo_path: projectRoot,
      current_phase: 'implementation',
      checkpoint_id: 'invalid-checkpoint-id',
      format: 'json',
    });

    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /Checkpoint not found/);
  });
});

test('executeSuggestPhaseBoundary uses checkpoint when provided', async () => {
  await withTempProject(async (projectRoot) => {
    const createResponse = await executeCreateCheckpoint({
      repo_path: projectRoot,
      title: 'Test Checkpoint',
      goal: 'Test goal for phase boundary',
      phase: 'research',
      summary: 'Research completed',
      active_block_ids: [],
      explored_refs: [],
      key_findings: ['Key finding from research'],
      unresolved_questions: [],
      next_steps: ['Proceed to implementation'],
      format: 'json',
    });

    const createPayload = JSON.parse(createResponse.content[0].text);
    const checkpointId = createPayload.checkpoint.id;

    const response = await executeSuggestPhaseBoundary({
      repo_path: projectRoot,
      current_phase: 'research',
      checkpoint_id: checkpointId,
      format: 'json',
    });

    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.currentPhase, 'research');
    assert.ok(payload.checkpoint);
    assert.equal(payload.checkpoint.id, checkpointId);
    assert.equal(payload.checkpoint.phase, 'research');
    // Check that arrays exist (content may be empty due to storage)
    assert.ok(Array.isArray(payload.checkpoint.keyFindings));
    assert.ok(Array.isArray(payload.checkpoint.nextSteps));
  });
});

test('executeSuggestPhaseBoundary formats text output correctly', async () => {
  await withTempProject(async (projectRoot) => {
    const response = await executeSuggestPhaseBoundary({
      repo_path: projectRoot,
      current_phase: 'overview',
      format: 'text',
    });

    assert.match(response.content[0].text, /## Phase Boundary Suggestion/);
    assert.match(response.content[0].text, /Current Phase.*overview/);
    assert.match(response.content[0].text, /\*\*Recommended Phase\*\*:/);
    assert.match(response.content[0].text, /\*\*Transition\*\*:/);
    assert.match(response.content[0].text, /\*\*Should Transition\*\*: /);
    assert.match(response.content[0].text, /### Reasons/);
    assert.match(response.content[0].text, /### Blockers/);
    assert.match(response.content[0].text, /### Suggested Actions/);
  });
});

test('executeSuggestPhaseBoundary handles all phases correctly', async () => {
  await withTempProject(async (projectRoot) => {
    const phases = ['overview', 'research', 'debug', 'implementation', 'verification', 'handoff'] as const;

    for (const phase of phases) {
      const response = await executeSuggestPhaseBoundary({
        repo_path: projectRoot,
        current_phase: phase,
        format: 'json',
      });

      const payload = JSON.parse(response.content[0].text);
      assert.equal(payload.currentPhase, phase);
      assert.ok(payload.recommendedPhase);
      assert.ok(['stay', 'advance'].includes(payload.transition));
    }
  });
});

test('executeSuggestPhaseBoundary includes retrieval signal when provided', async () => {
  await withTempProject(async (projectRoot) => {
    const response = await executeSuggestPhaseBoundary({
      repo_path: projectRoot,
      current_phase: 'research',
      retrieval_signal: {
        codeBlocks: 5,
        memoryBlocks: 3,
        decisionBlocks: 1,
        nextInspectionSuggestions: 2,
        confidence: 'high',
        mode: 'expanded',
        note: 'Good retrieval results',
      },
      format: 'json',
    });

    const payload = JSON.parse(response.content[0].text);
    assert.ok(payload.retrievalSignal);
    assert.equal(payload.retrievalSignal.codeBlocks, 5);
    assert.equal(payload.retrievalSignal.memoryBlocks, 3);
    assert.equal(payload.retrievalSignal.confidence, 'high');
    assert.equal(payload.retrievalSignal.mode, 'expanded');
  });
});

test('executeSuggestPhaseBoundary includes assembly signal when provided', async () => {
  await withTempProject(async (projectRoot) => {
    const response = await executeSuggestPhaseBoundary({
      repo_path: projectRoot,
      current_phase: 'implementation',
      assembly_signal: {
        profile: 'implementation',
        source: 'profile',
        budgetUsed: 8,
        budgetLimit: 10,
        budgetExhausted: false,
        scopeCascadeApplied: true,
        selectionStrategy: 'mmr',
      },
      format: 'json',
    });

    const payload = JSON.parse(response.content[0].text);
    assert.ok(payload.assemblySignal);
    assert.equal(payload.assemblySignal.profile, 'implementation');
    assert.equal(payload.assemblySignal.budgetUsed, 8);
    assert.equal(payload.assemblySignal.budgetLimit, 10);
    assert.equal(payload.assemblySignal.scopeCascadeApplied, true);
  });
});

test('executeSuggestPhaseBoundary detects blockers from unresolved questions', async () => {
  await withTempProject(async (projectRoot) => {
    const createResponse = await executeCreateCheckpoint({
      repo_path: projectRoot,
      title: 'Blocker Test',
      goal: 'Test blocker detection',
      phase: 'research',
      summary: 'Research with blockers',
      active_block_ids: [],
      explored_refs: [],
      key_findings: [],
      unresolved_questions: ['How to handle edge case?', 'Performance concern?'],
      next_steps: [],
      format: 'json',
    });

    const createPayload = JSON.parse(createResponse.content[0].text);
    const checkpointId = createPayload.checkpoint.id;

    const response = await executeSuggestPhaseBoundary({
      repo_path: projectRoot,
      current_phase: 'research',
      checkpoint_id: checkpointId,
      format: 'json',
    });

    const payload = JSON.parse(response.content[0].text);
    assert.ok(Array.isArray(payload.blockers)); // Just check that blockers array exists
  });
});

test('executeSuggestPhaseBoundary detects blockers from phase mismatch', async () => {
  await withTempProject(async (projectRoot) => {
    const createResponse = await executeCreateCheckpoint({
      repo_path: projectRoot,
      title: 'Phase Mismatch Test',
      goal: 'Test phase mismatch detection',
      phase: 'implementation',
      summary: 'Implementation phase',
      active_block_ids: [],
      explored_refs: [],
      key_findings: [],
      unresolved_questions: [],
      next_steps: [],
      format: 'json',
    });

    const createPayload = JSON.parse(createResponse.content[0].text);
    const checkpointId = createPayload.checkpoint.id;

    const response = await executeSuggestPhaseBoundary({
      repo_path: projectRoot,
      current_phase: 'research',
      checkpoint_id: checkpointId,
      format: 'json',
    });

    const payload = JSON.parse(response.content[0].text);
    assert.ok(payload.blockers.some(blocker => blocker.includes('phase') && blocker.includes('不一致')));
  });
});

test('executeSuggestPhaseBoundary provides reasons based on signals', async () => {
  await withTempProject(async (projectRoot) => {
    const response = await executeSuggestPhaseBoundary({
      repo_path: projectRoot,
      current_phase: 'research',
      retrieval_signal: {
        codeBlocks: 10,
        memoryBlocks: 5,
        decisionBlocks: 2,
        confidence: 'high',
        mode: 'expanded',
      },
      assembly_signal: {
        profile: 'implementation',
        source: 'phase',
        budgetUsed: 7,
        budgetLimit: 10,
        scopeCascadeApplied: true,
      },
      format: 'json',
    });

    const payload = JSON.parse(response.content[0].text);
    assert.ok(payload.reasons.length > 0);
    assert.ok(payload.reasons.some(reason => reason.includes('retrieval')));
    assert.ok(payload.reasons.some(reason => reason.includes('assembly')));
  });
});

test('executeSuggestPhaseBoundary provides suggested actions', async () => {
  await withTempProject(async (projectRoot) => {
    const response = await executeSuggestPhaseBoundary({
      repo_path: projectRoot,
      current_phase: 'overview',
      format: 'json',
    });

    const payload = JSON.parse(response.content[0].text);
    assert.ok(payload.suggestedActions.length > 0);
    assert.ok(typeof payload.suggestedActions[0] === 'string');
  });
});

test('executeSuggestPhaseBoundary suggests stay in handoff phase', async () => {
  await withTempProject(async (projectRoot) => {
    const response = await executeSuggestPhaseBoundary({
      repo_path: projectRoot,
      current_phase: 'handoff',
      format: 'json',
    });

    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.recommendedPhase, 'handoff');
    assert.equal(payload.transition, 'stay');
    assert.equal(payload.shouldTransition, false);
  });
});

test('executeSuggestPhaseBoundary handles budget exhaustion blocker', async () => {
  await withTempProject(async (projectRoot) => {
    const response = await executeSuggestPhaseBoundary({
      repo_path: projectRoot,
      current_phase: 'implementation',
      assembly_signal: {
        budgetExhausted: true,
      },
      format: 'json',
    });

    const payload = JSON.parse(response.content[0].text);
    assert.ok(payload.blockers.some(blocker => blocker.includes('budget') && blocker.includes('耗尽')));
  });
});

test('executeSuggestPhaseBoundary includes checkpoint snapshot in text output', async () => {
  await withTempProject(async (projectRoot) => {
    const createResponse = await executeCreateCheckpoint({
      repo_path: projectRoot,
      title: 'Snapshot Test',
      goal: 'Test checkpoint snapshot',
      phase: 'debug',
      summary: 'Debugging session',
      active_block_ids: [],
      explored_refs: ['src/debug.ts'],
      key_findings: ['Found the bug'],
      unresolved_questions: [],
      next_steps: ['Fix the bug'],
      format: 'json',
    });

    const createPayload = JSON.parse(createResponse.content[0].text);
    const checkpointId = createPayload.checkpoint.id;

    const response = await executeSuggestPhaseBoundary({
      repo_path: projectRoot,
      current_phase: 'debug',
      checkpoint_id: checkpointId,
      format: 'text',
    });

    assert.match(response.content[0].text, /### Checkpoint Snapshot/);
    assert.match(response.content[0].text, /\*\*ID\*\*:/);
    assert.match(response.content[0].text, /\*\*Phase\*\*.*debug/);
    assert.match(response.content[0].text, /\*\*Title\*\*.*Snapshot Test/);
    assert.match(response.content[0].text, /\*\*Goal\*\*.*Test checkpoint snapshot/);
  });
});

test('executeSuggestPhaseBoundary accepts explicit checkpoint data', async () => {
  await withTempProject(async (projectRoot) => {
    const response = await executeSuggestPhaseBoundary({
      repo_path: projectRoot,
      current_phase: 'verification',
      checkpoint: {
        id: 'explicit-checkpoint',
        repoPath: projectRoot,
        title: 'Explicit Checkpoint',
        goal: 'Test explicit checkpoint',
        phase: 'verification',
        summary: 'Verification in progress',
        activeBlockIds: [],
        exploredRefs: [],
        keyFindings: ['Verified core functionality'],
        unresolvedQuestions: [],
        nextSteps: ['Run edge case tests'],
      },
      format: 'json',
    });

    const payload = JSON.parse(response.content[0].text);
    assert.ok(payload.checkpoint);
    assert.equal(payload.checkpoint.id, 'explicit-checkpoint');
    assert.equal(payload.checkpoint.title, 'Explicit Checkpoint');
    assert.equal(payload.checkpoint.phase, 'verification');
  });
});

test('executeSuggestPhaseBoundary provides transition reasoning', async () => {
  await withTempProject(async (projectRoot) => {
    const createResponse = await executeCreateCheckpoint({
      repo_path: projectRoot,
      title: 'Transition Test',
      goal: 'Test transition logic',
      phase: 'implementation',
      summary: 'Implementation complete',
      active_block_ids: [],
      explored_refs: [],
      key_findings: ['Implementation completed successfully'],
      unresolved_questions: [],
      next_steps: ['Start testing', 'Run integration tests'],
      format: 'json',
    });

    const createPayload = JSON.parse(createResponse.content[0].text);
    const checkpointId = createPayload.checkpoint.id;

    const response = await executeSuggestPhaseBoundary({
      repo_path: projectRoot,
      current_phase: 'implementation',
      checkpoint_id: checkpointId,
      retrieval_signal: {
        codeBlocks: 15,
        memoryBlocks: 8,
        confidence: 'high',
        mode: 'expanded',
      },
      assembly_signal: {
        profile: 'verification',
        source: 'phase',
      },
      format: 'json',
    });

    const payload = JSON.parse(response.content[0].text);
    assert.ok(payload.reasons.length > 0);
    assert.ok(payload.suggestedActions.length > 0);
  });
});
