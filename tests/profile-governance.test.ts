import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { handleRecordLongTermMemory } from '../src/mcp/tools/longTermMemory.ts';
import { MemoryHubDatabase } from '../src/memory/MemoryHubDatabase.ts';
import { MemoryStore } from '../src/memory/MemoryStore.ts';
import { SharedMemoryHub } from '../src/memory/SharedMemoryHub.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function withTempProject(
  run: (projectRoot: string, dbPath: string) => Promise<void>,
): Promise<void> {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cw-profile-governance-'));
  const projectRoot = path.join(tempDir, 'project');
  const dbPath = path.join(tempDir, 'memory-hub.db');

  return (async () => {
    try {
      await run(projectRoot, dbPath);
    } finally {
      MemoryStore.resetSharedHubForTests();
      rmSync(tempDir, { recursive: true, force: true });
    }
  })();
}

test('readonly profile 未 force 时不能被覆盖', async () => {
  await withTempProject(async (projectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));
    const store = new MemoryStore(projectRoot);

    await store.saveProfile({
      name: 'ContextAtlas',
      description: '测试项目',
      techStack: {
        language: ['TypeScript'],
        frameworks: [],
        databases: ['SQLite'],
        tools: ['pnpm'],
      },
      structure: {
        srcDir: 'src',
        mainEntry: 'src/index.ts',
        keyModules: [],
      },
      conventions: {
        namingConventions: [],
        codeStyle: [],
        gitWorkflow: 'trunk',
      },
      commands: {
        build: ['pnpm build'],
        test: ['pnpm test'],
        dev: ['pnpm dev'],
        start: ['pnpm start'],
      },
      governance: {
        profileMode: 'organization-readonly',
        sharedMemory: 'readonly',
        personalMemory: 'global-user',
      },
      lastUpdated: new Date().toISOString(),
    });

    await assert.rejects(
      () =>
        store.saveProfile({
          name: 'ContextAtlas 2',
          description: '覆盖尝试',
          techStack: {
            language: ['TypeScript'],
            frameworks: [],
            databases: ['SQLite'],
            tools: ['pnpm'],
          },
          structure: {
            srcDir: 'src',
            mainEntry: 'src/index.ts',
            keyModules: [],
          },
          conventions: {
            namingConventions: [],
            codeStyle: [],
            gitWorkflow: 'trunk',
          },
          commands: {
            build: ['pnpm build'],
            test: ['pnpm test'],
            dev: ['pnpm dev'],
            start: ['pnpm start'],
          },
          governance: {
            profileMode: 'editable',
            sharedMemory: 'editable',
            personalMemory: 'project',
          },
          lastUpdated: new Date().toISOString(),
        }),
      /readonly/i,
    );

    await store.saveProfile(
      {
        name: 'ContextAtlas 2',
        description: 'force 覆盖',
        techStack: {
          language: ['TypeScript'],
          frameworks: [],
          databases: ['SQLite'],
          tools: ['pnpm'],
        },
        structure: {
          srcDir: 'src',
          mainEntry: 'src/index.ts',
          keyModules: [],
        },
        conventions: {
          namingConventions: [],
          codeStyle: [],
          gitWorkflow: 'trunk',
        },
        commands: {
          build: ['pnpm build'],
          test: ['pnpm test'],
          dev: ['pnpm dev'],
          start: ['pnpm start'],
        },
        governance: {
          profileMode: 'editable',
          sharedMemory: 'editable',
          personalMemory: 'project',
        },
        lastUpdated: new Date().toISOString(),
      },
      { force: true },
    );

    const profile = await store.readProfile();
    assert.equal(profile?.name, 'ContextAtlas 2');
    assert.equal(profile?.governance?.sharedMemory, 'editable');
  });
});

test('record_long_term_memory 默认继承 profile.personalMemory 作用域', async () => {
  await withTempProject(async (projectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));
    const store = new MemoryStore(projectRoot);

    await store.saveProfile({
      name: 'ContextAtlas',
      description: '测试项目',
      techStack: {
        language: ['TypeScript'],
        frameworks: [],
        databases: ['SQLite'],
        tools: ['pnpm'],
      },
      structure: {
        srcDir: 'src',
        mainEntry: 'src/index.ts',
        keyModules: [],
      },
      conventions: {
        namingConventions: [],
        codeStyle: [],
        gitWorkflow: 'trunk',
      },
      commands: {
        build: ['pnpm build'],
        test: ['pnpm test'],
        dev: ['pnpm dev'],
        start: ['pnpm start'],
      },
      governance: {
        profileMode: 'editable',
        sharedMemory: 'readonly',
        personalMemory: 'project',
      },
      lastUpdated: new Date().toISOString(),
    });

    const response = await handleRecordLongTermMemory(
      {
        type: 'reference',
        title: 'Runbook',
        summary: 'runbook link',
        tags: ['ops'],
        format: 'json',
      },
      projectRoot,
    );
    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.memory.scope, 'project');

    const projectMemories = await store.listLongTermMemories({ types: ['reference'], scope: 'project' });
    assert.equal(projectMemories.length, 1);
  });
});

test('shared memory contribute respects profile sharedMemory policy', async () => {
  await withTempProject(async (projectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));
    const store = new MemoryStore(projectRoot);

    await store.saveProfile({
      name: 'ContextAtlas',
      description: '测试项目',
      techStack: {
        language: ['TypeScript'],
        frameworks: [],
        databases: ['SQLite'],
        tools: ['pnpm'],
      },
      structure: {
        srcDir: 'src',
        mainEntry: 'src/index.ts',
        keyModules: [],
      },
      conventions: {
        namingConventions: [],
        codeStyle: [],
        gitWorkflow: 'trunk',
      },
      commands: {
        build: ['pnpm build'],
        test: ['pnpm test'],
        dev: ['pnpm dev'],
        start: ['pnpm start'],
      },
      governance: {
        profileMode: 'editable',
        sharedMemory: 'readonly',
        personalMemory: 'project',
      },
      lastUpdated: new Date().toISOString(),
    });

    const hub = new SharedMemoryHub(dbPath);
    await assert.rejects(
      () =>
        hub.contribute(
          'patterns',
          {
            name: 'SearchPattern',
            responsibility: 'shared pattern',
            location: { dir: 'src/search', files: ['pattern.ts'] },
            api: { exports: ['SearchPattern'], endpoints: [] },
            dependencies: { imports: [], external: [] },
            dataFlow: 'query -> shared pattern',
            keyPatterns: ['search'],
            lastUpdated: new Date().toISOString(),
          },
          { contributor: 'tester', projectRoot },
        ),
      /readonly/i,
    );
  });
});

test('shared:contribute CLI saves shared memory when project policy is editable', async () => {
  await withTempProject(async (projectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));
    const store = new MemoryStore(projectRoot);

    await store.saveProfile({
      name: 'ContextAtlas',
      description: '测试项目',
      techStack: {
        language: ['TypeScript'],
        frameworks: [],
        databases: ['SQLite'],
        tools: ['pnpm'],
      },
      structure: {
        srcDir: 'src',
        mainEntry: 'src/index.ts',
        keyModules: [],
      },
      conventions: {
        namingConventions: [],
        codeStyle: [],
        gitWorkflow: 'trunk',
      },
      commands: {
        build: ['pnpm build'],
        test: ['pnpm test'],
        dev: ['pnpm dev'],
        start: ['pnpm start'],
      },
      governance: {
        profileMode: 'editable',
        sharedMemory: 'editable',
        personalMemory: 'project',
      },
      lastUpdated: new Date().toISOString(),
    });

    const previousBaseDir = process.env.CONTEXTATLAS_BASE_DIR;
    process.env.CONTEXTATLAS_BASE_DIR = path.dirname(dbPath);

    try {
      const result = spawnSync(
        'node',
        [
          '--import',
          'tsx',
          'src/index.ts',
          'shared:contribute',
          '--repo',
          projectRoot,
          '--category',
          'patterns',
          '--name',
          'SearchPattern',
          '--desc',
          'shared pattern',
          '--dir',
          'src/search',
          '--files',
          'pattern.ts',
          '--exports',
          'SearchPattern',
          '--json',
        ],
        {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          env: {
            ...process.env,
            CONTEXTATLAS_BASE_DIR: path.dirname(dbPath),
          },
        },
      );

      assert.equal(result.status, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.category, 'patterns');
      assert.equal(payload.name, 'SearchPattern');

      const hub = new SharedMemoryHub(dbPath);
      const memory = await hub.pull('patterns', 'SearchPattern');
      assert.equal(memory?.name, 'SearchPattern');
    } finally {
      if (previousBaseDir === undefined) {
        delete process.env.CONTEXTATLAS_BASE_DIR;
      } else {
        process.env.CONTEXTATLAS_BASE_DIR = previousBaseDir;
      }
    }
  });
});

test('shared:list and shared:sync CLI expose shared memory inventory and sync flow', async () => {
  await withTempProject(async (projectRoot, dbPath) => {
    const tempDir = path.dirname(projectRoot);
    const consumerRoot = path.join(tempDir, 'consumer');
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));
    const store = new MemoryStore(projectRoot);
    const consumerStore = new MemoryStore(consumerRoot);

    await store.saveProfile({
      name: 'Producer',
      description: 'source project',
      techStack: { language: ['TypeScript'], frameworks: [], databases: ['SQLite'], tools: ['pnpm'] },
      structure: { srcDir: 'src', mainEntry: 'src/index.ts', keyModules: [] },
      conventions: { namingConventions: [], codeStyle: [], gitWorkflow: 'trunk' },
      commands: { build: ['pnpm build'], test: ['pnpm test'], dev: ['pnpm dev'], start: ['pnpm start'] },
      governance: { profileMode: 'editable', sharedMemory: 'editable', personalMemory: 'project' },
      lastUpdated: new Date().toISOString(),
    });

    await consumerStore.saveProfile({
      name: 'Consumer',
      description: 'consumer project',
      techStack: { language: ['TypeScript'], frameworks: [], databases: ['SQLite'], tools: ['pnpm'] },
      structure: { srcDir: 'src', mainEntry: 'src/index.ts', keyModules: [] },
      conventions: { namingConventions: [], codeStyle: [], gitWorkflow: 'trunk' },
      commands: { build: ['pnpm build'], test: ['pnpm test'], dev: ['pnpm dev'], start: ['pnpm start'] },
      governance: { profileMode: 'editable', sharedMemory: 'readonly', personalMemory: 'project' },
      lastUpdated: new Date().toISOString(),
    });

    const previousBaseDir = process.env.CONTEXTATLAS_BASE_DIR;
    process.env.CONTEXTATLAS_BASE_DIR = path.dirname(dbPath);

    try {
      const contribute = spawnSync(
        'node',
        [
          '--import',
          'tsx',
          'src/index.ts',
          'shared:contribute',
          '--repo',
          projectRoot,
          '--category',
          'patterns',
          '--name',
          'SearchPattern',
          '--desc',
          'shared pattern',
          '--dir',
          'src/search',
          '--files',
          'pattern.ts',
          '--exports',
          'SearchPattern',
          '--json',
        ],
        {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          env: { ...process.env, CONTEXTATLAS_BASE_DIR: path.dirname(dbPath) },
        },
      );
      assert.equal(contribute.status, 0, contribute.stderr);

      const listResult = spawnSync(
        'node',
        ['--import', 'tsx', 'src/index.ts', 'shared:list', '--json'],
        {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          env: { ...process.env, CONTEXTATLAS_BASE_DIR: path.dirname(dbPath) },
        },
      );
      assert.equal(listResult.status, 0, listResult.stderr);
      const listPayload = JSON.parse(listResult.stdout);
      assert.ok(listPayload.results.some((item: { name: string }) => item.name === 'searchpattern'));

      const syncResult = spawnSync(
        'node',
        [
          '--import',
          'tsx',
          'src/index.ts',
          'shared:sync',
          '--repo',
          consumerRoot,
          '--category',
          'patterns',
          '--name',
          'SearchPattern',
          '--json',
        ],
        {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          env: { ...process.env, CONTEXTATLAS_BASE_DIR: path.dirname(dbPath) },
        },
      );
      assert.equal(syncResult.status, 0, syncResult.stderr);
      const syncPayload = JSON.parse(syncResult.stdout);
      assert.equal(syncPayload.success, true);

      const synced = await consumerStore.readFeature('SearchPattern');
      assert.equal(synced?.name, 'SearchPattern');
    } finally {
      if (previousBaseDir === undefined) {
        delete process.env.CONTEXTATLAS_BASE_DIR;
      } else {
        process.env.CONTEXTATLAS_BASE_DIR = previousBaseDir;
      }
    }
  });
});
