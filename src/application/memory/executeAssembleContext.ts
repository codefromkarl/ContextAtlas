/**
 * AssembleContext Application Layer
 *
 * CLI 和 MCP adapter 统一通过此入口调用上下文装配业务逻辑。
 * 高层上下文装配编排：复用 loadModuleMemory、loadCheckpoint、codebaseRetrieval。
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
import { buildWakeupLayers, formatWakeupLayersText, type WakeupLayersBundle } from './wakeupLayers.js';
import type { ResponseFormat, MemoryToolResponse } from './memoryTypes.js';
import { executeLoadModuleMemory } from './executeModuleMemory.js';
import { executeLoadCheckpoint } from './executeCheckpoints.js';

// ===========================================
// Input 类型
// ===========================================

export interface AssembleContextInput {
  repo_path: string;
  phase?: TaskCheckpoint['phase'];
  profile?: AssemblyProfileName;
  query?: string;
  moduleName?: string;
  filePaths?: string[];
  checkpoint_id?: string;
  includeDiary?: boolean;
  agentName?: string;
  diaryTopic?: string;
  diaryLimit?: number;
  format: ResponseFormat;
}

// ===========================================
// 内部类型
// ===========================================

type AssembleContextPhase = TaskCheckpoint['phase'];
type AssembleContextSource = 'default' | 'phase' | 'profile' | 'checkpoint';

interface LoadModuleMemoryJsonPayload {
  tool: 'load_module_memory';
  input: {
    moduleName?: string;
    query?: string;
    scope?: string;
    filePaths?: string[];
    phase?: AssemblyProfileName;
    profile: AssemblyProfileName;
    enableScopeCascade: boolean;
    maxResults: number;
    useMmr: boolean;
    mmrLambda: number;
  };
  assembly: {
    name: AssemblyProfileName;
    source: 'default' | 'phase' | 'profile';
    enableScopeCascade: boolean;
    maxResults: number;
    useMmr: boolean;
    mmrLambda: number;
  };
  routing: {
    candidateCount: number;
    selectedCount: number;
    selectionStrategy: 'mmr' | 'ranked';
    routeStrategy: string;
    routeBreakdown: Array<{ matchedBy: string; count: number }>;
    scopeCascadeApplied: boolean;
    selectedModules: string[];
  };
  result_count: number;
  match_details: Array<{ module: string; matchedBy: string; detail: string }>;
  memories: FeatureMemory[];
  message?: string;
}

interface LoadCheckpointJsonPayload {
  tool: 'load_checkpoint';
  checkpoint: TaskCheckpoint;
  contextBlocks: ContextBlock[];
  handoff: unknown;
  summary: unknown;
  savedTo?: string;
}

interface CodebaseRetrievalJsonPayload {
  responseMode: 'overview' | 'expanded';
  summary: {
    codeBlocks: number;
    files: number;
    totalSegments: number;
  };
  contextBlocks: ContextBlock[];
  references: ContextBlockReference[];
  expansionCandidates: Array<{ filePath: string; reason: string; priority: 'high' | 'medium' | 'low' }>;
  nextInspectionSuggestions: string[];
  checkpointCandidate: CheckpointCandidate;
  blockFirst: {
    schemaVersion: 1;
    contextBlocks: ContextBlock[];
    references: ContextBlockReference[];
    checkpointCandidate: CheckpointCandidate;
    nextInspectionSuggestions: string[];
  };
}

interface AssembledContextJsonPayload {
  tool: 'assemble_context';
  repo_path: string;
  input: {
    phase?: AssembleContextPhase;
    profile?: AssemblyProfileName;
    query?: string;
    moduleName?: string;
    filePaths?: string[];
    checkpoint_id?: string;
    includeDiary?: boolean;
    agentName?: string;
    diaryTopic?: string;
    diaryLimit?: number;
    format: 'json';
  };
  assemblyProfile: {
    requestedPhase?: AssembleContextPhase;
    resolvedProfile: AssemblyProfileName;
    source: AssembleContextSource;
  };
  routing: {
    checkpoint: {
      checkpointId?: string;
      phase?: AssembleContextPhase;
      loaded: boolean;
    };
    moduleMemory: LoadModuleMemoryJsonPayload['routing'] | null;
    codebaseRetrieval: {
      informationRequest: string;
      technicalTerms: string[];
      responseMode: 'expanded';
      summary: CodebaseRetrievalJsonPayload['summary'] | null;
      nextInspectionSuggestions: string[];
    } | null;
  };
  budget: {
    moduleMemory: {
      candidateCount: number;
      selectedCount: number;
      selectedModules: string[];
      maxResults: number;
      selectionStrategy: 'mmr' | 'ranked';
      routeStrategy: string;
    } | null;
    codebaseRetrieval: {
      codeBlocks: number;
      files: number;
      totalSegments: number;
    } | null;
    selectedContextBlocks: number;
  };
  selectedContext: {
    checkpoint: LoadCheckpointJsonPayload | null;
    moduleMemories: FeatureMemory[];
    codebaseRetrieval: CodebaseRetrievalJsonPayload | null;
    contextBlocks: ContextBlock[];
    summary: {
      checkpointBlocks: number;
      diaryBlocks: number;
      moduleMemoryBlocks: number;
      codeBlocks: number;
      totalBlocks: number;
      references: number;
    };
  };
  references: ContextBlockReference[];
  wakeupLayers: WakeupLayersBundle;
  source: {
    checkpoint: null | {
      tool: 'load_checkpoint';
      checkpointId: string;
      phase: AssembleContextPhase;
    };
    moduleMemory: null | {
      tool: 'load_module_memory';
      assembly: LoadModuleMemoryJsonPayload['assembly'];
      resultCount: number;
    };
    codebaseRetrieval: null | {
      tool: 'codebase-retrieval';
      responseMode: 'expanded';
      summary: CodebaseRetrievalJsonPayload['summary'];
    };
    diary: null | {
      tool: 'record_agent_diary';
      resultCount: number;
      agentName?: string;
      topic?: string;
    };
  };
}

const PHASE_TO_PROFILE: Record<AssembleContextPhase, AssemblyProfileName> = {
  overview: 'overview',
  research: 'overview',
  debug: 'debug',
  implementation: 'implementation',
  verification: 'verification',
  handoff: 'handoff',
};

// ===========================================
// Handler
// ===========================================

export async function executeAssembleContext(
  args: AssembleContextInput,
): Promise<MemoryToolResponse> {
  const checkpoint = await loadCheckpointIfNeeded(args.repo_path, args.checkpoint_id);
  if (checkpoint.isError) {
    return checkpoint.response;
  }

  const resolvedProfile = resolveAssemblyProfile(args, checkpoint.payload?.checkpoint);
  const moduleMemoryInput = buildModuleMemoryInput(args, resolvedProfile.name, checkpoint.payload?.checkpoint);
  const codebaseRequest = buildCodebaseRetrievalRequest(args, checkpoint.payload?.checkpoint);

  const moduleMemoryResult = await invokeModuleMemory(args.repo_path, moduleMemoryInput);
  const codebaseResult = await invokeCodebaseRetrieval(args.repo_path, codebaseRequest);

  const checkpointPayload = checkpoint.payload;
  const modulePayload = moduleMemoryResult.payload;
  const codePayload = codebaseResult.payload;
  const diaryBlocks = await loadDiaryBlocks(args.repo_path, args);

  const checkpointBlocks = checkpointPayload?.contextBlocks ?? [];
  const moduleMemoryBlocks = buildModuleMemoryBlocks(modulePayload?.memories ?? []);
  const codeBlocks = codePayload?.contextBlocks ?? [];
  const selectedBlocks = mergeContextBlocks(checkpointBlocks, diaryBlocks, moduleMemoryBlocks, codeBlocks);
  const references = uniqueReferences(
    selectedBlocks.flatMap((block) =>
      block.provenance.map((item) => ({
        blockId: block.id,
        source: item.source,
        ref: item.ref,
      })),
    ),
  );
  const wakeupLayers = buildWakeupLayers({
    assemblyProfile: {
      requestedPhase: args.phase,
      resolvedProfile: resolvedProfile.name,
      source: resolvedProfile.source,
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

  const payload: AssembledContextJsonPayload = {
    tool: 'assemble_context',
    repo_path: args.repo_path,
    input: {
      phase: args.phase,
      profile: args.profile,
      query: args.query,
      moduleName: args.moduleName,
      filePaths: args.filePaths,
      checkpoint_id: args.checkpoint_id,
      includeDiary: args.includeDiary,
      agentName: args.agentName,
      diaryTopic: args.diaryTopic,
      diaryLimit: args.diaryLimit,
      format: 'json',
    },
    assemblyProfile: {
      requestedPhase: args.phase,
      resolvedProfile: resolvedProfile.name,
      source: resolvedProfile.source,
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
            nextInspectionSuggestions: codebaseResult.nextInspectionSuggestions,
          }
        : null,
    },
    budget: {
      moduleMemory: modulePayload
        ? {
            candidateCount: modulePayload.routing.candidateCount,
            selectedCount: modulePayload.routing.selectedCount,
            selectedModules: modulePayload.routing.selectedModules,
            maxResults: modulePayload.assembly.maxResults,
            selectionStrategy: modulePayload.routing.selectionStrategy,
            routeStrategy: modulePayload.routing.routeStrategy,
          }
        : null,
      codebaseRetrieval: codebaseResult.summary
        ? {
            codeBlocks: codebaseResult.summary.codeBlocks,
            files: codebaseResult.summary.files,
            totalSegments: codebaseResult.summary.totalSegments,
          }
        : null,
      selectedContextBlocks: selectedBlocks.length,
    },
    selectedContext: {
      checkpoint: checkpointPayload,
      moduleMemories: modulePayload?.memories ?? [],
      codebaseRetrieval: codePayload ?? null,
      contextBlocks: selectedBlocks,
      summary: {
        checkpointBlocks: checkpointBlocks.length,
        diaryBlocks: diaryBlocks.length,
        moduleMemoryBlocks: moduleMemoryBlocks.length,
        codeBlocks: codeBlocks.length,
        totalBlocks: selectedBlocks.length,
        references: references.length,
      },
    },
    references,
    wakeupLayers,
    source: {
      checkpoint: checkpointPayload
        ? {
            tool: 'load_checkpoint',
            checkpointId: checkpointPayload.checkpoint.id,
            phase: checkpointPayload.checkpoint.phase,
          }
        : null,
      moduleMemory: modulePayload
        ? {
            tool: 'load_module_memory',
            assembly: modulePayload.assembly,
            resultCount: modulePayload.result_count,
          }
        : null,
      codebaseRetrieval: codebaseResult.summary
        ? {
            tool: 'codebase-retrieval',
            responseMode: 'expanded',
            summary: codebaseResult.summary,
          }
        : null,
      diary: diaryBlocks.length > 0
        ? {
            tool: 'record_agent_diary',
            resultCount: diaryBlocks.length,
            agentName: args.agentName,
            topic: args.diaryTopic,
          }
        : null,
    },
  };

  if (args.format === 'json') {
    return {
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    };
  }

  return {
    content: [{ type: 'text', text: formatAssembleContextText(payload) }],
  };
}

// ===========================================
// Internal Helpers
// ===========================================

async function loadCheckpointIfNeeded(
  repoPath: string,
  checkpointId?: string,
): Promise<
  | {
      payload: LoadCheckpointJsonPayload | null;
      isError: false;
      response?: never;
    }
  | {
      payload: null;
      isError: true;
      response: MemoryToolResponse;
    }
> {
  if (!checkpointId) {
    return { payload: null, isError: false };
  }

  const result = await executeLoadCheckpoint({
    repo_path: repoPath,
    checkpoint_id: checkpointId,
    format: 'json',
  });

  if (result.isError) {
    return {
      payload: null,
      isError: true,
      response: {
        isError: true,
        content: result.content,
      },
    };
  }

  const payload = parseJsonContent<LoadCheckpointJsonPayload>(result.content[0]?.text ?? '', 'load_checkpoint');
  return { payload, isError: false };
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
): Promise<{ payload: LoadModuleMemoryJsonPayload | null }> {
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

  return {
    payload: parseJsonContent<LoadModuleMemoryJsonPayload>(result.content[0]?.text ?? '', 'load_module_memory'),
  };
}

async function invokeCodebaseRetrieval(
  repoPath: string,
  request: { information_request: string; technical_terms: string[] },
): Promise<{ payload: CodebaseRetrievalJsonPayload | null; summary: CodebaseRetrievalJsonPayload['summary'] | null; nextInspectionSuggestions: string[] }> {
  // Import codebaseRetrieval dynamically to avoid circular dependencies
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
    const error = err as { message?: string };
    logger.warn(
      {
        repoPath,
        request: request.information_request,
        error: error.message,
      },
      'assemble_context 跳过抛错的 codebase-retrieval 调用',
    );
    return { payload: null, summary: null, nextInspectionSuggestions: [] };
  }

  if (result.isError) {
    logger.warn(
      {
        repoPath,
        request: request.information_request,
        error: result.text,
      },
      'assemble_context 跳过失败的 codebase-retrieval 响应',
    );
    return { payload: null, summary: null, nextInspectionSuggestions: [] };
  }

  const payload = parseJsonContent<CodebaseRetrievalJsonPayload>(result.text ?? '', 'codebase-retrieval');
  return {
    payload,
    summary: payload.summary,
    nextInspectionSuggestions: payload.nextInspectionSuggestions || [],
  };
}

function resolveAssemblyProfile(
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
    return {
      name: PHASE_TO_PROFILE[checkpoint.phase],
      source: 'checkpoint',
    };
  }

  return { name: 'implementation', source: 'default' };
}

function buildModuleMemoryInput(
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

function buildCodebaseRetrievalRequest(
  args: AssembleContextInput,
  checkpoint?: TaskCheckpoint,
): { information_request: string; technical_terms: string[] } {
  const technicalTerms = uniqueStrings([
    args.moduleName,
    ...(args.filePaths ?? []).map((filePath) => path.basename(filePath)),
    checkpoint?.title,
    checkpoint?.goal,
  ]);

  if (args.query?.trim()) {
    return {
      information_request: args.query.trim(),
      technical_terms: technicalTerms,
    };
  }

  if (args.moduleName?.trim()) {
    return {
      information_request: `Trace code context for ${args.moduleName.trim()}`,
      technical_terms: technicalTerms,
    };
  }

  if (args.filePaths && args.filePaths.length > 0) {
    return {
      information_request: `Trace code context for ${args.filePaths.join(', ')}`,
      technical_terms: technicalTerms,
    };
  }

  if (checkpoint?.goal?.trim()) {
    return {
      information_request: `Trace code context for ${checkpoint.goal.trim()}`,
      technical_terms: technicalTerms,
    };
  }

  if (checkpoint?.title?.trim()) {
    return {
      information_request: `Trace code context for ${checkpoint.title.trim()}`,
      technical_terms: technicalTerms,
    };
  }

  return {
    information_request: `Assemble context for phase ${args.phase ?? args.profile ?? 'implementation'}`,
    technical_terms: technicalTerms,
  };
}

function buildModuleMemoryBlocks(memories: FeatureMemory[]): ContextBlock[] {
  return memories.map((memory) => ({
    id: `memory:${normalizeName(memory.name)}`,
    type: 'module-summary',
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
    priority: 'high',
    pinned: true,
    expandable: true,
    memoryKind: 'semantic',
    provenance: [{ source: 'feature-memory', ref: memory.name }],
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
    type: 'recent-findings',
    title: item.title,
    purpose: 'Preserve recent agent diary entries that explain attempts, blockers, and next verification steps',
    content: item.summary,
    priority: 'medium',
    pinned: false,
    expandable: true,
    memoryKind: 'episodic',
    provenance: [{ source: 'long-term-memory', ref: item.id }],
    freshness: {
      lastVerifiedAt: item.lastVerifiedAt || item.updatedAt,
      stale: item.status !== 'active',
      confidence: item.confidence >= 0.8 ? 'high' : item.confidence >= 0.5 ? 'medium' : 'low',
    },
  }));
}

function mergeContextBlocks(...groups: ContextBlock[][]): ContextBlock[] {
  const merged: ContextBlock[] = [];
  const seen = new Set<string>();

  for (const group of groups) {
    for (const block of group) {
      if (seen.has(block.id)) {
        continue;
      }
      seen.add(block.id);
      merged.push(block);
    }
  }

  return merged;
}

function uniqueReferences(references: ContextBlockReference[]): ContextBlockReference[] {
  const seen = new Set<string>();
  const unique: ContextBlockReference[] = [];

  for (const reference of references) {
    const key = `${reference.blockId}:${reference.source}:${reference.ref}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(reference);
  }

  return unique;
}

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }

  return result;
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-');
}

function parseJsonContent<T>(text: string, toolName: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`Failed to parse ${toolName} JSON payload: ${(error as Error).message}`);
  }
}

function formatAssembleContextText(payload: AssembledContextJsonPayload): string {
  const stage = payload.input.phase ?? payload.assemblyProfile.resolvedProfile;
  const moduleSummary =
    payload.selectedContext.moduleMemories.length > 0
      ? payload.selectedContext.moduleMemories.map((memory) => `- ${memory.name}`).join('\n')
      : '- None';
  const blockSummary =
    payload.selectedContext.contextBlocks.length > 0
      ? payload.selectedContext.contextBlocks.slice(0, 12).map((block) => formatContextBlockText(block)).join('\n\n---\n\n')
      : '- None';
  const wakeupLayerSummary = formatWakeupLayersText(payload.wakeupLayers);
  const referenceSummary =
    payload.references.length > 0
      ? payload.references
          .slice(0, 12)
          .map((reference) => `- ${reference.source}:${reference.ref} (${reference.blockId})`)
          .join('\n')
      : '- None';

  return [
    '## Context Assembly',
    `- **Stage**: ${stage}`,
    `- **Assembly Profile**: ${payload.assemblyProfile.resolvedProfile}`,
    `- **Assembly Source**: ${payload.assemblyProfile.source}`,
    '',
    '### Routing / Budget',
    `- **Module Memory**: ${
      payload.budget.moduleMemory
        ? `${payload.budget.moduleMemory.selectedCount}/${payload.budget.moduleMemory.maxResults}`
        : 'None'
    }`,
    `- **Code Retrieval**: ${payload.routing.codebaseRetrieval ? `${payload.routing.codebaseRetrieval.summary?.codeBlocks ?? 0} blocks` : 'None'}`,
    `- **Selected Context Blocks**: ${payload.budget.selectedContextBlocks}`,
    '',
    '### Selected Context',
    `- **Checkpoint**: ${payload.selectedContext.checkpoint ? payload.selectedContext.checkpoint.checkpoint.id : 'None'}`,
    `- **Diary Blocks**: ${payload.selectedContext.summary.diaryBlocks}`,
    `- **Module Memories**: ${payload.selectedContext.moduleMemories.length}`,
    `- **Code Evidence Blocks**: ${payload.selectedContext.codebaseRetrieval?.contextBlocks.length ?? 0}`,
    '',
    wakeupLayerSummary,
    '',
    '### Loaded Module Memories',
    moduleSummary,
    '',
    '### Selected Context Blocks',
    blockSummary,
    '',
    '### References',
    referenceSummary,
  ].join('\n');
}

function formatContextBlockText(block: ContextBlock): string {
  const provenance = block.provenance.map((item) => `${item.source}:${item.ref}`).join(', ') || 'None';
  const contentLines = block.content
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  return [
    `### ${block.title || block.id}`,
    `- **ID**: ${block.id}`,
    `- **Type**: ${block.type}`,
    `- **Purpose**: ${block.purpose}`,
    '- **Content**:',
    ...(contentLines.length > 0 ? contentLines.map((line) => `  - ${line}`) : ['  - None']),
    `- **Provenance**: ${provenance}`,
  ].join('\n');
}
