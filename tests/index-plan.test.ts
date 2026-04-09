import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getEmbeddingConfig, getIndexUpdateStrategyConfig } from '../src/config.ts';
import {
  generateProjectId,
  getAllFileMeta,
  getAllPaths,
  getFilesNeedingVectorIndex,
  initDb,
  setStoredEmbeddingDimensions,
  setStoredIndexContentSchemaVersion,
} from '../src/db/index.ts';
import {
  analyzeIndexUpdatePlan,
  collectLightweightPlanDelta,
  executeIndexUpdatePlan,
  formatIndexUpdateStrategyDiagnosticsReport,
  formatIndexUpdatePlanReport,
  getIndexUpdateStrategyDiagnostics,
} from '../src/indexing/updateStrategy.ts';
import { getTaskById } from '../src/indexing/queue.ts';
import { MEMORY_CATALOG_VERSION } from '../src/memory/MemoryRouter.ts';
import { MemoryHubDatabase } from '../src/memory/MemoryHubDatabase.ts';
import { MemoryStore } from '../src/memory/MemoryStore.ts';
import { scan } from '../src/scanner/index.ts';
import { resolveIndexPaths } from '../src/storage/layout.ts';

async function withTempRepo(
  run: (repoRoot: string, baseDir: string) => Promise<void>,
): Promise<void> {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-index-plan-'));
  const repoRoot = path.join(baseDir, 'repo');
  fs.mkdirSync(repoRoot, { recursive: true });
  const previousBaseDir = process.env.CONTEXTATLAS_BASE_DIR;

  process.env.CONTEXTATLAS_BASE_DIR = baseDir;
  MemoryStore.setSharedHubForTests(new MemoryHubDatabase(path.join(baseDir, 'memory-hub.db')));

  try {
    await run(repoRoot, baseDir);
  } finally {
    MemoryStore.resetSharedHubForTests();
    if (previousBaseDir === undefined) {
      delete process.env.CONTEXTATLAS_BASE_DIR;
    } else {
      process.env.CONTEXTATLAS_BASE_DIR = previousBaseDir;
    }
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

function restoreEnv(originalEnv: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

test('analyzeIndexUpdatePlan recommends full rebuild when index is missing', async () => {
  await withTempRepo(async (repoRoot) => {
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'src', 'auth.ts'), 'export function login() {}\n');

    const plan = await analyzeIndexUpdatePlan(repoRoot);

    assert.equal(plan.mode, 'full');
    assert.equal(plan.reasons[0]?.code, 'missing-index');
    assert.equal(plan.changeSummary.added, 1);
    assert.ok(plan.commands.includes(`contextatlas index ${repoRoot}`));
  });
});

test('collectLightweightPlanDelta 仅返回疑似变更与自愈文件，不扫描稳定文件', async () => {
  await withTempRepo(async (repoRoot) => {
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    const stablePath = path.join(repoRoot, 'src', 'stable.ts');
    const mtimeOnlyPath = path.join(repoRoot, 'src', 'mtime.ts');
    const deletedPath = path.join(repoRoot, 'src', 'deleted.ts');
    const addedPath = path.join(repoRoot, 'src', 'added.ts');

    fs.writeFileSync(stablePath, 'export const stable = 1;\n');
    fs.writeFileSync(mtimeOnlyPath, 'export const mtimeOnly = 1;\n');
    fs.writeFileSync(deletedPath, 'export const deleted = 1;\n');

    await scan(repoRoot, { vectorIndex: false });

    const projectId = generateProjectId(repoRoot);
    const db = initDb(projectId);
    db.exec('UPDATE files SET vector_index_hash = hash');
    db.prepare('UPDATE files SET vector_index_hash = NULL WHERE path = ?').run('src/stable.ts');
    db.close();

    const originalMtime = fs.statSync(mtimeOnlyPath).mtime;
    const nextMtime = new Date(originalMtime.getTime() + 5_000);
    fs.utimesSync(mtimeOnlyPath, nextMtime, nextMtime);
    fs.rmSync(deletedPath);
    fs.writeFileSync(addedPath, 'export const added = 1;\n');

    const verifyDb = initDb(projectId);
    const delta = await collectLightweightPlanDelta(repoRoot, {
      knownFiles: getAllFileMeta(verifyDb),
      indexedPaths: getAllPaths(verifyDb),
      healingPaths: new Set(getFilesNeedingVectorIndex(verifyDb)),
    });
    verifyDb.close();

    assert.deepEqual(
      delta.candidateEntries.map((entry) => entry.relPath).sort(),
      ['src/added.ts', 'src/mtime.ts'],
    );
    assert.deepEqual(delta.deletedPaths, ['src/deleted.ts']);
    assert.deepEqual(delta.healingEntries.map((entry) => entry.relPath), ['src/stable.ts']);
    assert.equal(delta.totalFiles, 3);
  });
});

test('analyzeIndexUpdatePlan recommends incremental update and reports impacted memories', async () => {
  await withTempRepo(async (repoRoot) => {
    fs.mkdirSync(path.join(repoRoot, 'src', 'search'), { recursive: true });
    const filePath = path.join(repoRoot, 'src', 'search', 'SearchService.ts');
    fs.writeFileSync(filePath, 'export function search() { return 1; }\n');

    await scan(repoRoot, { vectorIndex: false });
    const db = initDb('' + (await import('../src/db/index.ts')).generateProjectId(repoRoot));
    setStoredEmbeddingDimensions(db, getEmbeddingConfig().dimensions);
    db.close();
    const { vectorPath } = resolveIndexPaths(generateProjectId(repoRoot), {
      baseDir: process.env.CONTEXTATLAS_BASE_DIR,
    });
    fs.mkdirSync(vectorPath, { recursive: true });

    const store = new MemoryStore(repoRoot);
    await store.saveFeature({
      name: 'SearchService',
      responsibility: 'search pipeline',
      location: { dir: 'src/search', files: ['SearchService.ts'] },
      api: { exports: ['search'], endpoints: [] },
      dependencies: { imports: [], external: [] },
      dataFlow: 'query -> result',
      keyPatterns: ['search'],
      lastUpdated: new Date().toISOString(),
      confirmationStatus: 'human-confirmed',
    });

    fs.writeFileSync(filePath, 'export function search() { return 2; }\n');

    const plan = await analyzeIndexUpdatePlan(repoRoot);

    assert.equal(plan.mode, 'incremental');
    assert.equal(plan.changeSummary.modified, 1);
    assert.ok(plan.impactedMemories.some((memory) => memory.name === 'SearchService'));
    assert.ok(plan.commands.includes(`contextatlas index ${repoRoot}`));
  });
});

test('analyzeIndexUpdatePlan escalates to full rebuild when churn and estimated incremental cost are high', async () => {
  await withTempRepo(async (repoRoot) => {
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });

    for (let i = 0; i < 10; i += 1) {
      fs.writeFileSync(path.join(repoRoot, 'src', `file-${i}.ts`), `export const value${i} = ${i};\n`);
    }

    await scan(repoRoot, { vectorIndex: false });
    const projectId = generateProjectId(repoRoot);
    const db = initDb(projectId);
    setStoredEmbeddingDimensions(db, getEmbeddingConfig().dimensions);
    db.close();
    const { vectorPath } = resolveIndexPaths(projectId, {
      baseDir: process.env.CONTEXTATLAS_BASE_DIR,
    });
    fs.mkdirSync(vectorPath, { recursive: true });

    for (let i = 0; i < 8; i += 1) {
      fs.writeFileSync(
        path.join(repoRoot, 'src', `file-${i}.ts`),
        `export const value${i} = ${i + 100};\n`,
      );
    }

    const plan = await analyzeIndexUpdatePlan(repoRoot);
    const report = formatIndexUpdatePlanReport(plan);

    assert.equal(plan.mode, 'full');
    assert.ok(plan.reasons.some((reason) => reason.code === 'high-churn'));
    assert.ok(plan.reasons.some((reason) => reason.code === 'incremental-cost-high'));
    assert.ok(plan.strategySignals.changedFiles >= 8);
    assert.ok(plan.strategySignals.churnRatio >= 0.7);
    assert.ok(plan.strategySignals.incrementalCostRatio >= 0.7);
    assert.match(report, /Churn/i);
    assert.match(report, /Cost/i);
    assert.ok(plan.commands.includes(`contextatlas index ${repoRoot} --force`));
  });
});

test('getIndexUpdateStrategyConfig returns defaults and tolerates invalid env values', () => {
  const originalEnv = {
    INDEX_UPDATE_CHURN_THRESHOLD: process.env.INDEX_UPDATE_CHURN_THRESHOLD,
    INDEX_UPDATE_COST_RATIO_THRESHOLD: process.env.INDEX_UPDATE_COST_RATIO_THRESHOLD,
    INDEX_UPDATE_MIN_FILES: process.env.INDEX_UPDATE_MIN_FILES,
    INDEX_UPDATE_MIN_CHANGED_FILES: process.env.INDEX_UPDATE_MIN_CHANGED_FILES,
  };

  process.env.INDEX_UPDATE_CHURN_THRESHOLD = 'invalid';
  process.env.INDEX_UPDATE_COST_RATIO_THRESHOLD = '2';
  process.env.INDEX_UPDATE_MIN_FILES = '0';
  process.env.INDEX_UPDATE_MIN_CHANGED_FILES = '-1';

  try {
    const config = getIndexUpdateStrategyConfig();
    assert.equal(config.churnThreshold, 0.35);
    assert.equal(config.costThresholdRatio, 0.65);
    assert.equal(config.minFilesForEscalation, 8);
    assert.equal(config.minChangedFilesForEscalation, 5);
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('getIndexUpdateStrategyDiagnostics returns the parsed threshold values', () => {
  const originalEnv = {
    INDEX_UPDATE_CHURN_THRESHOLD: process.env.INDEX_UPDATE_CHURN_THRESHOLD,
    INDEX_UPDATE_COST_RATIO_THRESHOLD: process.env.INDEX_UPDATE_COST_RATIO_THRESHOLD,
    INDEX_UPDATE_MIN_FILES: process.env.INDEX_UPDATE_MIN_FILES,
    INDEX_UPDATE_MIN_CHANGED_FILES: process.env.INDEX_UPDATE_MIN_CHANGED_FILES,
  };

  process.env.INDEX_UPDATE_CHURN_THRESHOLD = '0.45';
  process.env.INDEX_UPDATE_COST_RATIO_THRESHOLD = '0.75';
  process.env.INDEX_UPDATE_MIN_FILES = '13';
  process.env.INDEX_UPDATE_MIN_CHANGED_FILES = '8';

  try {
    const diagnostics = getIndexUpdateStrategyDiagnostics();
    assert.equal(diagnostics.churnThreshold, 0.45);
    assert.equal(diagnostics.costThresholdRatio, 0.75);
    assert.equal(diagnostics.minFilesForEscalation, 13);
    assert.equal(diagnostics.minChangedFilesForEscalation, 8);
  } finally {
    restoreEnv(originalEnv);
  }
});

test('formatIndexUpdateStrategyDiagnosticsReport renders threshold values and env keys', () => {
  const text = formatIndexUpdateStrategyDiagnosticsReport({
    churnThreshold: 0.35,
    costThresholdRatio: 0.65,
    minFilesForEscalation: 8,
    minChangedFilesForEscalation: 5,
  });

  assert.match(text, /Index Strategy Diagnostics/);
  assert.match(text, /Churn Threshold: 35%/);
  assert.match(text, /Cost Threshold: 65% of full/);
  assert.match(text, /INDEX_UPDATE_CHURN_THRESHOLD/);
  assert.match(text, /INDEX_UPDATE_MIN_CHANGED_FILES/);
});

test('index:diagnose CLI 输出稳定阈值 JSON', () => {
  const originalEnv = {
    INDEX_UPDATE_CHURN_THRESHOLD: process.env.INDEX_UPDATE_CHURN_THRESHOLD,
    INDEX_UPDATE_COST_RATIO_THRESHOLD: process.env.INDEX_UPDATE_COST_RATIO_THRESHOLD,
    INDEX_UPDATE_MIN_FILES: process.env.INDEX_UPDATE_MIN_FILES,
    INDEX_UPDATE_MIN_CHANGED_FILES: process.env.INDEX_UPDATE_MIN_CHANGED_FILES,
  };

  process.env.INDEX_UPDATE_CHURN_THRESHOLD = '0.41';
  process.env.INDEX_UPDATE_COST_RATIO_THRESHOLD = '0.73';
  process.env.INDEX_UPDATE_MIN_FILES = '12';
  process.env.INDEX_UPDATE_MIN_CHANGED_FILES = '7';

  try {
    const result = spawnSync(
      'node',
      ['--import', 'tsx', 'src/index.ts', 'index:diagnose', '--json'],
      {
        cwd: path.resolve(import.meta.dirname, '..'),
        encoding: 'utf8',
        env: process.env,
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.churnThreshold, 0.41);
    assert.equal(payload.costThresholdRatio, 0.73);
    assert.equal(payload.minFilesForEscalation, 12);
    assert.equal(payload.minChangedFilesForEscalation, 7);
  } finally {
    restoreEnv(originalEnv);
  }
});

test('analyzeIndexUpdatePlan honors configurable churn and cost thresholds', async () => {
  const originalEnv = {
    INDEX_UPDATE_CHURN_THRESHOLD: process.env.INDEX_UPDATE_CHURN_THRESHOLD,
    INDEX_UPDATE_COST_RATIO_THRESHOLD: process.env.INDEX_UPDATE_COST_RATIO_THRESHOLD,
    INDEX_UPDATE_MIN_FILES: process.env.INDEX_UPDATE_MIN_FILES,
  };
  process.env.INDEX_UPDATE_CHURN_THRESHOLD = '0.95';
  process.env.INDEX_UPDATE_COST_RATIO_THRESHOLD = '0.95';
  process.env.INDEX_UPDATE_MIN_FILES = '20';

  try {
    await withTempRepo(async (repoRoot) => {
      fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });

      for (let i = 0; i < 10; i += 1) {
        fs.writeFileSync(
          path.join(repoRoot, 'src', `file-${i}.ts`),
          `export const value${i} = ${i};\n`,
        );
      }

      await scan(repoRoot, { vectorIndex: false });
      const projectId = generateProjectId(repoRoot);
      const db = initDb(projectId);
      setStoredEmbeddingDimensions(db, getEmbeddingConfig().dimensions);
      db.close();
      const { vectorPath } = resolveIndexPaths(projectId, {
        baseDir: process.env.CONTEXTATLAS_BASE_DIR,
      });
      fs.mkdirSync(vectorPath, { recursive: true });

      for (let i = 0; i < 8; i += 1) {
        fs.writeFileSync(
          path.join(repoRoot, 'src', `file-${i}.ts`),
          `export const value${i} = ${i + 100};\n`,
        );
      }

      const plan = await analyzeIndexUpdatePlan(repoRoot);

      assert.equal(plan.mode, 'incremental');
      assert.deepEqual(plan.strategySignals.fullRebuildTriggers, []);
      assert.equal(plan.strategySignals.churnThreshold, 0.95);
      assert.equal(plan.strategySignals.costThresholdRatio, 0.95);
      assert.equal(plan.strategySignals.eligibleForFullRebuildEscalation, false);
    });
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('analyzeIndexUpdatePlan recommends full rebuild when embedding dimensions changed', async () => {
  await withTempRepo(async (repoRoot) => {
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'src', 'auth.ts'), 'export function login() {}\n');

    await scan(repoRoot, { vectorIndex: false });
    const db = initDb(generateProjectId(repoRoot));
    setStoredEmbeddingDimensions(db, getEmbeddingConfig().dimensions + 1);
    db.close();

    const plan = await analyzeIndexUpdatePlan(repoRoot);

    assert.equal(plan.mode, 'full');
    assert.ok(plan.reasons.some((reason) => reason.code === 'embedding-dimension-changed'));
  });
});

test('analyzeIndexUpdatePlan adds schema status and rebuilds catalog when catalog version is outdated', async () => {
  await withTempRepo(async (repoRoot) => {
    fs.mkdirSync(path.join(repoRoot, 'src', 'search'), { recursive: true });
    const filePath = path.join(repoRoot, 'src', 'search', 'SearchService.ts');
    fs.writeFileSync(filePath, 'export function search() { return 1; }\n');

    await scan(repoRoot, { vectorIndex: false });

    const store = new MemoryStore(repoRoot);
    await store.saveFeature({
      name: 'SearchService',
      responsibility: 'search pipeline',
      location: { dir: 'src/search', files: ['SearchService.ts'] },
      api: { exports: ['search'], endpoints: [] },
      dependencies: { imports: [], external: [] },
      dataFlow: 'query -> result',
      keyPatterns: ['search'],
      lastUpdated: new Date().toISOString(),
      confirmationStatus: 'human-confirmed',
    });
    await store.saveCatalog({
      version: MEMORY_CATALOG_VERSION - 1,
      globalMemoryFiles: ['profile'],
      modules: {},
      scopes: {},
    });

    const plan = await analyzeIndexUpdatePlan(repoRoot);

    assert.equal(plan.schemaStatus.memoryCatalog.status, 'version-mismatch');
    assert.equal(plan.schemaStatus.memoryCatalog.storedVersion, MEMORY_CATALOG_VERSION - 1);
    assert.equal(plan.schemaStatus.memoryCatalog.expectedVersion, MEMORY_CATALOG_VERSION);
    assert.ok(plan.reasons.some((reason) => reason.code === 'memory-catalog-version-mismatch'));
    assert.ok(plan.commands.includes('contextatlas memory:rebuild-catalog'));
  });
});

test('analyzeIndexUpdatePlan exposes concrete catalog drift module names', async () => {
  await withTempRepo(async (repoRoot) => {
    fs.mkdirSync(path.join(repoRoot, 'src', 'search'), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, 'src', 'search', 'SearchService.ts'),
      'export function search() { return 1; }\n',
    );

    await scan(repoRoot, { vectorIndex: false });

    const store = new MemoryStore(repoRoot);
    await store.saveFeature({
      name: 'SearchService',
      responsibility: 'search pipeline',
      location: { dir: 'src/search', files: ['SearchService.ts'] },
      api: { exports: ['search'], endpoints: [] },
      dependencies: { imports: [], external: [] },
      dataFlow: 'query -> result',
      keyPatterns: ['search'],
      lastUpdated: new Date().toISOString(),
      confirmationStatus: 'human-confirmed',
    });

    await store.saveCatalog({
      version: MEMORY_CATALOG_VERSION,
      globalMemoryFiles: ['profile'],
      modules: {
        'orphaned-module': {
          file: 'features/orphaned-module.json',
          scope: 'search',
          keywords: ['orphaned'],
          triggerPaths: ['src/search/Orphaned.ts'],
          lastUpdated: new Date().toISOString(),
        },
      },
      scopes: {
        search: {
          description: 'search scope',
          cascadeLoad: true,
        },
      },
    });

    const plan = await analyzeIndexUpdatePlan(repoRoot);

    assert.equal(plan.schemaStatus.memoryCatalog.status, 'inconsistent');
    assert.deepEqual(plan.schemaStatus.memoryCatalog.missingModuleNames, ['searchservice']);
    assert.deepEqual(plan.schemaStatus.memoryCatalog.staleModuleNames, ['orphaned-module']);
    assert.match(formatIndexUpdatePlanReport(plan), /searchservice/);
    assert.match(formatIndexUpdatePlanReport(plan), /orphaned-module/);
  });
});

test('analyzeIndexUpdatePlan keeps impacted memories focused on direct file matches', async () => {
  await withTempRepo(async (repoRoot) => {
    fs.mkdirSync(path.join(repoRoot, 'src', 'search'), { recursive: true });
    const servicePath = path.join(repoRoot, 'src', 'search', 'SearchService.ts');
    const controllerPath = path.join(repoRoot, 'src', 'search', 'SearchController.ts');
    fs.writeFileSync(servicePath, 'export function search() { return 1; }\n');
    fs.writeFileSync(controllerPath, 'export function handleSearch() { return search(); }\n');

    await scan(repoRoot, { vectorIndex: false });

    const store = new MemoryStore(repoRoot);
    await store.saveFeature({
      name: 'SearchService',
      responsibility: 'search pipeline',
      location: { dir: 'src/search', files: ['SearchService.ts'] },
      api: { exports: ['search'], endpoints: [] },
      dependencies: { imports: [], external: [] },
      dataFlow: 'query -> result',
      keyPatterns: ['search'],
      lastUpdated: new Date().toISOString(),
      confirmationStatus: 'human-confirmed',
    });
    await store.saveFeature({
      name: 'SearchController',
      responsibility: 'http endpoint for search',
      location: { dir: 'src/search', files: ['SearchController.ts'] },
      api: { exports: ['handleSearch'], endpoints: [] },
      dependencies: { imports: ['SearchService'], external: [] },
      dataFlow: 'request -> search -> response',
      keyPatterns: ['search'],
      lastUpdated: new Date().toISOString(),
      confirmationStatus: 'human-confirmed',
    });

    fs.writeFileSync(servicePath, 'export function search() { return 2; }\n');

    const plan = await analyzeIndexUpdatePlan(repoRoot);

    assert.deepEqual(
      plan.impactedMemories.map((memory) => memory.name),
      ['SearchService'],
    );
    assert.deepEqual(plan.impactedMemories[0]?.matchedPaths, ['src/search/SearchService.ts']);
    assert.ok(plan.impactedMemories[0]?.reasons.includes('direct-file'));
  });
});

test('analyzeIndexUpdatePlan recommends full rebuild when vector store is missing for a vectorized index', async () => {
  await withTempRepo(async (repoRoot, baseDir) => {
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'src', 'auth.ts'), 'export function login() {}\n');

    const projectId = generateProjectId(repoRoot);
    const db = initDb(projectId);
    db.prepare(
      'INSERT INTO files(path, hash, mtime, size, content, language, vector_index_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('src/auth.ts', 'h1', Date.now(), 28, 'export function login() {}\n', 'typescript', 'h1');
    setStoredEmbeddingDimensions(db, getEmbeddingConfig().dimensions);
    db.close();

    const { vectorPath } = resolveIndexPaths(projectId, { baseDir: process.env.CONTEXTATLAS_BASE_DIR });
    fs.rmSync(vectorPath, { recursive: true, force: true });

    const plan = await analyzeIndexUpdatePlan(repoRoot);

    assert.equal(plan.mode, 'full');
    assert.ok(plan.reasons.some((reason) => reason.code === 'vector-store-missing'));
    assert.equal(plan.schemaStatus.snapshot.hasVectorStore, false);
    assert.ok(plan.commands.includes(`contextatlas index ${repoRoot} --force`));
  });
});

test('analyzeIndexUpdatePlan recommends full rebuild when index content schema changed', async () => {
  await withTempRepo(async (repoRoot) => {
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'src', 'auth.ts'), 'export function login() {}\n');

    const store = new MemoryStore(repoRoot);
    await store.saveFeature({
      name: 'AuthModule',
      responsibility: 'authentication entrypoint',
      location: { dir: 'src', files: ['auth.ts'] },
      api: { exports: ['login'], endpoints: [] },
      dependencies: { imports: [], external: [] },
      dataFlow: 'input -> auth -> output',
      keyPatterns: ['auth'],
      lastUpdated: new Date().toISOString(),
      confirmationStatus: 'human-confirmed',
    });

    await scan(repoRoot, { vectorIndex: false });
    const db = initDb(generateProjectId(repoRoot));
    setStoredEmbeddingDimensions(db, getEmbeddingConfig().dimensions);
    setStoredIndexContentSchemaVersion(db, 0);
    db.close();
    const { vectorPath } = resolveIndexPaths(generateProjectId(repoRoot), {
      baseDir: process.env.CONTEXTATLAS_BASE_DIR,
    });
    fs.mkdirSync(vectorPath, { recursive: true });

    const plan = await analyzeIndexUpdatePlan(repoRoot);

    assert.equal(plan.mode, 'full');
    assert.ok(plan.reasons.some((reason) => reason.code === 'index-content-schema-changed'));
    assert.equal(plan.schemaStatus.contentSchema.storedVersion, 0);
    assert.equal(plan.schemaStatus.contentSchema.compatible, false);
    assert.ok(plan.impactedMemories.some((memory) => memory.scope === 'broad-review'));
    assert.ok(
      plan.impactedMemories.some((memory) => memory.reasons.includes('content-schema-wide-impact')),
    );
    assert.match(formatIndexUpdatePlanReport(plan), /Content Schema:/);
    assert.match(formatIndexUpdatePlanReport(plan), /broad-review/);
  });
});

test('formatIndexUpdatePlanReport renders compact strategy guidance', () => {
  const text = formatIndexUpdatePlanReport({
    repoPath: '/repo',
    projectId: 'proj123',
    mode: 'incremental',
    reasons: [{ code: 'files-modified', message: '2 files changed' }],
    changeSummary: {
      added: 0,
      modified: 2,
      deleted: 0,
      unchangedNeedingVectorRepair: 1,
      unchanged: 5,
      skipped: 0,
      errors: 0,
      totalFiles: 7,
    },
    impactedMemories: [{
      name: 'SearchService',
      location: 'src/search/SearchService.ts',
      scope: 'direct',
      reasons: ['direct-file'],
      matchedPaths: ['src/search/SearchService.ts'],
    }],
    commands: ['contextatlas index /repo'],
    memoryCatalogStatus: 'consistent',
    schemaStatus: {
      snapshot: {
        layout: 'snapshot',
        currentSnapshotId: 'snap-1',
        hasIndexData: true,
        hasVectorStore: true,
      },
      embeddings: {
        storedDimensions: 1024,
        currentDimensions: 1024,
        compatible: true,
      },
      contentSchema: {
        storedVersion: 1,
        currentVersion: 1,
        compatible: true,
      },
      memoryCatalog: {
        status: 'consistent',
        storedVersion: 1,
        expectedVersion: 1,
        missingModules: 0,
        staleModules: 0,
        missingModuleNames: [],
        staleModuleNames: [],
      },
    },
    strategySignals: {
      changedFiles: 3,
      eligibleForFullRebuildEscalation: false,
      churnRatio: 3 / 7,
      churnThreshold: 0.35,
      estimatedIncrementalBytes: 2048,
      estimatedFullBytes: 4096,
      incrementalCostRatio: 0.5,
      costThresholdRatio: 0.65,
      fullRebuildTriggers: [],
    },
  });

  assert.match(text, /Index Update Plan/);
  assert.match(text, /Mode: INCREMENTAL/);
   assert.match(text, /SearchService/);
   assert.match(text, /\[direct\]/);
   assert.match(text, /contextatlas index \/repo/);
  assert.match(text, /Schema Status/);
});

test('executeIndexUpdatePlan enqueues incremental task when repo files changed', async () => {
  await withTempRepo(async (repoRoot) => {
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    const filePath = path.join(repoRoot, 'src', 'auth.ts');
    fs.writeFileSync(filePath, 'export function login() { return 1; }\n');

    await scan(repoRoot, { vectorIndex: false });
    const db = initDb(generateProjectId(repoRoot));
    setStoredEmbeddingDimensions(db, getEmbeddingConfig().dimensions);
    db.close();
    const { vectorPath } = resolveIndexPaths(generateProjectId(repoRoot), {
      baseDir: process.env.CONTEXTATLAS_BASE_DIR,
    });
    fs.mkdirSync(vectorPath, { recursive: true });

    fs.writeFileSync(filePath, 'export function login() { return 2; }\n');

    const result = await executeIndexUpdatePlan(repoRoot, { requestedBy: 'test' });

    assert.equal(result.plan.mode, 'incremental');
    assert.equal(result.enqueued, true);
    assert.ok(result.taskId);
    const task = getTaskById(result.taskId!);
    assert.equal(task?.scope, 'incremental');
    assert.equal(task?.requestedBy, 'test');
    assert.ok(task?.executionHint);
    assert.equal(task?.executionHint?.ttlMs, 10 * 60 * 1000);
    assert.equal(task?.executionHint?.changeSummary.modified, 1);
    assert.deepEqual(
      task?.executionHint?.candidates.map((item) => item.relPath),
      ['src/auth.ts'],
    );
  });
});

test('executeIndexUpdatePlan enqueues full task when embedding dimensions drifted', async () => {
  await withTempRepo(async (repoRoot) => {
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'src', 'auth.ts'), 'export function login() {}\n');

    await scan(repoRoot, { vectorIndex: false });
    const db = initDb(generateProjectId(repoRoot));
    setStoredEmbeddingDimensions(db, getEmbeddingConfig().dimensions + 8);
    db.close();

    const result = await executeIndexUpdatePlan(repoRoot, { requestedBy: 'test' });

    assert.equal(result.plan.mode, 'full');
    assert.equal(result.enqueued, true);
    const task = getTaskById(result.taskId!);
    assert.equal(task?.scope, 'full');
  });
});

test('executeIndexUpdatePlan does not enqueue when index is already up to date', async () => {
  await withTempRepo(async (repoRoot) => {
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'src', 'auth.ts'), 'export function login() {}\n');

    await scan(repoRoot, { vectorIndex: false });
    const projectId = generateProjectId(repoRoot);
    const db = initDb(projectId);
    setStoredEmbeddingDimensions(db, getEmbeddingConfig().dimensions);
    db.exec('UPDATE files SET vector_index_hash = hash');
    db.close();
    const { vectorPath } = resolveIndexPaths(projectId, {
      baseDir: process.env.CONTEXTATLAS_BASE_DIR,
    });
    fs.mkdirSync(vectorPath, { recursive: true });

    const result = await executeIndexUpdatePlan(repoRoot, { requestedBy: 'test' });

    assert.equal(result.plan.mode, 'none');
    assert.equal(result.enqueued, false);
    assert.equal(result.taskId, null);
  });
});
