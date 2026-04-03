import { z } from 'zod';
import { MemoryHubDatabase } from '../../memory/MemoryHubDatabase.js';
import { logger } from '../../utils/logger.js';

const responseFormatSchema = z.enum(['text', 'json']).optional().default('text');

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
  const { query, queryText, category, moduleName, memory_type, limit, mode } = args;
  const effectiveQuery = query ?? queryText;

  logger.info(
    { query: effectiveQuery, category, moduleName, limit, mode },
    'MCP query_shared_memories 调用开始',
  );

  const db = new MemoryHubDatabase();

  try {
    const normalizedQueryText = buildFtsPrefixQuery(effectiveQuery);
    const usingCompatibilityFts = mode === 'fts' || (!!queryText && !query);
    const results = usingCompatibilityFts
      ? db.searchMemoriesFTS(normalizedQueryText || effectiveQuery || '', limit)
      : db.searchMemories({
          queryText: normalizedQueryText,
          category,
          moduleName,
          memory_type,
          limit,
        });

    if (results.length === 0) {
      const filters = [
        effectiveQuery ? `query="${effectiveQuery}"` : undefined,
        category ? `category="${category}"` : undefined,
        moduleName ? `moduleName="${moduleName}"` : undefined,
        memory_type ? `memory_type="${memory_type}"` : undefined,
        usingCompatibilityFts ? 'mode="fts"' : undefined,
      ]
        .filter(Boolean)
        .join(', ');

      if (args.format === 'json') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  tool: 'query_shared_memories',
                  query: {
                    query: effectiveQuery,
                    category,
                    moduleName,
                    memory_type,
                    limit,
                    mode,
                  },
                  result_count: 0,
                  results: [],
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
            text: `No shared memories found${filters ? ` with filters: ${filters}` : ''}.\n\nTry using different search terms or register projects using 'manage_projects({ action: "register" })'.`,
          },
        ],
      };
    }

    const formatted = results.map((r) => formatSharedMemory(r)).join('\n\n---\n\n');

    if (args.format === 'json') {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                tool: 'query_shared_memories',
                query: {
                  query: effectiveQuery,
                  category,
                  moduleName,
                  memory_type,
                  limit,
                  mode,
                },
                result_count: results.length,
                results,
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
          text: `## Found ${results.length} shared memories\n\n${formatted}`,
        },
      ],
    };
  } finally {
    db.close();
  }
}

export async function handleLinkMemories(args: LinkMemoriesInput): Promise<ToolTextResponse> {
  const { from, to, type } = args;

  logger.info({ from, to, type }, 'MCP link_memories 调用开始');

  const db = new MemoryHubDatabase();

  try {
    const fromMemory = db.getMemory(from.project, from.module);
    if (!fromMemory) {
      return {
        content: [
          {
            type: 'text',
            text: `Source memory not found: ${from.module} in project ${from.project}`,
          },
        ],
        isError: true,
      };
    }

    const toMemory = db.getMemory(to.project, to.module);
    if (!toMemory) {
      return {
        content: [
          {
            type: 'text',
            text: `Target memory not found: ${to.module} in project ${to.project}`,
          },
        ],
        isError: true,
      };
    }

    db.createRelation(fromMemory.id, toMemory.id, type);

    return {
      content: [
        {
          type: 'text',
          text: `## Memory Link Created\n\n- **From**: ${fromMemory.name} (${from.project})\n- **To**: ${toMemory.name} (${to.project})\n- **Type**: ${type}\n\nThis relationship can now be queried using 'get_dependency_chain'.`,
        },
      ],
    };
  } finally {
    db.close();
  }
}

export async function handleGetDependencyChain(
  args: GetDependencyChainInput,
): Promise<ToolTextResponse> {
  const { project, module, recursive } = args;

  logger.info({ project, module, recursive }, 'MCP get_dependency_chain 调用开始');

  const db = new MemoryHubDatabase();

  try {
    const memory = db.getMemory(project, module);
    if (!memory) {
      return {
        content: [
          {
            type: 'text',
            text: `Memory not found: ${module} in project ${project}`,
          },
        ],
        isError: true,
      };
    }

    const deps = recursive ? db.getDependencies(memory.id) : db.getDependents(memory.id);

    if (deps.length <= 1) {
      if (args.format === 'json') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  tool: 'get_dependency_chain',
                  project,
                  module,
                  recursive,
                  result_count: 0,
                  results: [],
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
            text: `## Dependency Chain for ${module}\n\nNo ${recursive ? 'dependencies' : 'dependents'} found.`,
          },
        ],
      };
    }

    const actualDeps = deps.slice(1);

    const formatted = actualDeps
      .map((d, i) => `${i + 1}. **${d.name}** (${d.location_dir})\n   - 职责：${d.responsibility}`)
      .join('\n\n');

    if (args.format === 'json') {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                tool: 'get_dependency_chain',
                project,
                module,
                recursive,
                result_count: actualDeps.length,
                results: actualDeps,
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
          text: `## Dependency Chain for ${module} (${project})\n\n${recursive ? '**Recursive Dependencies**' : '**Direct Dependents**'} (${actualDeps.length} modules):\n\n${formatted}`,
        },
      ],
    };
  } finally {
    db.close();
  }
}

export async function handleManageProjects(args: ManageProjectsInput): Promise<ToolTextResponse> {
  const db = new MemoryHubDatabase();

  try {
    switch (args.action) {
      case 'register':
        return handleRegisterProject(db, args);
      case 'list':
        return handleListProjects(db, args);
      case 'stats':
        return handleGetMemoryStats(db, args);
    }
  } finally {
    db.close();
  }
}

async function handleRegisterProject(
  db: MemoryHubDatabase,
  args: ManageProjectsInput,
): Promise<ToolTextResponse> {
  if (!args.path) {
    return {
      content: [{ type: 'text', text: 'Error: register action requires `path`.' }],
      isError: true,
    };
  }

  logger.info(
    { name: args.name, projectPath: args.path },
    'MCP manage_projects (register) 调用开始',
  );

  const project = db.ensureProject({
    name: args.name,
    path: args.path,
  });

  return {
    content: [
      {
        type: 'text',
        text: `## Project Registered\n\n- **ID**: ${project.id}\n- **Name**: ${project.name}\n- **Path**: ${project.path}\n\nYou can now save memories to this project using 'record_memory'.`,
      },
    ],
  };
}

async function handleListProjects(
  db: MemoryHubDatabase,
  args: ManageProjectsInput,
): Promise<ToolTextResponse> {
  logger.info('MCP manage_projects (list) 调用开始');

  const projects = db.listProjects();

  if (args.format === 'json') {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { tool: 'manage_projects', action: 'list', result_count: projects.length, projects },
            null,
            2,
          ),
        },
      ],
    };
  }

  if (projects.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: "No projects registered. Use manage_projects({ action: 'register', path: '...' }) to add a project.",
        },
      ],
    };
  }

  const formatted = projects.map((p) => `- **${p.name}** (\`${p.id}\`): ${p.path}`).join('\n');

  return {
    content: [
      {
        type: 'text',
        text: `## Registered Projects (${projects.length})\n\n${formatted}`,
      },
    ],
  };
}

async function handleGetMemoryStats(
  db: MemoryHubDatabase,
  args: ManageProjectsInput,
): Promise<ToolTextResponse> {
  logger.info('MCP manage_projects (stats) 调用开始');

  const stats = db.getStats();

  if (args.format === 'json') {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ tool: 'manage_projects', action: 'stats', stats }, null, 2),
        },
      ],
    };
  }

  return {
    content: [
      {
        type: 'text',
        text: `## Memory Hub Statistics\n\n- **Projects**: ${stats.totalProjects}\n- **Memories**: ${stats.totalMemories}\n- **Relations**: ${stats.totalRelations}\n- **Decisions**: ${stats.totalDecisions}\n\n**By Category**:\n${Object.entries(
          stats.byCategory,
        )
          .map(([cat, count]) => `- ${cat}: ${count}`)
          .join('\n')}`,
      },
    ],
  };
}

function formatSharedMemory(memory: any): string {
  return `### ${memory.name} (${memory.project_name})

- **职责**: ${memory.responsibility}
- **位置**: ${memory.location_dir}
- **文件**: ${safeParse(memory.location_files)?.join(', ') || 'N/A'}
- **导出**: ${safeParse(memory.api_exports)?.join(', ') || 'N/A'}
- **数据流**: ${memory.data_flow || 'N/A'}
- **类型**: ${memory.memory_type}
- **项目**: ${memory.project_name} (${memory.project_path})
- **更新**: ${new Date(memory.updated_at).toLocaleString()}`;
}

function safeParse(json: string | any): any {
  if (typeof json === 'string') {
    try {
      return JSON.parse(json);
    } catch {
      return null;
    }
  }
  return json;
}

function buildFtsPrefixQuery(query?: string): string | undefined {
  if (!query) {
    return undefined;
  }

  const terms = query
    .split(/\s+/)
    .map((term) => term.trim().replace(/[^\p{L}\p{N}_]+/gu, ' '))
    .flatMap((term) => term.split(/\s+/))
    .map((term) => term.trim().replace(/["'*]/g, ''))
    .filter(Boolean);

  if (terms.length === 0) {
    return undefined;
  }

  return terms.map((term) => `${term}*`).join(' ');
}
