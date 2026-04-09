import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { defaultConfig, evaluateAlerts, formatAlertReport } from '../src/monitoring/alertEngine.ts';
import { MemoryHubDatabase } from '../src/memory/MemoryHubDatabase.ts';
import { MemoryStore } from '../src/memory/MemoryStore.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeBaseDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cw-alert-eval-'));
}

function buildFeature(name: string): Parameters<MemoryStore['saveFeature']>[0] {
  return {
    name,
    responsibility: `${name} responsibility`,
    location: {
      dir: 'src/search',
      files: [`${name}.ts`],
    },
    api: {
      exports: [name],
      endpoints: [],
    },
    dependencies: {
      imports: [],
      external: [],
    },
    dataFlow: `${name} data flow`,
    keyPatterns: [name.toLowerCase()],
    lastUpdated: new Date('2026-04-09T10:00:00.000Z').toISOString(),
    confirmationStatus: 'human-confirmed',
  };
}

test('evaluateAlerts triggers memory-catalog-inconsistent when catalog is inconsistent', () => {
  const result = evaluateAlerts(
    {
      memory: {
        staleRate: 0,
        expiredRate: 0,
        orphanedRate: 0,
        catalogInconsistent: true,
      },
    },
    defaultConfig(),
  );

  const alert = result.triggered.find((item) => item.ruleId === 'memory-catalog-inconsistent');
  assert.ok(alert);
  assert.equal(alert.metric, 'memory.catalogInconsistent');
  assert.equal(alert.value, 1);
  assert.match(formatAlertReport(result), /记忆目录不一致/);
});

test('evaluateAlerts triggers memory-orphaned-features when orphaned rate exceeds threshold', () => {
  const result = evaluateAlerts(
    {
      memory: {
        staleRate: 0,
        expiredRate: 0,
        orphanedRate: 0.35,
        catalogInconsistent: false,
      },
    },
    defaultConfig(),
  );

  const alert = result.triggered.find((item) => item.ruleId === 'memory-orphaned-features');
  assert.ok(alert);
  assert.equal(alert.metric, 'memory.orphanedRate');
  assert.equal(alert.value, 0.35);
});

test('alert:eval CLI 输出稳定 JSON 结构', () => {
  const baseDir = makeBaseDir();
  const previousBaseDir = process.env.CONTEXTATLAS_BASE_DIR;
  process.env.CONTEXTATLAS_BASE_DIR = baseDir;

  try {
    const result = spawnSync(
      'node',
      ['--import', 'tsx', 'src/index.ts', 'alert:eval', '--json'],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          CONTEXTATLAS_BASE_DIR: baseDir,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.ok(Array.isArray(payload.triggered));
    assert.ok(Array.isArray(payload.active));
    assert.ok(payload.triggered.some((item: { ruleId?: string }) => item.ruleId === 'daemon-down'));
  } finally {
    if (previousBaseDir === undefined) {
      delete process.env.CONTEXTATLAS_BASE_DIR;
    } else {
      process.env.CONTEXTATLAS_BASE_DIR = previousBaseDir;
    }
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('alert:eval CLI surfaces memory-catalog-inconsistent for catalog drift', async () => {
  const baseDir = makeBaseDir();
  const repoRoot = path.join(baseDir, 'repo');
  const previousBaseDir = process.env.CONTEXTATLAS_BASE_DIR;
  process.env.CONTEXTATLAS_BASE_DIR = baseDir;
  fs.mkdirSync(repoRoot, { recursive: true });

  MemoryStore.setSharedHubForTests(new MemoryHubDatabase(path.join(baseDir, 'memory-hub.db')));

  try {
    const store = new MemoryStore(repoRoot);
    await store.saveFeature(buildFeature('SearchService'));
    await store.saveCatalog({
      version: 1,
      globalMemoryFiles: [],
      modules: {},
      scopes: {},
    });

    const result = spawnSync(
      'node',
      ['--import', 'tsx', 'src/index.ts', 'alert:eval', '--json'],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          CONTEXTATLAS_BASE_DIR: baseDir,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.ok(
      payload.triggered.some(
        (item: { ruleId?: string }) => item.ruleId === 'memory-catalog-inconsistent',
      ),
    );
  } finally {
    MemoryStore.resetSharedHubForTests();
    if (previousBaseDir === undefined) {
      delete process.env.CONTEXTATLAS_BASE_DIR;
    } else {
      process.env.CONTEXTATLAS_BASE_DIR = previousBaseDir;
    }
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('alert:eval CLI surfaces combined governance alerts for catalog drift, orphaned paths, and stale memory', async () => {
  const baseDir = makeBaseDir();
  const repoRoot = path.join(baseDir, 'repo');
  const previousBaseDir = process.env.CONTEXTATLAS_BASE_DIR;
  process.env.CONTEXTATLAS_BASE_DIR = baseDir;
  fs.mkdirSync(repoRoot, { recursive: true });

  MemoryStore.setSharedHubForTests(new MemoryHubDatabase(path.join(baseDir, 'memory-hub.db')));

  try {
    const store = new MemoryStore(repoRoot);
    await store.saveFeature(buildFeature('SearchService'));
    await store.saveFeature({
      ...buildFeature('OrphanModule'),
      location: {
        dir: 'src/search',
        files: ['missing.ts'],
      },
    });
    await store.saveCatalog({
      version: 1,
      globalMemoryFiles: [],
      modules: {},
      scopes: {},
    });
    await store.appendLongTermMemoryItem({
      type: 'feedback',
      title: 'stale governance memory',
      summary: 'legacy smoke guidance',
      scope: 'project',
      source: 'user-explicit',
      confidence: 1,
      lastVerifiedAt: '2020-01-01',
      tags: ['smoke'],
      links: [],
      provenance: [],
      durability: 'stable',
    });

    const result = spawnSync(
      'node',
      ['--import', 'tsx', 'src/index.ts', 'alert:eval', '--json'],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          CONTEXTATLAS_BASE_DIR: baseDir,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    const triggeredRuleIds = payload.triggered.map((item: { ruleId: string }) => item.ruleId);
    assert.ok(triggeredRuleIds.includes('memory-catalog-inconsistent'));
    assert.ok(triggeredRuleIds.includes('memory-orphaned-features'));
    assert.ok(triggeredRuleIds.includes('memory-high-stale-rate'));
  } finally {
    MemoryStore.resetSharedHubForTests();
    if (previousBaseDir === undefined) {
      delete process.env.CONTEXTATLAS_BASE_DIR;
    } else {
      process.env.CONTEXTATLAS_BASE_DIR = previousBaseDir;
    }
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});
