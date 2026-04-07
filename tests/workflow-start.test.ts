import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { generateProjectId, initDb } from '../src/db/index.js';
import { enqueueIndexTask } from '../src/indexing/queue.js';
import { buildStartGuide, shouldRunDefaultStart } from '../src/workflow/start.js';

function createTempBaseDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cw-workflow-start-test-'));
}

test('buildStartGuide shows ready workflow when index exists', async () => {
  const baseDir = createTempBaseDir();
  const repoDir = path.join(baseDir, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });

  const previousBaseDir = process.env.CONTEXTATLAS_BASE_DIR;
  process.env.CONTEXTATLAS_BASE_DIR = baseDir;

  try {
    const projectId = generateProjectId(repoDir);
    const db = initDb(projectId);
    db.close();

    const guide = await buildStartGuide(repoDir);

    assert.match(guide, /Connect Repo/);
    assert.match(guide, /Index Status: Ready/);
    assert.match(guide, /contextatlas health:check --project-id/);
    assert.match(guide, /contextatlas search --repo-path/);
    assert.match(guide, /### Quick Actions/);
    assert.match(guide, /contextatlas feedback:record --outcome helpful/);
    assert.match(guide, /contextatlas decision:record/);
    assert.match(guide, /contextatlas memory:record-long-term --type reference/);
    assert.match(guide, /contextatlas memory:record/);
  } finally {
    if (previousBaseDir === undefined) {
      delete process.env.CONTEXTATLAS_BASE_DIR;
    } else {
      process.env.CONTEXTATLAS_BASE_DIR = previousBaseDir;
    }
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('buildStartGuide shows first-run workflow when no index or active task exists', async () => {
  const baseDir = createTempBaseDir();
  const repoDir = path.join(baseDir, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });

  const previousBaseDir = process.env.CONTEXTATLAS_BASE_DIR;
  process.env.CONTEXTATLAS_BASE_DIR = baseDir;

  try {
    const guide = await buildStartGuide(repoDir);

    assert.match(guide, /Index Status: Not Indexed/);
    assert.match(guide, /Partial lexical answers are available before first indexing/);
    assert.match(guide, /contextatlas index/);
    assert.match(guide, /contextatlas search --repo-path/);
  } finally {
    if (previousBaseDir === undefined) {
      delete process.env.CONTEXTATLAS_BASE_DIR;
    } else {
      process.env.CONTEXTATLAS_BASE_DIR = previousBaseDir;
    }
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('buildStartGuide shows indexing workflow when task is queued and no index exists', async () => {
  const baseDir = createTempBaseDir();
  const repoDir = path.join(baseDir, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });

  const previousBaseDir = process.env.CONTEXTATLAS_BASE_DIR;
  process.env.CONTEXTATLAS_BASE_DIR = baseDir;

  try {
    const projectId = generateProjectId(repoDir);
    enqueueIndexTask({
      projectId,
      repoPath: repoDir,
      scope: 'full',
      reason: 'test-start-guide',
      requestedBy: 'test',
    });

    const guide = await buildStartGuide(repoDir);

    assert.match(guide, /Index Status: Indexing/);
    assert.match(guide, /Partial lexical answers are available/);
    assert.match(guide, /contextatlas daemon start/);
    assert.match(guide, /contextatlas task:status --project-id/);
    assert.match(guide, /contextatlas task:inspect/);
    assert.match(guide, /contextatlas search --repo-path/);
    assert.match(guide, /### Result Card Promise/);
    assert.match(guide, /完整模式会在索引完成后自动可用/);
  } finally {
    if (previousBaseDir === undefined) {
      delete process.env.CONTEXTATLAS_BASE_DIR;
    } else {
      process.env.CONTEXTATLAS_BASE_DIR = previousBaseDir;
    }
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('shouldRunDefaultStart only enables the default guide for interactive no-arg CLI', () => {
  assert.equal(shouldRunDefaultStart([], false), true);
  assert.equal(shouldRunDefaultStart([], true), false);
  assert.equal(shouldRunDefaultStart(['search'], false), false);
  assert.equal(shouldRunDefaultStart(['--help'], false), false);
});
