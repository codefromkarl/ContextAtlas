import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deriveStableProjectId } from '../src/db/index.ts';
import { handleListMemoryCatalog } from '../src/mcp/tools/listMemoryCatalog.ts';
import { handleLoadModuleMemory } from '../src/mcp/tools/loadModuleMemory.ts';
import { handleRegisterProject } from '../src/mcp/tools/memoryHub.ts';
import { handleRecordMemory } from '../src/mcp/tools/projectMemory.ts';
import { MemoryHubDatabase } from '../src/memory/MemoryHubDatabase.ts';
import { MemoryStore } from '../src/memory/MemoryStore.ts';

async function withTempProject(
  run: (projectRoot: string, dbPath: string) => Promise<void>,
): Promise<void> {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cw-mcp-memory-tools-'));
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

test('list_memory_catalog does not auto-register project when catalog is missing', async () => {
  await withTempProject(async (projectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const response = await handleListMemoryCatalog(
      { includeDetails: false, format: 'text' },
      projectRoot,
    );

    assert.match(response.content[0].text, /## Memory Catalog/);
    assert.match(response.content[0].text, /Total Modules\*\*: 0/);

    const db = new MemoryHubDatabase(dbPath);
    try {
      assert.equal(db.listProjects().length, 1);
      assert.equal(db.listProjects()[0]?.path, projectRoot);
    } finally {
      db.close();
    }
  });
});

test('register_project derives project identity from normalized path', async () => {
  await withTempProject(async (projectRoot, dbPath) => {
    const originalHome = process.env.HOME;
    process.env.HOME = path.dirname(dbPath);

    try {
      const response = await handleRegisterProject({
        name: 'ContextAtlas',
        path: `${projectRoot}/`,
      });

      assert.match(response.content[0].text, /Project Registered/);
      assert.match(
        response.content[0].text,
        new RegExp(`- \\*\\*ID\\*\\*: ${deriveStableProjectId(projectRoot)}`),
      );
      assert.match(
        response.content[0].text,
        new RegExp(`- \\*\\*Path\\*\\*: ${projectRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      );
    } finally {
      process.env.HOME = originalHome;
    }
  });
});

test('record_memory can overwrite same-name module and load updated content', async () => {
  await withTempProject(async (projectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    await handleRecordMemory(
      {
        name: 'legacy-project-memory-migration-map',
        responsibility: 'initial responsibility',
        dir: 'src/memory',
        files: ['map.ts'],
        exports: ['legacy-project-memory-migration-map'],
        endpoints: [],
        imports: ['A'],
        external: [],
        dataFlow: 'initial flow',
        keyPatterns: ['initial'],
      },
      projectRoot,
    );

    await handleRecordMemory(
      {
        name: 'legacy-project-memory-migration-map',
        responsibility: 'updated responsibility',
        dir: 'src/memory',
        files: ['map.ts'],
        exports: ['legacy-project-memory-migration-map'],
        endpoints: [],
        imports: [],
        external: [],
        dataFlow: 'updated flow',
        keyPatterns: ['updated'],
      },
      projectRoot,
    );

    const store = new MemoryStore(projectRoot);
    const memory = await store.readFeature('legacy-project-memory-migration-map');
    assert.ok(memory);
    assert.equal(memory?.responsibility, 'updated responsibility');
    assert.deepEqual(memory?.dependencies.imports, []);
    assert.equal(memory?.dataFlow, 'updated flow');

    const loadResponse = await handleLoadModuleMemory(
      {
        moduleName: 'legacy-project-memory-migration-map',
        maxResults: 5,
        useMmr: true,
        mmrLambda: 0.65,
        enableScopeCascade: false,
        format: 'text',
      },
      projectRoot,
    );

    assert.match(loadResponse.content[0].text, /updated responsibility/);
    assert.match(loadResponse.content[0].text, /updated flow/);
  });
});

test('store delete removes routed visibility after coordinated cleanup', async () => {
  await withTempProject(async (projectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    await handleRecordMemory(
      {
        name: 'delete-me-module',
        responsibility: 'temporary responsibility',
        dir: 'src/memory',
        files: ['delete.ts'],
        exports: ['delete-me-module'],
        endpoints: [],
        imports: ['TmpDep'],
        external: [],
        dataFlow: 'temporary flow',
        keyPatterns: ['temporary'],
      },
      projectRoot,
    );

    const store = new MemoryStore(projectRoot);
    const deleted = await store.deleteFeature('delete-me-module');
    assert.equal(deleted, true);

    const memory = await store.readFeature('delete-me-module');
    assert.equal(memory, null);

    const loadResponse = await handleLoadModuleMemory(
      {
        moduleName: 'delete-me-module',
        maxResults: 5,
        useMmr: true,
        mmrLambda: 0.65,
        enableScopeCascade: false,
        format: 'text',
      },
      projectRoot,
    );

    assert.match(loadResponse.content[0].text, /No module memories matched/);

    const db = new MemoryHubDatabase(dbPath);
    try {
      const project = db.getProjectByPath(projectRoot);
      assert.ok(project);

      const row = db.getMemory(project!.id, 'delete-me-module');
      assert.equal(row, undefined);

      const searchResults = db.searchMemories({ moduleName: 'delete-me-module', limit: 10 });
      assert.equal(searchResults.length, 0);
    } finally {
      db.close();
    }
  });
});
