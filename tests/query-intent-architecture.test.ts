import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyQueryIntent, deriveQueryAwareSearchConfig } from '../src/search/QueryIntentClassifier.ts';
import { DEFAULT_CONFIG } from '../src/search/config.ts';

test('classifyQueryIntent 将架构/边界类问题识别为 architecture', () => {
  const intent = classifyQueryIntent(
    'Locate the actual CLI entrypoint, command registration, MCP server startup path, and architecture boundary between CLI and MCP',
    ['MCP', 'cli', 'Command'],
  );

  assert.equal(intent, 'architecture');
});

test('classifyQueryIntent 不会把 transport/adaptation 误判为 navigation，并识别为 architecture', () => {
  const intent = classifyQueryIntent(
    'Find the relationship between MCP tool handlers and underlying core services for code retrieval and memory. I need to know whether MCP is just a transport/adaptation layer or deeply coupled to the business logic.',
    ['handleCodebaseRetrieval', 'SearchService', 'MemoryStore'],
  );

  assert.equal(intent, 'architecture');
});

test('deriveQueryAwareSearchConfig 为 architecture 打开 skeleton recall', () => {
  const config = deriveQueryAwareSearchConfig(DEFAULT_CONFIG, 'architecture');

  assert.equal(config.enableSkeletonRecall, true);
  assert.equal(config.wVec, 0.25);
  assert.equal(config.wLex, 0.75);
  assert.equal(config.smartTopScoreRatio, 0.1);
  assert.equal(config.smartMinScore, 0.02);
  assert.equal(config.smartMinK, 4);
});
