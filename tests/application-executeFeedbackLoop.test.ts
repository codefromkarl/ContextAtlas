import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { executeRecordResultFeedback } from '../src/application/memory/executeFeedbackLoop.js';
import { MemoryHubDatabase } from '../src/memory/MemoryHubDatabase.js';
import { MemoryStore } from '../src/memory/MemoryStore.js';

async function withTempProjects(
  run: (projectA: string, projectB: string, dbPath: string) => Promise<void>,
): Promise<void> {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cw-feedback-loop-'));
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

test('executeRecordResultFeedback records helpful outcome with JSON format', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const response = await executeRecordResultFeedback(
      {
        outcome: 'helpful',
        targetType: 'feature-memory',
        query: 'How to use SearchService',
        targetId: 'SearchService',
        title: 'SearchService retrieval was helpful',
        details: 'The SearchService documentation helped resolve the query quickly.',
        format: 'json',
      },
      projectRoot,
    );

    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.tool, 'record_result_feedback');
    assert.equal(payload.write_action, 'created');
    assert.equal(payload.memory.type, 'feedback');
    assert.equal(payload.memory.title, 'SearchService retrieval was helpful');
    assert.ok(payload.memory.tags.includes('feedback'));
    assert.ok(payload.memory.tags.includes('helpful'));
    assert.ok(payload.memory.tags.includes('feature-memory'));
    assert.ok(payload.memory.tags.includes('SearchService'));
  });
});

test('executeRecordResultFeedback records not-helpful outcome', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const response = await executeRecordResultFeedback(
      {
        outcome: 'not-helpful',
        targetType: 'code',
        query: 'Database connection pool configuration',
        targetId: 'DatabaseConfig',
        details: 'The retrieved code was outdated and did not match current implementation.',
        format: 'json',
      },
      projectRoot,
    );

    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.memory.type, 'feedback');
    assert.ok(payload.memory.tags.includes('not-helpful'));
    assert.ok(payload.memory.tags.includes('code'));
    assert.ok(payload.memory.tags.includes('DatabaseConfig'));
    assert.ok(payload.memory.summary.includes('outcome=not-helpful'));
    assert.ok(payload.memory.summary.includes('DatabaseConfig'));
  });
});

test('executeRecordResultFeedback records memory-stale outcome', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const response = await executeRecordResultFeedback(
      {
        outcome: 'memory-stale',
        targetType: 'feature-memory',
        query: 'Trace retrieval flow',
        targetId: 'SearchService',
        details: 'The retrieval flow description references legacy components that have been refactored.',
        format: 'json',
      },
      projectRoot,
    );

    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.memory.type, 'feedback');
    assert.ok(payload.memory.tags.includes('memory-stale'));
    assert.ok(payload.memory.tags.includes('feature-memory'));
    assert.ok(payload.memory.summary.includes('outcome=memory-stale'));
    assert.equal(payload.memory.why, 'The retrieval flow description references legacy components that have been refactored.');
  });
});

test('executeRecordResultFeedback records wrong-module outcome', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const response = await executeRecordResultFeedback(
      {
        outcome: 'wrong-module',
        targetType: 'long-term-memory',
        query: 'Authentication flow documentation',
        targetId: 'AuthService',
        details: 'The retrieved memory was about OAuth but user needed local auth flow.',
        format: 'json',
      },
      projectRoot,
    );

    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.memory.type, 'feedback');
    assert.ok(payload.memory.tags.includes('wrong-module'));
    assert.ok(payload.memory.tags.includes('long-term-memory'));
    assert.ok(payload.memory.summary.includes('outcome=wrong-module'));
  });
});

test('executeRecordResultFeedback generates default title when not provided', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const response = await executeRecordResultFeedback(
      {
        outcome: 'helpful',
        targetType: 'decision-record',
        query: 'Architecture decision for caching',
        format: 'json',
      },
      projectRoot,
    );

    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.memory.title, 'decision-record:general:helpful');
  });
});

test('executeRecordResultFeedback records with text format', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const response = await executeRecordResultFeedback(
      {
        outcome: 'helpful',
        targetType: 'feature-memory',
        query: 'How to use the cache system',
        targetId: 'CacheService',
        details: 'Perfect explanation of the cache implementation.',
        format: 'text',
      },
      projectRoot,
    );

    const text = response.content[0].text;
    assert.match(text, /## Result Feedback Recorded/);
    assert.match(text, /\*\*Outcome\*\*: helpful/);
    assert.match(text, /\*\*Target Type\*\*: feature-memory/);
    assert.match(text, /\*\*Target ID\*\*: CacheService/);
    assert.match(text, /\*\*Saved Memory ID\*\*:/);
  });
});

test('executeRecordResultFeedback handles query without targetId', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const response = await executeRecordResultFeedback(
      {
        outcome: 'not-helpful',
        targetType: 'code',
        query: 'General search for validation patterns',
        details: 'Results were too generic and not applicable to our use case.',
        format: 'json',
      },
      projectRoot,
    );

    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.memory.type, 'feedback');
    assert.ok(payload.memory.tags.includes('not-helpful'));
    assert.ok(payload.memory.tags.includes('code'));
    assert.ok(payload.memory.summary.includes('query=General search for validation patterns'));
    assert.equal(payload.memory.howToApply, '后续检索到 code 时优先参考这条反馈');
  });
});

test('executeRecordResultFeedback includes all information in summary', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const response = await executeRecordResultFeedback(
      {
        outcome: 'helpful',
        targetType: 'decision-record',
        query: 'Database migration strategy',
        targetId: 'migration-2024',
        details: 'The decision record provided clear guidance on our migration approach.',
        format: 'json',
      },
      projectRoot,
    );

    const payload = JSON.parse(response.content[0].text);
    assert.ok(payload.memory.summary.includes('outcome=helpful'));
    assert.ok(payload.memory.summary.includes('targetType=decision-record'));
    assert.ok(payload.memory.summary.includes('target=migration-2024'));
    assert.ok(payload.memory.summary.includes('query=Database migration strategy'));
    assert.ok(payload.memory.summary.includes('details=The decision record provided clear guidance'));
  });
});

test('executeRecordResultFeedback sets correct provenance', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const response = await executeRecordResultFeedback(
      {
        outcome: 'memory-stale',
        targetType: 'feature-memory',
        query: 'Update service implementation',
        targetId: 'UpdateService',
        details: 'Memory refers to old API endpoints that were refactored.',
        format: 'json',
      },
      projectRoot,
    );

    const payload = JSON.parse(response.content[0].text);
    assert.ok(payload.memory.provenance.includes('Update service implementation'));
    assert.ok(payload.memory.provenance.includes('UpdateService'));
  });
});

test('executeRecordResultFeedback sets correct memory metadata', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const response = await executeRecordResultFeedback(
      {
        outcome: 'helpful',
        targetType: 'long-term-memory',
        query: 'Performance optimization patterns',
        details: 'Great insights on async optimization.',
        format: 'json',
      },
      projectRoot,
    );

    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.memory.scope, 'project');
    assert.equal(payload.memory.source, 'user-explicit');
    assert.equal(payload.memory.confidence, 1);
    assert.equal(payload.memory.durability, 'stable');
    assert.ok(payload.memory.lastVerifiedAt);
  });
});

test('executeRecordResultFeedback merges duplicate feedback entries', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    // Record first feedback
    const firstResponse = await executeRecordResultFeedback(
      {
        outcome: 'memory-stale',
        targetType: 'feature-memory',
        query: 'Trace retrieval flow',
        targetId: 'SearchService',
        details: 'legacy path',
        format: 'json',
      },
      projectRoot,
    );

    const firstPayload = JSON.parse(firstResponse.content[0].text);
    assert.equal(firstPayload.write_action, 'created');

    // Record duplicate feedback
    const secondResponse = await executeRecordResultFeedback(
      {
        outcome: 'memory-stale',
        targetType: 'feature-memory',
        query: 'Trace retrieval flow',
        targetId: 'SearchService',
        details: 'legacy path',
        format: 'json',
      },
      projectRoot,
    );

    const secondPayload = JSON.parse(secondResponse.content[0].text);
    assert.equal(secondPayload.write_action, 'merged');

    // Verify only one feedback entry exists
    const store = new MemoryStore(projectRoot);
    const feedback = await store.findLongTermMemories('SearchService', {
      types: ['feedback'],
      scope: 'project',
    });

    assert.equal(feedback.length, 1);
    assert.ok(feedback[0].memory.provenance?.includes('Trace retrieval flow'));
    assert.ok(feedback[0].memory.provenance?.includes('SearchService'));
  });
});

test('executeRecordResultFeedback handles all target types', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const targetTypes = ['code', 'feature-memory', 'decision-record', 'long-term-memory'] as const;

    for (const targetType of targetTypes) {
      const response = await executeRecordResultFeedback(
        {
          outcome: 'helpful',
          targetType,
          query: `Test query for ${targetType}`,
          targetId: `${targetType}-test-id`,
          details: `Testing feedback for ${targetType}`,
          format: 'json',
        },
        projectRoot,
      );

      const payload = JSON.parse(response.content[0].text);
      assert.equal(payload.memory.type, 'feedback');
      assert.ok(payload.memory.tags.includes(targetType));
      assert.ok(payload.memory.tags.includes(`${targetType}-test-id`));
    }

    // Verify all feedback types were recorded
    const store = new MemoryStore(projectRoot);
    const allFeedback = await store.listLongTermMemories({
      types: ['feedback'],
      scope: 'project',
    });

    assert.equal(allFeedback.length, 4);
  });
});

test('executeRecordResultFeedback preserves feedback in memory store for retrieval', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    await executeRecordResultFeedback(
      {
        outcome: 'wrong-module',
        targetType: 'feature-memory',
        query: 'Authentication implementation',
        targetId: 'AuthService',
        details: 'Needed session auth but got OAuth documentation.',
        format: 'json',
      },
      projectRoot,
    );

    // Verify feedback can be retrieved
    const store = new MemoryStore(projectRoot);
    const feedbackMemories = await store.listLongTermMemories({
      types: ['feedback'],
      scope: 'project',
    });

    assert.equal(feedbackMemories.length, 1);
    assert.equal(feedbackMemories[0].title, 'feature-memory:AuthService:wrong-module');
    assert.ok(feedbackMemories[0].tags.includes('wrong-module'));
    assert.ok(feedbackMemories[0].tags.includes('AuthService'));
  });
});
