import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { handleDetectChanges } from '../src/mcp/tools/codeGraph.ts';
import { scan } from '../src/scanner/index.ts';

function makeTempRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cw-mcp-detect-changes-'));
}

function runGit(repoRoot: string, args: string[]): void {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
  }
}

test('detect_changes MCP tool reports changed symbols and risk summary', async () => {
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
    runGit(rootPath, ['init']);
    runGit(rootPath, ['config', 'user.name', 'Codex']);
    runGit(rootPath, ['config', 'user.email', 'codex@example.com']);
    runGit(rootPath, ['add', '.']);
    runGit(rootPath, ['commit', '-m', 'baseline']);

    await scan(rootPath, { vectorIndex: false });

    fs.writeFileSync(
      sourcePath,
      [
        'export class UserService {',
        '  updatePassword(input: string) {',
        '    return hashLocal(input).toUpperCase();',
        '  }',
        '}',
        '',
        'function hashLocal(value: string) {',
        '  return value.trim();',
        '}',
      ].join('\n'),
    );
    runGit(rootPath, ['add', sourcePath]);

    const response = await handleDetectChanges({ scope: 'staged', format: 'json' }, rootPath);
    const payload = JSON.parse(response.content[0]?.text ?? '{}');
    assert.equal(payload.tool, 'detect_changes');
    assert.equal(payload.scope, 'staged');
    assert.ok(payload.changed_files.includes('src/user/UserService.ts'));
    assert.ok(payload.matches[0].symbols.some((entry: { symbol: { name: string } }) => entry.symbol.name === 'updatePassword'));
    assert.equal(typeof payload.risk_summary.level, 'string');
  } finally {
    fs.rmSync(rootPath, { recursive: true, force: true });
  }
});
