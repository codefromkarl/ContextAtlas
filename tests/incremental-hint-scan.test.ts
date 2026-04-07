import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { analyzeIndexUpdatePlan } from '../src/indexing/updateStrategy.ts';
import { scan, scanWithSnapshotSwap } from '../src/scanner/index.ts';

async function withTempRepo(
  run: (repoRoot: string, baseDir: string) => Promise<void>,
): Promise<void> {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-incremental-hint-'));
  const repoRoot = path.join(baseDir, 'repo');
  fs.mkdirSync(repoRoot, { recursive: true });
  const previousBaseDir = process.env.CONTEXTATLAS_BASE_DIR;

  process.env.CONTEXTATLAS_BASE_DIR = baseDir;
  try {
    await run(repoRoot, baseDir);
  } finally {
    if (previousBaseDir === undefined) {
      delete process.env.CONTEXTATLAS_BASE_DIR;
    } else {
      process.env.CONTEXTATLAS_BASE_DIR = previousBaseDir;
    }
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

test('scanWithSnapshotSwap can apply incremental execution hint directly', async () => {
  await withTempRepo(async (repoRoot) => {
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    const aPath = path.join(repoRoot, 'src', 'a.ts');
    const bPath = path.join(repoRoot, 'src', 'b.ts');
    fs.writeFileSync(aPath, 'export const a = 1;\n');
    fs.writeFileSync(bPath, 'export const b = 1;\n');

    await scan(repoRoot, { vectorIndex: false });

    fs.writeFileSync(aPath, 'export const a = 2;\n');
    fs.rmSync(bPath);

    const plan = await analyzeIndexUpdatePlan(repoRoot);
    assert.equal(plan.mode, 'incremental');
    assert.ok(plan.executionHint);

    const stats = await scanWithSnapshotSwap(repoRoot, {
      vectorIndex: false,
      incrementalHint: plan.executionHint,
    });

    assert.equal(stats.modified, 1);
    assert.equal(stats.deleted, 1);
    assert.equal(stats.added, 0);

    const verify = await analyzeIndexUpdatePlan(repoRoot);
    assert.equal(verify.changeSummary.added, 0);
    assert.equal(verify.changeSummary.modified, 0);
    assert.equal(verify.changeSummary.deleted, 0);
  });
});

test('scanWithSnapshotSwap falls back when incremental execution hint drifts', async () => {
  await withTempRepo(async (repoRoot) => {
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    const aPath = path.join(repoRoot, 'src', 'a.ts');
    const bPath = path.join(repoRoot, 'src', 'b.ts');
    fs.writeFileSync(aPath, 'export const a = 1;\n');
    fs.writeFileSync(bPath, 'export const b = 1;\n');

    await scan(repoRoot, { vectorIndex: false });

    fs.writeFileSync(aPath, 'export const a = 2;\n');
    const plan = await analyzeIndexUpdatePlan(repoRoot);
    assert.equal(plan.mode, 'incremental');
    assert.ok(plan.executionHint);

    // 扰动提示依赖的文件状态，迫使执行阶段放弃复用并回退到常规扫描
    fs.writeFileSync(aPath, 'export const a = 200;\n');
    fs.writeFileSync(bPath, 'export const b = 200;\n');

    const stats = await scanWithSnapshotSwap(repoRoot, {
      vectorIndex: false,
      incrementalHint: plan.executionHint,
    });

    assert.equal(stats.modified, 2);

    const verify = await analyzeIndexUpdatePlan(repoRoot);
    assert.equal(verify.changeSummary.added, 0);
    assert.equal(verify.changeSummary.modified, 0);
    assert.equal(verify.changeSummary.deleted, 0);
  });
});
