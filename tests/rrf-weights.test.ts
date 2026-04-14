import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveQueryAwareSearchConfig, classifyQueryIntent } from '../src/search/QueryIntentClassifier.ts';
import { DEFAULT_CONFIG } from '../src/search/config.ts';

test('symbol_lookup intent boosts lexical weight over vector', () => {
  const config = deriveQueryAwareSearchConfig(DEFAULT_CONFIG, 'symbol_lookup');
  assert.ok(config.wLex > config.wVec, 'lexical weight should exceed vector for symbol_lookup');
  assert.equal(config.wLex, 0.65);
  assert.equal(config.wVec, 0.35);
});

test('navigation intent strongly favors lexical', () => {
  const config = deriveQueryAwareSearchConfig(DEFAULT_CONFIG, 'navigation');
  assert.ok(config.wLex > config.wVec, 'lexical should dominate for navigation');
  assert.equal(config.wLex, 0.7);
});

test('conceptual intent boosts vector weight over lexical', () => {
  const config = deriveQueryAwareSearchConfig(DEFAULT_CONFIG, 'conceptual');
  assert.ok(config.wVec > config.wLex, 'vector should dominate for conceptual');
  assert.equal(config.wVec, 0.55);
});

test('balanced intent returns base config unchanged', () => {
  const config = deriveQueryAwareSearchConfig(DEFAULT_CONFIG, 'balanced');
  assert.equal(config.wVec, DEFAULT_CONFIG.wVec);
  assert.equal(config.wLex, DEFAULT_CONFIG.wLex);
});

test('base weights are numeric and sum to approximately 1', () => {
  assert.equal(typeof DEFAULT_CONFIG.wVec, 'number');
  assert.equal(typeof DEFAULT_CONFIG.wLex, 'number');
  const sum = DEFAULT_CONFIG.wVec + DEFAULT_CONFIG.wLex;
  assert.ok(Math.abs(sum - 1) < 0.01, `wVec + wLex should sum to ~1, got ${sum}`);
});
