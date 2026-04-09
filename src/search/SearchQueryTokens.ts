import { segmentQuery } from './fts.js';

export function createQueryTokenSet(query: string): Set<string> {
  return new Set(segmentQuery(query));
}
