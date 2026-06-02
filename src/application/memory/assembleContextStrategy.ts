/**
 * AssembleContext 策略层
 *
 * 负责 5 源数据收集、profile 解析、block 合并。
 * 纯数据编排，不涉及 JSON payload 构造或文本格式化。
 */

import path from 'node:path';
import type {
  CheckpointCandidate,
  ContextBlock,
  ContextBlockReference,
  FeatureMemory,
  TaskCheckpoint,
} from '../../memory/types.js';
import type { AssemblyProfileName } from '../../memory/MemoryRouter.js';
import { MemoryStore } from '../../memory/MemoryStore.js';
import { logger } from '../../utils/logger.js';
import { buildWakeupLayers, type WakeupLayersBundle } from './wakeupLayers.js';
import { executeLoadModuleMemory } from './executeModuleMemory.js';
import { executeLoadCheckpoint } from './executeCheckpoints.js';
import type { AssembleContextInput } from './executeAssembleContext.js';

// ===========================================
// 导出类型
// ===========================================

export type AssembleContextPhase = TaskCheckpoint['phase'];
export type AssembleContextSource = 'default' | 'phase' | 'profile' | 'checkpoint';

export interface ModuleMemoryPayload {
  memories: FeatureMemory[];
  routing: {
    candidateCount: number;
    selectedCount: number;
    selectedModules: string[];
    routeStrategy: string;
    selectionStrategy: 'mmr' | 'ranked';
  } | null;
  assembly: {
    maxResults: number;
  };
  result_count: number;
  match_details: Array<{ module: string; matchedBy: string; detail: string }>;
}

export interface CodebaseRetrievalPayload {
  contextBlocks: ContextBlock[];
  architecturePrimaryFiles: string[];
  nextInspectionSuggestions: string[];
  summary: {
    codeBlocks: number;
    files: number;
    totalSegments: number;
  } | null;
}

export interface CheckpointPayload {
  checkpoint: TaskCheckpoint;
  contextBlocks: ContextBlock[];
}

export interface AssembledData {
  profile: {
    requestedPhase?: AssembleContextPhase;
    resolvedProfile: AssemblyProfileName;
    source: AssembleContextSource;
  };
  checkpoint: CheckpointPayload | null;
  moduleMemory: ModuleMemoryPayload | null;
  codebaseRetrieval: CodebaseRetrievalPayload | null;
  diaryBlocks: ContextBlock[];
  selectedBlocks: ContextBlock[];
  references: ContextBlockReference[];
  wakeupLayers: WakeupLayersBundle;
  codebaseRequest: { information_request: string; technical_terms: string[] };
}

export interface StrategyResult {
  isError: boolean;
  data: AssembledData | null;
  errorMessage?: string;
}

// ===========================================
// 常量
// ===========================================

export const PHASE_TO_PROFILE: Record<AssembleContextPhase, AssemblyProfileName> = {
  overview: 'overview',
  research: 'overview',
  debug: 'debug',
  implementation: 'implementation',
  verification: 'verification',
  handoff: 'handoff',
};

// ===========================================
// 策略执行
// ===========================================

export async function executeAssemblyStrategy(
  args: AssembleContextInput,
): Promise<StrategyResult> {
  // 1. 加载 checkpoint（如有）
  const checkpointResult = await loadCheckpointIfNeeded(args.repo_path, args.checkpoint_id);
  if (checkpointResult.isError) {
    return { isError: true, data: null, errorMessage: checkpointResult.errorMessage ?? 'Checkpoint load failed' };
  }

  const checkpointPayload = checkpointResult.payload;

  // 2. 解析 assembly profile
  const profile = resolveAssemblyProfile(args, checkpointPayload?.checkpoint);

  // 3. 构建子请求
  const moduleMemoryInput = buildModuleMemoryInput(args, profile.name, checkpointPayload?.checkpoint);
  const codebaseRequest = buildCodebaseRetrievalRequest(args, checkpointPayload?.checkpoint);

  // 4. 并行调用 3 个数据源
  const [moduleMemoryResult, codebaseResult, diaryBlocks] = await Promise.all([
    invokeModuleMemory(args.repo_path, moduleMemoryInput),
    invokeCodebaseRetrieval(args.repo_path, codebaseRequest),
    loadDiaryBlocks(args.repo_path, args),
  ]);

  const modulePayload = moduleMemoryResult;
  const codePayload = codebaseResult.payload;

  // 5. 合并 blocks
  const checkpointBlocks = checkpointPayload?.contextBlocks ?? [];
  const moduleMemoryBlocks = buildModuleMemoryBlocks(modulePayload?.memories ?? []);
  const codeBlocks = codePayload?.contextBlocks ?? [];
  const selectedBlocks = mergeContextBlocks(checkpointBlocks, diaryBlocks, moduleMemoryBlocks, codeBlocks);

  // 6. 收集 references
  const references = uniqueReferences(
    selectedBlocks.flatMap((block) =>
      block.provenance.map((item) => ({
        blockId: block.id,
        source: item.source,
        ref: item.ref,
      })),
    ),
  );

  // 7. 构建 wakeup layers
  const wakeupLayers = buildWakeupLayers({
    assemblyProfile: {
      requestedPhase: args.phase,
      resolvedProfile: profile.name,
      source: profile.source,
    },
    routing: {
      checkpoint: {
        checkpointId: checkpointPayload?.checkpoint.id,
        phase: checkpointPayload?.checkpoint.phase,
        loaded: Boolean(checkpointPayload),
      },
      moduleMemory: modulePayload?.routing ? {
        candidateCount: modulePayload.routing.candidateCount,
        selectedCount: modulePayload.routing.selectedCount,
        selectedModules: modulePayload.routing.selectedModules,
        maxResults: modulePayload.assembly.maxResults,
        selectionStrategy: modulePayload.routing.selectionStrategy,
        routeStrategy: modulePayload.routing.routeStrategy,
      } as any : null,
      codebaseRetrieval: codebaseResult.summary
        ? {
            informationRequest: codebaseRequest.information_request,
            technicalTerms: codebaseRequest.technical_terms,
            responseMode: 'expanded',
            summary: codebaseResult.summary,
            architecturePrimaryFiles: codePayload?.architecturePrimaryFiles ?? [],
            nextInspectionSuggestions: codebaseResult.nextInspectionSuggestions,
          }
        : null,
    },
    checkpoint: checkpointPayload?.checkpoint
      ? {
          id: checkpointPayload.checkpoint.id,
          title: checkpointPayload.checkpoint.title,
          goal: checkpointPayload.checkpoint.goal,
          phase: checkpointPayload.checkpoint.phase,
        }
      : null,
    moduleMemories: modulePayload?.memories ?? [],
    contextBlocks: selectedBlocks,
    references,
    summary: {
      checkpointBlocks: checkpointBlocks.length,
      moduleMemoryBlocks: moduleMemoryBlocks.length,
      codeBlocks: codeBlocks.length,
      totalBlocks: selectedBlocks.length,
      references: references.length,
    },
  });

  return {
    isError: false,
    data: {
      profile,
      checkpoint: checkpointPayload,
      moduleMemory: modulePayload,
      codebaseRetrieval: codePayload,
      diaryBlocks,
      selectedBlocks,
      references,
      wakeupLayers,
      codebaseRequest,
    },
  };
}

// ===========================================
// Profile / Request 解析（纯函数）
// ===========================================

export function resolveAssemblyProfile(
  args: AssembleContextInput,
  checkpoint?: TaskCheckpoint,
): { name: AssemblyProfileName; source: AssembleContextSource } {
  if (args.profile) {
    return { name: args.profile, source: 'profile' };
  }
  if (args.phase) {
    return { name: PHASE_TO_PROFILE[args.phase], source: 'phase' };
  }
  if (checkpoint) {
    return { name: PHASE_TO_PROFILE[checkpoint.phase], source: 'checkpoint' };
  }
  return { name: 'implementation', source: 'default' };
}

export function buildModuleMemoryInput(
  args: AssembleContextInput,
  profile: AssemblyProfileName,
  checkpoint?: TaskCheckpoint,
): {
  moduleName?: string;
  query?: string;
  filePaths?: string[];
  phase?: AssemblyProfileName;
  profile: AssemblyProfileName;
} {
  const phase =
    args.phase && args.phase !== 'research' && !args.profile
      ? args.phase
      : checkpoint && checkpoint.phase !== 'research' && !args.profile && !args.phase
        ? PHASE_TO_PROFILE[checkpoint.phase]
        : undefined;

  return {
    moduleName: args.moduleName,
    query: args.query ?? checkpoint?.goal ?? checkpoint?.title,
    filePaths: args.filePaths,
    ...(phase ? { phase } : {}),
    profile,
  };
}

export function buildCodebaseRetrievalRequest(
  args: AssembleContextInput,
  checkpoint?: TaskCheckpoint,
): { information_request: string; technical_terms: string[] } {
  const technicalTerms = uniqueStrings([
    args.moduleName,
    ...(args.filePaths ?? []).map((fp) => path.basename(fp)),
    checkpoint?.title,
    checkpoint?.goal,
  ]);

  if (args.query?.trim()) {
    return { information_request: args.query.trim(), technical_terms: technicalTerms };
  }
  if (args.moduleName?.trim()) {
    return { information_request: `Trace code context for ${args.moduleName.trim()}`, technical_terms: technicalTerms };
  }
  if (args.filePaths && args.filePaths.length > 0) {
    return { information_request: `Trace code context for ${args.filePaths.join(', ')}`, technical_terms: technicalTerms };
  }
  if (checkpoint?.goal?.trim()) {
    return { information_request: `Trace code context for ${checkpoint.goal.trim()}`, technical_terms: technicalTerms };
  }
  if (checkpoint?.title?.trim()) {
    return { information_request: `Trace code context for ${checkpoint.title.trim()}`, technical_terms: technicalTerms };
  }

  return {
    information_request: `Assemble context for phase ${args.phase ?? args.profile ?? 'implementation'}`,
    technical_terms: technicalTerms,
  };
}

// ===========================================
// 数据源调用
// ===========================================

interface CheckpointLoadResult {
  payload: CheckpointPayload | null;
  isError: boolean;
  errorMessage?: string;
}

async function loadCheckpointIfNeeded(
  repoPath: string,
  checkpointId?: string,
): Promise<CheckpointLoadResult> {
  if (!checkpointId) {
    return { payload: null, isError: false };
  }

  const result = await executeLoadCheckpoint({
    repo_path: repoPath,
    checkpoint_id: checkpointId,
    format: 'json',
  });

  if (result.isError) {
    return { payload: null, isError: true, errorMessage: 'Checkpoint not found' };
  }

  const parsed = parseJsonContent<any>(result.content[0]?.text ?? '', 'load_checkpoint');
  return {
    payload: parsed ? { checkpoint: parsed.checkpoint, contextBlocks: parsed.contextBlocks ?? [] } : null,
    isError: false,
  };
}

async function invokeModuleMemory(
  repoPath: string,
  input: {
    moduleName?: string;
    query?: string;
    filePaths?: string[];
    phase?: AssemblyProfileName;
    profile: AssemblyProfileName;
  },
): Promise<ModuleMemoryPayload | null> {
  const result = await executeLoadModuleMemory(
    {
      moduleName: input.moduleName,
      query: input.query,
      filePaths: input.filePaths,
      phase: input.phase,
      profile: input.profile,
      format: 'json',
    },
    repoPath,
  );

  return parseJsonContent<ModuleMemoryPayload>(result.content[0]?.text ?? '', 'load_module_memory');
}

async function invokeCodebaseRetrieval(
  repoPath: string,
  request: { information_request: string; technical_terms: string[] },
): Promise<{ payload: CodebaseRetrievalPayload | null; summary: CodebaseRetrievalPayload['summary'] | null; nextInspectionSuggestions: string[] }> {
  const { executeCodebaseRetrieval } = await import('../../application/retrieval/codebaseRetrieval.js');

  let result;
  try {
    result = await executeCodebaseRetrieval({
      repoPath,
      informationRequest: request.information_request,
      technicalTerms: request.technical_terms.length > 0 ? request.technical_terms : undefined,
      responseFormat: 'json',
      responseMode: 'expanded',
    });
  } catch (err) {
    logger.warn({ repoPath, error: (err as Error).message }, 'assemble_context 跳过抛错的 codebase-retrieval 调用');
    return { payload: null, summary: null, nextInspectionSuggestions: [] };
  }

  if (result.isError) {
    logger.warn({ repoPath, error: result.text }, 'assemble_context 跳过失败的 codebase-retrieval 响应');
    return { payload: null, summary: null, nextInspectionSuggestions: [] };
  }

  const payload = parseJsonContent<CodebaseRetrievalPayload>(result.text ?? '', 'codebase-retrieval');
  return { payload, summary: payload?.summary ?? null, nextInspectionSuggestions: payload?.nextInspectionSuggestions ?? [] };
}

// ===========================================
// Block 构建与合并（纯函数）
// ===========================================

export function buildModuleMemoryBlocks(memories: FeatureMemory[]): ContextBlock[] {
  return memories.map((memory) => ({
    id: `memory:${normalizeName(memory.name)}`,
    type: 'module-summary' as const,
    title: memory.name,
    purpose: 'Summarize stable module responsibilities and interfaces',
    content: [
      `Responsibility: ${memory.responsibility}`,
      `Location: ${memory.location.dir}`,
      `Files: ${memory.location.files.length > 0 ? memory.location.files.join(', ') : 'N/A'}`,
      `Exports: ${memory.api.exports.length > 0 ? memory.api.exports.join(', ') : 'N/A'}`,
      `Data Flow: ${memory.dataFlow || 'N/A'}`,
      `Key Patterns: ${memory.keyPatterns.length > 0 ? memory.keyPatterns.join(', ') : 'N/A'}`,
    ].join('\n'),
    priority: 'high' as const,
    pinned: true,
    expandable: true,
    memoryKind: 'semantic' as const,
    provenance: [{ source: 'feature-memory' as const, ref: memory.name }],
    freshness: {
      lastVerifiedAt: memory.lastUpdated,
      stale: memory.reviewStatus === 'needs-review',
      confidence:
        memory.confirmationStatus === 'human-confirmed'
          ? 'high'
          : memory.confirmationStatus === 'agent-inferred'
            ? 'medium'
            : 'low',
    },
  }));
}

async function loadDiaryBlocks(
  repoPath: string,
  args: AssembleContextInput,
): Promise<ContextBlock[]> {
  const shouldIncludeDiary = args.includeDiary || Boolean(args.agentName) || Boolean(args.diaryTopic);
  if (!shouldIncludeDiary) {
    return [];
  }

  const store = new MemoryStore(repoPath);
  const limit = args.diaryLimit ?? 3;
  const journals = (await store.listLongTermMemories({
    types: ['journal'],
    scope: 'project',
    includeExpired: true,
  }))
    .filter((item) => !args.agentName || item.tags.includes(`agent:${args.agentName}`))
    .filter((item) => !args.diaryTopic || item.tags.includes(`topic:${args.diaryTopic}`))
    .slice(0, limit);

  return journals.map((item) => ({
    id: `diary:${item.id}`,
    type: 'recent-findings' as const,
    title: item.title,
    purpose: 'Preserve recent agent diary entries that explain attempts, blockers, and next verification steps',
    content: item.summary,
    priority: 'medium' as const,
    pinned: false,
    expandable: true,
    memoryKind: 'episodic' as const,
    provenance: [{ source: 'long-term-memory' as const, ref: item.id }],
    freshness: {
      lastVerifiedAt: item.lastVerifiedAt || item.updatedAt,
      stale: item.status !== 'active',
      confidence: item.confidence >= 0.8 ? 'high' : item.confidence >= 0.5 ? 'medium' : 'low',
    },
  }));
}

export function mergeContextBlocks(...groups: ContextBlock[][]): ContextBlock[] {
  const merged: ContextBlock[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const block of group) {
      if (seen.has(block.id)) continue;
      seen.add(block.id);
      merged.push(block);
    }
  }
  return merged;
}

export function uniqueReferences(references: ContextBlockReference[]): ContextBlockReference[] {
  const seen = new Set<string>();
  const unique: ContextBlockReference[] = [];
  for (const ref of references) {
    const key = `${ref.blockId}:${ref.source}:${ref.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(ref);
  }
  return unique;
}

// ===========================================
// 工具函数
// ===========================================

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-');
}

function parseJsonContent<T>(text: string, toolName: string): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`Failed to parse ${toolName} JSON payload: ${(error as Error).message}`);
  }
}
