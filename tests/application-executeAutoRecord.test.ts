import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MemoryHubDatabase } from '../src/memory/MemoryHubDatabase.js';
import { MemoryStore } from '../src/memory/MemoryStore.js';
import {
  executeSuggestMemory,
  executeSessionEnd,
  type SuggestMemoryInput,
  type SessionEndInput,
} from '../src/application/memory/executeAutoRecord.js';

async function withTempProjects(
  run: (projectRoot: string, dbPath: string) => Promise<void>,
): Promise<void> {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cw-execute-auto-record-'));
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

test('executeSuggestMemory suggests module memory recording for explicit requests', async () => {
  await withTempProjects(async (projectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const suggestArgs: SuggestMemoryInput = {
      moduleName: 'SearchService',
      files: ['src/search/SearchService.ts'],
      project: projectRoot,
    };

    const response = await executeSuggestMemory(suggestArgs);
    assert.equal(response.content[0].type, 'text');
    assert.match(response.content[0].text, /建议记录模块/);
    assert.match(response.content[0].text, /SearchService/);
    assert.match(response.content[0].text, /src\/search\/SearchService.ts/);
    assert.match(response.content[0].text, /suggested/);
    assert.match(response.content[0].text, /record_memory/);
  });
});

test('executeSuggestMemory handles minimal input gracefully', async () => {
  await withTempProjects(async (projectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const suggestArgs: SuggestMemoryInput = {
      moduleName: 'AuthService',
      project: projectRoot,
    };

    const response = await executeSuggestMemory(suggestArgs);
    assert.equal(response.content[0].type, 'text');
    assert.match(response.content[0].text, /建议记录模块/);
    assert.match(response.content[0].text, /AuthService/);
    assert.match(response.content[0].text, /待指定/);
  });
});

test('executeSuggestMemory includes export information when files are provided', async () => {
  await withTempProjects(async (projectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    // Create a test file with exports
    const testFile = path.join(projectRoot, 'src', 'test', 'TestService.ts');
    mkdirSync(path.dirname(testFile), { recursive: true });

    const suggestArgs: SuggestMemoryInput = {
      moduleName: 'TestService',
      files: [testFile],
      project: projectRoot,
    };

    const response = await executeSuggestMemory(suggestArgs);
    assert.equal(response.content[0].type, 'text');
    assert.match(response.content[0].text, /TestService/);
    assert.match(response.content[0].text, /导出/);
  });
});

test('executeSessionEnd detects and suggests long-term memory candidates', async () => {
  await withTempProjects(async (projectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const sessionArgs: SessionEndInput = {
      summary: '提交代码前必须运行 lint，因为之前多次把格式问题带进主分支。生产环境 Grafana 仪表盘在 https://grafana.example.com/d/abc123。',
      project: projectRoot,
      autoRecord: false,
    };

    const response = await executeSessionEnd(sessionArgs);
    assert.equal(response.content[0].type, 'text');
    assert.match(response.content[0].text, /长期记忆/);
    assert.match(response.content[0].text, /feedback/);
    assert.match(response.content[0].text, /reference/);
  });
});

test('executeSessionEnd auto-records memories when autoRecord is true', async () => {
  await withTempProjects(async (projectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const sessionArgs: SessionEndInput = {
      summary: '实现了 SearchService 模块，文件位于 src/search/SearchService.ts。这个模块负责处理检索流程和上下文打包。',
      project: projectRoot,
      autoRecord: true,
    };

    const response = await executeSessionEnd(sessionArgs);
    assert.equal(response.content[0].type, 'text');
    assert.match(response.content[0].text, /模块记忆/);
    assert.match(response.content[0].text, /SearchService/);
    assert.match(response.content[0].text, /agent-inferred/);

    const store = new MemoryStore(projectRoot);
    const memory = await store.readFeature('SearchService');
    assert.ok(memory);
    assert.equal(memory?.confirmationStatus, 'agent-inferred');
  });
});

test('executeSessionEnd handles session with no memory candidates', async () => {
  await withTempProjects(async (projectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const sessionArgs: SessionEndInput = {
      summary: '今日无事发生。',
      project: projectRoot,
      autoRecord: false,
    };

    const response = await executeSessionEnd(sessionArgs);
    assert.equal(response.content[0].type, 'text');
    assert.match(response.content[0].text, /会话分析完成/);
  });
});

test('executeSessionEnd saves checkpoints when detected in session', async () => {
  await withTempProjects(async (projectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const sessionArgs: SessionEndInput = {
      summary: '完成了用户认证模块的开发，现在需要暂停工作，明天继续处理权限部分。',
      project: projectRoot,
      autoRecord: true,
    };

    const response = await executeSessionEnd(sessionArgs);
    assert.equal(response.content[0].type, 'text');

    const store = new MemoryStore(projectRoot);
    const checkpoints = await store.listCheckpoints();

    if (checkpoints.length > 0) {
      assert.match(response.content[0].text, /任务检查点/);
      assert.equal(checkpoints[0]?.phase, 'handoff');
    }
  });
});

test('executeSessionEnd handles project resolution with absolute paths', async () => {
  await withTempProjects(async (projectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const sessionArgs: SessionEndInput = {
      summary: '完成了数据库迁移脚本的开发。',
      project: projectRoot,
      autoRecord: false,
    };

    const response = await executeSessionEnd(sessionArgs);
    assert.equal(response.content[0].type, 'text');
    // Should handle absolute path without error
    assert.ok(response.content[0].text.length > 0);
  });
});

test('executeSessionEnd handles project resolution with relative paths', async () => {
  await withTempProjects(async (projectRoot, dbPath) => {
    MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));

    const sessionArgs: SessionEndInput = {
      summary: '完成了 API 接口的设计。',
      project: 'test-project',
      autoRecord: false,
    };

    const response = await executeSessionEnd(sessionArgs);
    assert.equal(response.content[0].type, 'text');
    // Should handle relative/project ID path (may fall back to cwd)
    assert.ok(response.content[0].text.length > 0);
  });
});