import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { handleGraphQuery } from '../src/mcp/tools/codeGraph.ts';
import { scan } from '../src/scanner/index.ts';

function makeTempRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cw-mcp-graph-query-'));
}

test('graph_query MCP tool returns traced paths for indexed symbols', async () => {
  const rootPath = makeTempRepo();
  const sourcePath = path.join(rootPath, 'src/user/UserService.ts');
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(
    sourcePath,
    [
      'export class UserService {',
      '  updatePassword(input: string) {',
      '    return hashLocal(input);',
      '  }',
      '}',
      '',
      'function hashLocal(value: string) {',
      '  return value.trim();',
      '}',
    ].join('\n'),
  );

  try {
    await scan(rootPath, { vectorIndex: false });

    const response = await handleGraphQuery(
      { symbol: 'UserService', direction: 'downstream', max_depth: 3, format: 'json' },
      rootPath,
    );
    const payload = JSON.parse(response.content[0]?.text ?? '{}');
    assert.equal(payload.tool, 'graph_query');
    assert.equal(payload.entry.name, 'UserService');
    assert.ok(payload.paths.length >= 1);
    assert.deepEqual(
      payload.paths[0].symbols.map((symbol: { name: string }) => symbol.name),
      ['UserService', 'updatePassword', 'hashLocal'],
    );
  } finally {
    fs.rmSync(rootPath, { recursive: true, force: true });
  }
});
