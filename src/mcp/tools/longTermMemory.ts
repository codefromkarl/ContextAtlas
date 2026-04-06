import { z } from 'zod';
import { MemoryStore } from '../../memory/MemoryStore.js';
import type { ResolvedLongTermMemoryItem } from '../../memory/types.js';
import { logger } from '../../utils/logger.js';
import { responseFormatSchema } from './responseFormat.js';

const longTermMemoryTypeSchema = z.enum(['user', 'feedback', 'project-state', 'reference']);
const longTermMemoryScopeSchema = z.enum(['project', 'global-user']);

export const recordLongTermMemorySchema = z.object({
  type: longTermMemoryTypeSchema.describe('Long-term memory type'),
  title: z.string().describe('Memory title'),
  summary: z.string().describe('Core summary'),
  why: z.string().optional().describe('Why this memory matters'),
  howToApply: z.string().optional().describe('How to apply this memory later'),
  tags: z.array(z.string()).optional().default([]).describe('Tags'),
  scope: longTermMemoryScopeSchema.optional().describe('Memory scope'),
  source: z
    .enum(['user-explicit', 'agent-inferred', 'tool-result'])
    .optional()
    .default('user-explicit')
    .describe('Memory source'),
  confidence: z.number().optional().default(1).describe('Confidence score'),
  links: z.array(z.string()).optional().default([]).describe('External links'),
  validFrom: z.string().optional().describe('Effective date in ISO format'),
  validUntil: z.string().optional().describe('Expiry/deadline in ISO format'),
  lastVerifiedAt: z.string().optional().describe('Last verification date in ISO format'),
  format: responseFormatSchema,
});

export const manageLongTermMemorySchema = z.object({
  action: z
    .enum(['find', 'list', 'prune', 'delete'])
    .describe(
      'Action: find=search by keyword, list=all memories, prune=remove expired/stale, delete=remove one by id',
    ),
  query: z.string().optional().describe('[find] Keyword query'),
  types: z
    .array(longTermMemoryTypeSchema)
    .optional()
    .describe('[find/list/prune] Filter by memory types'),
  scope: longTermMemoryScopeSchema.optional().describe('[find/list/prune] Restrict to one scope'),
  limit: z.number().optional().default(10).describe('[find] Maximum results'),
  minScore: z.number().optional().default(1).describe('[find] Minimum score threshold'),
  includeExpired: z
    .boolean()
    .optional()
    .default(true)
    .describe('[prune] Whether to prune expired memories'),
  includeStale: z
    .boolean()
    .optional()
    .default(false)
    .describe('[prune] Whether to prune stale memories'),
  staleDays: z
    .number()
    .optional()
    .default(30)
    .describe('[find/list/prune] Days after which an unverified memory is considered stale'),
  dryRun: z
    .boolean()
    .optional()
    .default(true)
    .describe('[prune] Preview pruning without deleting data'),
  id: z.string().optional().describe('[delete] Memory item id to delete'),
  format: responseFormatSchema,
});

export type RecordLongTermMemoryInput = z.infer<typeof recordLongTermMemorySchema>;
export type ManageLongTermMemoryInput = z.infer<typeof manageLongTermMemorySchema>;

export async function handleRecordLongTermMemory(
  args: RecordLongTermMemoryInput,
  projectRoot: string,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const store = new MemoryStore(projectRoot);
  const profile = await store.readProfile();
  const resolvedScope = args.scope || profile?.governance?.personalMemory || 'project';

  logger.info(
    { type: args.type, scope: resolvedScope, title: args.title },
    'MCP record_long_term_memory 调用开始',
  );

  const memory = await store.appendLongTermMemoryItem({
    type: args.type,
    title: args.title,
    summary: args.summary,
    why: args.why,
    howToApply: args.howToApply,
    tags: args.tags,
    scope: resolvedScope,
    source: args.source,
    confidence: args.confidence,
    links: args.links,
    validFrom: args.validFrom,
    validUntil: args.validUntil,
    lastVerifiedAt: args.lastVerifiedAt,
  });

  if (args.format === 'json') {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ tool: 'record_long_term_memory', memory }, null, 2),
        },
      ],
    };
  }

  return {
    content: [
      {
        type: 'text',
        text: `## Long-term Memory Recorded\n\n- **ID**: ${memory.id}\n- **Type**: ${memory.type}\n- **Scope**: ${memory.scope}\n- **Title**: ${memory.title}\n- **Summary**: ${memory.summary}`,
      },
    ],
  };
}

export async function handleManageLongTermMemory(
  args: ManageLongTermMemoryInput,
  projectRoot: string,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
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
  }
}

async function handleFind(
  store: MemoryStore,
  args: ManageLongTermMemoryInput,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
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
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
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
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
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
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
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

function formatLongTermMemory(memory: ResolvedLongTermMemoryItem, matchFields?: string[]): string {
  const matchInfo =
    matchFields && matchFields.length > 0
      ? `\n- **Matched Fields**: ${matchFields.join(', ')}`
      : '';

  const why = memory.why ? `\n- **Why**: ${memory.why}` : '';
  const howToApply = memory.howToApply ? `\n- **How To Apply**: ${memory.howToApply}` : '';
  const links =
    memory.links && memory.links.length > 0 ? `\n- **Links**: ${memory.links.join(', ')}` : '';
  const validity = memory.validUntil ? `\n- **Valid Until**: ${memory.validUntil}` : '';
  const verified = memory.lastVerifiedAt ? `\n- **Last Verified**: ${memory.lastVerifiedAt}` : '';

  return `## ${memory.title}${matchInfo}

- **ID**: ${memory.id}
- **Type**: ${memory.type}
- **Scope**: ${memory.scope}
- **Status**: ${memory.status}
- **Summary**: ${memory.summary}${why}${howToApply}
- **Tags**: ${memory.tags.join(', ') || 'N/A'}${links}
- **Confidence**: ${(memory.confidence * 100).toFixed(0)}%
- **Updated**: ${new Date(memory.updatedAt).toLocaleString()}${validity}${verified}`;
}
