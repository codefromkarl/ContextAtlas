import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function withTempProjects(
  run: (input: { baseDir: string; repoA: string; repoB: string }) => Promise<void>,
): Promise<void> {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-memory-health-'));
  const repoA = path.join(baseDir, 'repo-a');
  const repoB = path.join(baseDir, 'repo-b');
  const previousBaseDir = process.env.CONTEXTATLAS_BASE_DIR;
  process.env.CONTEXTATLAS_BASE_DIR = baseDir;
  const { MemoryHubDatabase } = await import('../src/memory/MemoryHubDatabase.ts');
  const { MemoryStore } = await import('../src/memory/MemoryStore.ts');
  MemoryStore.setSharedHubForTests(new MemoryHubDatabase(path.join(baseDir, 'memory-hub.db')));
  fs.mkdirSync(repoA, { recursive: true });
  fs.mkdirSync(repoB, { recursive: true });

  try {
    await run({ baseDir, repoA, repoB });
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

async function seedProject(repoRoot: string, summary: string): Promise<void> {
  const { MemoryStore } = await import('../src/memory/MemoryStore.ts');
  fs.mkdirSync(path.join(repoRoot, 'src', 'search'), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, 'src', 'search', 'SearchService.ts'),
    `export const summary = ${JSON.stringify(summary)};\n`,
  );

  const store = new MemoryStore(repoRoot);
  await store.saveFeature({
    name: 'SearchService',
    responsibility: summary,
    location: { dir: 'src/search', files: ['SearchService.ts'] },
    api: { exports: ['SearchService'], endpoints: [] },
    dependencies: { imports: [], external: [] },
    dataFlow: summary,
    keyPatterns: ['search'],
    lastUpdated: new Date('2026-04-09T00:00:00.000Z').toISOString(),
    confirmationStatus: 'human-confirmed',
  });
  await store.appendLongTermMemoryItem({
    type: 'project-state',
    title: `${path.basename(repoRoot)} state`,
    summary,
    scope: 'project',
    source: 'user-explicit',
    confidence: 0.9,
    tags: ['state'],
    createdAt: '2026-04-09T00:00:00.000Z',
    updatedAt: '2026-04-09T00:00:00.000Z',
    lastVerifiedAt: '2026-04-09T00:00:00.000Z',
  });
}

test('analyzeMemoryHealth keeps project long-term counts isolated and aggregates catalog totals per project', async () => {
  await withTempProjects(async ({ repoA, repoB }) => {
    await seedProject(repoA, 'repo A state');
    await seedProject(repoB, 'repo B state');

    const { analyzeMemoryHealth } = await import('../src/monitoring/memoryHealth.ts');
    const report = await analyzeMemoryHealth({
      projectRoots: [repoA, repoB],
      staleDays: 30,
    });

    assert.equal(report.catalogConsistency.isConsistent, true);
    assert.equal(report.catalogConsistency.totalFeatures, 2);
    assert.equal(report.catalogConsistency.totalCatalogEntries, 2);
    assert.deepEqual(report.catalogConsistency.missingFromCatalog, []);
    assert.deepEqual(report.catalogConsistency.staleInCatalog, []);

    const repoAStats = report.projectScores.find((project) => project.projectName === 'repo-a');
    const repoBStats = report.projectScores.find((project) => project.projectName === 'repo-b');
    assert.ok(repoAStats);
    assert.ok(repoBStats);
    assert.equal(repoAStats?.longTermCount, 1);
    assert.equal(repoBStats?.longTermCount, 1);
    assert.equal(repoAStats?.catalogConsistent, true);
    assert.equal(repoBStats?.catalogConsistent, true);
  });
});
