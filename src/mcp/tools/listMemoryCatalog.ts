/**
 * List Memory Catalog MCP Tool
 *
 * 列出 catalog 中的所有模块路由条目和 scope 定义
 */

import { z } from 'zod';
import { MemoryRouter } from '../../memory/MemoryRouter.js';
import type { CatalogModuleEntry, MemoryScope } from '../../memory/types.js';
import { logger } from '../../utils/logger.js';
import { responseFormatSchema } from './responseFormat.js';

// ===========================================
// Schema 定义
// ===========================================

export const listMemoryCatalogSchema = z.object({
  scope: z.string().optional().describe('Filter by scope name'),
  includeDetails: z
    .boolean()
    .optional()
    .default(false)
    .describe('Include module details (keywords, triggerPaths)'),
  format: responseFormatSchema,
});

export type ListMemoryCatalogInput = z.infer<typeof listMemoryCatalogSchema>;

// ===========================================
// 工具处理函数
// ===========================================

/**
 * 列出记忆目录索引
 *
 * 返回 catalog 中的所有模块路由条目和 scope 定义，
 * 可选按 scope 过滤。
 */
export async function handleListMemoryCatalog(
  args: ListMemoryCatalogInput,
  projectRoot: string,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const { scope, includeDetails, format } = args;

  logger.info({ scope, includeDetails }, 'MCP list_memory_catalog 调用开始');

  const router = MemoryRouter.forProject(projectRoot);
  await router.initialize();

  const catalog = router.getCatalog();

  if (!catalog) {
    return {
      content: [
        {
          type: 'text',
          text: 'No memory catalog found. Use record_memory to create module memories or run an explicit catalog build path.',
        },
      ],
    };
  }

  // 按 scope 过滤模块
  const filteredModules = scope
    ? Object.entries(catalog.modules).filter(([, entry]) => entry.scope === scope)
    : Object.entries(catalog.modules);

  // 构建输出
  const parts: string[] = [];

  // 概览
  parts.push('## Memory Catalog');
  parts.push(`- **Version**: ${catalog.version}`);
  parts.push(`- **Total Modules**: ${Object.keys(catalog.modules).length}`);
  parts.push(`- **Total Scopes**: ${Object.keys(catalog.scopes).length}`);
  parts.push(`- **Global Memory Files**: ${catalog.globalMemoryFiles.join(', ') || 'none'}`);
  parts.push('');

  // Scopes
  parts.push('### Scopes');
  const scopeEntries = scope
    ? ([[scope, catalog.scopes[scope]]] as [string, MemoryScope | undefined][])
    : Object.entries(catalog.scopes);

  for (const [scopeName, scopeDef] of scopeEntries) {
    if (!scopeDef) continue;
    const modulesInScope = Object.entries(catalog.modules).filter(([, e]) => e.scope === scopeName);
    parts.push(
      `- **${scopeName}**: ${scopeDef.description} (${modulesInScope.length} modules, cascadeLoad: ${scopeDef.cascadeLoad})`,
    );
  }
  parts.push('');

  // Modules
  parts.push('### Modules');
  for (const [modName, entry] of filteredModules) {
    const detail = includeDetails
      ? formatModuleEntryDetailed(modName, entry)
      : formatModuleEntryBrief(modName, entry);
    parts.push(detail);
  }

  // Global memories
  const globals = router.getGlobals();

  if (format === 'json') {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              tool: 'list_memory_catalog',
              scope: scope || null,
              includeDetails,
              catalog: {
                version: catalog.version,
                globalMemoryFiles: catalog.globalMemoryFiles,
                scopes: scope
                  ? Object.fromEntries(
                      Object.entries(catalog.scopes).filter(([name]) => name === scope),
                    )
                  : catalog.scopes,
                modules: Object.fromEntries(filteredModules),
              },
              globals,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  if (globals.length > 0) {
    parts.push('');
    parts.push('### Global Memories');
    for (const g of globals) {
      parts.push(`- **${g.type}**: last updated ${new Date(g.lastUpdated).toLocaleString()}`);
    }
  }

  return {
    content: [
      {
        type: 'text',
        text: parts.join('\n'),
      },
    ],
  };
}

// ===========================================
// 格式化函数
// ===========================================

function formatModuleEntryBrief(name: string, entry: CatalogModuleEntry): string {
  return `- **${name}**: scope="${entry.scope}", updated=${entry.lastUpdated}`;
}

function formatModuleEntryDetailed(name: string, entry: CatalogModuleEntry): string {
  return `- **${name}**:
  - file: ${entry.file}
  - scope: ${entry.scope}
  - keywords: ${entry.keywords.join(', ') || 'none'}
  - triggerPaths: ${entry.triggerPaths.join(', ') || 'none'}
  - lastUpdated: ${entry.lastUpdated}`;
}
