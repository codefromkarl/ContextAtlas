import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createMcpLifecycleController } from '../src/mcp/server.ts';

test('createMcpLifecycleController 在 stdin end/close 下只清理一次', async () => {
  const stdin = new EventEmitter();
  const calls: string[] = [];

  createMcpLifecycleController({
    stdin,
    closeResources: async () => {
      calls.push('resources');
    },
    closeServer: async () => {
      calls.push('server');
    },
  });

  stdin.emit('end');
  stdin.emit('close');
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, ['resources', 'server']);
});

test('createMcpLifecycleController 在 stdin error 下清理一次', async () => {
  const stdin = new EventEmitter();
  const calls: string[] = [];

  createMcpLifecycleController({
    stdin,
    closeResources: async () => {
      calls.push('resources');
    },
    closeServer: async () => {
      calls.push('server');
    },
  });

  stdin.emit('error', new Error('broken pipe'));
  stdin.emit('close');
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, ['resources', 'server']);
});
