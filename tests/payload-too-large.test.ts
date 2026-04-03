import assert from 'node:assert/strict';
import test from 'node:test';
import { locatePayloadTooLargeFile } from '../src/indexer/payloadTooLarge.ts';

test('locatePayloadTooLargeFile 能定位命中的文件与剩余文件', () => {
  const files = [
    { path: 'a.ts', hash: 'ha' },
    { path: 'b.ts', hash: 'hb' },
    { path: 'c.ts', hash: 'hc' },
  ];
  const globalIndexByFileChunk = [[0, 1], [2, 3, 4], [5]];

  const result = locatePayloadTooLargeFile(files, globalIndexByFileChunk, 3);

  assert.ok(result);
  assert.equal(result?.offending.path, 'b.ts');
  assert.equal(result?.remaining.length, 2);
  assert.deepEqual(
    result?.remaining.map((f) => f.path),
    ['a.ts', 'c.ts'],
  );
});

test('locatePayloadTooLargeFile 在索引不存在时返回 null', () => {
  const files = [
    { path: 'a.ts', hash: 'ha' },
    { path: 'b.ts', hash: 'hb' },
  ];
  const globalIndexByFileChunk = [[0, 1], [2, 3]];

  const result = locatePayloadTooLargeFile(files, globalIndexByFileChunk, 99);

  assert.equal(result, null);
});

