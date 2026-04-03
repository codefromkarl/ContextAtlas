import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeEmbeddingInput } from '../src/api/unicode.ts';

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

test('sanitizeEmbeddingInput 会清理孤立代理项且保留正常字符', () => {
  const bad = '\udd25🌟🎯x';
  const sanitized = sanitizeEmbeddingInput(bad);

  assert.equal(hasLoneSurrogate(sanitized), false);
  assert.ok(sanitized.includes('🌟🎯x'));
});
