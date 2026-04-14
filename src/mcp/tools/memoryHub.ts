/**
 * MemoryHub MCP Tool（Thin Adapter）
 *
 * Zod schema + 协议适配，业务逻辑在 application 层。
 */

import { z } from 'zod';
import { responseFormatSchema } from './responseFormat.js';

export const querySharedMemoriesSchema = z.object({
  query: z.string().optional().describe('Full-text search query (FTS5)'),
  queryText: z.string().optional().describe('Compatibility alias for full-text search query'),
  category: z
    .string()
    .optional()
    .describe('Memory category (auth, database, api, search, cache, general)'),
  moduleName: z.string().optional().describe('Module name pattern match'),
  memory_type: z
    .enum(['local', 'shared', 'pattern', 'framework'])
    .optional()
    .describe('Memory type filter'),
  limit: z.number().optional().default(20).describe('Maximum results'),
  mode: z
    .enum(['default', 'fts'])
    .optional()
    .default('default')
    .describe('Search mode: default hybrid query or fts-style query compatibility'),
  format: responseFormatSchema.describe('Response format: text or json'),
});

export const linkMemoriesSchema = z.object({
  from: z
    .object({
      project: z.string().describe('Source project ID'),
      module: z.string().describe('Source module name'),
    })
    .describe('Source memory location'),
  to: z
    .object({
      project: z.string().describe('Target project ID'),
      module: z.string().describe('Target module name'),
    })
    .describe('Target memory location'),
  type: z.enum(['depends_on', 'extends', 'references', 'implements']).describe('Relationship type'),
});

export const getDependencyChainSchema = z.object({
  project: z.string().describe('Project ID'),
  module: z.string().describe('Module name'),
  recursive: z.boolean().optional().default(true).describe('Whether to get recursive dependencies'),
  format: responseFormatSchema.describe('Response format: text or json'),
});

export const manageProjectsSchema = z.object({
  action: z
    .enum(['register', 'list', 'stats'])
    .describe('Action: register=new project, list=all projects, stats=hub statistics'),
  name: z.string().optional().describe('[register] Project display name'),
  path: z.string().optional().describe('[register] Project absolute path'),
  format: responseFormatSchema.describe('Response format: text or json'),
});

export type QuerySharedMemoriesInput = z.infer<typeof querySharedMemoriesSchema>;
export type LinkMemoriesInput = z.infer<typeof linkMemoriesSchema>;
export type GetDependencyChainInput = z.infer<typeof getDependencyChainSchema>;
export type ManageProjectsInput = z.infer<typeof manageProjectsSchema>;
type ToolTextResponse = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

export async function handleQuerySharedMemories(
  args: QuerySharedMemoriesInput,
): Promise<ToolTextResponse> {
  const { executeQuerySharedMemories } = await import('../../application/memory/executeMemoryHub.js');
  return executeQuerySharedMemories(args);
}

export async function handleLinkMemories(args: LinkMemoriesInput): Promise<ToolTextResponse> {
  const { executeLinkMemories } = await import('../../application/memory/executeMemoryHub.js');
  return executeLinkMemories(args);
}

export async function handleGetDependencyChain(
  args: GetDependencyChainInput,
): Promise<ToolTextResponse> {
  const { executeGetDependencyChain } = await import('../../application/memory/executeMemoryHub.js');
  return executeGetDependencyChain(args);
}

export async function handleManageProjects(args: ManageProjectsInput): Promise<ToolTextResponse> {
  const { executeManageProjects } = await import('../../application/memory/executeMemoryHub.js');
  return executeManageProjects(args);
}
