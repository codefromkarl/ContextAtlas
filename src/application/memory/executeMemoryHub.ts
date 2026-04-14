/**
 * MemoryHub Application Layer
 *
 * CLI 和 MCP adapter 统一通过此入口调用 memory hub 业务逻辑。
 */

import { MemoryHubDatabase } from '../../memory/MemoryHubDatabase.js';
import { logger } from '../../utils/logger.js';
import type { ResponseFormat, MemoryToolResponse } from './memoryTypes.js';

// ===========================================
// Input 类型
// ===========================================

export interface QuerySharedMemoriesInput {
  query?: string;
  queryText?: string;
  category?: string;
  moduleName?: string;
  memory_type?: 'local' | 'shared' | 'pattern' | 'framework';
  limit?: number;
  mode?: 'default' | 'fts';
  format: ResponseFormat;
}

export interface LinkMemoriesInput {
  from: { project: string; module: string };
  to: { project: string; module: string };
  type: 'depends_on' | 'extends' | 'references' | 'implements';
}

export interface GetDependencyChainInput {
  project: string;
  module: string;
  recursive?: boolean;
  format: ResponseFormat;
}

export interface ManageProjectsInput {
  action: 'register' | 'list' | 'stats';
  name?: string;
  path?: string;
  format: ResponseFormat;
}

// ===========================================
// Helpers
// ===========================================

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

// ===========================================
// Handlers
// ===========================================

export async function executeQuerySharedMemories(
  args: QuerySharedMemoriesInput,
): Promise<MemoryToolResponse> {
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
      ? db.searchMemoriesFTS(normalizedQueryText || effectiveQuery || '', limit ?? 20)
      : db.searchMemories({
          queryText: normalizedQueryText,
          category,
          moduleName,
          memory_type,
          limit: limit ?? 20,
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

export async function executeLinkMemories(args: LinkMemoriesInput): Promise<MemoryToolResponse> {
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

export async function executeGetDependencyChain(
  args: GetDependencyChainInput,
): Promise<MemoryToolResponse> {
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

export async function executeManageProjects(args: ManageProjectsInput): Promise<MemoryToolResponse> {
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
): Promise<MemoryToolResponse> {
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
): Promise<MemoryToolResponse> {
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
): Promise<MemoryToolResponse> {
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
