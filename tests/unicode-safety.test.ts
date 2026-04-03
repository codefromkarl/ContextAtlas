import assert from 'node:assert/strict';
import test from 'node:test';
import { SourceAdapter } from '../src/chunking/SourceAdapter.ts';

function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      i++;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

test('SourceAdapter.slice 在 UTF-16 域切片不会生成孤立代理项', () => {
  const code = 'A🔥B';
  const adapter = new SourceAdapter({ code, endIndex: code.length });

  // start 落在低位代理上，历史上会生成孤立代理项
  const sliced = adapter.slice(2, 4);

  assert.equal(hasLoneSurrogate(sliced), false);
  assert.equal(sliced, '🔥B');
});
