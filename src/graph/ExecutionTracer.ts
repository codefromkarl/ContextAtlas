import type { GraphDirection } from './types.js';
import { GraphStore, type GraphRelationEntry, type StoredSymbol } from './GraphStore.js';

export type ExecutionEntryKind =
  | 'api_route'
  | 'cli_command'
  | 'mcp_tool'
  | 'test'
  | 'main_bootstrap'
  | 'library_symbol';

export interface ExecutionTracePath {
  symbols: StoredSymbol[];
  relationTypes: string[];
  depth: number;
  keyFiles: string[];
  moduleHints: string[];
  score: number;
  scoreReasons: string[];
}

export interface ExecutionModuleCluster {
  modulePath: string;
  symbolCount: number;
  fileCount: number;
  callDensity: number;
  sharedDependencyCount: number;
}

export interface ExecutionProcessSummary {
  id: string;
  entryKind: ExecutionEntryKind;
  entryName: string;
  keySymbols: string[];
  keyFiles: string[];
  modules: ExecutionModuleCluster[];
  depth: number;
  score: number;
  scoreReasons: string[];
}

export interface ExecutionTraceResult {
  entry: StoredSymbol;
  entryKind: ExecutionEntryKind;
  direction: Exclude<GraphDirection, 'both'>;
  maxDepth: number;
  paths: ExecutionTracePath[];
  processes: ExecutionProcessSummary[];
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
    options: { direction?: Exclude<GraphDirection, 'both'>; maxDepth?: number; query?: string } = {},
  ): ExecutionTraceResult | null {
    const direction = options.direction ?? 'downstream';
    const maxDepth = options.maxDepth ?? 3;
    const entry = this.store.findSymbolsByName(symbolName)[0] ?? null;
    if (!entry) return null;

    const entryKind = classifyExecutionEntry(entry);
    const queryTerms = buildQueryTerms(options.query ?? symbolName);
    const paths: ExecutionTracePath[] = [];
    const queue: QueueItem[] = [{ symbol: entry, pathSymbols: [entry], pathRelationTypes: [] }];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const depth = current.pathSymbols.length - 1;
      if (depth >= maxDepth) {
        if (current.pathSymbols.length > 1) {
          paths.push(buildTracePath(current.pathSymbols, current.pathRelationTypes, entryKind, queryTerms));
        }
        continue;
      }

      const nextRelations = this.store
        .getDirectRelations(current.symbol.id, direction)
        .filter((relation) => relation.resolved && relation.symbol)
        .filter((relation) => this.isTraceableRelation(relation));

      if (nextRelations.length === 0) {
        if (current.pathSymbols.length > 1) {
          paths.push(buildTracePath(current.pathSymbols, current.pathRelationTypes, entryKind, queryTerms));
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

    paths.sort((a, b) => b.score - a.score || b.symbols.length - a.symbols.length || a.symbols.map((s) => s.name).join('>').localeCompare(b.symbols.map((s) => s.name).join('>')));

    return {
      entry,
      entryKind,
      direction,
      maxDepth,
      paths,
      processes: paths.map((path, index) => buildProcessSummary(path, index, entryKind)),
    };
  }

  private isTraceableRelation(relation: GraphRelationEntry): boolean {
    return (
      relation.relationType === 'CALLS'
      || relation.relationType === 'HAS_METHOD'
      || relation.relationType === 'IMPORTS'
      || relation.relationType === 'EXTENDS'
      || relation.relationType === 'IMPLEMENTS'
      || relation.relationType === 'METHOD_OVERRIDES'
      || relation.relationType === 'METHOD_IMPLEMENTS'
    );
  }
}

export function classifyExecutionEntry(symbol: StoredSymbol): ExecutionEntryKind {
  const filePath = symbol.filePath.replace(/\\/g, '/');
  const lowerPath = filePath.toLowerCase();
  const lowerName = symbol.name.toLowerCase();

  if (
    lowerPath.includes('/__tests__/')
    || lowerPath.endsWith('.test.ts')
    || lowerPath.endsWith('.test.tsx')
    || lowerPath.endsWith('.spec.ts')
    || lowerPath.endsWith('.spec.tsx')
    || lowerPath.endsWith('_test.go')
  ) {
    return 'test';
  }

  if (
    lowerPath.includes('/api/')
    || lowerPath.includes('/routes/')
    || lowerPath.includes('/pages/api/')
    || lowerPath.includes('/app/api/')
    || ['get', 'post', 'put', 'patch', 'delete', 'handler'].includes(lowerName)
  ) {
    return 'api_route';
  }

  if (lowerPath.includes('/src/mcp/tools/') || lowerPath.includes('/src/mcp/registry/') || lowerName.startsWith('handle')) {
    return 'mcp_tool';
  }

  if (lowerPath.includes('/src/cli/commands/') || lowerPath.includes('/bin/') || lowerName.includes('command')) {
    return 'cli_command';
  }

  if (
    lowerPath.endsWith('/src/index.ts')
    || lowerPath.endsWith('/src/main.ts')
    || lowerPath.endsWith('/src/server.ts')
    || lowerName === 'main'
    || lowerName.includes('bootstrap')
    || lowerName.includes('start')
  ) {
    return 'main_bootstrap';
  }

  return 'library_symbol';
}

function buildTracePath(
  symbols: StoredSymbol[],
  relationTypes: string[],
  entryKind: ExecutionEntryKind,
  queryTerms: Set<string>,
): ExecutionTracePath {
  const keyFiles = Array.from(new Set(symbols.map((symbol) => symbol.filePath))).slice(0, 8);
  const moduleHints = Array.from(new Set(symbols.map((symbol) => modulePathForFile(symbol.filePath)))).slice(0, 5);
  const { score, reasons } = scoreTracePath(symbols, relationTypes, entryKind, queryTerms);

  return {
    symbols,
    relationTypes,
    depth: Math.max(0, symbols.length - 1),
    keyFiles,
    moduleHints,
    score,
    scoreReasons: reasons,
  };
}

function buildProcessSummary(
  path: ExecutionTracePath,
  index: number,
  entryKind: ExecutionEntryKind,
): ExecutionProcessSummary {
  const keySymbols = path.symbols.map((symbol) => symbol.name).slice(0, 8);
  return {
    id: `process-${index + 1}`,
    entryKind,
    entryName: path.symbols[0]?.name ?? 'unknown',
    keySymbols,
    keyFiles: path.keyFiles,
    modules: buildModuleClusters(path),
    depth: path.depth,
    score: path.score,
    scoreReasons: path.scoreReasons,
  };
}

function buildModuleClusters(path: ExecutionTracePath): ExecutionModuleCluster[] {
  const byModule = new Map<string, { files: Set<string>; symbols: number; callCount: number; dependencyCount: number }>();

  path.symbols.forEach((symbol, index) => {
    const modulePath = modulePathForFile(symbol.filePath);
    const existing = byModule.get(modulePath) ?? {
      files: new Set<string>(),
      symbols: 0,
      callCount: 0,
      dependencyCount: 0,
    };
    existing.files.add(symbol.filePath);
    existing.symbols += 1;
    const relationType = path.relationTypes[index - 1];
    if (relationType === 'CALLS' || relationType === 'HAS_METHOD') {
      existing.callCount += 1;
    }
    if (relationType === 'IMPORTS' || relationType === 'EXTENDS' || relationType === 'IMPLEMENTS') {
      existing.dependencyCount += 1;
    }
    byModule.set(modulePath, existing);
  });

  return Array.from(byModule.entries())
    .map(([modulePath, value]) => ({
      modulePath,
      symbolCount: value.symbols,
      fileCount: value.files.size,
      callDensity: round(value.callCount / Math.max(1, value.symbols)),
      sharedDependencyCount: value.dependencyCount,
    }))
    .sort((a, b) => b.symbolCount - a.symbolCount || a.modulePath.localeCompare(b.modulePath));
}

function scoreTracePath(
  symbols: StoredSymbol[],
  relationTypes: string[],
  entryKind: ExecutionEntryKind,
  queryTerms: Set<string>,
): { score: number; reasons: string[] } {
  let score = 1;
  const reasons: string[] = ['base'];

  if (entryKind !== 'library_symbol') {
    score += 0.25;
    reasons.push(`entry:${entryKind}`);
  }

  const matchedTerms = new Set<string>();
  for (const symbol of symbols) {
    const haystack = `${symbol.name} ${symbol.filePath}`.toLowerCase();
    for (const term of queryTerms) {
      if (term.length >= 2 && haystack.includes(term)) {
        matchedTerms.add(term);
      }
    }
  }
  if (matchedTerms.size > 0) {
    score += Math.min(0.5, matchedTerms.size * 0.1);
    reasons.push(`query_match:${Array.from(matchedTerms).slice(0, 5).join(',')}`);
  }

  if (relationTypes.includes('CALLS')) {
    score += 0.2;
    reasons.push('calls');
  }
  if (relationTypes.some((type) => type === 'EXTENDS' || type === 'IMPLEMENTS')) {
    score += 0.15;
    reasons.push('inheritance');
  }

  score -= Math.max(0, symbols.length - 3) * 0.03;
  return { score: round(score), reasons };
}

function buildQueryTerms(query: string): Set<string> {
  return new Set(
    query
      .toLowerCase()
      .split(/[^a-z0-9_]+/i)
      .map((term) => term.trim())
      .filter(Boolean),
  );
}

function modulePathForFile(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts[0] === 'src' && parts.length >= 3) {
    return parts.slice(0, 3).join('/');
  }
  return parts.length >= 2 ? parts.slice(0, 2).join('/') : (parts[0] ?? '.');
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
