import assert from 'node:assert/strict';
import test from 'node:test';

import { logger } from '../src/utils/logger.js';
import {
  exitWithError,
  exitWithStderr,
  joinToolText,
  splitCommaSeparated,
  toJsonLine,
  toTextLine,
  writeJson,
  writeText,
} from '../src/cli/helpers.js';

test('splitCommaSeparated trims items and drops empty entries', () => {
  assert.deepEqual(splitCommaSeparated(undefined), []);
  assert.deepEqual(splitCommaSeparated(''), []);
  assert.deepEqual(splitCommaSeparated(' auth, SearchService , ,profile '), [
    'auth',
    'SearchService',
    'profile',
  ]);
});

test('toJsonLine serializes values with pretty indentation and trailing newline', () => {
  assert.equal(
    toJsonLine({ ok: true, count: 2 }),
    `${JSON.stringify({ ok: true, count: 2 }, null, 2)}\n`,
  );
});

test('toTextLine appends one trailing newline', () => {
  assert.equal(toTextLine('hello'), 'hello\n');
});

test('writeJson writes serialized JSON to target stream', () => {
  let output = '';
  writeJson(
    { ok: true },
    {
      write(chunk: string) {
        output += chunk;
        return true;
      },
    },
  );

  assert.equal(output, `${JSON.stringify({ ok: true }, null, 2)}\n`);
});

test('writeText writes one trailing newline to target stream', () => {
  let output = '';
  writeText('hello', {
    write(chunk: string) {
      output += chunk;
      return true;
    },
  });

  assert.equal(output, 'hello\n');
});

test('exitWithError logs message then exits with code 1', () => {
  const originalError = logger.error.bind(logger);
  const calls: unknown[][] = [];
  let exitCode: number | undefined;

  logger.error = ((...args: unknown[]) => {
    calls.push(args);
  }) as typeof logger.error;

  try {
    assert.throws(
      () =>
        exitWithError('boom', { detail: true }, ((code?: number) => {
          exitCode = code;
          throw new Error('exit');
        }) as (code?: number) => never),
      /exit/,
    );
  } finally {
    logger.error = originalError;
  }

  assert.equal(exitCode, 1);
  assert.deepEqual(calls, [[{ detail: true }, 'boom']]);
});

test('exitWithStderr writes message then exits with code 1', () => {
  const originalWrite = process.stderr.write.bind(process.stderr);
  let output = '';
  let exitCode: number | undefined;

  process.stderr.write = ((chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  }) as typeof process.stderr.write;

  try {
    assert.throws(
      () =>
        exitWithStderr(
          'bad',
          ((code?: number) => {
            exitCode = code;
            throw new Error('exit');
          }) as (code?: number) => never,
        ),
      /exit/,
    );
  } finally {
    process.stderr.write = originalWrite;
  }

  assert.equal(exitCode, 1);
  assert.equal(output, 'bad\n');
});

test('joinToolText joins MCP text content with newlines', () => {
  assert.equal(
    joinToolText({
      content: [
        { type: 'text', text: 'line-1' },
        { type: 'text', text: 'line-2' },
      ],
    }),
    'line-1\nline-2',
  );
});
