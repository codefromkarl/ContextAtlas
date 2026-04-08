type WakeupLayerName = 'L0' | 'L1' | 'L2' | 'L3';

interface WakeupLayerBlock {
  id: string;
  type: string;
  title?: string;
  purpose?: string;
  content?: string;
}

interface WakeupLayersInput {
  assemblyProfile: {
    requestedPhase?: string;
    resolvedProfile: string;
    source: string;
  };
  routing: {
    checkpoint: {
      checkpointId?: string;
      phase?: string;
      loaded: boolean;
    };
    moduleMemory:
      | {
          candidateCount: number;
          selectedCount: number;
          maxResults: number;
          selectionStrategy: 'mmr' | 'ranked';
          routeStrategy: string;
        }
      | null;
    codebaseRetrieval:
      | {
          informationRequest: string;
          technicalTerms: string[];
          responseMode: 'expanded';
          summary: {
            codeBlocks: number;
            files: number;
            totalSegments: number;
          } | null;
          nextInspectionSuggestions: string[];
        }
      | null;
  };
  checkpoint: {
    id: string;
    title: string;
    goal: string;
    phase: string;
  } | null;
  moduleMemories: Array<{
    name: string;
  }>;
  contextBlocks: WakeupLayerBlock[];
  references: Array<{
    blockId: string;
    source: string;
    ref: string;
  }>;
  summary: {
    checkpointBlocks: number;
    moduleMemoryBlocks: number;
    codeBlocks: number;
    totalBlocks: number;
    references: number;
  };
}

interface WakeupLayer {
  name: WakeupLayerName;
  title: string;
  summary: string;
  blockCount: number;
  blockIds: string[];
  highlights: string[];
}

export interface WakeupLayersBundle {
  version: 1;
  layers: WakeupLayer[];
  summary: {
    totalBlocks: number;
    totalReferences: number;
  };
}

export function buildWakeupLayers(input: WakeupLayersInput): WakeupLayersBundle {
  const checkpointBlocks = input.contextBlocks.filter((block) => block.type === 'task-state');
  const moduleMemoryBlocks = input.contextBlocks.filter((block) => block.type === 'module-summary');
  const codeBlocks = input.contextBlocks.filter((block) => block.type !== 'task-state' && block.type !== 'module-summary');

  const layers: WakeupLayer[] = [
    {
      name: 'L0',
      title: 'Intent / Routing',
      summary: `${input.assemblyProfile.resolvedProfile} via ${input.assemblyProfile.source}`,
      blockCount: 0,
      blockIds: [],
      highlights: [
        `Stage: ${input.assemblyProfile.requestedPhase ?? input.assemblyProfile.resolvedProfile}`,
        `Checkpoint: ${input.routing.checkpoint.loaded ? input.routing.checkpoint.checkpointId ?? 'loaded' : 'none'}`,
        `Module Memory: ${
          input.routing.moduleMemory
            ? `${input.routing.moduleMemory.selectedCount}/${input.routing.moduleMemory.maxResults}`
            : 'none'
        }`,
        `Code Retrieval: ${
          input.routing.codebaseRetrieval?.summary
            ? `${input.routing.codebaseRetrieval.summary.codeBlocks} blocks`
            : 'none'
        }`,
      ],
    },
    {
      name: 'L1',
      title: 'Checkpoint',
      summary: input.checkpoint
        ? `${input.checkpoint.title} · ${input.checkpoint.goal || input.checkpoint.phase}`
        : 'No checkpoint loaded',
      blockCount: checkpointBlocks.length,
      blockIds: checkpointBlocks.map((block) => block.id),
      highlights: input.checkpoint
        ? [
            `ID: ${input.checkpoint.id}`,
            `Phase: ${input.checkpoint.phase}`,
            `Goal: ${input.checkpoint.goal || 'N/A'}`,
          ]
        : ['No checkpoint loaded'],
    },
    {
      name: 'L2',
      title: 'Module Memories',
      summary:
        input.moduleMemories.length > 0
          ? `${input.moduleMemories.length} module memory${input.moduleMemories.length === 1 ? '' : 'ies'}`
          : 'No module memories loaded',
      blockCount: moduleMemoryBlocks.length,
      blockIds: moduleMemoryBlocks.map((block) => block.id),
      highlights:
        input.moduleMemories.length > 0
          ? input.moduleMemories.slice(0, 5).map((memory) => memory.name)
          : ['No module memories loaded'],
    },
    {
      name: 'L3',
      title: 'Code Evidence',
      summary:
        codeBlocks.length > 0
          ? `${codeBlocks.length} code block${codeBlocks.length === 1 ? '' : 's'}`
          : 'No code evidence loaded',
      blockCount: codeBlocks.length,
      blockIds: codeBlocks.map((block) => block.id),
      highlights:
        input.routing.codebaseRetrieval?.nextInspectionSuggestions.length > 0
          ? input.routing.codebaseRetrieval.nextInspectionSuggestions.slice(0, 5)
          : [`References: ${input.summary.references}`],
    },
  ];

  return {
    version: 1,
    layers,
    summary: {
      totalBlocks: input.summary.totalBlocks,
      totalReferences: input.references.length,
    },
  };
}

export function formatWakeupLayersText(bundle: WakeupLayersBundle): string {
  const lines = ['### Wakeup Layers'];

  for (const layer of bundle.layers) {
    lines.push(`- **${layer.name}** ${layer.title}: ${layer.summary}`);
    lines.push(`  - Blocks: ${layer.blockCount}`);
    lines.push(`  - Block IDs: ${layer.blockIds.length > 0 ? layer.blockIds.join(', ') : 'None'}`);
    lines.push(
      `  - Highlights: ${layer.highlights.length > 0 ? layer.highlights.map((item) => item.trim()).join(' | ') : 'None'}`,
    );
  }

  lines.push(`- **Selected Blocks**: ${bundle.summary.totalBlocks}`);
  lines.push(`- **References**: ${bundle.summary.totalReferences}`);

  return lines.join('\n');
}
