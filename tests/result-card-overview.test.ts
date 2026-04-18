import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOverviewData } from '../src/application/retrieval/resultCard.js';

test('buildOverviewData promotes query-relevant import candidates into architecturePrimaryFiles', () => {
  const overview = buildOverviewData(
    {
      query: 'Locate the actual CLI entrypoint, command registration, MCP server startup path',
      seeds: [],
      expanded: [],
      files: [
        {
          filePath: 'src/cli/commands/bootstrap.ts',
          segments: [
            {
              filePath: 'src/cli/commands/bootstrap.ts',
              rawStart: 0,
              rawEnd: 1,
              startLine: 1,
              endLine: 1,
              score: 0.9,
              breadcrumb: 'bootstrap',
              text: 'bootstrap',
            },
          ],
        },
      ],
      architecturePrimaryFiles: [
        'src/cli/commands/opsAlerts.ts',
        'src/cli/commands/opsWorkbench.ts',
        'src/cli/commands/profile.ts',
      ],
      expansionCandidates: [
        {
          filePath: 'src/cli/registerCommands.ts',
          reason: 'expanded via import',
          priority: 'high',
        },
      ],
    } as any,
    { nextActions: [] } as any,
    [],
  );

  assert.equal(overview.architecturePrimaryFiles[0], 'src/cli/registerCommands.ts');
  assert.ok(!overview.expansionCandidates.some((item) => item.filePath === 'src/cli/registerCommands.ts'));
});
