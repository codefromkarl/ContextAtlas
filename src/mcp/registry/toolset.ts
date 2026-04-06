import type { ToolMetadata } from './tools.js';

export type McpToolsetMode = 'full' | 'retrieval-only';

const RETRIEVAL_ONLY_TOOL_NAMES = new Set<string>([
  'codebase-retrieval',
  'find_memory',
  'get_project_profile',
  'load_module_memory',
  'list_memory_catalog',
  'query_shared_memories',
  'get_dependency_chain',
]);

export function resolveMcpToolsetMode(rawValue: string | undefined): McpToolsetMode {
  return rawValue === 'retrieval-only' ? 'retrieval-only' : 'full';
}

export function getConfiguredMcpToolsetMode(
  env: NodeJS.ProcessEnv = process.env,
): McpToolsetMode {
  return resolveMcpToolsetMode(env.CONTEXTATLAS_MCP_TOOLSET);
}

export function isToolAllowedInToolset(name: string, mode: McpToolsetMode): boolean {
  if (mode === 'full') {
    return true;
  }

  return RETRIEVAL_ONLY_TOOL_NAMES.has(name);
}

export function filterToolsForToolset(
  tools: ToolMetadata[],
  mode: McpToolsetMode,
): ToolMetadata[] {
  if (mode === 'full') {
    return tools;
  }

  return tools.filter((tool) => isToolAllowedInToolset(tool.name, mode));
}

export function assertToolAllowed(name: string, mode: McpToolsetMode): void {
  if (isToolAllowedInToolset(name, mode)) {
    return;
  }

  throw new Error(`Tool "${name}" is disabled in MCP toolset mode ${mode}`);
}
