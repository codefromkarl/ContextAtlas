import assert from 'node:assert/strict';
import test from 'node:test';

import { buildDefaultEnvContent, registerBootstrapCommands } from '../src/cli/commands/bootstrap.js';
import { registerGatewayCommands } from '../src/cli/commands/gateway.js';
import { registerHubCommands } from '../src/cli/commands/hub.js';
import { registerHubExploreCommands } from '../src/cli/commands/hubExplore.js';
import { registerHubProjectCommands } from '../src/cli/commands/hubProjects.js';
import { registerSharedMemoryCommands } from '../src/cli/commands/hubShared.js';
import { registerIndexingCommands } from '../src/cli/commands/indexing.js';
import { registerMemoryCatalogCommands } from '../src/cli/commands/memoryCatalog.js';
import { registerMemoryCommands } from '../src/cli/commands/memory.js';
import { registerMemoryFeatureCommands } from '../src/cli/commands/memoryFeatures.js';
import { registerMemoryKnowledgeCommands } from '../src/cli/commands/memoryKnowledge.js';
import { registerOpsAlertCommands } from '../src/cli/commands/opsAlerts.js';
import { registerOpsHealthCommands } from '../src/cli/commands/opsHealth.js';
import { registerOpsCommands } from '../src/cli/commands/ops.js';
import { registerOpsUsageCommands } from '../src/cli/commands/opsUsage.js';
import { registerOpsWorkbenchCommands } from '../src/cli/commands/opsWorkbench.js';
import { registerSearchCommands } from '../src/cli/commands/search.js';
import { registerCliCommands } from '../src/cli/registerCommands.js';

class FakeCommand {
  readonly options: string[] = [];
  actionHandler: Function | null = null;

  option(name: string): this {
    this.options.push(name);
    return this;
  }

  action(handler: Function): this {
    this.actionHandler = handler;
    return this;
  }
}

class FakeCli {
  readonly commands = new Map<string, FakeCommand>();

  command(name: string): FakeCommand {
    const command = new FakeCommand();
    this.commands.set(name, command);
    return command;
  }
}

test('registerCliCommands registers major command groups through a single entrypoint', () => {
  const cli = new FakeCli();

  registerCliCommands(cli as never);

  const registered = Array.from(cli.commands.keys());

  assert.ok(registered.includes('init'));
  assert.ok(registered.includes('index [path]'));
  assert.ok(registered.includes('mcp'));
  assert.ok(registered.includes('search'));
  assert.ok(registered.includes('monitor:retrieval'));
  assert.ok(registered.includes('daemon <action>'));
  assert.ok(registered.includes('start [path]'));
  assert.ok(registered.includes('gateway:embeddings'));
  assert.ok(registered.includes('memory:find <query>'));
  assert.ok(registered.includes('profile:record'));
  assert.ok(registered.includes('hub:search'));
  assert.ok(registered.includes('ops:summary'));
  assert.ok(registered.includes('index:plan [path]'));
  assert.ok(registered.includes('index:update [path]'));
  assert.ok(registered.includes('task:status'));
  assert.ok(registered.includes('task:inspect <taskId>'));
  assert.ok(registered.includes('storage:analyze'));
  assert.ok(registered.includes('perf:benchmark'));
});

test('registerBootstrapCommands registers startup-oriented commands', () => {
  const cli = new FakeCli();

  registerBootstrapCommands(cli as never);

  const registered = Array.from(cli.commands.keys());

  assert.deepEqual(registered, ['init', 'start [path]', 'mcp']);
});

test('buildDefaultEnvContent emits SiliconFlow-first embedding gateway example', () => {
  const content = buildDefaultEnvContent();

  assert.match(content, /EMBEDDINGS_BASE_URL=https:\/\/api\.siliconflow\.cn\/v1\/embeddings/);
  assert.match(content, /EMBEDDINGS_MODEL=BAAI\/bge-m3/);
  assert.match(content, /EMBEDDING_GATEWAY_VALIDATE_MODELS=BAAI\/bge-m3/);
  assert.match(content, /"name":"siliconflow-primary"/);
  assert.match(content, /"baseUrl":"https:\/\/api\.siliconflow\.cn\/v1\/embeddings"/);
});

test('registerGatewayCommands registers gateway server command', () => {
  const cli = new FakeCli();

  registerGatewayCommands(cli as never);

  const registered = Array.from(cli.commands.keys());
  const gateway = cli.commands.get('gateway:embeddings');

  assert.deepEqual(registered, ['gateway:embeddings']);
  assert.ok(gateway?.options.includes('--port <port>'));
  assert.ok(gateway?.options.includes('--cache-ttl-ms <ms>'));
  assert.ok(gateway?.options.includes('--cache-backend <backend>'));
  assert.ok(gateway?.options.includes('--redis-url <url>'));
  assert.ok(gateway?.options.includes('--no-coalesce-identical-requests'));
});

test('registerIndexingCommands registers indexing lifecycle commands', () => {
  const cli = new FakeCli();

  registerIndexingCommands(cli as never);

  const registered = Array.from(cli.commands.keys());

  assert.deepEqual(registered, ['index [path]', 'daemon <action>']);
});

test('registerSearchCommands registers retrieval-facing commands', () => {
  const cli = new FakeCli();

  registerSearchCommands(cli as never);

  const registered = Array.from(cli.commands.keys());

  assert.deepEqual(registered, ['search', 'monitor:retrieval']);
  assert.ok(cli.commands.get('search')?.options.includes('--json'));
});

test('registerHubCommands registers hub commands through a single entrypoint', () => {
  const cli = new FakeCli();

  registerHubCommands(cli as never);

  const registered = Array.from(cli.commands.keys());

  assert.ok(registered.includes('hub:register-project <path>'));
  assert.ok(registered.includes('hub:list-projects'));
  assert.ok(registered.includes('hub:stats'));
  assert.ok(registered.includes('hub:repair-project-identities'));
  assert.ok(registered.includes('shared:contribute'));
  assert.ok(registered.includes('shared:list'));
  assert.ok(registered.includes('shared:sync'));
  assert.ok(registered.includes('hub:save-memory <project> <name>'));
  assert.ok(registered.includes('hub:search'));
  assert.ok(registered.includes('hub:fts <query>'));
  assert.ok(registered.includes('hub:link <fromProject> <fromModule> <toProject> <toModule> <type>'));
  assert.ok(registered.includes('hub:deps <project> <module>'));
});

test('registerHubProjectCommands registers project-admin hub commands', () => {
  const cli = new FakeCli();

  registerHubProjectCommands(cli as never);

  const registered = Array.from(cli.commands.keys());

  assert.deepEqual(registered, [
    'hub:register-project <path>',
    'hub:list-projects',
    'hub:stats',
    'hub:repair-project-identities',
  ]);
});

test('registerSharedMemoryCommands registers shared-memory hub commands', () => {
  const cli = new FakeCli();

  registerSharedMemoryCommands(cli as never);

  const registered = Array.from(cli.commands.keys());

  assert.deepEqual(registered, ['shared:contribute', 'shared:list', 'shared:sync']);
});

test('registerHubExploreCommands registers search and relation hub commands', () => {
  const cli = new FakeCli();

  registerHubExploreCommands(cli as never);

  const registered = Array.from(cli.commands.keys());

  assert.deepEqual(registered, [
    'hub:save-memory <project> <name>',
    'hub:search',
    'hub:fts <query>',
    'hub:link <fromProject> <fromModule> <toProject> <toModule> <type>',
    'hub:deps <project> <module>',
  ]);
});

test('registerMemoryCommands registers memory commands through a single entrypoint', () => {
  const cli = new FakeCli();

  registerMemoryCommands(cli as never);

  const registered = Array.from(cli.commands.keys());

  assert.ok(registered.includes('memory:find <query>'));
  assert.ok(registered.includes('memory:suggest <name>'));
  assert.ok(registered.includes('memory:record <name>'));
  assert.ok(registered.includes('memory:list'));
  assert.ok(registered.includes('memory:delete <name>'));
  assert.ok(registered.includes('memory:rebuild-catalog'));
  assert.ok(registered.includes('memory:check-consistency'));
  assert.ok(registered.includes('memory:prune-long-term'));
  assert.ok(registered.includes('memory:record-long-term'));
  assert.ok(registered.includes('memory:create-checkpoint'));
  assert.ok(registered.includes('memory:load-checkpoint <checkpointId>'));
  assert.ok(registered.includes('memory:list-checkpoints'));
  assert.ok(registered.includes('feedback:record'));
  assert.ok(registered.includes('decision:record <id>'));
  assert.ok(registered.includes('decision:list'));
});

test('registerMemoryFeatureCommands registers feature-memory commands', () => {
  const cli = new FakeCli();

  registerMemoryFeatureCommands(cli as never);

  const registered = Array.from(cli.commands.keys());

  assert.deepEqual(registered, [
    'memory:find <query>',
    'memory:suggest <name>',
    'memory:record <name>',
    'memory:list',
    'memory:delete <name>',
  ]);
});

test('registerMemoryCatalogCommands registers catalog-maintenance commands', () => {
  const cli = new FakeCli();

  registerMemoryCatalogCommands(cli as never);

  const registered = Array.from(cli.commands.keys());

  assert.deepEqual(registered, ['memory:rebuild-catalog', 'memory:check-consistency']);
});

test('registerOpsHealthCommands registers index planning and update commands', () => {
  const cli = new FakeCli();

  registerOpsHealthCommands(cli as never);

  const registered = Array.from(cli.commands.keys());

  assert.ok(registered.includes('health:check'));
  assert.ok(registered.includes('health:full'));
  assert.ok(registered.includes('index:plan [path]'));
  assert.ok(registered.includes('index:update [path]'));
  assert.ok(registered.includes('task:status'));
  assert.ok(registered.includes('task:inspect <taskId>'));
});

test('registerMemoryKnowledgeCommands registers long-term and decision commands', () => {
  const cli = new FakeCli();

  registerMemoryKnowledgeCommands(cli as never);

  const registered = Array.from(cli.commands.keys());

  assert.deepEqual(registered, [
    'memory:prune-long-term',
    'memory:record-long-term',
    'memory:diary-write',
    'memory:diary-read',
    'memory:diary-find',
    'memory:invalidate-long-term',
    'feedback:record',
    'decision:record <id>',
    'decision:list',
    'memory:create-checkpoint',
    'memory:load-checkpoint <checkpointId>',
    'memory:list-checkpoints',
  ]);
});

test('registerOpsCommands registers operations commands through a single entrypoint', () => {
  const cli = new FakeCli();

  registerOpsCommands(cli as never);

  const registered = Array.from(cli.commands.keys());

  assert.ok(registered.includes('usage:index-report'));
  assert.ok(registered.includes('usage:purge'));
  assert.ok(registered.includes('storage:analyze'));
  assert.ok(registered.includes('perf:benchmark'));
  assert.ok(registered.includes('health:check'));
  assert.ok(registered.includes('memory:health'));
  assert.ok(registered.includes('health:full'));
  assert.ok(registered.includes('index:plan [path]'));
  assert.ok(registered.includes('alert:eval'));
  assert.ok(registered.includes('alert:config'));
  assert.ok(registered.includes('ops:summary'));
  assert.ok(registered.includes('ops:metrics'));
  assert.ok(registered.includes('ops:apply <actionId>'));
});

test('registerOpsUsageCommands registers usage-oriented ops commands', () => {
  const cli = new FakeCli();

  registerOpsUsageCommands(cli as never);

  const registered = Array.from(cli.commands.keys());

  assert.deepEqual(registered, ['usage:index-report', 'usage:purge', 'storage:analyze', 'perf:benchmark']);
});

test('registerOpsHealthCommands registers health-oriented ops commands', () => {
  const cli = new FakeCli();

  registerOpsHealthCommands(cli as never);

  const registered = Array.from(cli.commands.keys());

  assert.deepEqual(registered, [
    'fts:rebuild-chunks',
    'health:check',
    'memory:health',
    'health:full',
    'index:plan [path]',
    'index:update [path]',
    'task:status',
    'task:inspect <taskId>',
  ]);
});

test('registerOpsAlertCommands registers alert-oriented ops commands', () => {
  const cli = new FakeCli();

  registerOpsAlertCommands(cli as never);

  const registered = Array.from(cli.commands.keys());

  assert.deepEqual(registered, ['alert:eval', 'alert:config']);
});

test('registerOpsWorkbenchCommands registers workbench ops commands', () => {
  const cli = new FakeCli();

  registerOpsWorkbenchCommands(cli as never);

  const registered = Array.from(cli.commands.keys());

  assert.deepEqual(registered, ['ops:summary', 'ops:metrics', 'ops:apply <actionId>']);
});
