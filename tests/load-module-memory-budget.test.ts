import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { handleLoadModuleMemory } from '../src/mcp/tools/loadModuleMemory.ts';
import { MemoryHubDatabase } from '../src/memory/MemoryHubDatabase.ts';
import { MemoryStore } from '../src/memory/MemoryStore.ts';
import type { FeatureMemory } from '../src/memory/types.ts';

async function withTempProject(
  run: (projectRoot: string, dbPath: string) => Promise<void>,
): Promise<void> {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cw-load-memory-budget-'));
  const projectRoot = path.join(tempDir, 'project');
  const dbPath = path.join(tempDir, 'memory-hub.db');
  mkdirSync(projectRoot, { recursive: true });

  try {
    await run(projectRoot, dbPath);
  } finally {
    MemoryStore.resetSharedHubForTests();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function parseModuleHeadings(text: string): string[] {
  return Array.from(text.matchAll(/^###\s+(.+)$/gm)).map((match) => match[1].trim());
}

function buildMemory(name: string, responsibility: string, file: string, keyPatterns: string[]): FeatureMemory {
  return {
    name,
    responsibility,
    location: {
      dir: 'src/search',
      files: [file],
    },
    api: {
      exports: [name],
      endpoints: [],
    },
    dependencies: {
      imports: ['src/search/common.ts'],
      external: [],
    },
    dataFlow: responsibility,
    keyPatterns,
    lastUpdated: new Date().toISOString(),
  };
}

test('load_module_memory respects maxResults budget', async () => {
  await withTempProject(async (projectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));
    const store = new MemoryStore(projectRoot);

    await store.saveFeature(
      buildMemory(
        'SearchService',
        'search query processing ranking service core pipeline',
        'search.service.ts',
        ['search', 'service', 'ranking'],
      ),
    );
    await store.saveFeature(
      buildMemory(
        'SearchPipelineService',
        'search query processing ranking service pipeline orchestration',
        'search.pipeline.ts',
        ['search', 'service', 'pipeline'],
      ),
    );
    await store.saveFeature(
      buildMemory(
        'SearchUI',
        'search dashboard visualization rendering and interaction',
        'search.ui.ts',
        ['search', 'ui', 'dashboard'],
      ),
    );

    const response = await handleLoadModuleMemory(
      {
        query: 'search service',
        maxResults: 2,
        useMmr: false,
      },
      projectRoot,
    );

    const names = parseModuleHeadings(response.content[0].text);
    assert.equal(names.length, 2);
  });
});

test('load_module_memory mmr promotes novelty under strict budget', async () => {
  await withTempProject(async (projectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));
    const store = new MemoryStore(projectRoot);

    await store.saveFeature(
      buildMemory(
        'SearchService',
        'search query processing ranking service core pipeline',
        'search.service.ts',
        ['search', 'service', 'ranking'],
      ),
    );
    await store.saveFeature(
      buildMemory(
        'SearchPipelineService',
        'search query processing ranking service pipeline orchestration',
        'search.pipeline.ts',
        ['search', 'service', 'pipeline'],
      ),
    );
    await store.saveFeature(
      buildMemory(
        'SearchUI',
        'search dashboard visualization rendering and interaction',
        'search.ui.ts',
        ['search', 'ui', 'dashboard'],
      ),
    );

    const noMmr = await handleLoadModuleMemory(
      {
        query: 'search service pipeline',
        maxResults: 2,
        useMmr: false,
      },
      projectRoot,
    );
    const mmr = await handleLoadModuleMemory(
      {
        query: 'search service pipeline',
        maxResults: 2,
        useMmr: true,
        mmrLambda: 0.35,
      },
      projectRoot,
    );

    const noMmrNames = parseModuleHeadings(noMmr.content[0].text);
    const mmrNames = parseModuleHeadings(mmr.content[0].text);

    assert.equal(noMmrNames.length, 2);
    assert.equal(mmrNames.length, 2);

    assert.ok(noMmrNames.includes('SearchService'));
    assert.ok(noMmrNames.includes('SearchPipelineService'));
    assert.ok(!noMmrNames.includes('SearchUI'));

    assert.ok(mmrNames.includes('SearchUI'));
  });
});


test('load_module_memory overview phase applies tighter profile defaults', async () => {
  await withTempProject(async (projectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));
    const store = new MemoryStore(projectRoot);

    await store.saveFeature(buildMemory('SearchService', 'search service core pipeline', 'search.service.ts', ['search', 'service']));
    await store.saveFeature(buildMemory('SearchPipelineService', 'search pipeline orchestration', 'search.pipeline.ts', ['search', 'pipeline']));
    await store.saveFeature(buildMemory('SearchUI', 'search dashboard rendering', 'search.ui.ts', ['search', 'ui']));
    await store.saveFeature(buildMemory('SearchMetrics', 'search metrics and reporting', 'search.metrics.ts', ['search', 'metrics']));
    await store.saveFeature(buildMemory('SearchCache', 'search cache storage', 'search.cache.ts', ['search', 'cache']));

    const response = await handleLoadModuleMemory(
      {
        query: 'search',
        phase: 'overview',
      },
      projectRoot,
    );

    const text = response.content[0].text;
    const names = parseModuleHeadings(text);
    assert.ok(names.length <= 4);
    assert.match(text, /Assembly Profile\*\*: overview/);
    assert.match(text, /maxResults=4/);
    assert.match(text, /enableScopeCascade=false/);
  });
});

test('load_module_memory handoff profile disables mmr and uses handoff defaults', async () => {
  await withTempProject(async (projectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));
    const store = new MemoryStore(projectRoot);

    await store.saveFeature(buildMemory('SearchService', 'search service core pipeline', 'search.service.ts', ['search', 'service']));
    await store.saveFeature(buildMemory('SearchPipelineService', 'search pipeline orchestration', 'search.pipeline.ts', ['search', 'pipeline']));
    await store.saveFeature(buildMemory('SearchUI', 'search dashboard rendering', 'search.ui.ts', ['search', 'ui']));

    const response = await handleLoadModuleMemory(
      {
        query: 'search service pipeline',
        profile: 'handoff',
        format: 'json',
      },
      projectRoot,
    );

    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.input.profile, 'handoff');
    assert.equal(payload.input.useMmr, false);
    assert.equal(payload.input.enableScopeCascade, false);
    assert.equal(payload.input.maxResults, 6);
    assert.equal(payload.input.mmrLambda, 0.8);
  });
});
