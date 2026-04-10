import assert from 'node:assert/strict';
import test from 'node:test';

test('graph module index re-exports current code graph building blocks', async () => {
  const mod = await import('../src/graph/index.ts');

  assert.equal(typeof mod.GraphStore, 'function');
  assert.equal(typeof mod.SymbolExtractor, 'function');
  assert.equal(typeof mod.ChangeDetector, 'function');
  assert.equal(typeof mod.ExecutionTracer, 'function');
});
