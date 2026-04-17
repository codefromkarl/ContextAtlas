import type Database from 'better-sqlite3';
import type { Indexer } from '../indexer/index.js';
import type { VectorStore } from '../vectorStore/index.js';
import { ContextPacker } from './ContextPacker.js';
import { HybridRecallEngine } from './HybridRecallEngine.js';
import type { SearchPipelineCallbacks } from './SearchPipelineCallbacks.js';
import {
  buildContextRequest,
  buildRetrievalStats,
  buildResultStats,
  resolveIntentOperationalQuery,
  type BuildContextPackOptions,
} from './SearchPipelineSupport.js';
import { applySmartCutoff } from './RerankPolicy.js';
import { initAuditLog, writeAuditEntry } from './retrievalAuditLog.js';
import type {
  ContextPack,
  QueryIntent,
  ScoredChunk,
  SearchConfig,
} from './types.js';

export type SearchProgressStage = 'retrieve' | 'rerank' | 'expand' | 'pack';

export interface SearchRuntimeContext {
  projectId: string;
  snapshotId: string | null | undefined;
  indexer: Indexer | null;
  vectorStore: VectorStore | null;
  db: Database.Database | null;
}

export type { SearchPipelineCallbacks } from './SearchPipelineCallbacks.js';

export function applyIntentCandidateBias(
  chunks: ScoredChunk[],
  intent: QueryIntent,
): ScoredChunk[] {
  if (intent !== 'architecture' && intent !== 'symbol_lookup') {
    return chunks;
  }

  return chunks.map((chunk) => {
    const lowerPath = chunk.filePath.toLowerCase();
    let multiplier = 1;

    if (lowerPath.startsWith('src/')) {
      multiplier = 1.2;
    } else if (lowerPath.startsWith('tests/')) {
      multiplier = intent === 'symbol_lookup' ? 0.55 : 0.75;
    } else if (lowerPath.startsWith('docs/') || lowerPath === 'readme.md' || lowerPath === 'readme_zh.md') {
      multiplier = intent === 'symbol_lookup' ? 0.45 : 0.65;
    }

    return {
      ...chunk,
      score: chunk.score * multiplier,
    };
  });
}

export function ensureArchitectureFileDiversity(
  seeds: ScoredChunk[],
  reranked: ScoredChunk[],
  retrievedTopM: ScoredChunk[],
  queryIntent: QueryIntent,
  minimumUniqueFiles = 4,
  minimumSourceFiles = 3,
): ScoredChunk[] {
  if (queryIntent !== 'architecture') {
    return seeds;
  }

  const result = [...seeds];
  const seenFiles = new Set(result.map((chunk) => chunk.filePath));
  const countSourceFiles = (): number =>
    Array.from(seenFiles).filter((filePath) => filePath.toLowerCase().startsWith('src/')).length;

  if (seenFiles.size >= minimumUniqueFiles && countSourceFiles() >= minimumSourceFiles) {
    return result;
  }

  const supplemental = [...reranked, ...retrievedTopM];

  for (const chunk of supplemental) {
    const lowerPath = chunk.filePath.toLowerCase();
    if (!lowerPath.startsWith('src/')) continue;
    if (seenFiles.has(chunk.filePath)) continue;
    seenFiles.add(chunk.filePath);
    result.push(chunk);
    if (seenFiles.size >= minimumUniqueFiles && countSourceFiles() >= minimumSourceFiles) {
      return result;
    }
  }

  for (const chunk of supplemental) {
    if (seenFiles.has(chunk.filePath)) continue;
    seenFiles.add(chunk.filePath);
    result.push(chunk);
    if (seenFiles.size >= minimumUniqueFiles && countSourceFiles() >= minimumSourceFiles) {
      break;
    }
  }

  return result;
}

export function ensureSymbolLookupSourceDiversity(
  seeds: ScoredChunk[],
  reranked: ScoredChunk[],
  retrievedTopM: ScoredChunk[],
  queryIntent: QueryIntent,
  minimumSourceFiles = 3,
): ScoredChunk[] {
  if (queryIntent !== 'symbol_lookup') {
    return seeds;
  }

  const result = [...seeds];
  const seenFiles = new Set(result.map((chunk) => chunk.filePath));
  const countSourceFiles = (): number =>
    Array.from(seenFiles).filter((filePath) => filePath.toLowerCase().startsWith('src/')).length;

  if (countSourceFiles() >= minimumSourceFiles) {
    return result;
  }

  const supplemental = [...reranked, ...retrievedTopM];
  for (const chunk of supplemental) {
    const lowerPath = chunk.filePath.toLowerCase();
    if (!lowerPath.startsWith('src/')) continue;
    if (seenFiles.has(chunk.filePath)) continue;
    seenFiles.add(chunk.filePath);
    result.push(chunk);
    if (countSourceFiles() >= minimumSourceFiles) {
      break;
    }
  }

  return result;
}

export function dedupeArchitectureRerankedFiles(
  chunks: ScoredChunk[],
  queryIntent: QueryIntent,
): ScoredChunk[] {
  if (queryIntent !== 'architecture') {
    return chunks;
  }

  const byFile = new Set<string>();
  const deduped: ScoredChunk[] = [];
  for (const chunk of chunks) {
    if (byFile.has(chunk.filePath)) {
      continue;
    }
    byFile.add(chunk.filePath);
    deduped.push(chunk);
  }
  return deduped;
}

export function collectArchitecturePrimaryFiles(
  reranked: ScoredChunk[],
  retrievedTopM: ScoredChunk[],
  packedFiles: Array<{ filePath: string }>,
  queryIntent: QueryIntent,
  queryTokens: Set<string>,
  maxFiles = 3,
): string[] {
  if (queryIntent !== 'architecture') {
    return [];
  }

  const packed = new Set(packedFiles.map((file) => file.filePath));
  const fileScoreMap = new Map<string, { filePath: string; score: number; overlap: number }>();
  const candidates = [...reranked, ...retrievedTopM];

  for (const chunk of candidates) {
    const lowerPath = chunk.filePath.toLowerCase();
    if (!lowerPath.startsWith('src/')) continue;
    if (packed.has(chunk.filePath)) continue;

    const overlap = computePrimaryFileOverlap(chunk.filePath, queryTokens);
    const current = fileScoreMap.get(chunk.filePath);
    if (!current || overlap > current.overlap || (overlap === current.overlap && chunk.score > current.score)) {
      fileScoreMap.set(chunk.filePath, {
        filePath: chunk.filePath,
        score: chunk.score,
        overlap,
      });
    }
  }

  return Array.from(fileScoreMap.values())
    .sort((a, b) => {
      if (b.overlap !== a.overlap) {
        return b.overlap - a.overlap;
      }
      return b.score - a.score;
    })
    .slice(0, maxFiles)
    .map((entry) => entry.filePath);
}

function computePrimaryFileOverlap(filePath: string, queryTokens: Set<string>): number {
  if (queryTokens.size === 0) {
    return 0;
  }

  const pathTokens = tokenizePrimaryFilePath(filePath);
  let overlap = 0;
  for (const queryToken of queryTokens) {
    if (queryToken.length < 3) {
      continue;
    }
    if (pathTokens.some((pathToken) => pathToken === queryToken || pathToken.includes(queryToken) || queryToken.includes(pathToken))) {
      overlap++;
    }
  }
  return overlap;
}

function tokenizePrimaryFilePath(filePath: string): string[] {
  return filePath
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

export async function buildContextPackFromRuntime(
  runtime: SearchRuntimeContext,
  query: string,
  baseConfig: SearchConfig,
  extractQueryTokens: (query: string) => Set<string>,
  onStage?: (stage: SearchProgressStage) => void,
  options: BuildContextPackOptions = {},
  callbacks: SearchPipelineCallbacks = {},
): Promise<ContextPack> {
  const request = buildContextRequest(query, options, baseConfig);
  const operationalQuery = resolveIntentOperationalQuery(request, query);
  const timingMs: Record<string, number> = {};
  let t0 = Date.now();

  onStage?.('retrieve');
  const recallEngine = new HybridRecallEngine({
    indexer: runtime.indexer,
    vectorStore: runtime.vectorStore,
    db: runtime.db,
    config: request.activeConfig,
    extractQueryTokens,
  });
  const retrieved = await recallEngine.hybridRetrieve(
    request.semanticQuery,
    request.lexicalQuery,
    request.queryIntent,
  );
  const candidates = applyIntentCandidateBias(retrieved.chunks, request.queryIntent);
  timingMs.retrieve = Date.now() - t0;
  timingMs.retrieveVector = retrieved.timingMs.retrieveVector;
  timingMs.retrieveLexical = retrieved.timingMs.retrieveLexical;
  timingMs.retrieveFuse = retrieved.timingMs.retrieveFuse;

  t0 = Date.now();
  const topM = candidates.sort((a, b) => b.score - a.score).slice(0, request.activeConfig.fusedTopM);
  const topMCount = topM.length;

  onStage?.('rerank');
  if (!callbacks.rerank) {
    throw new Error('Search pipeline rerank callback is not configured');
  }
  const reranked = await callbacks.rerank(operationalQuery, topM, request.activeConfig);
  timingMs.rerank = Date.now() - t0;

  t0 = Date.now();
  const rerankedForCutoff = dedupeArchitectureRerankedFiles(
    applyIntentCandidateBias(
      reranked.chunks,
      request.queryIntent,
    ),
    request.queryIntent,
  );
  const initialSeeds = applySmartCutoff(rerankedForCutoff, request.activeConfig);
  const architectureSeeds = ensureArchitectureFileDiversity(
    initialSeeds,
    rerankedForCutoff,
    topM,
    request.queryIntent,
  );
  const seeds = ensureSymbolLookupSourceDiversity(
    architectureSeeds,
    rerankedForCutoff,
    topM,
    request.queryIntent,
  );
  timingMs.smartCutoff = Date.now() - t0;

  t0 = Date.now();
  onStage?.('expand');
  const queryTokens = extractQueryTokens(operationalQuery);
  if (!callbacks.expand) {
    throw new Error('Search pipeline expand callback is not configured');
  }
  const expandedResult = await callbacks.expand(seeds, queryTokens, request.activeConfig);
  const expanded = Array.isArray(expandedResult) ? expandedResult : expandedResult.chunks;
  timingMs.expand = Date.now() - t0;

  t0 = Date.now();
  onStage?.('pack');
  const packer = new ContextPacker(runtime.projectId, request.activeConfig, runtime.snapshotId);
  const chunksToPack = request.responseMode === 'overview' ? seeds : [...seeds, ...expanded];
  const packResult = await packer.packWithStats(chunksToPack);
  const files = packResult.files;
  const architecturePrimaryFiles = collectArchitecturePrimaryFiles(
    rerankedForCutoff,
    topM,
    files,
    request.queryIntent,
    queryTokens,
  );
  timingMs.pack = Date.now() - t0;

  const retrievalStats = buildRetrievalStats({
    queryIntent: request.queryIntent,
    retrievedStats: retrieved.stats,
    topMCount,
    rerankInputCount: reranked.inputCount,
    rerankedCount: reranked.chunks.length,
  });
  const resultStats = buildResultStats({
    seeds,
    expanded,
    files,
    packStats: packResult.stats,
  });

  // Audit log — best-effort, never breaks retrieval
  if (runtime.db) {
    try {
      initAuditLog(runtime.db);
      writeAuditEntry(runtime.db, {
        query,
        intent: request.queryIntent,
        lexicalStrategy: retrieved.stats.lexicalStrategy,
        vectorCount: retrieved.stats.vectorCount,
        lexicalCount: retrieved.stats.lexicalCount,
        fusedCount: retrieved.stats.fusedCount,
        rerankedCount: reranked.chunks.length,
        seedCount: seeds.length,
        expandedCount: expanded.length,
        totalMs: Object.values(timingMs).reduce((sum, ms) => sum + ms, 0),
        rerankProvider: process.env.RERANK_PROVIDER || 'api',
        topSeedPaths: seeds.slice(0, 5).map((s) => s.filePath),
      });
    } catch {
      // Audit log is best-effort
    }
  }

  return {
    query,
    mode: request.responseMode,
    seeds,
    expanded,
    files,
    architecturePrimaryFiles,
    expansionCandidates: Array.isArray(expandedResult) ? [] : expandedResult.explorationCandidates,
    nextInspectionSuggestions: Array.isArray(expandedResult) ? [] : expandedResult.nextInspectionSuggestions,
    debug: {
      wVec: request.activeConfig.wVec,
      wLex: request.activeConfig.wLex,
      timingMs,
      retrievalStats,
      resultStats,
      rerankUsage: reranked.usage,
    },
  };
}
