import assert from 'node:assert/strict';
import test from 'node:test';

test('search module index re-exports current search pipeline building blocks', async () => {
  const mod = await import('../src/search/index.ts');

  assert.equal(typeof mod.SearchService, 'function');
  assert.equal(typeof mod.HybridRecallEngine, 'function');
  assert.equal(typeof mod.ContextPacker, 'function');
  assert.equal(typeof mod.GraphExpander, 'function');
  assert.equal(typeof mod.buildRerankText, 'function');
  assert.equal(typeof mod.applySmartCutoff, 'function');
  assert.equal(typeof mod.selectRerankPoolCandidates, 'function');
});
