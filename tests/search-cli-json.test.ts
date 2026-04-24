import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSearchJsonPayload } from '../src/cli/commands/search.ts';

test('buildSearchJsonPayload emits script-friendly search payload', () => {
  const payload = buildSearchJsonPayload({
    repoPath: '/repo',
    informationRequest: 'trace auth flow',
    technicalTerms: ['AuthService', 'login'],
    response: {
      content: [
        {
          type: 'text',
          text: 'Found 2 relevant code blocks',
        },
      ],
    },
    data: {
      contextPack: {
        query: 'trace auth flow',
        seeds: [],
        expanded: [],
        files: [],
      },
      resultCard: {
        memories: [],
        decisions: [],
        longTermMemories: [],
        feedbackSignals: [],
        reasoning: [],
        trustRules: [],
        nextActions: [],
      },
      contextBlocks: [],
      checkpointCandidate: {
        id: 'checkpoint:1',
        repoPath: '/repo',
        title: 'trace auth flow',
        goal: 'trace auth flow',
        phase: 'overview',
        summary: 'summary',
        activeBlockIds: [],
        supportingRefs: [],
        exploredRefs: [],
        keyFindings: [],
        unresolvedQuestions: [],
        nextSteps: [],
        createdAt: '2026-04-17T00:00:00.000Z',
        updatedAt: '2026-04-17T00:00:00.000Z',
        source: 'retrieval',
        confidence: 'high',
        reason: 'test',
      },
      blockFirst: {
        schemaVersion: 1,
        contextBlocks: [],
        references: [],
        architecturePrimaryFiles: ['src/auth/AuthService.ts'],
        checkpointCandidate: {
          id: 'checkpoint:1',
          repoPath: '/repo',
          title: 'trace auth flow',
          goal: 'trace auth flow',
          phase: 'overview',
          summary: 'summary',
          activeBlockIds: [],
          supportingRefs: [],
          exploredRefs: [],
          keyFindings: [],
          unresolvedQuestions: [],
          nextSteps: [],
          createdAt: '2026-04-17T00:00:00.000Z',
          updatedAt: '2026-04-17T00:00:00.000Z',
          source: 'retrieval',
          confidence: 'high',
          reason: 'test',
        },
        nextInspectionSuggestions: [],
      },
      overview: {
        summary: { codeBlocks: 0, files: 0, totalSegments: 0 },
        topFiles: [],
        architecturePrimaryFiles: ['src/auth/AuthService.ts'],
        references: [],
        expansionCandidates: [],
        nextInspectionSuggestions: [],
      },
    },
  });

  assert.equal(payload.tool, 'codebase-retrieval');
  assert.equal(payload.repo_path, '/repo');
  assert.equal(payload.information_request, 'trace auth flow');
  assert.deepEqual(payload.technical_terms, ['AuthService', 'login']);
  assert.equal(payload.text, 'Found 2 relevant code blocks');
  assert.deepEqual(payload.content, [
    {
      type: 'text',
      text: 'Found 2 relevant code blocks',
    },
  ]);
  assert.deepEqual(payload.data?.overview.architecturePrimaryFiles, ['src/auth/AuthService.ts']);
});
