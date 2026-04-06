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
});
