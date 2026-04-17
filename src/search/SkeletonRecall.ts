import type Database from 'better-sqlite3';
import type { ChunkRecord, VectorStore } from '../vectorStore/index.js';
import { segmentQuery } from './fts.js';
import type { ScoredChunk, SearchConfig } from './types.js';

function buildMatchQuery(query: string): string {
  const tokens = segmentQuery(query);
  if (tokens.length === 0) return '';
  return tokens.map((token) => `"${token.replace(/"/g, '')}"`).join(' OR ');
}

function scoreChunkTokenOverlap(
  chunk: Pick<ChunkRecord, 'breadcrumb' | 'display_code'>,
  queryTokens: Set<string>,
): number {
  const text = `${chunk.breadcrumb} ${chunk.display_code}`.toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    if (text.includes(token)) score += 1;
  }
  return score;
}

function querySkeletonFileHits(
  db: Database.Database,
  matchQuery: string,
  limit: number,
): Array<{ filePath: string; score: number }> {
  if (!matchQuery) return [];

  const fileRows = db.prepare(`
    SELECT path as file_path, bm25(file_skeleton_fts) as score
    FROM file_skeleton_fts
    WHERE file_skeleton_fts MATCH ?
    ORDER BY score
    LIMIT ?
  `).all(matchQuery, limit) as Array<{ file_path: string; score: number }>;

  const symbolRows = db.prepare(`
    SELECT file_path, bm25(symbol_skeleton_fts) as score
    FROM symbol_skeleton_fts
    WHERE symbol_skeleton_fts MATCH ?
    ORDER BY score
    LIMIT ?
  `).all(matchQuery, limit) as Array<{ file_path: string; score: number }>;

  const merged = new Map<string, number>();
  for (const row of [...fileRows, ...symbolRows]) {
    const current = merged.get(row.file_path);
    const normalized = -row.score;
    if (current === undefined || normalized > current) {
      merged.set(row.file_path, normalized);
    }
  }

  return Array.from(merged.entries())
    .map(([filePath, score]) => ({ filePath, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export async function retrieveSkeletonChunks(input: {
  db: Database.Database | null;
  vectorStore: VectorStore | null;
  query: string;
  queryTokens: Set<string>;
  config: Pick<SearchConfig, 'enableSkeletonRecall' | 'skeletonTopKFiles' | 'skeletonChunksPerFile'>;
}): Promise<ScoredChunk[]> {
  const { db, vectorStore, query, queryTokens, config } = input;
  if (!config.enableSkeletonRecall || !db || !vectorStore) {
    return [];
  }

  const matchQuery = buildMatchQuery(query);
  if (!matchQuery) {
    return [];
  }

  const fileHits = querySkeletonFileHits(db, matchQuery, config.skeletonTopKFiles);
  if (fileHits.length === 0) {
    return [];
  }

  const chunksByFile = await vectorStore.getFilesChunks(fileHits.map((hit) => hit.filePath));
  const results: ScoredChunk[] = [];

  for (const hit of fileHits) {
    const chunks = chunksByFile.get(hit.filePath) ?? [];
    const selected = chunks
      .map((chunk) => ({
        chunk,
        overlap: scoreChunkTokenOverlap(chunk, queryTokens),
      }))
      .sort((a, b) => b.overlap - a.overlap || a.chunk.chunk_index - b.chunk.chunk_index)
      .slice(0, config.skeletonChunksPerFile)
      .map(({ chunk }) => chunk);

    for (const chunk of selected) {
      results.push({
        filePath: hit.filePath,
        chunkIndex: chunk.chunk_index,
        score: hit.score,
        source: 'skeleton',
        record: { ...chunk, _distance: 0 },
      });
    }
  }

  return results;
}
