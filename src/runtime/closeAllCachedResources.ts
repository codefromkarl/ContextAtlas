import { closeAllIndexers } from '../indexer/index.js';
import { closeAllVectorStores } from '../vectorStore/index.js';

export async function closeAllCachedResources(): Promise<void> {
  closeAllIndexers();
  await closeAllVectorStores();
}
