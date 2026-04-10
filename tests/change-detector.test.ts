import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ChangeDetector } from '../src/graph/ChangeDetector.ts';
import { scan } from '../src/scanner/index.ts';

function makeTempRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cw-change-detector-'));
}

function runGit(repoRoot: string, args: string[]): string {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
  }
  return result.stdout.trim();
}

test('ChangeDetector maps staged diff hunks back to indexed symbols', async () => {
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

    const result = new ChangeDetector(rootPath).detect('staged');
    assert.deepEqual(result.deletedFiles, []);
    assert.ok(result.changedFiles.includes('src/user/UserService.ts'));

    const match = result.matches.find((item) => item.filePath === 'src/user/UserService.ts');
    assert.ok(match);
    assert.ok(match!.changedLines.includes(3));
    assert.ok(match!.symbols.some((symbol) => symbol.name === 'updatePassword'));
  } finally {
    fs.rmSync(rootPath, { recursive: true, force: true });
  }
});
