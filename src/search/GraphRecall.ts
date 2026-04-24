import type Database from 'better-sqlite3';
import { GraphStore, type StoredSymbol } from '../graph/GraphStore.js';
import type { ChunkRecord, VectorStore } from '../vectorStore/index.js';
import { segmentQuery } from './fts.js';
import type { ScoredChunk, SearchConfig } from './types.js';

function collectSearchTerms(query: string): string[] {
  const rawTerms = query.split(/\s+/).map((term) => term.trim()).filter(Boolean);
  const tokenTerms = segmentQuery(query);
  return Array.from(new Set([...rawTerms, ...tokenTerms]))
    .map((term) => term.replace(/^['"]|['"]$/g, ''))
    .filter((term) => term.length >= 3);
}

function scoreChunkAgainstSymbols(
  chunk: Pick<ChunkRecord, 'breadcrumb' | 'display_code'>,
  symbols: StoredSymbol[],
): number {
  const text = `${chunk.breadcrumb}\n${chunk.display_code}`.toLowerCase();
  let score = 0;
  for (const symbol of symbols) {
    if (text.includes(symbol.name.toLowerCase())) {
      score += 1;
    }
  }
  return score;
}

export async function retrieveGraphChunks(input: {
  db: Database.Database | null;
  vectorStore: VectorStore | null;
  query: string;
  config: Pick<SearchConfig, 'enableGraphRecall' | 'graphRecallTopSymbols' | 'graphRecallChunksPerFile'>;
}): Promise<ScoredChunk[]> {
  const { db, vectorStore, query, config } = input;
  if (!config.enableGraphRecall || !db || !vectorStore) {
    return [];
  }

  const store = new GraphStore(db);
  const matchedSymbols = new Map<string, { symbol: StoredSymbol; score: number }>();
  for (const term of collectSearchTerms(query)) {
    for (const symbol of store.findSymbolsByName(term)) {
      matchedSymbols.set(symbol.id, { symbol, score: 1 });
    }
    for (const symbol of store.searchSymbols(term, config.graphRecallTopSymbols)) {
      if (!matchedSymbols.has(symbol.id)) {
        matchedSymbols.set(symbol.id, { symbol, score: 0.8 });
      }
    }
  }

  if (matchedSymbols.size === 0) {
    return [];
  }

  const relatedByFile = new Map<string, { symbols: StoredSymbol[]; score: number }>();
  const addRelated = (symbol: StoredSymbol, score: number): void => {
    const existing = relatedByFile.get(symbol.filePath);
    if (existing) {
      existing.symbols.push(symbol);
      existing.score = Math.max(existing.score, score);
    } else {
      relatedByFile.set(symbol.filePath, { symbols: [symbol], score });
    }
  };

  for (const { symbol, score } of matchedSymbols.values()) {
    addRelated(symbol, score);
    for (const relation of store.getDirectRelations(symbol.id, 'both')) {
      if (!relation.resolved || !relation.symbol) continue;
      addRelated(relation.symbol, score * 0.75);
    }
    for (const invocation of store.getInvocationsBySymbol(symbol.id)) {
      if (!invocation.enclosingSymbolId) continue;
      const callerSymbol = store.getSymbolById(invocation.enclosingSymbolId);
      if (callerSymbol) {
        addRelated(callerSymbol, score * 0.7);
      }
    }
  }

  const filePaths = Array.from(relatedByFile.keys());
  const chunksByFile = await vectorStore.getFilesChunks(filePaths);
  const results: ScoredChunk[] = [];

  for (const [filePath, relation] of relatedByFile) {
    const chunks = chunksByFile.get(filePath) ?? [];
    const selected = chunks
      .map((chunk) => ({
        chunk,
        score: scoreChunkAgainstSymbols(chunk, relation.symbols),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.chunk.chunk_index - b.chunk.chunk_index)
      .slice(0, config.graphRecallChunksPerFile)
      .map((item) => item.chunk);

    for (const chunk of selected) {
      results.push({
        filePath,
        chunkIndex: chunk.chunk_index,
        score: relation.score,
        source: 'graph',
        record: { ...chunk, _distance: 0 },
      });
    }
  }

  return results.sort((a, b) => b.score - a.score);
}
