import type Database from 'better-sqlite3';
import type { Indexer } from '../../indexer/index.js';
import type { VectorStore } from '../../vectorStore/index.js';

export interface SearchDependencyLoaders<
  TIndexer = Indexer,
  TVectorStore = VectorStore,
  TDb = Database.Database,
> {
  loadIndexer: () => Promise<TIndexer>;
  loadVectorStore: () => Promise<TVectorStore>;
  loadDb: () => Promise<TDb>;
}

export async function initializeSearchDependencies<
  TIndexer = Indexer,
  TVectorStore = VectorStore,
  TDb = Database.Database,
>({
  loadIndexer,
  loadVectorStore,
  loadDb,
}: SearchDependencyLoaders<TIndexer, TVectorStore, TDb>): Promise<{
  indexer: TIndexer;
  vectorStore: TVectorStore;
  db: TDb;
}> {
  const [indexer, vectorStore, db] = await Promise.all([loadIndexer(), loadVectorStore(), loadDb()]);
  return { indexer, vectorStore, db };
}
