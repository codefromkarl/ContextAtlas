import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

async function loadScanFromDist() {
  const distDir = path.resolve(process.cwd(), 'dist');
  const scannerBundle = fs
    .readdirSync(distDir)
    .find((fileName) => /^scanner-.*\.js$/.test(fileName));

  if (!scannerBundle) {
    throw new Error('未找到 dist/scanner-*.js，请先执行 pnpm build');
  }

  const mod = await import(pathToFileURL(path.join(distDir, scannerBundle)).href);
  return mod.scan;
}

test('scan 在子目录出现 EACCES 时应跳过并继续扫描', async (t) => {
  const scan = await loadScanFromDist();

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-crawler-'));
  const okDir = path.join(root, 'ok');
  const blockedDir = path.join(root, 'blocked');

  fs.mkdirSync(okDir, { recursive: true });
  fs.mkdirSync(blockedDir, { recursive: true });
  fs.writeFileSync(path.join(okDir, 'keep.ts'), 'export const keep = 1;');
  fs.writeFileSync(path.join(blockedDir, 'skip.ts'), 'export const skip = 1;');

  fs.chmodSync(blockedDir, 0o000);

  t.after(() => {
    try {
      fs.chmodSync(blockedDir, 0o755);
    } catch {
      // ignore cleanup error
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const stats = await scan(root, { vectorIndex: false });

  assert.equal(stats.totalFiles, 1);
  assert.equal(stats.errors, 0);
});

test('scan 在根路径不是目录时应抛错', async (t) => {
  const scan = await loadScanFromDist();

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-crawler-root-'));
  const filePath = path.join(root, 'not-a-directory.ts');
  fs.writeFileSync(filePath, 'export const value = 1;');

  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  await assert.rejects(() => scan(filePath, { vectorIndex: false }), /Root path is not a directory/);
});
