import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  executeCreateCheckpoint,
  executeListCheckpoints,
  executeLoadCheckpoint,
} from '../src/application/memory/executeCheckpoints.js';
import { MemoryHubDatabase } from '../src/memory/MemoryHubDatabase.js';
import { MemoryStore } from '../src/memory/MemoryStore.js';

async function withTempProjects(
  run: (projectA: string, projectB: string, dbPath: string) => Promise<void>,
): Promise<void> {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cw-checkpoints-'));
  const projectA = path.join(tempDir, 'project-a');
  const projectB = path.join(tempDir, 'project-b');
  const dbPath = path.join(tempDir, 'memory-hub.db');

  try {
    await run(projectA, projectB, dbPath);
  } finally {
    MemoryStore.resetSharedHubForTests();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

test('executeCreateCheckpoint creates a checkpoint with JSON format', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const response = await executeCreateCheckpoint({
      repo_path: projectRoot,
      title: 'Handoff checkpoint',
      goal: 'Capture session state for handoff',
      phase: 'handoff',
      summary: 'Completed SearchService implementation and testing',
      activeBlockIds: ['block:a', 'block:b'],
      exploredRefs: ['src/search/SearchService.ts', 'src/search/types.ts'],
      supportingRefs: ['docs/search-architecture.md'],
      keyFindings: ['SearchService now handles 1000 QPS', 'Memory usage optimized by 40%'],
      unresolvedQuestions: ['Need to optimize cache eviction policy'],
      nextSteps: ['Implement cache warming', 'Add performance monitoring'],
      format: 'json',
    });

    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.tool, 'create_checkpoint');
    assert.ok(payload.checkpoint.id);
    assert.equal(payload.checkpoint.title, 'Handoff checkpoint');
    assert.equal(payload.checkpoint.goal, 'Capture session state for handoff');
    assert.equal(payload.checkpoint.phase, 'handoff');
    assert.equal(payload.checkpoint.summary, 'Completed SearchService implementation and testing');
    assert.deepEqual(payload.checkpoint.activeBlockIds, ['block:a', 'block:b']);
    assert.deepEqual(payload.checkpoint.exploredRefs, ['src/search/SearchService.ts', 'src/search/types.ts']);
    assert.deepEqual(payload.checkpoint.supportingRefs, ['docs/search-architecture.md']);
    assert.deepEqual(payload.checkpoint.keyFindings, ['SearchService now handles 1000 QPS', 'Memory usage optimized by 40%']);
    assert.deepEqual(payload.checkpoint.unresolvedQuestions, ['Need to optimize cache eviction policy']);
    assert.deepEqual(payload.checkpoint.nextSteps, ['Implement cache warming', 'Add performance monitoring']);
    assert.ok(payload.handoffBundle);
    assert.ok(payload.resumeBundle);
  });
});

test('executeCreateCheckpoint creates a checkpoint with text format', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const response = await executeCreateCheckpoint({
      repo_path: projectRoot,
      title: 'Research checkpoint',
      goal: 'Document research findings',
      phase: 'research',
      summary: 'Investigated retrieval performance issues',
      keyFindings: ['Database queries are main bottleneck', 'Indexing improves performance by 10x'],
      nextSteps: ['Implement database indexing', 'Add query caching'],
      format: 'text',
    });

    const text = response.content[0].text;
    assert.match(text, /## Task Checkpoint/);
    assert.match(text, /\*\*Title\*\*: Research checkpoint/);
    assert.match(text, /\*\*Goal\*\*: Document research findings/);
    assert.match(text, /\*\*Phase\*\*: research/);
    assert.match(text, /\*\*Summary\*\*: Investigated retrieval performance issues/);
    assert.match(text, /### Key Findings/);
    assert.match(text, /- Database queries are main bottleneck/);
    assert.match(text, /- Indexing improves performance by 10x/);
    assert.match(text, /### Unresolved Questions/);
    assert.match(text, /- None/);
    assert.match(text, /### Next Steps/);
    assert.match(text, /- Implement database indexing/);
    assert.match(text, /- Add query caching/);
    assert.match(text, /\*\*Saved to\*\*:/);
  });
});

test('executeCreateCheckpoint handles minimal required fields', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const response = await executeCreateCheckpoint({
      repo_path: projectRoot,
      title: 'Minimal checkpoint',
      goal: 'Test minimal fields',
      phase: 'implementation',
      summary: 'Basic checkpoint with minimal data',
      format: 'json',
    });

    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.checkpoint.title, 'Minimal checkpoint');
    assert.equal(payload.checkpoint.goal, 'Test minimal fields');
    assert.equal(payload.checkpoint.phase, 'implementation');
    assert.equal(payload.checkpoint.summary, 'Basic checkpoint with minimal data');
    assert.deepEqual(payload.checkpoint.activeBlockIds, []);
    assert.deepEqual(payload.checkpoint.exploredRefs, []);
    assert.deepEqual(payload.checkpoint.supportingRefs, []);
    assert.deepEqual(payload.checkpoint.keyFindings, []);
    assert.deepEqual(payload.checkpoint.unresolvedQuestions, []);
    assert.deepEqual(payload.checkpoint.nextSteps, []);
  });
});

test('executeCreateCheckpoint generates unique IDs for different checkpoints', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const response1 = await executeCreateCheckpoint({
      repo_path: projectRoot,
      title: 'First checkpoint',
      goal: 'Test ID generation',
      phase: 'overview',
      summary: 'First checkpoint',
      format: 'json',
    });

    const response2 = await executeCreateCheckpoint({
      repo_path: projectRoot,
      title: 'Second checkpoint',
      goal: 'Test ID generation',
      phase: 'overview',
      summary: 'Second checkpoint',
      format: 'json',
    });

    const payload1 = JSON.parse(response1.content[0].text);
    const payload2 = JSON.parse(response2.content[0].text);

    assert.notEqual(payload1.checkpoint.id, payload2.checkpoint.id);
    assert.ok(payload1.checkpoint.id.startsWith('chk_'));
    assert.ok(payload2.checkpoint.id.startsWith('chk_'));
  });
});

test('executeLoadCheckpoint loads an existing checkpoint with JSON format', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    // Create a checkpoint first
    const createResponse = await executeCreateCheckpoint({
      repo_path: projectRoot,
      title: 'Load test checkpoint',
      goal: 'Test checkpoint loading',
      phase: 'verification',
      summary: 'Testing checkpoint load functionality',
      keyFindings: ['Load works correctly'],
      format: 'json',
    });

    const createPayload = JSON.parse(createResponse.content[0].text);
    const checkpointId = createPayload.checkpoint.id;

    // Load the checkpoint
    const loadResponse = await executeLoadCheckpoint({
      repo_path: projectRoot,
      checkpoint_id: checkpointId,
      format: 'json',
    });

    const loadPayload = JSON.parse(loadResponse.content[0].text);
    assert.equal(loadPayload.tool, 'load_checkpoint');
    assert.equal(loadPayload.checkpoint.id, checkpointId);
    assert.equal(loadPayload.checkpoint.title, 'Load test checkpoint');
    assert.equal(loadPayload.checkpoint.phase, 'verification');
    assert.deepEqual(loadPayload.checkpoint.keyFindings, ['Load works correctly']);
    assert.ok(loadPayload.handoffBundle);
    assert.ok(loadPayload.resumeBundle);
  });
});

test('executeLoadCheckpoint loads an existing checkpoint with text format', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    // Create a checkpoint first
    const createResponse = await executeCreateCheckpoint({
      repo_path: projectRoot,
      title: 'Text format load test',
      goal: 'Test text format loading',
      phase: 'debug',
      summary: 'Testing text format checkpoint load',
      keyFindings: ['Text format works'],
      unresolvedQuestions: ['Why does text format look different?'],
      format: 'json',
    });

    const createPayload = JSON.parse(createResponse.content[0].text);
    const checkpointId = createPayload.checkpoint.id;

    // Load the checkpoint
    const loadResponse = await executeLoadCheckpoint({
      repo_path: projectRoot,
      checkpoint_id: checkpointId,
      format: 'text',
    });

    const text = loadResponse.content[0].text;
    assert.match(text, /## Task Checkpoint/);
    assert.match(text, /\*\*Title\*\*: Text format load test/);
    assert.match(text, /\*\*Phase\*\*: debug/);
    assert.match(text, /### Key Findings/);
    assert.match(text, /- Text format works/);
    assert.match(text, /### Unresolved Questions/);
    assert.match(text, /- Why does text format look different\?/);
  });
});

test('executeLoadCheckpoint returns error for non-existent checkpoint', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const response = await executeLoadCheckpoint({
      repo_path: projectRoot,
      checkpoint_id: 'nonexistent_checkpoint_id',
      format: 'json',
    });

    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /Checkpoint not found/);
    assert.match(response.content[0].text, /nonexistent_checkpoint_id/);
  });
});

test('executeListCheckpoints lists all checkpoints with JSON format', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    // Create multiple checkpoints
    await executeCreateCheckpoint({
      repo_path: projectRoot,
      title: 'First checkpoint',
      goal: 'Test listing',
      phase: 'overview',
      summary: 'First checkpoint',
      format: 'json',
    });

    await executeCreateCheckpoint({
      repo_path: projectRoot,
      title: 'Second checkpoint',
      goal: 'Test listing',
      phase: 'research',
      summary: 'Second checkpoint',
      format: 'json',
    });

    await executeCreateCheckpoint({
      repo_path: projectRoot,
      title: 'Third checkpoint',
      goal: 'Test listing',
      phase: 'implementation',
      summary: 'Third checkpoint',
      format: 'json',
    });

    // List checkpoints
    const response = await executeListCheckpoints({
      repo_path: projectRoot,
      format: 'json',
    });

    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.tool, 'list_checkpoints');
    assert.equal(payload.total, 3);
    assert.equal(payload.checkpoints.length, 3);
    assert.equal(payload.summary.total, 3);
    assert.equal(payload.summary.phaseCounts.overview, 1);
    assert.equal(payload.summary.phaseCounts.research, 1);
    assert.equal(payload.summary.phaseCounts.implementation, 1);
    assert.ok(payload.contextBlocks);
    assert.equal(payload.contextBlocks.length, 3);
  });
});

test('executeListCheckpoints lists all checkpoints with text format', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    // Create multiple checkpoints
    await executeCreateCheckpoint({
      repo_path: projectRoot,
      title: 'Overview checkpoint',
      goal: 'Initial setup',
      phase: 'overview',
      summary: 'Project overview',
      format: 'json',
    });

    await executeCreateCheckpoint({
      repo_path: projectRoot,
      title: 'Research checkpoint',
      goal: 'Investigation',
      phase: 'research',
      summary: 'Research findings',
      format: 'json',
    });

    // List checkpoints
    const response = await executeListCheckpoints({
      repo_path: projectRoot,
      format: 'text',
    });

    const text = response.content[0].text;
    assert.match(text, /## Task Checkpoints/);
    assert.match(text, /\*\*Total\*\*: 2/);
    assert.match(text, /overview \| Overview checkpoint/);
    assert.match(text, /research \| Research checkpoint/);
  });
});

test('executeListCheckpoints handles empty checkpoint list', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const response = await executeListCheckpoints({
      repo_path: projectRoot,
      format: 'text',
    });

    const text = response.content[0].text;
    assert.match(text, /## Task Checkpoints/);
    assert.match(text, /\*\*Total\*\*: 0/);
    assert.match(text, /- None/);
  });
});

test('executeListCheckpoints counts phases correctly', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    // Create checkpoints in different phases
    await executeCreateCheckpoint({
      repo_path: projectRoot,
      title: 'Overview 1',
      goal: 'Test',
      phase: 'overview',
      summary: 'Overview',
      format: 'json',
    });

    await executeCreateCheckpoint({
      repo_path: projectRoot,
      title: 'Overview 2',
      goal: 'Test',
      phase: 'overview',
      summary: 'Overview',
      format: 'json',
    });

    await executeCreateCheckpoint({
      repo_path: projectRoot,
      title: 'Research 1',
      goal: 'Test',
      phase: 'research',
      summary: 'Research',
      format: 'json',
    });

    await executeCreateCheckpoint({
      repo_path: projectRoot,
      title: 'Implementation 1',
      goal: 'Test',
      phase: 'implementation',
      summary: 'Implementation',
      format: 'json',
    });

    const response = await executeListCheckpoints({
      repo_path: projectRoot,
      format: 'json',
    });

    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.total, 4);
    assert.equal(payload.summary.phaseCounts.overview, 2);
    assert.equal(payload.summary.phaseCounts.research, 1);
    assert.equal(payload.summary.phaseCounts.implementation, 1);
    assert.equal(payload.summary.phaseCounts.debug, 0);
    assert.equal(payload.summary.phaseCounts.verification, 0);
    assert.equal(payload.summary.phaseCounts.handoff, 0);
  });
});

test('checkpoint operations work with MemoryStore integration', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    // Create checkpoint via application layer
    const createResponse = await executeCreateCheckpoint({
      repo_path: projectRoot,
      title: 'Integration test checkpoint',
      goal: 'Test MemoryStore integration',
      phase: 'verification',
      summary: 'Testing integration with MemoryStore',
      keyFindings: ['Integration works'],
      format: 'json',
    });

    const createPayload = JSON.parse(createResponse.content[0].text);
    const checkpointId = createPayload.checkpoint.id;

    // Verify checkpoint exists in MemoryStore
    const store = new MemoryStore(projectRoot);
    const checkpoints = await store.listCheckpoints();
    assert.equal(checkpoints.length, 1);
    assert.equal(checkpoints[0]?.id, checkpointId);

    // Load checkpoint via application layer
    const loadResponse = await executeLoadCheckpoint({
      repo_path: projectRoot,
      checkpoint_id: checkpointId,
      format: 'json',
    });

    const loadPayload = JSON.parse(loadResponse.content[0].text);
    assert.equal(loadPayload.checkpoint.id, checkpointId);
    assert.equal(loadPayload.checkpoint.title, 'Integration test checkpoint');

    // List checkpoints via application layer
    const listResponse = await executeListCheckpoints({
      repo_path: projectRoot,
      format: 'json',
    });

    const listPayload = JSON.parse(listResponse.content[0].text);
    assert.equal(listPayload.total, 1);
    assert.equal(listPayload.checkpoints[0]?.id, checkpointId);
  });
});

test('executeCreateCheckpoint handles all phase types', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const phases: Array<'overview' | 'research' | 'debug' | 'implementation' | 'verification' | 'handoff'> = [
      'overview',
      'research',
      'debug',
      'implementation',
      'verification',
      'handoff',
    ];

    for (const phase of phases) {
      const response = await executeCreateCheckpoint({
        repo_path: projectRoot,
        title: `${phase} checkpoint`,
        goal: `Test ${phase} phase`,
        phase,
        summary: `Testing ${phase} checkpoint creation`,
        format: 'json',
      });

      const payload = JSON.parse(response.content[0].text);
      assert.equal(payload.checkpoint.phase, phase);
    }

    // Verify all checkpoints were created
    const store = new MemoryStore(projectRoot);
    const checkpoints = await store.listCheckpoints();
    assert.equal(checkpoints.length, 6);
  });
});

test('executeCreateCheckpoint preserves arrays and complex data', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const complexData = {
      activeBlockIds: ['block:search', 'block:cache', 'block:database'],
      exploredRefs: ['src/search/SearchService.ts', 'src/cache/CacheManager.ts', 'src/db/Database.ts'],
      supportingRefs: ['docs/architecture.md', 'docs/api.md'],
      keyFindings: [
        'Search performance improved by 300%',
        'Cache hit rate increased to 85%',
        'Database queries optimized',
      ],
      unresolvedQuestions: [
        'How to handle cache invalidation?',
        'Should we implement read replicas?',
        'What about failover scenarios?',
      ],
      nextSteps: [
        'Implement cache invalidation strategy',
        'Add database replication',
        'Set up failover mechanism',
        'Add monitoring dashboards',
      ],
    };

    const response = await executeCreateCheckpoint({
      repo_path: projectRoot,
      title: 'Complex data checkpoint',
      goal: 'Test complex data preservation',
      phase: 'implementation',
      summary: 'Testing preservation of complex arrays',
      ...complexData,
      format: 'json',
    });

    const payload = JSON.parse(response.content[0].text);
    assert.deepEqual(payload.checkpoint.activeBlockIds, complexData.activeBlockIds);
    assert.deepEqual(payload.checkpoint.exploredRefs, complexData.exploredRefs);
    assert.deepEqual(payload.checkpoint.supportingRefs, complexData.supportingRefs);
    assert.deepEqual(payload.checkpoint.keyFindings, complexData.keyFindings);
    assert.deepEqual(payload.checkpoint.unresolvedQuestions, complexData.unresolvedQuestions);
    assert.deepEqual(payload.checkpoint.nextSteps, complexData.nextSteps);
  });
});
