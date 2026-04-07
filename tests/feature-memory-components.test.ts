import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FeatureMemoryCatalogCoordinator } from '../src/memory/FeatureMemoryCatalogCoordinator.ts';
import { FeatureMemoryRepository } from '../src/memory/FeatureMemoryRepository.ts';
import { MemoryHubDatabase } from '../src/memory/MemoryHubDatabase.ts';
import { MemoryRouter } from '../src/memory/MemoryRouter.ts';
import { MemoryStore } from '../src/memory/MemoryStore.ts';
import type { FeatureMemory } from '../src/memory/types.ts';

function buildMemory(overrides: Partial<FeatureMemory> = {}): FeatureMemory {
  return {
    name: 'SearchService',
    responsibility: 'search query orchestration',
    location: {
      dir: 'src/search',
      files: ['SearchService.ts'],
    },
    api: {
      exports: ['SearchService'],
      endpoints: [],
    },
    dependencies: {
      imports: ['GraphExpander'],
      external: [],
    },
    dataFlow: 'query -> rerank -> pack',
    keyPatterns: ['search', 'service'],
    lastUpdated: '2026-04-07T10:00:00.000Z',
    ...overrides,
  };
}

async function withTempProject(
  run: (input: {
    projectRoot: string;
    projectId: string;
    repo: FeatureMemoryRepository;
    coordinator: FeatureMemoryCatalogCoordinator;
    router: MemoryRouter;
  }) => Promise<void>,
): Promise<void> {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cw-feature-memory-components-'));
  const projectRoot = path.join(tempDir, 'project');
  const dbPath = path.join(tempDir, 'memory-hub.db');
  mkdirSync(projectRoot, { recursive: true });
  const hub = new MemoryHubDatabase(dbPath);
  const projectId = hub.ensureProject({ path: projectRoot, name: 'project' }).id;
  MemoryStore.setSharedHubForTests(hub);

  try {
    await run({
      projectRoot,
      projectId,
      repo: new FeatureMemoryRepository({
        hub,
        projectId,
      }),
      coordinator: new FeatureMemoryCatalogCoordinator(projectRoot),
      router: MemoryRouter.forProject(projectRoot),
    });
  } finally {
    MemoryStore.resetSharedHubForTests();
    hub.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

test('FeatureMemoryRepository can save, read, list and resolve feature by path', async () => {
  await withTempProject(async ({ repo }) => {
    const memory = buildMemory();

    await repo.save(memory);

    const exact = await repo.readByName('SearchService');
    assert.ok(exact);
    assert.equal(exact?.responsibility, 'search query orchestration');

    const byPath = await repo.readByPath('src/search/SearchService.ts');
    assert.ok(byPath);
    assert.equal(byPath?.name, 'SearchService');

    const byBasename = await repo.readByPath('SearchService.ts');
    assert.ok(byBasename);
    assert.equal(byBasename?.name, 'SearchService');

    const listed = await repo.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.name, 'SearchService');
  });
});

test('FeatureMemoryCatalogCoordinator keeps router visibility in sync for save, review, and delete', async () => {
  await withTempProject(async ({ repo, coordinator, router }) => {
    const memory = buildMemory();
    await repo.save(memory);
    await coordinator.onFeatureSaved(memory);

    const loaded = await router.loadModule('SearchService');
    assert.ok(loaded);
    assert.equal(loaded?.responsibility, 'search query orchestration');

    const flagged = await repo.markNeedsReview('SearchService', 'path drift detected');
    assert.ok(flagged);
    await coordinator.onFeatureSaved(flagged!);

    const reloaded = await router.loadModule('SearchService');
    assert.ok(reloaded);
    assert.equal(reloaded?.reviewStatus, 'needs-review');
    assert.equal(reloaded?.reviewReason, 'path drift detected');

    const deleted = await repo.delete('SearchService');
    assert.equal(deleted, true);
    await coordinator.onFeatureDeleted('SearchService');

    const afterDelete = await router.loadModule('SearchService');
    assert.equal(afterDelete, null);
  });
});
