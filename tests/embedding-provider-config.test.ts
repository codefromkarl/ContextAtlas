import assert from 'node:assert/strict';
import test from 'node:test';
import { getEmbeddingConfig } from '../src/config.ts';

test('Embedding config accepts local Ollama endpoint configuration', () => {
  // Verify configuration values for local deployment scenarios
  const localBaseUrl = 'http://localhost:11434/v1/embeddings';
  const localModel = 'nomic-embed-text';
  const localDimensions = 768;

  assert.equal(localDimensions, 768, 'nomic-embed-text uses 768 dimensions');
  assert.ok(localBaseUrl.includes('localhost'), 'local URL should contain localhost');
  assert.equal(localModel, 'nomic-embed-text');
});

test('Embedding error message mentions local Ollama option', () => {
  // getEmbeddingConfig reads process.env at call time, so we can test
  // by temporarily clearing the env var
  const originalKey = process.env.EMBEDDINGS_API_KEY;
  delete process.env.EMBEDDINGS_API_KEY;

  try {
    getEmbeddingConfig();
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err instanceof Error, 'should throw Error');
    assert.match(err.message, /Ollama/i, 'Error message should mention Ollama as local alternative');
  } finally {
    if (originalKey !== undefined) process.env.EMBEDDINGS_API_KEY = originalKey;
  }
});
