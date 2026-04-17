import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyQueryIntent } from '../src/search/QueryIntentClassifier.ts';
import { DEFAULT_CONFIG } from '../src/search/config.ts';
import { buildContextRequest, resolveIntentOperationalQuery } from '../src/search/SearchPipelineSupport.ts';
import { buildRetrievalStats } from '../src/search/SearchPipelineSupport.ts';

test('classifyQueryIntent prefers explicit technical terms over architecture keywords embedded in symbols', () => {
  assert.equal(
    classifyQueryIntent('Trace retrieval flow SearchService', ['SearchService']),
    'symbol_lookup',
  );

  assert.equal(
    classifyQueryIntent('Locate handler registration LoginHandler', ['LoginHandler']),
    'symbol_lookup',
  );
});

test('classifyQueryIntent keeps architecture intent when natural-language architecture hints are present alongside technical terms', () => {
  assert.equal(
    classifyQueryIntent(
      'Find the relationship between MCP tool handlers and underlying core services for code retrieval and memory.',
      ['handleCodebaseRetrieval', 'SearchService', 'MemoryStore'],
    ),
    'architecture',
  );
});

test('buildRetrievalStats preserves classified query intent over raw retrieval stats payload', () => {
  const stats = buildRetrievalStats({
    queryIntent: 'symbol_lookup',
    retrievedStats: {
      queryIntent: 'balanced',
      lexicalStrategy: 'chunks_fts',
      vectorCount: 1,
      lexicalCount: 1,
      skeletonCount: 0,
      graphCount: 0,
      fusedCount: 1,
    },
    topMCount: 1,
    rerankInputCount: 1,
    rerankedCount: 1,
  });

  assert.equal(stats.queryIntent, 'symbol_lookup');
});

test('buildContextRequest narrows semantic query to technical terms for symbol lookup', () => {
  const request = buildContextRequest(
    'Trace retrieval flow SearchService',
    {
      technicalTerms: ['SearchService'],
      semanticQuery: 'Trace retrieval flow',
      lexicalQuery: 'SearchService',
      responseMode: 'overview',
    },
    DEFAULT_CONFIG,
  );

  assert.equal(request.queryIntent, 'symbol_lookup');
  assert.equal(request.semanticQuery, 'SearchService');
  assert.equal(request.lexicalQuery, 'SearchService');
});

test('resolveIntentOperationalQuery uses lexical query for symbol lookup rerank/expand stages', () => {
  assert.equal(
    resolveIntentOperationalQuery(
      {
        queryIntent: 'symbol_lookup',
        lexicalQuery: 'SearchService',
      },
      'Trace retrieval flow SearchService',
    ),
    'SearchService',
  );

  assert.equal(
    resolveIntentOperationalQuery(
      {
        queryIntent: 'architecture',
        lexicalQuery: 'SearchService',
      },
      'Trace retrieval flow SearchService',
    ),
    'Trace retrieval flow SearchService',
  );
});
