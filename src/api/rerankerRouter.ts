/**
 * Reranker Router — selects API or local reranker based on config
 */

import { getRerankProvider, getOllamaRerankerConfig } from '../config.js';
import { LocalRerankerClient } from './localReranker.js';
import { RerankerClient } from './reranker.js';
import type { RerankDetailedResult, RerankOptions } from './reranker.js';

export type RerankerBackend = {
  rerankDetailed(
    query: string,
    documents: string[],
    options?: RerankOptions,
  ): Promise<RerankDetailedResult>;

  rerankWithDataDetailed<T>(
    query: string,
    items: T[],
    textExtractor: (item: T) => string,
    options?: RerankOptions,
  ): Promise<RerankDetailedResult<T>>;
};

let cachedBackend: RerankerBackend | null = null;

export function getRerankerBackend(): RerankerBackend {
  if (cachedBackend) return cachedBackend;

  const provider = getRerankProvider();
  if (provider === 'ollama') {
    cachedBackend = new LocalRerankerClient(getOllamaRerankerConfig()) as RerankerBackend;
  } else {
    cachedBackend = new RerankerClient() as RerankerBackend;
  }
  return cachedBackend;
}

/**
 * Reset cached backend (for testing)
 */
export function resetRerankerBackend(): void {
  cachedBackend = null;
}
