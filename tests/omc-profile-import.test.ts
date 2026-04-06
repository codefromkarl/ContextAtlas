import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MemoryHubDatabase } from '../src/memory/MemoryHubDatabase.ts';
import { MemoryStore } from '../src/memory/MemoryStore.ts';
import { importOmcProjectProfile } from '../src/memory/OmcProjectMemoryImporter.ts';

function withTempProject(
  run: (projectRoot: string, dbPath: string) => Promise<void>,
): Promise<void> {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cw-omc-import-'));
  const projectRoot = path.join(tempDir, 'project');
  const dbPath = path.join(tempDir, 'memory-hub.db');
  fs.mkdirSync(projectRoot, { recursive: true });

  return (async () => {
    try {
      await run(projectRoot, dbPath);
    } finally {
      MemoryStore.resetSharedHubForTests();
      rmSync(tempDir, { recursive: true, force: true });
    }
  })();
}

function writeOmcProjectMemory(projectRoot: string, overrides: Record<string, unknown> = {}): void {
  const omcDir = path.join(projectRoot, '.omc');
  fs.mkdirSync(omcDir, { recursive: true });
  fs.writeFileSync(
    path.join(omcDir, 'project-memory.json'),
    JSON.stringify(
      {
        version: '1.0.0',
        lastScanned: 1775316426011,
        projectRoot,
        techStack: {
          languages: [{ name: 'TypeScript' }],
          frameworks: [{ name: 'MCP' }],
          packageManager: 'pnpm',
          runtime: 'Node.js 20',
        },
        build: {
          buildCommand: 'pnpm build',
          testCommand: 'pnpm test',
          devCommand: 'pnpm dev',
          scripts: {
            build: 'pnpm build',
            test: 'pnpm test',
            dev: 'pnpm dev',
          },
        },
        conventions: {
          namingStyle: 'camelCase',
          importStyle: 'esm',
          testPattern: '*.test.ts',
          fileOrganization: 'feature-based',
        },
        structure: {
          mainDirectories: ['src', 'tests', 'docs'],
        },
        directoryMap: {
          src: {
            path: 'src',
            purpose: 'Source code',
            keyFiles: ['index.ts', 'memory/MemoryStore.ts'],
          },
        },
        hotPaths: [{ path: 'src/index.ts', accessCount: 10, type: 'file' }],
        userDirectives: ['prefer sqlite memory'],
        ...overrides,
      },
      null,
      2,
    ),
    'utf-8',
  );
}

test('initializeWritable imports .omc profile into SQLite even when features already exist', async () => {
  await withTempProject(async (projectRoot, dbPath) => {
    writeOmcProjectMemory(projectRoot);

    const hub = new MemoryHubDatabase(dbPath);
    MemoryStore.setSharedHubForTests(hub);

    const project = hub.ensureProject({ path: projectRoot, name: 'project' });
    hub.saveMemory({
      project_id: project.id,
      name: 'existing-module',
      responsibility: 'already in sqlite',
      location_dir: 'src',
      location_files: ['existing.ts'],
      api_exports: ['existing-module'],
    });
    hub.setProjectMeta(
      project.id,
      'catalog',
      JSON.stringify({ version: 1, globalMemoryFiles: [], modules: {}, scopes: {} }),
    );

    const store = new MemoryStore(projectRoot);
    await store.initializeWritable();

    const profile = await store.readProfile();
    const conventions = await store.readGlobal('conventions');
    const crossCutting = await store.readGlobal('cross-cutting');

    assert.ok(profile);
    assert.equal(profile?.name, 'project');
    assert.deepEqual(profile?.techStack.language, ['TypeScript']);
    assert.deepEqual(profile?.commands.build, ['pnpm build']);
    assert.ok(conventions);
    assert.equal(conventions?.data.namingStyle, 'camelCase');
    assert.ok(crossCutting);
    assert.deepEqual(crossCutting?.data.userDirectives, ['prefer sqlite memory']);
  });
});

test('importOmcProjectProfile can force overwrite an existing SQLite profile', async () => {
  await withTempProject(async (projectRoot, dbPath) => {
    writeOmcProjectMemory(projectRoot, {
      conventions: {
        namingStyle: 'snake_case',
        importStyle: 'esm',
        testPattern: '*.spec.ts',
        fileOrganization: 'layered',
      },
    });

    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));
    const store = new MemoryStore(projectRoot);
    await store.saveProfile({
      name: 'old-profile',
      description: 'old profile',
      techStack: { language: ['Old'], frameworks: [], databases: [], tools: [] },
      structure: { srcDir: 'src', mainEntry: 'src/index.ts', keyModules: [] },
      conventions: { namingConventions: ['old'], codeStyle: [], gitWorkflow: 'old' },
      commands: { build: [], test: [], dev: [], start: [] },
      lastUpdated: new Date().toISOString(),
    });

    const result = await importOmcProjectProfile({
      projectRoot,
      store,
      force: true,
    });

    const profile = await store.readProfile();
    assert.equal(result.imported, true);
    assert.equal(result.source, '.omc/project-memory.json');
    assert.equal(profile?.name, 'project');
    assert.deepEqual(profile?.conventions.namingConventions, ['snake_case']);
  });
});
