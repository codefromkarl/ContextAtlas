import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { deriveStableProjectId } from '../src/db/index.ts';
import { handleListMemoryCatalog } from '../src/mcp/tools/listMemoryCatalog.ts';
import { handleCreateCheckpoint, handleListCheckpoints, handleLoadCheckpoint } from '../src/mcp/tools/checkpoints.ts';
import { handleLoadModuleMemory } from '../src/mcp/tools/loadModuleMemory.ts';
import { handleManageProjects } from '../src/mcp/tools/memoryHub.ts';
import { handleFindMemory } from '../src/mcp/tools/projectMemory.ts';
import { handleRecordDecision, handleRecordMemory } from '../src/mcp/tools/projectMemory.ts';
import { handleRecordResultFeedback } from '../src/mcp/tools/feedbackLoop.ts';
import { MemoryHubDatabase } from '../src/memory/MemoryHubDatabase.ts';
import { MemoryStore } from '../src/memory/MemoryStore.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
      const response = await handleManageProjects({
        action: 'register',
        name: 'ContextAtlas',
        path: `${projectRoot}/`,
        format: 'text',
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
    assert.equal(memory?.confirmationStatus, 'human-confirmed');

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

test('feature memory review status can be persisted and raised to needs-review', async () => {
  await withTempProject(async (projectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    await handleRecordMemory(
      {
        name: 'review-target-module',
        responsibility: 'review target',
        dir: 'src/memory',
        files: ['review.ts'],
        exports: ['review-target-module'],
        endpoints: [],
        imports: [],
        external: [],
        dataFlow: 'review flow',
        keyPatterns: ['review'],
        confirmationStatus: 'human-confirmed',
        reviewStatus: 'verified',
      },
      projectRoot,
    );

    const store = new MemoryStore(projectRoot);
    const flagged = await store.markFeatureNeedsReview(
      'review-target-module',
      '当前查询命中的代码路径与记忆记录不一致',
    );

    assert.ok(flagged);
    assert.equal(flagged?.reviewStatus, 'needs-review');
    assert.equal(flagged?.reviewReason, '当前查询命中的代码路径与记忆记录不一致');
    assert.ok(flagged?.reviewMarkedAt);

    const reread = await store.readFeature('review-target-module');
    assert.equal(reread?.reviewStatus, 'needs-review');
    assert.equal(reread?.reviewReason, '当前查询命中的代码路径与记忆记录不一致');
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

test('record_memory surfaces similar module merge hints', async () => {
  await withTempProject(async (projectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    await handleRecordMemory(
      {
        name: 'SearchService',
        responsibility: 'core search orchestration',
        dir: 'src/search',
        files: ['SearchService.ts'],
        exports: ['SearchService'],
        endpoints: [],
        imports: ['GraphExpander'],
        external: [],
        dataFlow: 'query -> rank -> pack',
        keyPatterns: ['search', 'rank'],
      },
      projectRoot,
    );

    const response = await handleRecordMemory(
      {
        name: 'SearchPipelineService',
        responsibility: 'core search orchestration pipeline',
        dir: 'src/search',
        files: ['SearchPipelineService.ts'],
        exports: ['SearchPipelineService'],
        endpoints: [],
        imports: ['GraphExpander'],
        external: [],
        dataFlow: 'query -> rank -> pack',
        keyPatterns: ['search', 'rank', 'pipeline'],
      },
      projectRoot,
    );

    assert.match(response.content[0].text, /Potential Duplicates/);
    assert.match(response.content[0].text, /SearchService/);
    assert.match(response.content[0].text, /建议先人工确认是否应合并/);
  });
});

test('record_decision surfaces unified write diagnostics for similar decisions', async () => {
  await withTempProject(async (projectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    await handleRecordDecision(
      {
        id: '2026-04-siliconflow-embeddings',
        title: 'Prefer direct SiliconFlow embeddings',
        context: 'Use direct SiliconFlow for faster indexing',
        decision: 'Default the embedding client to direct SiliconFlow',
        alternatives: [],
        rationale: 'It is measurably faster than the local gateway in this setup',
        consequences: ['Simpler runtime path'],
        reviewer: 'infra-lead',
      },
      projectRoot,
    );

    const response = await handleRecordDecision(
      {
        id: '2026-04-siliconflow-embeddings-dup',
        title: 'Prefer direct SiliconFlow embeddings',
        context: 'Use direct SiliconFlow for faster indexing',
        decision: 'Default the embedding client to direct SiliconFlow',
        alternatives: [],
        rationale: 'It is measurably faster than the local gateway in this setup',
        consequences: ['Simpler runtime path'],
        reviewer: 'infra-lead',
      },
      projectRoot,
    );

    assert.match(response.content[0].text, /Write Diagnostics/);
    assert.match(response.content[0].text, /Potential Duplicates/);
    assert.match(response.content[0].text, /Prefer direct SiliconFlow embeddings/);
  });
});

test('record_result_feedback stores retrieval feedback as long-term memory', async () => {
  await withTempProject(async (projectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const response = await handleRecordResultFeedback(
      {
        outcome: 'memory-stale',
        targetType: 'feature-memory',
        query: 'Trace retrieval flow',
        targetId: 'SearchService',
        title: 'SearchService stale memory',
        details: 'SearchService memory points to legacy path',
        format: 'json',
      },
      projectRoot,
    );

    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.tool, 'record_result_feedback');
    assert.equal(payload.memory.type, 'feedback');
    assert.equal(payload.memory.source, 'user-explicit');
    assert.match(payload.memory.summary, /memory-stale/);
    assert.match(payload.memory.summary, /SearchService/);

    const store = new MemoryStore(projectRoot);
    const feedback = await store.findLongTermMemories('SearchService', {
      types: ['feedback'],
      scope: 'project',
      staleDays: 30,
    });
    assert.equal(feedback.length, 1);
    assert.equal(feedback[0].memory.type, 'feedback');
  });
});

test('record_decision persists reviewer metadata', async () => {
  await withTempProject(async (projectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    await handleRecordDecision(
      {
        id: '2026-04-reviewer',
        title: 'Decision with reviewer',
        context: 'Need reviewer metadata',
        decision: 'Store reviewer in decision context payload',
        alternatives: [],
        rationale: 'P2 governance needs auditability',
        consequences: ['Reviewer visible in listings'],
        reviewer: 'ops-lead',
      },
      projectRoot,
    );

    const store = new MemoryStore(projectRoot);
    const decision = await store.readDecision('2026-04-reviewer');
    assert.equal(decision?.reviewer, 'ops-lead');
  });
});

test('record_memory persists evidenceRefs when provided', async () => {
  await withTempProject(async (projectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    await handleRecordMemory(
      {
        name: 'SearchService',
        responsibility: 'orchestrates retrieval and packing',
        dir: 'src/search',
        files: ['SearchService.ts'],
        exports: ['SearchService'],
        endpoints: [],
        imports: ['GraphExpander'],
        external: [],
        dataFlow: 'query -> rank -> pack',
        keyPatterns: ['search'],
        evidenceRefs: ['evidence:incident-123', 'evidence:profile-note'],
      } as any,
      projectRoot,
    );

    const store = new MemoryStore(projectRoot);
    const memory = await store.readFeature('SearchService');
    assert.deepEqual(memory?.evidenceRefs, ['evidence:incident-123', 'evidence:profile-note']);
  });
});

test('record_decision persists evidenceRefs when provided', async () => {
  await withTempProject(async (projectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    await handleRecordDecision(
      {
        id: '2026-04-evidence-backed-decision',
        title: 'Prefer direct embeddings',
        context: 'Gateway path proved slower during indexing.',
        decision: 'Use direct SiliconFlow for default indexing path.',
        alternatives: [],
        rationale: 'Observed lower latency and fewer upstream failures.',
        consequences: ['Gateway becomes failover instead of default'],
        reviewer: 'infra-lead',
        evidenceRefs: ['evidence:bench-2026-04-08', 'evidence:incident-123'],
      } as any,
      projectRoot,
    );

    const store = new MemoryStore(projectRoot);
    const decision = await store.readDecision('2026-04-evidence-backed-decision');
    assert.deepEqual(decision?.evidenceRefs, ['evidence:bench-2026-04-08', 'evidence:incident-123']);
  });
});

test('decision:list supports reviewer filter and json output', async () => {
  await withTempProject(async (projectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    await handleRecordDecision(
      {
        id: '2026-04-reviewer-a',
        title: 'Decision A',
        context: 'ctx',
        decision: 'A',
        alternatives: [],
        rationale: 'r',
        consequences: [],
        reviewer: 'ops-lead',
      },
      projectRoot,
    );

    await handleRecordDecision(
      {
        id: '2026-04-reviewer-b',
        title: 'Decision B',
        context: 'ctx',
        decision: 'B',
        alternatives: [],
        rationale: 'r',
        consequences: [],
        reviewer: 'search-lead',
      },
      projectRoot,
    );

    const previousBaseDir = process.env.CONTEXTATLAS_BASE_DIR;
    process.env.CONTEXTATLAS_BASE_DIR = path.dirname(dbPath);

    try {
      const result = spawnSync(
        'node',
        [
          '--import',
          'tsx',
          'src/index.ts',
          'decision:list',
          '--repo',
          projectRoot,
          '--reviewer',
          'ops-lead',
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
      assert.equal(payload.result_count, 1);
      assert.equal(payload.decisions[0].reviewer, 'ops-lead');
      assert.equal(payload.decisions[0].id, '2026-04-reviewer-a');
    } finally {
      if (previousBaseDir === undefined) {
        delete process.env.CONTEXTATLAS_BASE_DIR;
      } else {
        process.env.CONTEXTATLAS_BASE_DIR = previousBaseDir;
      }
    }
  });
});

test('find_memory excludes suggested memories and prefers human-confirmed memories', async () => {
  await withTempProject(async (projectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));
    const store = new MemoryStore(projectRoot);

    await store.saveFeature({
      name: 'SearchService',
      responsibility: 'search pipeline confirmed entry',
      location: { dir: 'src/search', files: ['SearchService.ts'] },
      api: { exports: ['SearchService'], endpoints: [] },
      dependencies: { imports: ['GraphExpander'], external: [] },
      dataFlow: 'query -> rank',
      keyPatterns: ['search', 'pipeline'],
      lastUpdated: new Date().toISOString(),
      confirmationStatus: 'human-confirmed',
    });

    await store.saveFeature({
      name: 'SearchSuggestionService',
      responsibility: 'search pipeline draft candidate',
      location: { dir: 'src/search', files: ['SearchSuggestionService.ts'] },
      api: { exports: ['SearchSuggestionService'], endpoints: [] },
      dependencies: { imports: ['GraphExpander'], external: [] },
      dataFlow: 'query -> rank',
      keyPatterns: ['search', 'pipeline'],
      lastUpdated: new Date().toISOString(),
      confirmationStatus: 'suggested',
    });

    await store.saveFeature({
      name: 'SearchAgentService',
      responsibility: 'search pipeline inferred entry',
      location: { dir: 'src/search', files: ['SearchAgentService.ts'] },
      api: { exports: ['SearchAgentService'], endpoints: [] },
      dependencies: { imports: ['GraphExpander'], external: [] },
      dataFlow: 'query -> rank',
      keyPatterns: ['search', 'pipeline'],
      lastUpdated: new Date().toISOString(),
      confirmationStatus: 'agent-inferred',
    });

    const response = await handleFindMemory(
      { query: 'search pipeline', limit: 10, minScore: 0, format: 'json' },
      projectRoot,
    );
    const payload = JSON.parse(response.content[0].text);

    assert.equal(payload.result_count, 2);
    assert.equal(payload.results[0].memory.name, 'SearchService');
    assert.equal(payload.results[1].memory.name, 'SearchAgentService');
    assert.ok(!payload.results.some((entry: { memory: { name: string } }) => entry.memory.name === 'SearchSuggestionService'));
  });
});

test('load_module_memory excludes suggested memories from main path results', async () => {
  await withTempProject(async (projectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));
    const store = new MemoryStore(projectRoot);

    await store.saveFeature({
      name: 'SearchService',
      responsibility: 'confirmed search pipeline',
      location: { dir: 'src/search', files: ['SearchService.ts'] },
      api: { exports: ['SearchService'], endpoints: [] },
      dependencies: { imports: ['GraphExpander'], external: [] },
      dataFlow: 'query -> rank',
      keyPatterns: ['search', 'pipeline'],
      lastUpdated: new Date().toISOString(),
      confirmationStatus: 'human-confirmed',
    });

    await store.saveFeature({
      name: 'SearchDraftService',
      responsibility: 'draft search pipeline',
      location: { dir: 'src/search', files: ['SearchDraftService.ts'] },
      api: { exports: ['SearchDraftService'], endpoints: [] },
      dependencies: { imports: ['GraphExpander'], external: [] },
      dataFlow: 'query -> rank',
      keyPatterns: ['search', 'pipeline'],
      lastUpdated: new Date().toISOString(),
      confirmationStatus: 'suggested',
    });

    const response = await handleLoadModuleMemory(
      {
        query: 'search pipeline',
        maxResults: 10,
        useMmr: false,
        format: 'json',
      },
      projectRoot,
    );
    const payload = JSON.parse(response.content[0].text);

    assert.equal(payload.result_count, 1);
    assert.equal(payload.memories[0].name, 'SearchService');
    assert.equal(payload.memories[0].confirmationStatus, 'human-confirmed');
  });
});


test('checkpoint MCP tools can create, load, and list checkpoints', async () => {
  await withTempProject(async (projectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const createResponse = await handleCreateCheckpoint({
      repo_path: projectRoot,
      title: 'Retrieval overview',
      goal: 'Understand retrieval path',
      phase: 'overview',
      summary: 'Captured current retrieval overview',
      activeBlockIds: ['block:overview'],
      exploredRefs: ['src/search/SearchService.ts:L1-L30'],
      keyFindings: ['SearchService is the main orchestration entry'],
      unresolvedQuestions: ['How to persist handoff state?'],
      nextSteps: ['Inspect MemoryStore'],
      format: 'json',
      supportingRefs: ['evidence:bench-2026-04-08'],
    } as any);

    const created = JSON.parse(createResponse.content[0].text);
    assert.equal(created.tool, 'create_checkpoint');
    assert.equal(created.checkpoint.phase, 'overview');
    assert.ok(created.checkpoint.id);
    assert.equal(created.contextBlocks[0].type, 'task-state');
    assert.equal(created.contextBlocks[0].memoryKind, 'task-state');
    assert.equal(created.handoff.checkpointId, created.checkpoint.id);
    assert.equal(created.handoff.contextBlockId, created.contextBlocks[0].id);
    assert.equal(created.handoffBundle.kind, 'handoff-bundle');
    assert.equal(created.handoffBundle.checkpointId, created.checkpoint.id);
    assert.equal(created.handoffBundle.handoff.checkpointId, created.checkpoint.id);
    assert.equal(created.resumeBundle.kind, 'resume-bundle');
    assert.equal(created.resumeBundle.resumeFromCheckpointId, created.checkpoint.id);
    assert.equal(created.summary.activeBlockCount, 1);
    assert.equal(created.summary.nextStepCount, 1);
    assert.deepEqual(created.checkpoint.supportingRefs, ['evidence:bench-2026-04-08']);

    const loadResponse = await handleLoadCheckpoint({
      repo_path: projectRoot,
      checkpoint_id: created.checkpoint.id,
      format: 'json',
    });
    const loaded = JSON.parse(loadResponse.content[0].text);
    assert.equal(loaded.tool, 'load_checkpoint');
    assert.equal(loaded.checkpoint.id, created.checkpoint.id);
    assert.equal(loaded.checkpoint.goal, 'Understand retrieval path');
    assert.equal(loaded.contextBlocks[0].type, 'task-state');
    assert.equal(loaded.handoff.checkpointId, created.checkpoint.id);
    assert.equal(loaded.handoffBundle.kind, 'handoff-bundle');
    assert.equal(loaded.resumeBundle.kind, 'resume-bundle');
    assert.deepEqual(loaded.checkpoint.supportingRefs, ['evidence:bench-2026-04-08']);

    const listResponse = await handleListCheckpoints({
      repo_path: projectRoot,
      format: 'json',
    });
    const listed = JSON.parse(listResponse.content[0].text);
    assert.equal(listed.tool, 'list_checkpoints');
    assert.equal(listed.total, 1);
    assert.equal(listed.checkpoints[0].id, created.checkpoint.id);
    assert.equal(listed.contextBlocks[0].type, 'task-state');
    assert.equal(listed.summary.phaseCounts.overview, 1);

    const textResponse = await handleLoadCheckpoint({
      repo_path: projectRoot,
      checkpoint_id: created.checkpoint.id,
      format: 'text',
    });
    assert.match(textResponse.content[0].text, /## Task Checkpoint/);
    assert.match(textResponse.content[0].text, /### Next Steps/);
  });
});
