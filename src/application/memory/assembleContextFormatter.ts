/**
 * AssembleContext 格式化层
 *
 * 将 AssembledData 格式化为 JSON payload 或文本输出。
 * 不包含任何业务逻辑或数据源调用。
 */

import type {
  ContextBlock,
  ContextBlockReference,
  FeatureMemory,
  TaskCheckpoint,
} from '../../memory/types.js';
import type { AssemblyProfileName } from '../../memory/MemoryRouter.js';
import { formatWakeupLayersText, type WakeupLayersBundle } from './wakeupLayers.js';
import type {
  AssembleContextPhase,
  AssembleContextSource,
  AssembledData,
  CheckpointPayload,
  CodebaseRetrievalPayload,
  ModuleMemoryPayload,
} from './assembleContextStrategy.js';

// ===========================================
// JSON Payload 类型
// ===========================================

export interface AssembledContextJsonPayload {
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
    moduleMemory: ModuleMemoryPayload['routing'] | null;
    codebaseRetrieval: {
      informationRequest: string;
      technicalTerms: string[];
      responseMode: 'expanded';
      summary: CodebaseRetrievalPayload['summary'] | null;
      architecturePrimaryFiles: string[];
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
    checkpoint: CheckpointPayload | null;
    moduleMemories: FeatureMemory[];
    codebaseRetrieval: CodebaseRetrievalPayload | null;
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
      assembly: ModuleMemoryPayload['assembly'];
      resultCount: number;
    };
    codebaseRetrieval: null | {
      tool: 'codebase-retrieval';
      responseMode: 'expanded';
      summary: CodebaseRetrievalPayload['summary'];
      architecturePrimaryFiles: string[];
    };
    diary: null | {
      tool: 'record_agent_diary';
      resultCount: number;
      agentName?: string;
      topic?: string;
    };
  };
}

// ===========================================
// 格式化函数
// ===========================================

export function buildAssembledPayload(
  args: {
    repo_path: string;
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
  },
  data: AssembledData,
): AssembledContextJsonPayload {
  const checkpointPayload = data.checkpoint;
  const modulePayload = data.moduleMemory;
  const codePayload = data.codebaseRetrieval;

  return {
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
      requestedPhase: data.profile.requestedPhase ?? args.phase,
      resolvedProfile: data.profile.name,
      source: data.profile.source,
    },
    routing: {
      checkpoint: {
        checkpointId: checkpointPayload?.checkpoint.id,
        phase: checkpointPayload?.checkpoint.phase,
        loaded: Boolean(checkpointPayload),
      },
      moduleMemory: modulePayload?.routing ?? null,
      codebaseRetrieval: data.codebaseRetrieval
        ? {
            informationRequest: data.codebaseRequest.information_request,
            technicalTerms: data.codebaseRequest.technical_terms,
            responseMode: 'expanded',
            summary: data.codebaseRetrieval.summary,
            architecturePrimaryFiles: data.codebaseRetrieval.architecturePrimaryFiles,
            nextInspectionSuggestions: data.codebaseRetrieval.nextInspectionSuggestions,
          }
        : null,
    },
    budget: {
      moduleMemory: modulePayload?.routing
        ? {
            candidateCount: modulePayload.routing.candidateCount,
            selectedCount: modulePayload.routing.selectedCount,
            selectedModules: modulePayload.routing.selectedModules,
            maxResults: modulePayload.assembly.maxResults,
            selectionStrategy: modulePayload.routing.selectionStrategy,
            routeStrategy: modulePayload.routing.routeStrategy,
          }
        : null,
      codebaseRetrieval: data.codebaseRetrieval?.summary
        ? {
            codeBlocks: data.codebaseRetrieval.summary.codeBlocks,
            files: data.codebaseRetrieval.summary.files,
            totalSegments: data.codebaseRetrieval.summary.totalSegments,
          }
        : null,
      selectedContextBlocks: data.selectedBlocks.length,
    },
    selectedContext: {
      checkpoint: checkpointPayload,
      moduleMemories: modulePayload?.memories ?? [],
      codebaseRetrieval: codePayload,
      contextBlocks: data.selectedBlocks,
      summary: {
        checkpointBlocks: checkpointPayload?.contextBlocks.length ?? 0,
        diaryBlocks: data.diaryBlocks.length,
        moduleMemoryBlocks: (modulePayload?.memories ?? []).length,
        codeBlocks: codePayload?.contextBlocks.length ?? 0,
        totalBlocks: data.selectedBlocks.length,
        references: data.references.length,
      },
    },
    references: data.references,
    wakeupLayers: data.wakeupLayers,
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
      codebaseRetrieval: codePayload?.summary
        ? {
            tool: 'codebase-retrieval',
            responseMode: 'expanded',
            summary: codePayload.summary,
            architecturePrimaryFiles: codePayload.architecturePrimaryFiles,
          }
        : null,
      diary: data.diaryBlocks.length > 0
        ? {
            tool: 'record_agent_diary',
            resultCount: data.diaryBlocks.length,
            agentName: args.agentName,
            topic: args.diaryTopic,
          }
        : null,
    },
  };
}

export function formatAssembleContextText(payload: AssembledContextJsonPayload): string {
  const stage = payload.input.phase ?? payload.assemblyProfile.resolvedProfile;
  const moduleSummary =
    payload.selectedContext.moduleMemories.length > 0
      ? payload.selectedContext.moduleMemories.map((m) => `- ${m.name}`).join('\n')
      : '- None';
  const blockSummary =
    payload.selectedContext.contextBlocks.length > 0
      ? payload.selectedContext.contextBlocks.slice(0, 12).map(formatContextBlockText).join('\n\n---\n\n')
      : '- None';
  const wakeupLayerSummary = formatWakeupLayersText(payload.wakeupLayers);
  const referenceSummary =
    payload.references.length > 0
      ? payload.references
          .slice(0, 12)
          .map((ref) => `- ${ref.source}:${ref.ref} (${ref.blockId})`)
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
    `- **Architecture Primary Files**: ${payload.routing.codebaseRetrieval?.architecturePrimaryFiles.length ?? 0}`,
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
