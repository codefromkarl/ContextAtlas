import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { handleGraphContext } from '../src/mcp/tools/codeGraph.ts';
import { scan } from '../src/scanner/index.ts';

function makeTempRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cw-mcp-graph-invocations-'));
}

test('graph_context JSON 输出包含 invocation 调用点列表', async () => {
  const rootPath = makeTempRepo();
  const sourcePath = path.join(rootPath, 'src/user/UserService.ts');
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(
    sourcePath,
    [
      "import { hashPassword } from './crypto';",
      '',
      'export class UserService {',
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

  await scan(rootPath, { vectorIndex: false, force: true });

  const response = await handleGraphContext(
    { symbol: 'updatePassword', format: 'json' },
    rootPath,
  );
  const payload = JSON.parse(response.content[0].text);

  assert.equal(payload.tool, 'graph_context');
  assert.ok(Array.isArray(payload.invocations));
  assert.ok(payload.invocations.some((invocation: { calleeName: string }) => invocation.calleeName === 'hashPassword'));
});
