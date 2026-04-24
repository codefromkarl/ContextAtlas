import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { closeDb, generateProjectId, initDb } from '../src/db/index.ts';
import { scan } from '../src/scanner/index.ts';

function makeTempRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cw-skeleton-scan-'));
}

test('scan 持久化 skeleton artifacts 并在删除文件后清理', async () => {
  const rootPath = makeTempRepo();
  const sourcePath = path.join(rootPath, 'src/gateway/service.ts');
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(
    sourcePath,
    [
      "import { createServer } from './server';",
      '',
      'export class GatewayService {',
      '  boot() {',
      '    return createServer();',
      '  }',
      '}',
    ].join('\n'),
    'utf8',
  );

  const firstScan = await scan(rootPath, { vectorIndex: false });
  assert.equal(firstScan.added, 1);

  const db = initDb(generateProjectId(rootPath));
  const fileRow = db.prepare('SELECT summary FROM file_skeleton WHERE path = ?').get('src/gateway/service.ts') as { summary: string } | undefined;
  assert.ok(fileRow);
  assert.match(fileRow.summary, /GatewayService/);

  fs.rmSync(sourcePath);
  const secondScan = await scan(rootPath, { vectorIndex: false });
  assert.equal(secondScan.deleted, 1);

  const deletedRow = db.prepare('SELECT summary FROM file_skeleton WHERE path = ?').get('src/gateway/service.ts');
  assert.equal(deletedRow, undefined);

  closeDb(db);
});
