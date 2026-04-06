import assert from 'node:assert/strict';
import test from 'node:test';
import { z, ZodError } from 'zod';
import { createTextResponse } from '../src/mcp/response.ts';
import { createCallToolHandler } from '../src/mcp/runtime/callToolHandler.ts';

test('createCallToolHandler wires progress notifications and generic usage recording on success', async () => {
  const notifications: Array<Record<string, unknown>> = [];
  const usageEvents: Array<Record<string, unknown>> = [];

  const handler = createCallToolHandler({
    dispatchTool: async (name, args, onProgress) => {
      assert.equal(name, 'find_memory');
      assert.deepEqual(args, { query: 'auth' });
      assert.ok(onProgress);
      await onProgress?.(2, 5, 'retrieving');
      return createTextResponse('ok');
    },
    recordToolUsage: async (event) => {
      usageEvents.push(event);
    },
    now: (() => {
      let current = 100;
      return () => {
        current += 17;
        return current;
      };
    })(),
  });

  const result = await handler(
    {
      params: {
        name: 'find_memory',
        arguments: { query: 'auth' },
      },
    },
    {
      _meta: { progressToken: 'token-1' },
      sendNotification: async (payload) => {
        notifications.push(payload as Record<string, unknown>);
      },
    },
  );

  assert.deepEqual(result, createTextResponse('ok'));
  assert.equal(notifications.length, 1);
  assert.deepEqual(notifications[0], {
    method: 'notifications/progress',
    params: {
      progressToken: 'token-1',
      progress: 2,
      total: 5,
      message: 'retrieving',
    },
  });
  assert.equal(usageEvents.length, 1);
  assert.equal(usageEvents[0]?.toolName, 'find_memory');
  assert.equal(usageEvents[0]?.status, 'success');
  assert.equal(usageEvents[0]?.source, 'mcp');
  assert.equal(usageEvents[0]?.durationMs, 17);
});

test('createCallToolHandler routes zod and internal errors to the correct MCP responses', async () => {
  const invalidArgumentsError = (() => {
    try {
      z.object({ query: z.string() }).parse({ query: 1 });
      throw new Error('expected zod error');
    } catch (err) {
      return err as ZodError;
    }
  })();

  const invalidUsageEvents: Array<Record<string, unknown>> = [];
  const invalidHandler = createCallToolHandler({
    dispatchTool: async () => {
      throw invalidArgumentsError;
    },
    recordToolUsage: async (event) => {
      invalidUsageEvents.push(event);
    },
  });

  const invalidResult = await invalidHandler(
    {
      params: {
        name: 'find_memory',
        arguments: { query: 1 },
      },
    },
    {
      _meta: {},
      sendNotification: async () => {},
    },
  );

  assert.equal(invalidResult.isError, true);
  assert.match(invalidResult.content[0]?.text || '', /Invalid arguments for find_memory/);
  assert.equal(invalidUsageEvents[0]?.status, 'error');

  const internalUsageEvents: Array<Record<string, unknown>> = [];
  const internalHandler = createCallToolHandler({
    dispatchTool: async () => {
      throw new Error('boom');
    },
    recordToolUsage: async (event) => {
      internalUsageEvents.push(event);
    },
  });

  const internalResult = await internalHandler(
    {
      params: {
        name: 'find_memory',
        arguments: { query: 'auth' },
      },
    },
    {
      _meta: {},
      sendNotification: async () => {},
    },
  );

  assert.equal(internalResult.isError, true);
  assert.equal(internalResult.content[0]?.text, 'Error in find_memory: boom');
  assert.equal(internalUsageEvents[0]?.status, 'error');
  assert.equal(internalUsageEvents[0]?.error, 'boom');
});
