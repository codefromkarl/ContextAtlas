import type { GraphDirection } from './types.js';
import { GraphStore, type GraphRelationEntry, type StoredSymbol } from './GraphStore.js';

export interface ExecutionTracePath {
  symbols: StoredSymbol[];
  relationTypes: string[];
}

export interface ExecutionTraceResult {
  entry: StoredSymbol;
  direction: Exclude<GraphDirection, 'both'>;
  maxDepth: number;
  paths: ExecutionTracePath[];
}

interface QueueItem {
  symbol: StoredSymbol;
  pathSymbols: StoredSymbol[];
  pathRelationTypes: string[];
}

export class ExecutionTracer {
  constructor(private readonly store: GraphStore) {}

  traceFromSymbol(
    symbolName: string,
    options: { direction?: Exclude<GraphDirection, 'both'>; maxDepth?: number } = {},
  ): ExecutionTraceResult | null {
    const direction = options.direction ?? 'downstream';
    const maxDepth = options.maxDepth ?? 3;
    const entry = this.store.findSymbolsByName(symbolName)[0] ?? null;
    if (!entry) return null;

    const paths: ExecutionTracePath[] = [];
    const queue: QueueItem[] = [{ symbol: entry, pathSymbols: [entry], pathRelationTypes: [] }];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const depth = current.pathSymbols.length - 1;
      if (depth >= maxDepth) {
        if (current.pathSymbols.length > 1) {
          paths.push({
            symbols: current.pathSymbols,
            relationTypes: current.pathRelationTypes,
          });
        }
        continue;
      }

      const nextRelations = this.store
        .getDirectRelations(current.symbol.id, direction)
        .filter((relation) => relation.resolved && relation.symbol)
        .filter((relation) => this.isTraceableRelation(relation));

      if (nextRelations.length === 0) {
        if (current.pathSymbols.length > 1) {
          paths.push({
            symbols: current.pathSymbols,
            relationTypes: current.pathRelationTypes,
          });
        }
        continue;
      }

      for (const relation of nextRelations) {
        const nextSymbol = relation.symbol!;
        if (current.pathSymbols.some((item) => item.id === nextSymbol.id)) {
          continue;
        }
        queue.push({
          symbol: nextSymbol,
          pathSymbols: [...current.pathSymbols, nextSymbol],
          pathRelationTypes: [...current.pathRelationTypes, relation.relationType],
        });
      }
    }

    paths.sort((a, b) => b.symbols.length - a.symbols.length || a.symbols.map((s) => s.name).join('>').localeCompare(b.symbols.map((s) => s.name).join('>')));

    return {
      entry,
      direction,
      maxDepth,
      paths,
    };
  }

  private isTraceableRelation(relation: GraphRelationEntry): boolean {
    return (
      relation.relationType === 'CALLS'
      || relation.relationType === 'HAS_METHOD'
      || relation.relationType === 'IMPORTS'
      || relation.relationType === 'EXTENDS'
      || relation.relationType === 'IMPLEMENTS'
    );
  }
}
