/**
 * Local Reranker Client — Ollama chat-based reranking
 *
 * Uses a local Ollama model to rerank code snippets by relevance.
 * Falls back to equal scoring if the model output cannot be parsed.
 */

import { logger } from '../utils/logger.js';
import type { RerankedDocument, RerankDetailedResult, RerankOptions } from './reranker.js';

export interface LocalRerankerConfig {
  baseUrl: string;
  model: string;
  /** Max tokens for model response (default 512) */
  maxTokens?: number;
  /** Request timeout in ms (default 30000) */
  timeoutMs?: number;
}

const RERANK_SYSTEM_PROMPT = `You are a code relevance judge. Given a query and a list of code snippets, return ONLY a JSON array of indices ordered by relevance (most relevant first). Example: [2, 0, 1]. No explanation, no markdown, just the array.`;

export class LocalRerankerClient {
  private config: Required<LocalRerankerConfig>;

  constructor(config: LocalRerankerConfig) {
    this.config = {
      maxTokens: 512,
      timeoutMs: 30000,
      ...config,
    };
  }

  async rerankDetailed(
    query: string,
    documents: string[],
  ): Promise<RerankDetailedResult> {
    if (documents.length === 0) {
      return { results: [] };
    }

    const numberedDocs = documents
      .map((doc, i) => `[${i}] ${doc}`)
      .join('\n\n');

    const userPrompt = `Query: ${query}\n\nSnippets:\n${numberedDocs}`;

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs,
    );

    try {
      const response = await fetch(`${this.config.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            { role: 'system', content: RERANK_SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
          stream: false,
          options: { num_predict: this.config.maxTokens },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Ollama rerank HTTP ${response.status}`);
      }

      const data = (await response.json()) as {
        message: { content: string };
      };
      const indices = this.parseIndexArray(data.message.content, documents.length);

      if (indices.length === 0) {
        // Model failed to produce valid ranking — return all with score 0
        logger.warn('Local rerank produced no valid indices, returning equal scores');
        return {
          results: documents.map((text, i) => ({
            originalIndex: i,
            score: 0,
            text,
          })),
        };
      }

      const topN = indices.length;
      const results: RerankedDocument[] = indices.map(
        (originalIndex, rank) => ({
          originalIndex,
          score: 1 - rank / Math.max(topN, 1),
          text: documents[originalIndex],
        }),
      );

      // Include documents not in the ranked list with score 0
      const rankedSet = new Set(indices);
      for (let i = 0; i < documents.length; i++) {
        if (!rankedSet.has(i)) {
          results.push({
            originalIndex: i,
            score: 0,
            text: documents[i],
          });
        }
      }

      return { results };
    } catch (err) {
      logger.error({ error: err }, 'Local rerank failed, returning equal scores');
      return {
        results: documents.map((text, i) => ({
          originalIndex: i,
          score: 0,
          text,
        })),
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Parse model output as an index array.
   * Tries direct JSON parse first, then extracts first [...]+ pattern.
   */
  /**
   * Rerank with attached metadata (matches RerankerClient.rerankWithDataDetailed contract)
   */
  async rerankWithDataDetailed<T>(
    query: string,
    items: T[],
    textExtractor: (item: T) => string,
    _options?: RerankOptions,
  ): Promise<RerankDetailedResult<T>> {
    if (items.length === 0) {
      return { results: [] };
    }

    const texts = items.map(textExtractor);
    const textResult = await this.rerankDetailed(query, texts);

    return {
      results: textResult.results.map((result) => ({
        ...result,
        data: items[result.originalIndex],
      })),
    };
  }

  private parseIndexArray(content: string, maxIndex: number): number[] {
    const cleaned = content.trim();

    // Attempt 1: direct parse
    try {
      const arr = JSON.parse(cleaned);
      if (Array.isArray(arr) && arr.every((n) => typeof n === 'number')) {
        return this.validateIndices(arr as number[], maxIndex);
      }
    } catch {
      // not valid JSON
    }

    // Attempt 2: extract first [..] block
    const match = cleaned.match(/\[[\d\s,]+\]/);
    if (match) {
      try {
        const arr = JSON.parse(match[0]) as number[];
        return this.validateIndices(arr, maxIndex);
      } catch {
        // extraction failed
      }
    }

    logger.warn({ content: cleaned.slice(0, 200) }, 'Failed to parse rerank output');
    return [];
  }

  private validateIndices(indices: number[], maxIndex: number): number[] {
    const valid = new Set<number>();
    const result: number[] = [];
    for (const idx of indices) {
      if (Number.isInteger(idx) && idx >= 0 && idx < maxIndex && !valid.has(idx)) {
        valid.add(idx);
        result.push(idx);
      }
    }
    return result;
  }
}
