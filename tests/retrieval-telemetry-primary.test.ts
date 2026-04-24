import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRetrievalTelemetry } from '../src/application/retrieval/executeRetrieval.ts';

test('buildRetrievalTelemetry emits architecturePrimaryCount and visibleFileCount', () => {
  const telemetry = buildRetrievalTelemetry({
    requestId: 'req-primary-1',
    projectId: 'abcdef1234567890',
    query: 'cli command registration',
    totalMs: 88,
    contextPack: {
      query: 'cli command registration',
      seeds: [],
      expanded: [],
      files: [
        {
          filePath: 'src/index.ts',
          segments: [
            {
              filePath: 'src/index.ts',
              rawStart: 0,
              rawEnd: 10,
              startLine: 1,
              endLine: 1,
              score: 0.8,
              breadcrumb: 'src/index.ts',
              text: 'main() {}',
            },
          ],
        },
      ],
      architecturePrimaryFiles: ['src/cli/registerCommands.ts'],
      debug: {
        wVec: 0.4,
        wLex: 0.6,
        timingMs: {},
      },
    },
  });

  assert.equal(telemetry.architecturePrimaryCount, 1);
  assert.deepEqual(telemetry.architecturePrimaryFiles, ['src/cli/registerCommands.ts']);
  assert.equal(telemetry.visibleFileCount, 2);
});
