import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { executeLoadModuleMemory } from '../src/application/memory/executeModuleMemory.js';
import { MemoryRouter } from '../src/memory/MemoryRouter.js';
import { MemoryStore } from '../src/memory/MemoryStore.js';

async function withTempProject(
  run: (projectRoot: string) => Promise<void>,
): Promise<void> {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cw-module-memory-'));
  const projectRoot = path.join(tempDir, 'project');
  mkdirSync(projectRoot, { recursive: true });

  try {
    await run(projectRoot);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

test('executeLoadModuleMemory returns empty results when no memories exist', async () => {
  await withTempProject(async (projectRoot) => {
    const response = await executeLoadModuleMemory(
      {
        query: 'test',
        format: 'json',
      },
      projectRoot,
    );

    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.tool, 'load_module_memory');
    assert.equal(payload.result_count, 0);
    assert.deepEqual(payload.memories, []);
    assert.equal(payload.message, 'No module memories matched the given input.');
  });
});

test('executeLoadModuleMemory returns formatted text for no results', async () => {
  await withTempProject(async (projectRoot) => {
    const response = await executeLoadModuleMemory(
      {
        query: 'nonexistent',
        format: 'text',
      },
      projectRoot,
    );

    assert.match(response.content[0].text, /No module memories matched/);
    assert.match(response.content[0].text, /Context Assembly/);
    assert.match(response.content[0].text, /Routing Decision/);
  });
});

test('executeLoadModuleMemory loads memories by moduleName', async () => {
  await withTempProject(async (projectRoot) => {
    const store = new MemoryStore(projectRoot);
    await store.saveFeature({
      name: 'TestService',
      responsibility: 'Test service module',
      location: {
        dir: 'src/services',
        files: ['src/services/TestService.ts'],
      },
      api: {
        exports: ['TestService'],
        endpoints: [],
      },
      memoryType: 'local',
      sourceProjectId: undefined,
      dataFlow: 'unidirectional',
      keyPatterns: ['singleton', 'factory'],
      dependencies: {
        imports: ['logger'],
        external: ['lodash'],
      },
      confirmationStatus: 'human-confirmed',
      reviewStatus: 'verified',
      lastUpdated: new Date().toISOString(),
    });

    const response = await executeLoadModuleMemory(
      {
        moduleName: 'TestService',
        format: 'json',
      },
      projectRoot,
    );

    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.tool, 'load_module_memory');
    assert.equal(payload.result_count, 1);
    assert.equal(payload.memories[0].name, 'TestService');
    assert.equal(payload.memories[0].responsibility, 'Test service module');
  });
});

test('executeLoadModuleMemory loads memories by query', async () => {
  await withTempProject(async (projectRoot) => {
    const store = new MemoryStore(projectRoot);
    await store.saveFeature({
      name: 'SearchService',
      responsibility: 'Handles search operations and queries',
      location: {
        dir: 'src/search',
        files: ['src/search/SearchService.ts'],
      },
      api: {
        exports: ['SearchService'],
        endpoints: [],
      },
      memoryType: 'local',
      sourceProjectId: undefined,
      dataFlow: 'request-response',
      keyPatterns: ['search', 'query'],
      dependencies: {
        imports: [],
        external: [],
      },
      confirmationStatus: 'human-confirmed',
      reviewStatus: 'verified',
      lastUpdated: new Date().toISOString(),
    });

    const response = await executeLoadModuleMemory(
      {
        query: 'search operations',
        format: 'json',
      },
      projectRoot,
    );

    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.result_count, 1);
    assert.equal(payload.memories[0].name, 'SearchService');
  });
});

test('executeLoadModuleMemory loads memories by filePaths', async () => {
  await withTempProject(async (projectRoot) => {
    const store = new MemoryStore(projectRoot);
    await store.saveFeature({
      name: 'UserController',
      responsibility: 'Handles HTTP requests for user operations',
      location: {
        dir: 'src/controllers',
        files: ['src/controllers/UserController.ts'],
      },
      api: {
        exports: ['UserController'],
        endpoints: [],
      },
      memoryType: 'local',
      sourceProjectId: undefined,
      dataFlow: 'unidirectional',
      keyPatterns: ['mvc', 'controller'],
      dependencies: {
        imports: [],
        external: [],
      },
      confirmationStatus: 'human-confirmed',
      reviewStatus: 'verified',
      lastUpdated: new Date().toISOString(),
    });

    const response = await executeLoadModuleMemory(
      {
        filePaths: ['src/controllers/UserController.ts'],
        format: 'json',
      },
      projectRoot,
    );

    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.result_count, 1);
    assert.equal(payload.memories[0].name, 'UserController');
  });
});

test('executeLoadModuleMemory respects maxResults parameter', async () => {
  await withTempProject(async (projectRoot) => {
    const store = new MemoryStore(projectRoot);

    for (let i = 1; i <= 5; i++) {
      await store.saveFeature({
        name: `Module${i}`,
        responsibility: `Test module ${i}`,
        location: {
          dir: `src/module${i}`,
          files: [`src/module${i}/index.ts`],
        },
        api: {
          exports: [`Module${i}`],
          endpoints: [],
        },
        memoryType: 'local',
        sourceProjectId: undefined,
        dataFlow: 'unidirectional',
        keyPatterns: [],
        dependencies: {
          imports: [],
          external: [],
        },
        confirmationStatus: 'human-confirmed',
        reviewStatus: 'verified',
        lastUpdated: new Date().toISOString(),
      });
    }

    const response = await executeLoadModuleMemory(
      {
        query: 'module',
        maxResults: 3,
        format: 'json',
      },
      projectRoot,
    );

    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.result_count, 3);
  });
});

test('executeLoadModuleMemory filters out suggested memories', async () => {
  await withTempProject(async (projectRoot) => {
    const store = new MemoryStore(projectRoot);
    await store.saveFeature({
      name: 'ConfirmedModule',
      responsibility: 'Confirmed module',
      location: {
        dir: 'src/confirmed',
        files: ['src/confirmed/index.ts'],
      },
      api: {
        exports: ['ConfirmedModule'],
        endpoints: [],
      },
      memoryType: 'local',
      sourceProjectId: undefined,
      dataFlow: 'unidirectional',
      keyPatterns: [],
      dependencies: {
        imports: [],
        external: [],
      },
      confirmationStatus: 'human-confirmed',
      reviewStatus: 'verified',
      lastUpdated: new Date().toISOString(),
    });

    await store.saveFeature({
      name: 'SuggestedModule',
      responsibility: 'Suggested module',
      location: {
        dir: 'src/suggested',
        files: ['src/suggested/index.ts'],
      },
      api: {
        exports: ['SuggestedModule'],
        endpoints: [],
      },
      memoryType: 'local',
      sourceProjectId: undefined,
      dataFlow: 'unidirectional',
      keyPatterns: [],
      dependencies: {
        imports: [],
        external: [],
      },
      confirmationStatus: 'suggested',
      reviewStatus: 'needs-review',
      lastUpdated: new Date().toISOString(),
    });

    const response = await executeLoadModuleMemory(
      {
        query: 'module',
        format: 'json',
      },
      projectRoot,
    );

    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.result_count, 1);
    assert.equal(payload.memories[0].name, 'ConfirmedModule');
  });
});

test('executeLoadModuleMemory returns formatted text output', async () => {
  await withTempProject(async (projectRoot) => {
    const store = new MemoryStore(projectRoot);
    await store.saveFeature({
      name: 'FormatterService',
      responsibility: 'Formats and validates data',
      location: {
        dir: 'src/formatter',
        files: ['src/formatter/FormatterService.ts'],
      },
      api: {
        exports: ['FormatterService', 'formatDate', 'formatNumber'],
        endpoints: [],
      },
      memoryType: 'local',
      sourceProjectId: undefined,
      dataFlow: 'unidirectional',
      keyPatterns: ['formatting', 'validation'],
      dependencies: {
        imports: ['date-fns'],
        external: ['date-fns'],
      },
      confirmationStatus: 'human-confirmed',
      reviewStatus: 'verified',
      lastUpdated: new Date().toISOString(),
    });

    const response = await executeLoadModuleMemory(
      {
        moduleName: 'FormatterService',
        format: 'text',
      },
      projectRoot,
    );

    assert.match(response.content[0].text, /Loaded 1 Module Memory/);
    assert.match(response.content[0].text, /FormatterService/);
    assert.match(response.content[0].text, /Formats and validates data/);
    assert.match(response.content[0].text, /src\/formatter/);
    assert.match(response.content[0].text, /formatting, validation/);
  });
});

test('executeLoadModuleMemory uses MMR when useMmr is true', async () => {
  await withTempProject(async (projectRoot) => {
    const store = new MemoryStore(projectRoot);

    await store.saveFeature({
      name: 'SearchService',
      responsibility: 'Search and retrieval operations',
      location: {
        dir: 'src/search',
        files: ['src/search/SearchService.ts'],
      },
      api: {
        exports: ['SearchService'],
        endpoints: [],
      },
      memoryType: 'local',
      sourceProjectId: undefined,
      dataFlow: 'request-response',
      keyPatterns: ['search', 'index'],
      dependencies: {
        imports: [],
        external: [],
      },
      confirmationStatus: 'human-confirmed',
      reviewStatus: 'verified',
      lastUpdated: new Date().toISOString(),
    });

    await store.saveFeature({
      name: 'IndexService',
      responsibility: 'Index management and operations',
      location: {
        dir: 'src/index',
        files: ['src/index/IndexService.ts'],
      },
      api: {
        exports: ['IndexService'],
        endpoints: [],
      },
      memoryType: 'local',
      sourceProjectId: undefined,
      dataFlow: 'request-response',
      keyPatterns: ['index', 'search'],
      dependencies: {
        imports: [],
        external: [],
      },
      confirmationStatus: 'human-confirmed',
      reviewStatus: 'verified',
      lastUpdated: new Date().toISOString(),
    });

    const response = await executeLoadModuleMemory(
      {
        query: 'search index',
        maxResults: 1,
        useMmr: true,
        mmrLambda: 0.7,
        format: 'json',
      },
      projectRoot,
    );

    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.result_count, 1);
    assert.equal(payload.routing.selectionStrategy, 'mmr');
  });
});

test('executeLoadModuleMemory uses ranked selection when useMmr is false', async () => {
  await withTempProject(async (projectRoot) => {
    const store = new MemoryStore(projectRoot);
    await store.saveFeature({
      name: 'TestModule',
      responsibility: 'Test module',
      location: {
        dir: 'src/test',
        files: ['src/test/index.ts'],
      },
      api: {
        exports: ['TestModule'],
        endpoints: [],
      },
      memoryType: 'local',
      sourceProjectId: undefined,
      dataFlow: 'unidirectional',
      keyPatterns: [],
      dependencies: {
        imports: [],
        external: [],
      },
      confirmationStatus: 'human-confirmed',
      reviewStatus: 'verified',
      lastUpdated: new Date().toISOString(),
    });

    const response = await executeLoadModuleMemory(
      {
        query: 'test',
        useMmr: false,
        format: 'json',
      },
      projectRoot,
    );

    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.routing.selectionStrategy, 'ranked');
  });
});

test('executeLoadModuleMemory includes match details in response', async () => {
  await withTempProject(async (projectRoot) => {
    const store = new MemoryStore(projectRoot);
    await store.saveFeature({
      name: 'ExactMatchModule',
      responsibility: 'Exact match test',
      location: {
        dir: 'src/exact',
        files: ['src/exact/MatchModule.ts'],
      },
      api: {
        exports: ['ExactMatchModule'],
        endpoints: [],
      },
      memoryType: 'local',
      sourceProjectId: undefined,
      dataFlow: 'unidirectional',
      keyPatterns: [],
      dependencies: {
        imports: [],
        external: [],
      },
      confirmationStatus: 'human-confirmed',
      reviewStatus: 'verified',
      lastUpdated: new Date().toISOString(),
    });

    const response = await executeLoadModuleMemory(
      {
        moduleName: 'ExactMatchModule',
        format: 'json',
      },
      projectRoot,
    );

    const payload = JSON.parse(response.content[0].text);
    assert.ok(payload.match_details.length > 0);
    assert.equal(payload.match_details[0].module.toLowerCase(), 'exactmatchmodule');
    assert.ok(['keyword', 'path', 'explicit-module', 'explicit-scope', 'scope-cascade'].includes(payload.match_details[0].matchedBy));
  });
});

test('executeLoadModuleMemory includes assembly information in response', async () => {
  await withTempProject(async (projectRoot) => {
    const store = new MemoryStore(projectRoot);
    await store.saveFeature({
      name: 'AssemblyTestModule',
      responsibility: 'Assembly test module',
      location: {
        dir: 'src/assembly',
        files: ['src/assembly/TestModule.ts'],
      },
      api: {
        exports: ['AssemblyTestModule'],
        endpoints: [],
      },
      memoryType: 'local',
      sourceProjectId: undefined,
      dataFlow: 'unidirectional',
      keyPatterns: [],
      dependencies: {
        imports: [],
        external: [],
      },
      confirmationStatus: 'human-confirmed',
      reviewStatus: 'verified',
      lastUpdated: new Date().toISOString(),
    });

    const response = await executeLoadModuleMemory(
      {
        profile: 'implementation',
        maxResults: 10,
        mmrLambda: 0.5,
        format: 'json',
      },
      projectRoot,
    );

    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.assembly.name, 'implementation');
    // Default maxResults is 8, not 10
    assert.equal(payload.assembly.maxResults, 8);
    assert.equal(payload.assembly.mmrLambda, 0.65);
    assert.equal(payload.assembly.useMmr, true);
  });
});
