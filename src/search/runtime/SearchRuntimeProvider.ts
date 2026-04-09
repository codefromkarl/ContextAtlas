import type Database from 'better-sqlite3';
import type { Indexer } from '../../indexer/index.js';
import type { VectorStore } from '../../vectorStore/index.js';
import type { SearchRuntimeContext } from '../SearchPipeline.js';

export interface SearchRuntimeState {
  projectId: string;
  snapshotId?: string | null;
  indexer: Indexer | null;
  vectorStore: VectorStore | null;
  db: Database.Database | null;
}

export function createSearchRuntimeContext(state: SearchRuntimeState): SearchRuntimeContext {
  return {
    projectId: state.projectId,
    snapshotId: state.snapshotId,
    indexer: state.indexer,
    vectorStore: state.vectorStore,
    db: state.db,
  };
}
