import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { handleGraphContext, handleGraphImpact } from '../src/mcp/tools/codeGraph.ts';
import { scan } from '../src/scanner/index.ts';

function makeTempRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cw-mcp-graph-'));
}

test('graph MCP tools return context and impact for indexed symbols', async () => {
  const rootPath = makeTempRepo();
  const sourcePath = path.join(rootPath, 'src/user/UserService.ts');
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(
    sourcePath,
    [
      "import { hashPassword } from './crypto';",
      '',
      'export class UserService extends BaseService {',
      '  updatePassword(input: string) {',
      '    return hashLocal(hashPassword(input));',
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

    const context = await handleGraphContext({ symbol: 'UserService', format: 'text' }, rootPath);
    const contextText = context.content[0]?.text ?? '';
    assert.match(contextText, /Symbol: UserService/);
    assert.match(contextText, /Downstream:/);
    assert.match(contextText, /IMPORTS -> hashPassword \(unresolved\)/);

    const impact = await handleGraphImpact(
      { symbol: 'UserService', direction: 'downstream', max_depth: 2, format: 'json' },
      rootPath,
    );
    const payload = JSON.parse(impact.content[0]?.text ?? '{}');
    assert.equal(payload.tool, 'graph_impact');
    assert.equal(payload.symbol.name, 'UserService');
    assert.ok(payload.direct_relations.some((relation: { relationType: string }) => relation.relationType === 'IMPORTS'));
    assert.ok(payload.resolved_impact.some((entry: { symbol: { name: string } }) => entry.symbol.name === 'updatePassword'));
  } finally {
    fs.rmSync(rootPath, { recursive: true, force: true });
  }
});
