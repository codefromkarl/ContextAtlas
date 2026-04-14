/**
 * ProjectMemory MCP Tool（Thin Adapter）
 *
 * Zod schema + 协议适配，业务逻辑在 application 层。
 */

import { z } from 'zod';
import { responseFormatSchema } from './responseFormat.js';

// ===========================================
// Schema 定义
// ===========================================

export const findMemorySchema = z.object({
  query: z.string().describe('Keyword to search for feature memories'),
  limit: z.number().optional().default(10).describe('Maximum number of results to return'),
  minScore: z.number().optional().default(1).describe('Minimum score threshold'),
  format: responseFormatSchema,
});

export const recordMemorySchema = z.object({
  name: z.string().describe('Module name'),
  responsibility: z.string().describe('Module responsibility description'),
  dir: z.string().describe('Source directory path'),
  files: z.array(z.string()).optional().default([]).describe('Related file list'),
  exports: z.array(z.string()).optional().default([]).describe('Exported symbols'),
  endpoints: z
    .array(
      z.object({
        method: z.string(),
        path: z.string(),
        handler: z.string(),
        description: z.string().optional(),
      }),
    )
    .optional()
    .default([])
    .describe('API endpoints'),
  imports: z.array(z.string()).optional().default([]).describe('Internal dependencies'),
  external: z.array(z.string()).optional().default([]).describe('External dependencies'),
  dataFlow: z.string().optional().default('').describe('Data flow description'),
  keyPatterns: z.array(z.string()).optional().default([]).describe('Key patterns'),
  confirmationStatus: z
    .enum(['suggested', 'agent-inferred', 'human-confirmed'])
    .optional()
    .default('human-confirmed')
    .describe('Memory confirmation status'),
  reviewStatus: z
    .enum(['verified', 'needs-review'])
    .optional()
    .default('verified')
    .describe('Review status for memory governance'),
  reviewReason: z.string().optional().describe('Why the memory needs review'),
  reviewMarkedAt: z.string().optional().describe('When the memory was marked for review'),
  evidenceRefs: z.array(z.string()).optional().default([]).describe('Supporting evidence references'),
});

export const recordDecisionSchema = z.object({
  id: z.string().describe('Unique identifier (e.g., "2026-03-27-architecture")'),
  title: z.string().describe('Decision title'),
  context: z.string().describe('Background context'),
  decision: z.string().describe('The decision made'),
  owner: z.string().optional().describe('Optional owner / maintainer for the decision'),
  reviewer: z.string().optional().describe('Optional reviewer for the decision'),
  alternatives: z
    .array(
      z.object({
        name: z.string(),
        pros: z.array(z.string()),
        cons: z.array(z.string()),
      }),
    )
    .optional()
    .default([])
    .describe('Considered alternatives'),
  rationale: z.string().describe('Rationale for the decision'),
  consequences: z.array(z.string()).optional().default([]).describe('Consequences'),
  evidenceRefs: z.array(z.string()).optional().default([]).describe('Supporting evidence references'),
});

export const getProjectProfileSchema = z.object({
  format: responseFormatSchema,
});

const maintenanceFormatSchema = responseFormatSchema;

export const deleteMemorySchema = z.object({
  name: z.string().describe('Module name to delete'),
  format: maintenanceFormatSchema.describe('Response format: text or json'),
});

export const maintainMemoryCatalogSchema = z.object({
  action: z
    .enum(['check', 'rebuild'])
    .describe('Maintenance action: check consistency or rebuild catalog'),
  format: maintenanceFormatSchema.describe('Response format: text or json'),
});

// ===========================================
// 类型定义
// ===========================================

export type FindMemoryInput = z.infer<typeof findMemorySchema>;
export type RecordMemoryInput = z.infer<typeof recordMemorySchema>;
export type RecordDecisionInput = z.infer<typeof recordDecisionSchema>;
export type DeleteMemoryInput = z.infer<typeof deleteMemorySchema>;
export type MaintainMemoryCatalogInput = z.infer<typeof maintainMemoryCatalogSchema>;
export type GetProjectProfileInput = z.infer<typeof getProjectProfileSchema>;

// ===========================================
// Thin Handlers
// ===========================================

export async function handleFindMemory(
  args: FindMemoryInput,
  projectRoot: string,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const { executeFindMemory } = await import('../../application/memory/executeProjectMemory.js');
  return executeFindMemory(args, projectRoot);
}

export async function handleRecordMemory(
  args: RecordMemoryInput,
  projectRoot: string,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const { executeRecordMemory } = await import('../../application/memory/executeProjectMemory.js');
  return executeRecordMemory(args, projectRoot);
}

export async function handleRecordDecision(
  args: RecordDecisionInput,
  projectRoot: string,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const { executeRecordDecision } = await import('../../application/memory/executeProjectMemory.js');
  return executeRecordDecision(args, projectRoot);
}

export async function handleGetProjectProfile(
  args: GetProjectProfileInput,
  projectRoot: string,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const { executeGetProjectProfile } = await import('../../application/memory/executeProjectMemory.js');
  return executeGetProjectProfile(args, projectRoot);
}

export async function handleDeleteMemory(
  args: DeleteMemoryInput,
  projectRoot: string,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const { executeDeleteMemory } = await import('../../application/memory/executeProjectMemory.js');
  return executeDeleteMemory(args, projectRoot);
}

export async function handleMaintainMemoryCatalog(
  args: MaintainMemoryCatalogInput,
  projectRoot: string,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const { executeMaintainMemoryCatalog } = await import('../../application/memory/executeProjectMemory.js');
  return executeMaintainMemoryCatalog(args, projectRoot);
}
