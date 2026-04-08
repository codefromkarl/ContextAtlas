import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { handleCreateCheckpoint } from '../src/mcp/tools/checkpoints.ts';
import { handlePrepareHandoff } from '../src/mcp/tools/prepareHandoff.ts';
import { MemoryHubDatabase } from '../src/memory/MemoryHubDatabase.ts';
import { MemoryStore } from '../src/memory/MemoryStore.ts';

async function withTempProject(
  run: (projectRoot: string, dbPath: string) => Promise<void>,
): Promise<void> {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cw-prepare-handoff-'));
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

test('prepare_handoff packages checkpoint handoff and resume bundles', async () => {
  await withTempProject(async (projectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));
    const store = new MemoryStore(projectRoot);
    await store.saveFeature({
      name: 'SearchService',
      responsibility: 'orchestrates retrieval and packing',
      location: {
        dir: 'src/search',
        files: ['SearchService.ts'],
      },
      api: {
        exports: ['SearchService'],
        endpoints: [],
      },
      dependencies: {
        imports: ['GraphExpander'],
        external: [],
      },
      dataFlow: 'SearchService data flow',
      keyPatterns: ['searchservice', 'search'],
      evidenceRefs: ['evidence:evidence-feature'],
      lastUpdated: new Date('2026-04-07T10:00:00.000Z').toISOString(),
      confirmationStatus: 'human-confirmed',
    });
    await store.appendLongTermMemoryItem({
      id: 'handoff-ref',
      type: 'reference',
      title: 'Handoff checklist',
      summary: 'Review retrieval pipeline notes before editing',
      tags: ['handoff'],
      scope: 'project',
      source: 'user-explicit',
      confidence: 0.9,
      durability: 'stable',
      provenance: ['prepare-handoff.test'],
    });
    await store.appendLongTermMemoryItem({
      id: 'evidence-1',
      type: 'evidence',
      title: 'Index benchmark evidence',
      summary: 'Direct SiliconFlow indexing completed faster than the local gateway path.',
      tags: ['benchmark'],
      scope: 'project',
      source: 'tool-result',
      confidence: 0.95,
      durability: 'stable',
      provenance: ['prepare-handoff.test'],
    });
    await store.appendLongTermMemoryItem({
      id: 'evidence-feature',
      type: 'evidence',
      title: 'Feature evidence',
      summary: 'SearchService memory is backed by an incident review note.',
      tags: ['feature-evidence'],
      scope: 'project',
      source: 'tool-result',
      confidence: 0.9,
      durability: 'stable',
      provenance: ['prepare-handoff.test'],
    });

    const createResponse = await handleCreateCheckpoint({
      repo_path: projectRoot,
      title: 'Retrieval overview',
      goal: 'Understand retrieval path',
      phase: 'overview',
      summary: 'Captured current retrieval overview',
      activeBlockIds: [
        'memory:searchservice',
        'feature:SearchService',
        'long-term:reference:handoff-ref',
        'task:open-questions',
        'code:src/search/SearchService.ts:L1-L30',
        'block:overview',
      ],
      exploredRefs: ['src/search/SearchService.ts:L1-L30'],
      supportingRefs: ['evidence:evidence-1'],
      keyFindings: ['SearchService is the main orchestration entry'],
      unresolvedQuestions: ['How to persist handoff state?'],
      nextSteps: ['Inspect MemoryStore'],
      format: 'json',
    } as any);

    const created = JSON.parse(createResponse.content[0].text);

    const response = await handlePrepareHandoff({
      repo_path: projectRoot,
      checkpoint_id: created.checkpoint.id,
      format: 'json',
    });

    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.tool, 'prepare_handoff');
    assert.equal(payload.checkpoint.id, created.checkpoint.id);
    assert.equal(payload.contextBlocks[0].type, 'task-state');
    assert.equal(payload.contextBlocks[0].purpose, 'Preserve task state for handoff and resume');
    assert.ok(payload.contextBlocks.some((block: { type: string; id: string }) => block.type === 'module-summary' && block.id === 'memory:searchservice'));
    assert.ok(payload.contextBlocks.some((block: { type: string; id: string }) => block.type === 'module-summary' && block.id === 'feature:SearchService'));
    assert.ok(payload.contextBlocks.some((block: { type: string; id: string }) => block.type === 'repo-rules' && block.id === 'long-term:reference:handoff-ref'));
    assert.ok(payload.contextBlocks.some((block: { type: string; id: string }) => block.type === 'repo-rules' && block.id === 'long-term:evidence:evidence-1'));
    assert.ok(payload.contextBlocks.some((block: { type: string; id: string }) => block.type === 'repo-rules' && block.id === 'long-term:evidence:evidence-feature'));
    assert.ok(payload.contextBlocks.some((block: { type: string }) => block.type === 'code-evidence'));
    assert.ok(payload.contextBlocks.some((block: { type: string; id: string }) => block.type === 'open-questions' && block.id === 'task:open-questions'));
    assert.equal(payload.handoffSummary.goal, 'Understand retrieval path');
    assert.equal(payload.handoffSummary.phase, 'overview');
    assert.equal(payload.handoffSummary.unresolvedQuestionCount, 1);
    assert.equal(payload.handoffSummary.nextStepCount, 1);
    assert.equal(payload.handoffSummary.resolvedBlockCount, 10);
    assert.deepEqual(payload.handoffSummary.unresolvedBlockIds, ['block:overview']);
    assert.deepEqual(payload.handoffSummary.referencedBlockIds, [
      'memory:searchservice',
      'feature:SearchService',
      'long-term:reference:handoff-ref',
      'task:open-questions',
      'code:src/search/SearchService.ts:L1-L30',
      'block:overview',
      'evidence:evidence-1',
      `checkpoint-block:${created.checkpoint.id}`,
    ]);
    assert.deepEqual(payload.referencedBlockIds, [
      'memory:searchservice',
      'feature:SearchService',
      'long-term:reference:handoff-ref',
      'task:open-questions',
      'code:src/search/SearchService.ts:L1-L30',
      'block:overview',
      'evidence:evidence-1',
      `checkpoint-block:${created.checkpoint.id}`,
    ]);
    assert.deepEqual(payload.unresolvedBlockIds, ['block:overview']);
    assert.equal(payload.handoff.checkpointId, created.checkpoint.id);
    assert.equal(payload.handoffBundle.kind, 'handoff-bundle');
    assert.equal(payload.handoffBundle.checkpointId, created.checkpoint.id);
    assert.equal(payload.resumeBundle.kind, 'resume-bundle');
    assert.equal(payload.resumeBundle.resumeFromCheckpointId, created.checkpoint.id);
    assert.deepEqual(payload.nextSteps, ['Inspect MemoryStore']);
    assert.equal(payload.handoffBundle.nextSteps[0], 'Inspect MemoryStore');
  });
});

test('prepare_handoff returns readable text and errors when the checkpoint is missing', async () => {
  await withTempProject(async (projectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const missingResponse = await handlePrepareHandoff({
      repo_path: projectRoot,
      checkpoint_id: 'missing-checkpoint',
      format: 'text',
    });

    assert.equal(missingResponse.isError, true);
    assert.equal(missingResponse.content[0].text, 'Checkpoint not found: missing-checkpoint');

    const createResponse = await handleCreateCheckpoint({
      repo_path: projectRoot,
      title: 'Handoff text',
      goal: 'Verify text formatting',
      phase: 'handoff',
      summary: 'Text formatting checkpoint',
      activeBlockIds: ['block:text'],
      exploredRefs: ['src/mcp/tools/checkpoints.ts:L1-L40'],
      keyFindings: ['Checkpoint bundles are reusable'],
      unresolvedQuestions: [],
      nextSteps: ['Review the resume bundle'],
      format: 'json',
    });

    const created = JSON.parse(createResponse.content[0].text);

    const textResponse = await handlePrepareHandoff({
      repo_path: projectRoot,
      checkpoint_id: created.checkpoint.id,
      format: 'text',
    });

    assert.match(textResponse.content[0].text, /## Prepare Handoff/);
    assert.match(textResponse.content[0].text, /### Handoff Summary/);
    assert.match(textResponse.content[0].text, /- \*\*Referenced Blocks\*\*: block:text, checkpoint-block:/);
    assert.match(textResponse.content[0].text, /### Unresolved Questions/);
    assert.match(textResponse.content[0].text, /### Next Steps/);
    assert.match(textResponse.content[0].text, /### Active Block References/);
    assert.match(textResponse.content[0].text, /### Unresolved Block References/);
    assert.match(textResponse.content[0].text, /### Context Block/);
  });
});
