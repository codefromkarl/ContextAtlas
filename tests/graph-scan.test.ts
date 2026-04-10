import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { closeDb, generateProjectId, initDb } from '../src/db/index.ts';
import { GraphStore } from '../src/graph/GraphStore.ts';
import { scan } from '../src/scanner/index.ts';

function makeTempRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cw-graph-scan-'));
}

test('scan persists graph symbols and clears them after file deletion', async () => {
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
    const firstScan = await scan(rootPath, { vectorIndex: false });
    assert.equal(firstScan.errors, 0);

    const db = initDb(generateProjectId(rootPath));
    try {
      const store = new GraphStore(db);
      const userService = store.findSymbolsByName('UserService')[0];
      assert.ok(userService);

      const impact = store.getImpact(userService!.id, { direction: 'downstream', maxDepth: 2 });
      assert.ok(impact.some((entry) => entry.symbol.name === 'updatePassword'));
      assert.ok(impact.some((entry) => entry.symbol.name === 'hashLocal'));
    } finally {
      closeDb(db);
    }

    fs.rmSync(sourcePath, { force: true });
    const secondScan = await scan(rootPath, { vectorIndex: false });
    assert.equal(secondScan.errors, 0);

    const dbAfterDelete = initDb(generateProjectId(rootPath));
    try {
      const store = new GraphStore(dbAfterDelete);
      assert.equal(store.findSymbolsByName('UserService').length, 0);
    } finally {
      closeDb(dbAfterDelete);
    }
  } finally {
    fs.rmSync(rootPath, { recursive: true, force: true });
  }
});
