import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalRerankerClient } from '../src/api/localReranker.ts';

test('LocalRerankerClient returns sorted results from Ollama chat API', async () => {
  const client = new LocalRerankerClient({
    baseUrl: 'http://localhost:11434',
    model: 'qwen2.5-coder:7b',
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    assert.ok(url.includes('/api/chat'), `Expected /api/chat URL, got ${url}`);

    return new Response(
      JSON.stringify({
        message: { content: '[2, 0, 1]' },
        model: 'qwen2.5-coder:7b',
      }),
      { status: 200 },
    );
  };

  try {
    const result = await client.rerankDetailed(
      'how does user authentication work',
      ['function login() {}', 'const auth = true', 'export function login() {}'],
    );

    assert.equal(result.results.length, 3, 'should return 3 results');
    // Index 2 is ranked first per mock response [2, 0, 1]
    assert.equal(result.results[0].originalIndex, 2, 'most relevant should be index 2');
    assert.ok(result.results[0].score > 0, 'top result should have positive score');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('LocalRerankerClient handles empty documents', async () => {
  const client = new LocalRerankerClient({
    baseUrl: 'http://localhost:11434',
    model: 'qwen2.5-coder:7b',
  });

  const result = await client.rerankDetailed('query', []);
  assert.equal(result.results.length, 0);
});

test('LocalRerankerClient falls back to score=0 on parse failure', async () => {
  const client = new LocalRerankerClient({
    baseUrl: 'http://localhost:11434',
    model: 'qwen2.5-coder:7b',
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ message: { content: 'I cannot parse this query' } }),
      { status: 200 },
    );

  try {
    const result = await client.rerankDetailed('query', ['doc1', 'doc2']);
    assert.equal(result.results.length, 2);
    assert.ok(result.results.every((r) => r.score === 0), 'all scores should be 0 on parse failure');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('LocalRerankerClient falls back on network error', async () => {
  const client = new LocalRerankerClient({
    baseUrl: 'http://localhost:11434',
    model: 'qwen2.5-coder:7b',
    timeoutMs: 1000,
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('ECONNREFUSED');
  };

  try {
    const result = await client.rerankDetailed('query', ['doc1', 'doc2']);
    assert.equal(result.results.length, 2);
    assert.ok(result.results.every((r) => r.score === 0));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
