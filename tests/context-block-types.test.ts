import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  BlockFirstPayload,
  CheckpointCandidate,
  ContextBlock,
  TaskCheckpoint,
} from '../src/memory/types.ts';

test('context lifecycle types support block-first retrieval payloads and checkpoint candidates', () => {
  const codeBlock = {
    id: 'code:src/search/SearchService.ts:L1-L12',
    type: 'code-evidence',
    title: 'src/search/SearchService.ts',
    purpose: 'Provide directly relevant code evidence for the current query',
    content: 'export class SearchService {}',
    priority: 'high',
    pinned: true,
    expandable: true,
    budgetChars: 128,
    memoryKind: 'semantic',
    provenance: [{ source: 'code', ref: 'src/search/SearchService.ts:L1-L12' }],
    freshness: {
      lastVerifiedAt: '2026-04-07T10:00:00.000Z',
      stale: false,
      confidence: 'high',
    },
    score: 0.98,
    rank: 1,
    summary: 'SearchService orchestrates retrieval',
    references: [{ blockId: 'memory:SearchService', source: 'feature-memory', ref: 'SearchService' }],
    relatedBlockIds: ['memory:SearchService'],
    links: [
      {
        blockId: 'code:src/search/SearchService.ts:L1-L12',
        relation: 'supports',
        targetBlockId: 'memory:SearchService',
        reason: 'same module',
      },
    ],
  } satisfies ContextBlock;

  const checkpointCandidate = {
    id: 'checkpoint:trace-retrieval-flow',
    repoPath: '/tmp/repo',
    title: 'Trace retrieval flow',
    goal: 'Trace retrieval flow',
    phase: 'overview',
    summary: 'SearchService orchestrates retrieval',
    activeBlockIds: [codeBlock.id],
    exploredRefs: ['src/search/SearchService.ts:L1-L12'],
    keyFindings: ['SearchService orchestrates retrieval'],
    unresolvedQuestions: ['Should this be split further?'],
    nextSteps: ['Inspect GraphExpander'],
    createdAt: '2026-04-07T10:00:00.000Z',
    updatedAt: '2026-04-07T10:00:00.000Z',
    source: 'retrieval',
    confidence: 'high',
    reason: 'Generated from retrieval context blocks',
  } satisfies CheckpointCandidate;

  const payload = {
    schemaVersion: 1,
    contextBlocks: [codeBlock],
    references: [{ blockId: codeBlock.id, source: 'code', ref: 'src/search/SearchService.ts:L1-L12' }],
    checkpointCandidate,
    nextInspectionSuggestions: ['Inspect GraphExpander'],
  } satisfies BlockFirstPayload;

  const taskCheckpoint: TaskCheckpoint = checkpointCandidate;

  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.contextBlocks[0]?.type, 'code-evidence');
  assert.equal(payload.references[0]?.source, 'code');
  assert.equal(payload.checkpointCandidate.phase, 'overview');
  assert.equal(taskCheckpoint.id, 'checkpoint:trace-retrieval-flow');
});
