/**
 * LongTermMemory Application Layer
 *
 * CLI 和 MCP adapter 统一通过此入口调用长期记忆业务逻辑。
 */

import { MemoryWriteAdvisor } from '../../memory/MemoryWriteAdvisor.js';
import { MemoryStore } from '../../memory/MemoryStore.js';
import type { ResolvedLongTermMemoryItem } from '../../memory/types.js';
import { logger } from '../../utils/logger.js';
import type { ResponseFormat, MemoryToolResponse } from './memoryTypes.js';

// ===========================================
// Input 类型
// ===========================================

export interface RecordLongTermMemoryInput {
  type: 'user' | 'feedback' | 'project-state' | 'reference' | 'journal' | 'evidence' | 'temporal-fact';
  title: string;
  summary: string;
  why?: string;
  howToApply?: string;
  tags?: string[];
  scope?: 'project' | 'global-user';
  source?: 'user-explicit' | 'agent-inferred' | 'tool-result';
  confidence?: number;
  links?: string[];
  durability?: 'stable' | 'ephemeral';
  provenance?: string[];
  validFrom?: string;
  validUntil?: string;
  lastVerifiedAt?: string;
  factKey?: string;
  format: ResponseFormat;
}

export interface ManageLongTermMemoryInput {
  action: 'find' | 'list' | 'prune' | 'delete' | 'invalidate';
  query?: string;
  types?: Array<'user' | 'feedback' | 'project-state' | 'reference' | 'journal' | 'evidence' | 'temporal-fact'>;
  scope?: 'project' | 'global-user';
  limit?: number;
  minScore?: number;
  includeExpired?: boolean;
  includeStale?: boolean;
  staleDays?: number;
  dryRun?: boolean;
  id?: string;
  factKey?: string;
  ended?: string;
  reason?: string;
  format: ResponseFormat;
}

// ===========================================
// Formatting
// ===========================================

function formatLongTermMemory(memory: ResolvedLongTermMemoryItem, matchFields?: string[]): string {
  const matchInfo =
    matchFields && matchFields.length > 0
      ? `\n- **Matched Fields**: ${matchFields.join(', ')}`
      : '';

  const why = memory.why ? `\n- **Why**: ${memory.why}` : '';
  const howToApply = memory.howToApply ? `\n- **How To Apply**: ${memory.howToApply}` : '';
  const links =
    memory.links && memory.links.length > 0 ? `\n- **Links**: ${memory.links.join(', ')}` : '';
  const factKey = memory.factKey ? `\n- **Fact Key**: ${memory.factKey}` : '';
  const validity = memory.validUntil ? `\n- **Valid Until**: ${memory.validUntil}` : '';
  const verified = memory.lastVerifiedAt ? `\n- **Last Verified**: ${memory.lastVerifiedAt}` : '';

  return `## ${memory.title}${matchInfo}

- **ID**: ${memory.id}
- **Type**: ${memory.type}
- **Scope**: ${memory.scope}
- **Status**: ${memory.status}
- **Summary**: ${memory.summary}${why}${howToApply}
- **Tags**: ${memory.tags.join(', ') || 'N/A'}${links}${factKey}
- **Confidence**: ${(memory.confidence * 100).toFixed(0)}%
- **Updated**: ${new Date(memory.updatedAt).toLocaleString()}${validity}${verified}`;
}

// ===========================================
// Handlers
// ===========================================

export async function executeRecordLongTermMemory(
  args: RecordLongTermMemoryInput,
  projectRoot: string,
): Promise<MemoryToolResponse> {
  const store = new MemoryStore(projectRoot);
  const advisor = new MemoryWriteAdvisor();
  const profile = await store.readProfile();
  const resolvedScope = args.scope || profile?.governance?.personalMemory || 'project';

  logger.info(
    { type: args.type, scope: resolvedScope, title: args.title },
    'MCP record_long_term_memory 调用开始',
  );

  const duplicateHints = await advisor.suggestLongTermMemoryHints(store, {
    type: args.type,
    title: args.title,
    summary: args.summary,
    scope: resolvedScope,
    factKey: args.factKey,
    links: args.links,
    tags: args.tags,
  });

  const { memory, action } = await store.appendLongTermMemoryItem({
    type: args.type,
    title: args.title,
    summary: args.summary,
    why: args.why,
    howToApply: args.howToApply,
    tags: args.tags ?? [],
    scope: resolvedScope,
    source: args.source ?? 'user-explicit',
    confidence: args.confidence ?? 1,
    links: args.links ?? [],
    durability: args.durability ?? 'stable',
    provenance: args.provenance ?? [],
    validFrom: args.validFrom,
    validUntil: args.validUntil,
    lastVerifiedAt: args.lastVerifiedAt,
    factKey: args.factKey,
  });

  if (args.format === 'json') {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { tool: 'record_long_term_memory', write_action: action, memory, duplicateHints },
            null,
            2,
          ),
        },
      ],
    };
  }

  const diagnosticsSection = advisor.formatDiagnosticsSection(
    duplicateHints,
    'No potential duplicates found.',
  );

  return {
    content: [
      {
        type: 'text',
        text: `## Long-term Memory Recorded\n\n- **ID**: ${memory.id}\n- **Type**: ${memory.type}\n- **Scope**: ${memory.scope}\n- **Title**: ${memory.title}\n- **Summary**: ${memory.summary}\n\n${diagnosticsSection}`,
      },
    ],
  };
}

export async function executeManageLongTermMemory(
  args: ManageLongTermMemoryInput,
  projectRoot: string,
): Promise<MemoryToolResponse> {
  const store = new MemoryStore(projectRoot);

  switch (args.action) {
    case 'find':
      return handleFind(store, args);
    case 'list':
      return handleList(store, args);
    case 'prune':
      return handlePrune(store, args);
    case 'delete':
      return handleDelete(store, args);
    case 'invalidate':
      return handleInvalidate(store, args);
  }
}

async function handleFind(
  store: MemoryStore,
  args: ManageLongTermMemoryInput,
): Promise<MemoryToolResponse> {
  const query = args.query ?? '';
  const results = await store.findLongTermMemories(query, {
    types: args.types,
    scope: args.scope,
    limit: args.limit,
    minScore: args.minScore,
    includeExpired: args.includeExpired,
    staleDays: args.staleDays,
  });

  if (args.format === 'json') {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              tool: 'manage_long_term_memory',
              action: 'find',
              query,
              result_count: results.length,
              results: results.map((entry) => ({
                ...entry.memory,
                score: entry.score,
                matchFields: entry.matchFields,
              })),
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  if (results.length === 0) {
    return {
      content: [{ type: 'text', text: `No long-term memories found for "${query}".` }],
    };
  }

  return {
    content: [
      {
        type: 'text',
        text: `## Found ${results.length} long-term memories\n\n${results.map((entry) => formatLongTermMemory(entry.memory, entry.matchFields)).join('\n\n---\n\n')}`,
      },
    ],
  };
}

async function handleList(
  store: MemoryStore,
  args: ManageLongTermMemoryInput,
): Promise<MemoryToolResponse> {
  const memories = await store.listLongTermMemories({
    types: args.types,
    scope: args.scope,
    includeExpired: args.includeExpired,
    staleDays: args.staleDays,
  });

  if (args.format === 'json') {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              tool: 'manage_long_term_memory',
              action: 'list',
              result_count: memories.length,
              results: memories,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  if (memories.length === 0) {
    return { content: [{ type: 'text', text: 'No long-term memories found.' }] };
  }

  return {
    content: [
      {
        type: 'text',
        text: `## Long-term Memories (${memories.length})\n\n${memories.map((memory) => formatLongTermMemory(memory)).join('\n\n---\n\n')}`,
      },
    ],
  };
}

async function handlePrune(
  store: MemoryStore,
  args: ManageLongTermMemoryInput,
): Promise<MemoryToolResponse> {
  const result = await store.pruneLongTermMemories({
    types: args.types,
    scope: args.scope,
    includeExpired: args.includeExpired,
    includeStale: args.includeStale,
    staleDays: args.staleDays,
    dryRun: args.dryRun,
  });

  if (args.format === 'json') {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              tool: 'manage_long_term_memory',
              action: 'prune',
              dry_run: args.dryRun,
              scanned_count: result.scannedCount,
              pruned_count: result.prunedCount,
              pruned_ids: result.pruned.map((m) => m.id),
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  if (result.prunedCount === 0) {
    return {
      content: [
        {
          type: 'text',
          text: `## manage_long_term_memory (prune)\n\n- dry_run: ${args.dryRun}\n- scanned_count: ${result.scannedCount}\n- pruned_count: 0`,
        },
      ],
    };
  }

  return {
    content: [
      {
        type: 'text',
        text: [
          '## manage_long_term_memory (prune)',
          '',
          `- dry_run: ${args.dryRun}`,
          `- scanned_count: ${result.scannedCount}`,
          `- pruned_count: ${result.prunedCount}`,
          `- pruned_ids: ${result.pruned.map((m) => m.id).join(', ')}`,
        ].join('\n'),
      },
    ],
  };
}

async function handleDelete(
  store: MemoryStore,
  args: ManageLongTermMemoryInput,
): Promise<MemoryToolResponse> {
  if (!args.id || !args.types?.[0]) {
    return {
      content: [
        {
          type: 'text',
          text: 'Error: delete action requires both `id` and `types` (at least one type).',
        },
      ],
      isError: true,
    };
  }

  const deleted = await store.deleteLongTermMemoryItem(
    args.types[0],
    args.scope ?? 'project',
    args.id,
  );

  if (args.format === 'json') {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              tool: 'manage_long_term_memory',
              action: 'delete',
              id: args.id,
              type: args.types[0],
              scope: args.scope ?? 'project',
              status: deleted ? 'deleted' : 'not_found',
            },
            null,
            2,
          ),
        },
      ],
      isError: !deleted,
    };
  }

  return {
    content: [
      {
        type: 'text',
        text: deleted
          ? `Deleted long-term memory ${args.id}.`
          : `Long-term memory ${args.id} was not found.`,
      },
    ],
    isError: !deleted,
  };
}

async function handleInvalidate(
  store: MemoryStore,
  args: ManageLongTermMemoryInput,
): Promise<MemoryToolResponse> {
  const type = args.types?.[0];
  if (!type || (!args.id && !args.factKey)) {
    return {
      content: [
        {
          type: 'text',
          text: 'Error: invalidate action requires `types` (at least one type) and either `id` or `factKey`.',
        },
      ],
      isError: true,
    };
  }

  const result = await store.invalidateLongTermMemoryItem(type, args.scope ?? 'project', {
    id: args.id,
    factKey: args.factKey,
    ended: args.ended,
    reason: args.reason,
  });

  if (args.format === 'json') {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              tool: 'manage_long_term_memory',
              action: 'invalidate',
              invalidated_count: result.invalidatedCount,
              memory: result.memory,
            },
            null,
            2,
          ),
        },
      ],
      isError: result.invalidatedCount === 0,
    };
  }

  if (result.invalidatedCount === 0 || !result.memory) {
    return {
      content: [{ type: 'text', text: 'No active long-term memory matched the given id/factKey.' }],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: 'text',
        text: `Invalidated ${result.invalidatedCount} long-term memory item(s): ${result.memory.id}`,
      },
    ],
  };
}
