/**
 * Project Memory MCP Tools
 *
 * 提供功能记忆和决策记录的查询、保存能力
 */

import { z } from 'zod';
import { MemoryFinder } from '../../memory/MemoryFinder.js';
import { MemoryRouter } from '../../memory/MemoryRouter.js';
import { MemoryStore } from '../../memory/MemoryStore.js';
import { MemoryWriteAdvisor } from '../../memory/MemoryWriteAdvisor.js';
import type {
  DecisionRecord,
  FeatureMemory,
  GlobalMemory,
  ProjectProfile,
} from '../../memory/types.js';
import { logger } from '../../utils/logger.js';
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
// 工具处理函数
// ===========================================

/**
 * 查找功能记忆
 */
export async function handleFindMemory(
  args: FindMemoryInput,
  projectRoot: string,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const { query, limit, minScore, format } = args;

  logger.info({ query, limit, minScore }, 'MCP find_memory 调用开始');

  const finder = new MemoryFinder(projectRoot);
  const results = await finder.find(query, { limit, minScore });

  if (results.length === 0) {
    // 触发自动记录器，检查是否建议记录
    const { MemoryAutoRecorder } = await import('../../memory/MemoryAutoRecorder.js');
    const recorder = new MemoryAutoRecorder(projectRoot);
    const triggerResult = await recorder.onTrigger({
      type: 'module-not-found',
      context: { moduleName: query, projectRoot },
    });

    if (triggerResult.shouldSuggest) {
      return {
        content: [
          {
            type: 'text',
            text: `未找到 "${query}" 相关记忆。

检测到可能是新模块，建议记录功能记忆。

**优先调用 suggest_memory 生成建议，再决定是否 record_memory：**
\`\`\`json
{
  "moduleName": "${query}"
}
\`\`\`

或直接调用 record_memory 来确认记录：
\`\`\`json
{
  "name": "${query}",
  "responsibility": "模块职责描述",
  "dir": "src/xxx/",
  "files": ["xxx.service.ts"]
}
\`\`\`

或调用 suggest_memory 让 AI 帮助提取模块信息。`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: `No feature memory found for query "${query}".\n\nTry using different keywords or call 'suggest_memory' before recording a new memory.`,
        },
      ],
    };
  }

  if (format === 'json') {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              tool: 'find_memory',
              query,
              result_count: results.length,
              results: results.map((r) => ({
                score: r.score,
                matchFields: r.matchFields,
                memory: r.memory,
              })),
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  const formattedResults = results
    .map((r) => formatFeatureMemory(r.memory, r.matchFields))
    .join('\n\n---\n\n');

  return {
    content: [
      {
        type: 'text',
        text: `## Found ${results.length} feature memories for "${query}"\n\n${formattedResults}`,
      },
    ],
  };
}

/**
 * 记录功能记忆
 */
export async function handleRecordMemory(
  args: RecordMemoryInput,
  projectRoot: string,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const {
    name,
    responsibility,
    dir,
    files,
    exports,
    endpoints,
    imports,
    external,
    dataFlow,
    keyPatterns,
    confirmationStatus,
    reviewStatus,
    reviewReason,
    reviewMarkedAt,
    evidenceRefs,
  } = args;

  logger.info({ name, dir }, 'MCP record_memory 调用开始');

  const store = new MemoryStore(projectRoot);
  const advisor = new MemoryWriteAdvisor();

  const memory: FeatureMemory = {
    name,
    responsibility,
    location: {
      dir,
      files: files || [],
    },
    api: {
      exports: exports || [],
      endpoints: endpoints || [],
    },
    dependencies: {
      imports: imports || [],
      external: external || [],
    },
    dataFlow: dataFlow || '',
    keyPatterns: keyPatterns || [],
    lastUpdated: new Date().toISOString(),
    confirmationStatus,
    reviewStatus,
    reviewReason,
    reviewMarkedAt,
    evidenceRefs,
  };

  const duplicateHints = await advisor.suggestFeatureMemoryHints(store, memory);

  const filePath = await store.saveFeature(memory);
  const diagnosticsSection = advisor.formatDiagnosticsSection(
    duplicateHints,
    'No potential duplicates found.',
  );

  return {
    content: [
      {
        type: 'text',
        text: `## Feature Memory Recorded\n\n- **Name**: ${name}\n- **Location**: ${dir}\n- **Responsibility**: ${responsibility}\n- **Confirmation Status**: ${confirmationStatus}\n- **Review Status**: ${reviewStatus}${reviewReason ? ` (${reviewReason})` : ''}\n- **Saved to**: ${filePath}\n\n${diagnosticsSection}`,
      },
    ],
  };
}

/**
 * 记录决策
 */
export async function handleRecordDecision(
  args: RecordDecisionInput,
  projectRoot: string,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const { id, title, context, decision, owner, reviewer, alternatives, rationale, consequences, evidenceRefs } = args;

  logger.info({ id, title }, 'MCP record_decision 调用开始');

  const store = new MemoryStore(projectRoot);
  const advisor = new MemoryWriteAdvisor();

  const decisionRecord: DecisionRecord = {
    id,
    date: new Date().toISOString().split('T')[0],
    owner,
    reviewer,
    title,
    context,
    decision,
    alternatives: alternatives || [],
    rationale,
    consequences: consequences || [],
    evidenceRefs,
    status: 'accepted',
  };

  const duplicateHints = await advisor.suggestDecisionHints(store, decisionRecord);
  const filePath = await store.saveDecision(decisionRecord);
  const diagnosticsSection = advisor.formatDiagnosticsSection(
    duplicateHints,
    'No potential duplicates found.',
  );

  return {
    content: [
      {
        type: 'text',
        text: `## Decision Recorded\n\n- **ID**: ${id}\n- **Title**: ${title}\n- **Owner**: ${owner || 'N/A'}\n- **Reviewer**: ${reviewer || 'N/A'}\n- **Decision**: ${decision}\n- **Saved to**: ${filePath}\n\n${diagnosticsSection}`,
      },
    ],
  };
}

/**
 * 获取项目档案 + 全局记忆
 */
export async function handleGetProjectProfile(
  args: GetProjectProfileInput,
  projectRoot: string,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  logger.info('MCP get_project_profile 调用开始');

  const router = MemoryRouter.forProject(projectRoot);
  const initialized = await router.initialize();

  const store = new MemoryStore(projectRoot);
  const profile = await store.readProfile();

  if (!profile) {
    if (args.format === 'json') {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                tool: 'get_project_profile',
                status: 'not_found',
                profile: null,
                globals: initialized.globals,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: 'No project profile found. Create one using the CLI or MCP tools.',
        },
      ],
    };
  }

  // Load global memories
  const globals = initialized.globals;

  if (args.format === 'json') {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              tool: 'get_project_profile',
              profile,
              globals,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  const globalSection = globals.length > 0 ? '\n\n' + formatGlobalMemories(globals) : '';

  return {
    content: [
      {
        type: 'text',
        text: formatProjectProfile(profile) + globalSection,
      },
    ],
  };
}

export async function handleDeleteMemory(
  args: DeleteMemoryInput,
  projectRoot: string,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  logger.info({ name: args.name }, 'MCP delete_memory 调用开始');

  const store = new MemoryStore(projectRoot);
  const deleted = await store.deleteFeature(args.name);

  if (args.format === 'json') {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              tool: 'delete_memory',
              status: deleted ? 'deleted' : 'not_found',
              name: args.name,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  return {
    content: [
      {
        type: 'text',
        text: deleted
          ? ['## delete_memory', '', '- status: deleted', `- name: ${args.name}`].join('\n')
          : ['## delete_memory', '', '- status: not_found', `- name: ${args.name}`].join('\n'),
      },
    ],
  };
}

async function handleCheckMemoryConsistency(
  args: { format: 'text' | 'json' },
  projectRoot: string,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  logger.info('MCP check_memory_consistency 调用开始');

  const store = new MemoryStore(projectRoot);
  const router = MemoryRouter.forProject(projectRoot);
  await router.initialize();

  const features = await store.listFeatures();
  const featureNames = new Set(
    features.map((feature) => feature.name.toLowerCase().trim().replace(/\s+/g, '-')),
  );
  const catalog = router.getCatalog();
  const catalogNames = new Set(Object.keys(catalog?.modules || {}));

  const missingFromCatalog = [...featureNames].filter((name) => !catalogNames.has(name));
  const staleCatalogEntries = [...catalogNames].filter((name) => !featureNames.has(name));

  if (args.format === 'json') {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              tool: 'check_memory_consistency',
              status:
                missingFromCatalog.length === 0 && staleCatalogEntries.length === 0
                  ? 'ok'
                  : 'issues_detected',
              missing_from_catalog: missingFromCatalog.length,
              stale_catalog_entries: staleCatalogEntries.length,
              missing_modules: missingFromCatalog,
              stale_modules: staleCatalogEntries,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  if (missingFromCatalog.length === 0 && staleCatalogEntries.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: [
            '## check_memory_consistency',
            '',
            '- status: ok',
            '- missing_from_catalog: 0',
            '- stale_catalog_entries: 0',
          ].join('\n'),
        },
      ],
    };
  }

  const parts: string[] = ['## check_memory_consistency', '', '- status: issues_detected'];
  parts.push(`- missing_from_catalog: ${missingFromCatalog.length}`);
  parts.push(`- stale_catalog_entries: ${staleCatalogEntries.length}`);
  if (missingFromCatalog.length > 0) {
    parts.push(`- missing_modules: ${missingFromCatalog.join(', ')}`);
  }
  if (staleCatalogEntries.length > 0) {
    parts.push(`- stale_modules: ${staleCatalogEntries.join(', ')}`);
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

async function handleRebuildMemoryCatalog(
  args: { format: 'text' | 'json' },
  projectRoot: string,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  logger.info('MCP rebuild_memory_catalog 调用开始');

  const router = MemoryRouter.forProject(projectRoot);
  const catalog = await router.buildCatalog();

  if (args.format === 'json') {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              tool: 'rebuild_memory_catalog',
              status: 'rebuilt',
              modules: Object.keys(catalog.modules).length,
              scopes: Object.keys(catalog.scopes).length,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  return {
    content: [
      {
        type: 'text',
        text: [
          '## rebuild_memory_catalog',
          '',
          '- status: rebuilt',
          `- modules: ${Object.keys(catalog.modules).length}`,
          `- scopes: ${Object.keys(catalog.scopes).length}`,
        ].join('\n'),
      },
    ],
  };
}

export async function handleMaintainMemoryCatalog(
  args: MaintainMemoryCatalogInput,
  projectRoot: string,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  if (args.action === 'check') {
    return handleCheckMemoryConsistency({ format: args.format }, projectRoot);
  }

  return handleRebuildMemoryCatalog({ format: args.format }, projectRoot);
}

// ===========================================
// 格式化函数
// ===========================================

function formatFeatureMemory(memory: FeatureMemory, matchFields?: string[]): string {
  const matchInfo =
    matchFields && matchFields.length > 0
      ? `\n- **Matched Fields**: ${matchFields.join(', ')}`
      : '';

  const endpoints =
    memory.api.endpoints && memory.api.endpoints.length > 0
      ? `\n- **Endpoints**:\n${memory.api.endpoints.map((e) => `  - ${e.method} ${e.path} → ${e.handler}`).join('\n')}`
      : '';

  return `## ${memory.name}${matchInfo}

- **职责**: ${memory.responsibility}
- **位置**: ${memory.location.dir}
- **文件**: ${memory.location.files.join(', ') || 'N/A'}
- **导出**: ${memory.api.exports.join(', ') || 'N/A'}${endpoints}
- **确认状态**: ${memory.confirmationStatus || 'human-confirmed'}
- **复核状态**: ${memory.reviewStatus || 'verified'}${memory.reviewReason ? ` (${memory.reviewReason})` : ''}
- **数据流**: ${memory.dataFlow || 'N/A'}
- **关键模式**: ${memory.keyPatterns.join(', ') || 'N/A'}
- **内部依赖**: ${memory.dependencies.imports.join(', ') || 'N/A'}
- **外部依赖**: ${memory.dependencies.external.join(', ') || 'N/A'}
- **最后更新**: ${new Date(memory.lastUpdated).toLocaleString()}`;
}

function formatGlobalMemories(globals: GlobalMemory[]): string {
  const parts = globals.map((g) => {
    const dataEntries = Object.entries(g.data)
      .map(([k, v]) => `  - ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join('\n');
    return `### Global Memory: ${g.type}\n${dataEntries || '  (no entries)'}\n- **Last Updated**: ${new Date(g.lastUpdated).toLocaleString()}`;
  });
  return `## Global Memories\n\n${parts.join('\n\n')}`;
}

function formatProjectProfile(profile: ProjectProfile): string {
  return `## Project Profile: ${profile.name}

${profile.description}

### Tech Stack

- **Languages**: ${profile.techStack.language.join(', ')}
- **Frameworks**: ${profile.techStack.frameworks.join(', ')}
- **Databases**: ${profile.techStack.databases.join(', ')}
- **Tools**: ${profile.techStack.tools.join(', ')}

### Project Structure

- **Source Dir**: ${profile.structure.srcDir}
- **Main Entry**: ${profile.structure.mainEntry}

**Key Modules**:
${profile.structure.keyModules.map((m) => `- **${m.name}**: ${m.path} - ${m.description}`).join('\n')}

### Conventions

- **Naming**: ${profile.conventions.namingConventions.join(', ')}
- **Code Style**: ${profile.conventions.codeStyle.join(', ')}
- **Git Workflow**: ${profile.conventions.gitWorkflow}

### Commands

- **Build**: ${profile.commands.build.join(', ')}
- **Test**: ${profile.commands.test.join(', ')}
- **Dev**: ${profile.commands.dev.join(', ')}
- **Start**: ${profile.commands.start.join(', ')}

---
Last Updated: ${new Date(profile.lastUpdated).toLocaleString()}
`;
}
