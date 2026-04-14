/**
 * LongTermMemory MCP Tool（Thin Adapter）
 *
 * Zod schema + 协议适配，业务逻辑在 application 层。
 */

import { z } from 'zod';
import { responseFormatSchema } from './responseFormat.js';

const longTermMemoryTypeSchema = z.enum([
  'user',
  'feedback',
  'project-state',
  'reference',
  'journal',
  'evidence',
  'temporal-fact',
]);
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
  durability: z.enum(['stable', 'ephemeral']).optional().default('stable').describe('Memory durability class'),
  provenance: z.array(z.string()).optional().default([]).describe('Evidence or provenance references'),
  validFrom: z.string().optional().describe('Effective date in ISO format'),
  validUntil: z.string().optional().describe('Expiry/deadline in ISO format'),
  lastVerifiedAt: z.string().optional().describe('Last verification date in ISO format'),
  factKey: z.string().optional().describe('Stable identity key for temporal facts or evidence entries'),
  format: responseFormatSchema,
});

export const manageLongTermMemorySchema = z.object({
  action: z
    .enum(['find', 'list', 'prune', 'delete', 'invalidate'])
    .describe(
      'Action: find=search by keyword, list=all memories, prune=remove expired/stale, delete=remove one by id, invalidate=mark an active memory as invalid',
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
  factKey: z.string().optional().describe('[invalidate] Stable fact key to invalidate'),
  ended: z.string().optional().describe('[invalidate] End date in ISO format'),
  reason: z.string().optional().describe('[invalidate] Optional invalidation reason'),
  format: responseFormatSchema,
});

export type RecordLongTermMemoryInput = z.infer<typeof recordLongTermMemorySchema>;
export type ManageLongTermMemoryInput = z.infer<typeof manageLongTermMemorySchema>;

export async function handleRecordLongTermMemory(
  args: RecordLongTermMemoryInput,
  projectRoot: string,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const { executeRecordLongTermMemory } = await import('../../application/memory/executeLongTermMemory.js');
  return executeRecordLongTermMemory(args, projectRoot);
}

export async function handleManageLongTermMemory(
  args: ManageLongTermMemoryInput,
  projectRoot: string,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const { executeManageLongTermMemory } = await import('../../application/memory/executeLongTermMemory.js');
  return executeManageLongTermMemory(args, projectRoot);
}
