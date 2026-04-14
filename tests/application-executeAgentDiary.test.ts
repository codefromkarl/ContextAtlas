import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  executeFindAgentDiary,
  executeReadAgentDiary,
  executeRecordAgentDiary,
} from '../src/application/memory/executeAgentDiary.js';
import { MemoryHubDatabase } from '../src/memory/MemoryHubDatabase.js';
import { MemoryStore } from '../src/memory/MemoryStore.js';

async function withTempProjects(
  run: (projectA: string, projectB: string, dbPath: string) => Promise<void>,
): Promise<void> {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cw-agent-diary-'));
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

test('executeRecordAgentDiary records a diary entry with JSON format', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const response = await executeRecordAgentDiary(
      {
        agent_name: 'worker-alpha',
        entry: 'Investigated retrieval slowdown and switched embeddings back to direct SiliconFlow.',
        topic: 'retrieval',
        scope: 'project',
        tags: ['ops', 'retrieval'],
        format: 'json',
      },
      projectRoot,
    );

    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.tool, 'record_agent_diary');
    assert.equal(payload.memory.type, 'journal');
    assert.equal(payload.memory.title, 'worker-alpha · retrieval');
    assert.equal(payload.memory.summary, 'Investigated retrieval slowdown and switched embeddings back to direct SiliconFlow.');
    assert.ok(payload.memory.tags.includes('agent:worker-alpha'));
    assert.ok(payload.memory.tags.includes('topic:retrieval'));
    assert.ok(payload.memory.tags.includes('ops'));
    assert.ok(payload.memory.tags.includes('retrieval'));
  });
});

test('executeRecordAgentDiary records a diary entry with text format', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const response = await executeRecordAgentDiary(
      {
        agent_name: 'worker-beta',
        entry: 'Fixed authentication bug in the login flow.',
        topic: 'bugfix',
        scope: 'project',
        tags: ['auth', 'bug'],
        format: 'text',
      },
      projectRoot,
    );

    const text = response.content[0].text;
    assert.match(text, /## Agent Diary Recorded/);
    assert.match(text, /worker-beta/);
    assert.match(text, /bugfix/);
    assert.match(text, /\*\*ID\*\*:/);
  });
});

test('executeRecordAgentDiary handles provenance parameter', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const response = await executeRecordAgentDiary(
      {
        agent_name: 'worker-gamma',
        entry: 'Processed user feedback and updated documentation.',
        topic: 'documentation',
        scope: 'project',
        tags: ['docs'],
        provenance: ['session:123', 'task:feedback-processing'],
        format: 'json',
      },
      projectRoot,
    );

    const payload = JSON.parse(response.content[0].text);
    assert.deepEqual(payload.memory.provenance, ['session:123', 'task:feedback-processing']);
  });
});

test('executeReadAgentDiary reads diary entries for a specific agent', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    // Record multiple diary entries
    await executeRecordAgentDiary(
      {
        agent_name: 'worker-alpha',
        entry: 'First entry',
        topic: 'topic1',
        scope: 'project',
        tags: ['tag1'],
        format: 'json',
      },
      projectRoot,
    );

    await executeRecordAgentDiary(
      {
        agent_name: 'worker-alpha',
        entry: 'Second entry',
        topic: 'topic2',
        scope: 'project',
        tags: ['tag2'],
        format: 'json',
      },
      projectRoot,
    );

    await executeRecordAgentDiary(
      {
        agent_name: 'worker-beta',
        entry: 'Different agent entry',
        topic: 'topic3',
        scope: 'project',
        tags: ['tag3'],
        format: 'json',
      },
      projectRoot,
    );

    // Read diary entries for worker-alpha
    const response = await executeReadAgentDiary(
      {
        agent_name: 'worker-alpha',
        last_n: 10,
        scope: 'project',
        format: 'json',
      },
      projectRoot,
    );

    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.tool, 'read_agent_diary');
    assert.equal(payload.result_count, 2);
    assert.equal(payload.results[0].title, 'worker-alpha · topic2');
    assert.equal(payload.results[1].title, 'worker-alpha · topic1');
  });
});

test('executeReadAgentDiary filters by topic', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    // Record multiple diary entries with different topics
    await executeRecordAgentDiary(
      {
        agent_name: 'worker-alpha',
        entry: 'Retrieval work',
        topic: 'retrieval',
        scope: 'project',
        tags: ['ops'],
        format: 'json',
      },
      projectRoot,
    );

    await executeRecordAgentDiary(
      {
        agent_name: 'worker-alpha',
        entry: 'Documentation work',
        topic: 'documentation',
        scope: 'project',
        tags: ['docs'],
        format: 'json',
      },
      projectRoot,
    );

    await executeRecordAgentDiary(
      {
        agent_name: 'worker-alpha',
        entry: 'More retrieval work',
        topic: 'retrieval',
        scope: 'project',
        tags: ['ops'],
        format: 'json',
      },
      projectRoot,
    );

    // Read only retrieval topic entries
    const response = await executeReadAgentDiary(
      {
        agent_name: 'worker-alpha',
        last_n: 10,
        topic: 'retrieval',
        scope: 'project',
        format: 'json',
      },
      projectRoot,
    );

    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.result_count, 2);
    assert.ok(payload.results.every((item: { title: string }) => item.title.includes('retrieval')));
  });
});

test('executeReadAgentDiary respects last_n parameter', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    // Record multiple diary entries
    for (let i = 1; i <= 5; i++) {
      await executeRecordAgentDiary(
        {
          agent_name: 'worker-alpha',
          entry: `Entry ${i}`,
          topic: 'topic1',
          scope: 'project',
          tags: [`tag${i}`],
          format: 'json',
        },
        projectRoot,
      );
    }

    // Read only last 3 entries
    const response = await executeReadAgentDiary(
      {
        agent_name: 'worker-alpha',
        last_n: 3,
        scope: 'project',
        format: 'json',
      },
      projectRoot,
    );

    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.result_count, 3);
  });
});

test('executeReadAgentDiary handles no entries found', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const response = await executeReadAgentDiary(
      {
        agent_name: 'nonexistent-worker',
        last_n: 10,
        scope: 'project',
        format: 'text',
      },
      projectRoot,
    );

    assert.equal(response.content[0].text, 'No diary entries found.');
  });
});

test('executeFindAgentDiary searches diary entries by query', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    // Record multiple diary entries
    await executeRecordAgentDiary(
      {
        agent_name: 'worker-alpha',
        entry: 'Investigated retrieval slowdown and switched embeddings.',
        topic: 'retrieval',
        scope: 'project',
        tags: ['ops', 'retrieval'],
        format: 'json',
      },
      projectRoot,
    );

    await executeRecordAgentDiary(
      {
        agent_name: 'worker-alpha',
        entry: 'Fixed authentication bug in login flow.',
        topic: 'bugfix',
        scope: 'project',
        tags: ['auth', 'bug'],
        format: 'json',
      },
      projectRoot,
    );

    // Search for entries about embeddings
    const response = await executeFindAgentDiary(
      {
        query: 'embeddings',
        agent_name: 'worker-alpha',
        scope: 'project',
        limit: 10,
        format: 'json',
      },
      projectRoot,
    );

    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.tool, 'find_agent_diary');
    assert.equal(payload.result_count, 1);
    assert.ok(payload.results[0].summary.includes('embeddings'));
  });
});

test('executeFindAgentDiary filters by agent and topic', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    // Record multiple diary entries
    await executeRecordAgentDiary(
      {
        agent_name: 'worker-alpha',
        entry: 'Retrieval optimization work.',
        topic: 'retrieval',
        scope: 'project',
        tags: ['ops'],
        format: 'json',
      },
      projectRoot,
    );

    await executeRecordAgentDiary(
      {
        agent_name: 'worker-beta',
        entry: 'Also did retrieval work.',
        topic: 'retrieval',
        scope: 'project',
        tags: ['ops'],
        format: 'json',
      },
      projectRoot,
    );

    await executeRecordAgentDiary(
      {
        agent_name: 'worker-alpha',
        entry: 'Documentation improvements.',
        topic: 'documentation',
        scope: 'project',
        tags: ['docs'],
        format: 'json',
      },
      projectRoot,
    );

    // Search for retrieval entries by worker-alpha only
    const response = await executeFindAgentDiary(
      {
        query: 'retrieval',
        agent_name: 'worker-alpha',
        topic: 'retrieval',
        scope: 'project',
        limit: 10,
        format: 'json',
      },
      projectRoot,
    );

    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.result_count, 1);
    assert.equal(payload.results[0].title, 'worker-alpha · retrieval');
  });
});

test('executeFindAgentDiary handles no matches found', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const response = await executeFindAgentDiary(
      {
        query: 'nonexistent-topic',
        agent_name: 'worker-alpha',
        scope: 'project',
        limit: 10,
        format: 'text',
      },
      projectRoot,
    );

    assert.match(response.content[0].text, /No diary entries found for "nonexistent-topic"/);
  });
});

test('executeFindAgentDiary respects limit parameter', async () => {
  await withTempProjects(async (projectRoot, _otherProjectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    // Record multiple diary entries
    for (let i = 1; i <= 5; i++) {
      await executeRecordAgentDiary(
        {
          agent_name: 'worker-alpha',
          entry: `Work entry ${i}`,
          topic: 'work',
          scope: 'project',
          tags: [`tag${i}`],
          format: 'json',
        },
        projectRoot,
      );
    }

    // Search with limit
    const response = await executeFindAgentDiary(
      {
        query: 'work',
        agent_name: 'worker-alpha',
        scope: 'project',
        limit: 2,
        format: 'json',
      },
      projectRoot,
    );

    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.result_count, 2);
  });
});

test('agent diary functions work with global-user scope', async () => {
  await withTempProjects(async (projectA, projectB, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    // Record diary entry in projectA with global-user scope
    await executeRecordAgentDiary(
      {
        agent_name: 'worker-alpha',
        entry: 'Global preference: users prefer concise explanations.',
        topic: 'preferences',
        scope: 'global-user',
        tags: ['style'],
        format: 'json',
      },
      projectA,
    );

    // Read diary entries in projectB (should see global-user entries)
    const response = await executeReadAgentDiary(
      {
        agent_name: 'worker-alpha',
        last_n: 10,
        scope: 'global-user',
        format: 'json',
      },
      projectB,
    );

    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.result_count, 1);
    assert.equal(payload.results[0].title, 'worker-alpha · preferences');
    assert.equal(payload.results[0].scope, 'global-user');
  });
});
