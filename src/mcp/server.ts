/**
 * ContextAtlas MCP Server
 *
 * 提供代码库检索能力的 Model Context Protocol 服务器
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ZodError } from 'zod';
import { logger } from '../utils/logger.js';
import {
  createInternalErrorResponse,
  createInvalidArgumentsResponse,
  validateToolTextResponse,
  type ToolTextResponse,
} from './response.js';
import { createResponseFormatInputSchemaProperty } from './tools/responseFormat.js';
import {
  codebaseRetrievalSchema,
  deleteMemorySchema,
  findMemorySchema,
  getDependencyChainSchema,
  getProjectProfileSchema,
  handleCodebaseRetrieval,
  handleDeleteMemory,
  handleFindMemory,
  handleGetDependencyChain,
  handleGetProjectProfile,
  handleLinkMemories,
  handleListMemoryCatalog,
  handleLoadModuleMemory,
  handleMaintainMemoryCatalog,
  handleManageLongTermMemory,
  handleManageProjects,
  handleQuerySharedMemories,
  handleRecordDecision,
  handleRecordLongTermMemory,
  handleRecordMemory,
  handleSessionEnd,
  handleSuggestMemory,
  linkMemoriesSchema,
  listMemoryCatalogSchema,
  loadModuleMemorySchema,
  maintainMemoryCatalogSchema,
  manageLongTermMemorySchema,
  manageProjectsSchema,
  querySharedMemoriesSchema,
  recordDecisionSchema,
  recordLongTermMemorySchema,
  recordMemorySchema,
  sessionEndSchema,
  suggestMemorySchema,
} from './tools/index.js';

// ===========================================
// 服务器配置
// ===========================================

const SERVER_NAME = 'contextatlas';

// ===========================================
// 工具定义
// ===========================================

const responseFormatProperty = createResponseFormatInputSchemaProperty();

export const TOOLS = [
  {
    name: 'codebase-retrieval',
    description: `
IMPORTANT: This is the PRIMARY tool for searching the codebase.
It uses a hybrid engine (Semantic + Exact Match) to find relevant code.
Think of it as the "Google Search" for this repository.

Capabilities:
1. Semantic Search: Understands "what code does" (e.g., "auth logic") via high-dimensional embeddings.
2. Exact Match: Filters by precise symbols (e.g., class names) via FTS (Full Text Search).
3. Localized Context: Returns code with localized context (breadcrumbs) to avoid token overflow.

<RULES>
# 1. Tool Selection (When to use)
- ALWAYS use this tool FIRST for any code exploration or understanding task.
- DO NOT try to guess file paths. If you don't have the exact path, use this tool.
- DO NOT use 'grep' or 'find' for semantic understanding. Only use them for exhaustive text matching (e.g. "Find ALL occurrences of string 'foo'").

# 2. Before Editing (Critical)
- Before creating a plan or editing any file, YOU MUST call this tool to gather context.
- Ask for ALL symbols involved in the edit (classes, functions, types, constants).
- Do not assume you remember the code structure. Verify it with this tool.

# 3. Query Strategy (How to use)
- Split your intent:
  - Put the "Goal/Context" in 'information_request'.
  - Put "Known Class/Func Names" in 'technical_terms'.
- If the first search is too broad, add more specific 'technical_terms'.
</RULES>

Examples of GOOD queries:
* [Goal: Understand Auth]
  information_request: "How is user authentication flow handled?"
* [Goal: Fix DB Pool bug]
  information_request: "Logic for database connection pooling and error handling"
  technical_terms: ["PoolConfig", "Connection", "release"]

Examples of BAD queries:
* "Show me src/main.ts" (Use 'read_file' instead)
* "Find definition of constructor of class Foo" (Use this tool, but put "Foo" in technical_terms)
* "Find all references to function bar across the whole project" (Use 'grep' tool for exhaustive reference counting)
`,
    inputSchema: {
      type: 'object',
      properties: {
        repo_path: {
          type: 'string',
          description: 'The absolute file system path to the repository root.',
        },
        information_request: {
          type: 'string',
          description:
            "The SEMANTIC GOAL. Describe the functionality, logic, or behavior you are looking for in full natural language sentences. Focus on 'how it works' rather than exact names. (e.g., 'Trace the execution flow of the login process')",
        },
        technical_terms: {
          type: 'array',
          items: { type: 'string' },
          description:
            'HARD FILTERS. An optional list of EXACT, KNOWN identifiers (class/function names, constants) that MUST appear in the code. Only use terms you are 100% sure exist. Leave empty if exploring.',
        },
      },
      required: ['repo_path', 'information_request'],
    },
  },
  {
    name: 'find_memory',
    description: `
[FIRST-STEP] Fast module lookup using pre-recorded feature memories.

Usage Strategy:
1. ALWAYS call find_memory FIRST when asked about module location, responsibility, or dependencies
2. If find_memory returns results, use that information directly (no need for codebase-retrieval)
3. If find_memory returns NO results, FALL BACK to codebase-retrieval

Examples:
- "Where is auth handled?" → find_memory("auth")
- "What does SearchService do?" → find_memory("SearchService")
- "How to add new API endpoint?" → find_memory("API") to get conventions

Returns: Module responsibility, location, exports, dependencies, data flow.
`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Module name or keyword (e.g., "auth", "SearchService", "database")',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results',
          default: 10,
        },
        minScore: {
          type: 'number',
          description: 'Minimum score threshold',
          default: 1,
        },
        format: {
          ...responseFormatProperty,
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'record_memory',
    description: `
Record a new feature memory for a module.

Use this to document module responsibilities, APIs, dependencies, and data flow.
This creates a persistent memory that can be quickly retrieved later.

Required fields:
- name: Module name
- responsibility: What the module does
- dir: Source directory
`,
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Module name',
        },
        responsibility: {
          type: 'string',
          description: 'Module responsibility description',
        },
        dir: {
          type: 'string',
          description: 'Source directory path',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Related file list',
        },
        exports: {
          type: 'array',
          items: { type: 'string' },
          description: 'Exported symbols',
        },
        endpoints: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              method: { type: 'string' },
              path: { type: 'string' },
              handler: { type: 'string' },
            },
          },
          description: 'API endpoints',
        },
        imports: {
          type: 'array',
          items: { type: 'string' },
          description: 'Internal dependencies',
        },
        external: {
          type: 'array',
          items: { type: 'string' },
          description: 'External dependencies',
        },
        dataFlow: {
          type: 'string',
          description: 'Data flow description',
        },
        keyPatterns: {
          type: 'array',
          items: { type: 'string' },
          description: 'Key patterns',
        },
      },
      required: ['name', 'responsibility', 'dir'],
    },
  },
  {
    name: 'record_decision',
    description: `
Record an architectural decision.

Use this to document important design decisions, alternatives considered, and rationale.
Creates a persistent record for future reference.

Required fields:
- id: Unique identifier (e.g., "2026-03-27-architecture")
- title: Decision title
- context: Background
- decision: What was decided
- rationale: Why
`,
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Unique identifier',
        },
        title: {
          type: 'string',
          description: 'Decision title',
        },
        context: {
          type: 'string',
          description: 'Background context',
        },
        decision: {
          type: 'string',
          description: 'The decision made',
        },
        alternatives: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              pros: { type: 'array', items: { type: 'string' } },
              cons: { type: 'array', items: { type: 'string' } },
            },
          },
          description: 'Considered alternatives',
        },
        rationale: {
          type: 'string',
          description: 'Rationale for the decision',
        },
        consequences: {
          type: 'array',
          items: { type: 'string' },
          description: 'Consequences',
        },
      },
      required: ['id', 'title', 'context', 'decision', 'rationale'],
    },
  },
  {
    name: 'manage_long_term_memory',
    description: `
Manage long-term memories (find, list, prune, delete).

Actions:
- find: Search by keyword query
- list: List all memories with optional type/scope filters
- prune: Remove expired/stale memories (dryRun=true by default)
- delete: Remove a specific memory by id

Examples:
- manage_long_term_memory({ action: "find", query: "user preferences" })
- manage_long_term_memory({ action: "list", types: ["user"] })
- manage_long_term_memory({ action: "prune", dryRun: true })
- manage_long_term_memory({ action: "delete", id: "mem_123", types: ["reference"] })
`,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['find', 'list', 'prune', 'delete'],
          description: 'Action to perform',
        },
        query: {
          type: 'string',
          description: '[find] Keyword query',
        },
        types: {
          type: 'array',
          items: { type: 'string', enum: ['user', 'feedback', 'project-state', 'reference'] },
          description: '[find/list/prune] Filter by memory types',
        },
        scope: {
          type: 'string',
          enum: ['project', 'global-user'],
          description: '[find/list/prune] Restrict to one scope',
        },
        limit: {
          type: 'number',
          description: '[find] Maximum results',
          default: 10,
        },
        minScore: {
          type: 'number',
          description: '[find] Minimum score threshold',
          default: 1,
        },
        includeExpired: {
          type: 'boolean',
          description: '[find/prune] Include expired memories',
          default: false,
        },
        includeStale: {
          type: 'boolean',
          description: '[prune] Whether to prune stale memories',
          default: false,
        },
        staleDays: {
          type: 'number',
          description: '[find/list/prune] Days for stale threshold',
          default: 30,
        },
        dryRun: {
          type: 'boolean',
          description: '[prune] Preview without deleting',
          default: true,
        },
        id: {
          type: 'string',
          description: '[delete] Memory item id',
        },
        format: {
          ...responseFormatProperty,
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'get_project_profile',
    description: `
Get the project profile containing tech stack, structure, and conventions.

Returns comprehensive project information including:
- Technology stack
- Project structure
- Key modules
- Development conventions
- Build/test commands
`,
    inputSchema: {
      type: 'object',
      properties: {
        format: {
          ...responseFormatProperty,
        },
      },
    },
  },
  {
    name: 'delete_memory',
    description: `
Delete a feature memory for the current project.

This removes the feature memory and cleans coordinated derived state.
`,
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Module name to delete',
        },
        format: {
          ...responseFormatProperty,
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'maintain_memory_catalog',
    description: `
Perform maintenance operations for the current project's memory catalog.

Actions:
- check: verify feature memories and catalog entries are consistent
- rebuild: rebuild the catalog from stored feature memories
`,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['check', 'rebuild'],
          description: 'Maintenance action',
        },
        format: {
          ...responseFormatProperty,
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'load_module_memory',
    description: `
[PROGRESSIVE-LOAD] Load module memories on demand using the routing engine.

Routes to matching modules via:
1. filePaths -> triggerPaths prefix matching
2. query -> keyword matching
3. scope -> explicit scope loading (with optional cascade)

This is more efficient than find_memory for large projects as it uses the catalog index.

Examples:
- Load a specific module -> load_module_memory({ moduleName: "search-service" })
- Load search-related modules -> load_module_memory({ query: "search" })
- Load modules handling files in src/auth/ -> load_module_memory({ filePaths: ["src/auth/login.ts"] })
- Load all MCP modules -> load_module_memory({ scope: "mcp" })
`,
    inputSchema: {
      type: 'object',
      properties: {
        moduleName: {
          type: 'string',
          description: 'Exact module name to load',
        },
        query: {
          type: 'string',
          description: 'Keyword to search for matching modules',
        },
        scope: {
          type: 'string',
          description: 'Explicit scope name to load all modules within',
        },
        filePaths: {
          type: 'array',
          items: { type: 'string' },
          description: 'File paths to match against triggerPaths',
        },
        enableScopeCascade: {
          type: 'boolean',
          description: 'Whether to include additional modules from matched scopes',
          default: false,
        },
        maxResults: {
          type: 'number',
          description: 'Maximum number of module memories to return',
          default: 8,
        },
        useMmr: {
          type: 'boolean',
          description: 'Whether to apply MMR reranking for novelty/diversity',
          default: true,
        },
        mmrLambda: {
          type: 'number',
          description: 'MMR relevance weight (0=novelty only, 1=relevance only)',
          default: 0.65,
        },
        format: {
          ...responseFormatProperty,
        },
      },
    },
  },
  {
    name: 'list_memory_catalog',
    description: `
[DEBUG / MAINTENANCE] Inspect the memory catalog index.

Shows all modules, scopes, and global memories registered in the catalog.
Prefer load_module_memory for normal module retrieval. Use this tool for debugging routing, scope contents, or catalog drift.

Examples:
- List all -> list_memory_catalog()
- List MCP scope only -> list_memory_catalog({ scope: "mcp" })
- With details -> list_memory_catalog({ includeDetails: true })
`,
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          description: 'Filter by scope name',
        },
        includeDetails: {
          type: 'boolean',
          description: 'Include module details (keywords, triggerPaths)',
          default: false,
        },
        format: {
          ...responseFormatProperty,
        },
      },
    },
  },
  {
    name: 'query_shared_memories',
    description: `
[CROSS-PROJECT] Search feature memories across all registered projects.

Usage Strategy:
1. Use this tool to find similar modules across different projects
2. Great for finding patterns, auth implementations, API conventions, etc.
3. Supports category filtering (auth, database, api, search, cache, general)
4. Also supports compatibility FTS-style search via queryText or mode="fts"

Examples:
- "Find auth modules in all projects" → query_shared_memories({ category: "auth" })
- "Search for search functionality" → query_shared_memories({ moduleName: "search" })
- "FTS-style search" → query_shared_memories({ queryText: "database connection pool", mode: "fts" })
`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Full-text search query (FTS5)',
        },
        queryText: {
          type: 'string',
          description: 'Compatibility alias for FTS-style full-text query',
        },
        category: {
          type: 'string',
          description: 'Memory category (auth, database, api, search, cache, general)',
        },
        moduleName: {
          type: 'string',
          description: 'Module name pattern match',
        },
        memory_type: {
          type: 'string',
          enum: ['local', 'shared', 'pattern', 'framework'],
          description: 'Memory type filter',
        },
        limit: {
          type: 'number',
          description: 'Maximum results',
          default: 20,
        },
        mode: {
          type: 'string',
          enum: ['default', 'fts'],
          description: 'Search mode',
          default: 'default',
        },
        format: {
          ...responseFormatProperty,
        },
      },
    },
  },
  {
    name: 'link_memories',
    description: `
[CROSS-PROJECT] Create a relationship link between two memories.

Relationship types:
- depends_on: Source memory depends on target memory
- extends: Source memory extends target memory functionality
- references: Source memory references target memory
- implements: Source memory implements target interface/pattern

Examples:
- AuthService depends_on SearchService → link_memories({ from: {project: "ctx", module: "AuthService"}, to: {project: "ctx", module: "SearchService"}, type: "depends_on" })
`,
    inputSchema: {
      type: 'object',
      properties: {
        from: {
          type: 'object',
          description: 'Source memory location',
          properties: {
            project: { type: 'string' },
            module: { type: 'string' },
          },
          required: ['project', 'module'],
        },
        to: {
          type: 'object',
          description: 'Target memory location',
          properties: {
            project: { type: 'string' },
            module: { type: 'string' },
          },
          required: ['project', 'module'],
        },
        type: {
          type: 'string',
          enum: ['depends_on', 'extends', 'references', 'implements'],
          description: 'Relationship type',
        },
      },
      required: ['from', 'to', 'type'],
    },
  },
  {
    name: 'get_dependency_chain',
    description: `
[CROSS-PROJECT] Get all dependencies (recursive) for a module.

Uses recursive CTE to traverse the full dependency graph.
Great for understanding impact of changes or debugging cascading issues.

Examples:
- Get all dependencies of AuthService → get_dependency_chain({ project: "ctx", module: "AuthService" })
`,
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Project ID',
        },
        module: {
          type: 'string',
          description: 'Module name',
        },
        recursive: {
          type: 'boolean',
          description: 'Whether to get recursive dependencies',
          default: true,
        },
        format: {
          ...responseFormatProperty,
        },
      },
      required: ['project', 'module'],
    },
  },
  {
    name: 'manage_projects',
    description: `
[CROSS-PROJECT] Manage projects in the memory hub (register, list, stats).

Actions:
- register: Register a new project (requires path)
- list: List all registered projects
- stats: Get memory hub statistics

Examples:
- manage_projects({ action: "register", name: "MyApp", path: "/path/to/app" })
- manage_projects({ action: "list" })
- manage_projects({ action: "stats" })
`,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['register', 'list', 'stats'],
          description: 'Action to perform',
        },
        name: {
          type: 'string',
          description: '[register] Project display name',
        },
        path: {
          type: 'string',
          description: '[register] Project absolute path',
        },
        format: {
          ...responseFormatProperty,
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'session_end',
    description: `
[AUTO-RECORD] Analyze session summary and auto-record memory for new modules.

Usage Strategy:
1. Call this at the end of a development session
2. Provide a summary of what was built/modified
3. If autoRecord=true, memories are saved automatically
4. If autoRecord=false (default), returns suggestions for confirmation

Examples:
- session_end({ summary: "Created AuthService with JWT login" })
- session_end({ summary: "...", autoRecord: true })
`,
    inputSchema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'Session summary or conversation transcript',
        },
        project: {
          type: 'string',
          description:
            'Deprecated project label; identity is derived from the current working path',
        },
        autoRecord: {
          type: 'boolean',
          description: 'Whether to auto-record without confirmation',
          default: false,
        },
      },
      required: ['summary'],
    },
  },
  {
    name: 'suggest_memory',
    description: `
[AUTO-RECORD] Suggest memory recording for a specific module.

Use this when you want to record a memory but need AI to help extract details.

Examples:
- suggest_memory({ moduleName: "AuthService", files: ["src/auth/auth.service.ts"] })
`,
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description:
            'Deprecated project label; identity is derived from the current working path',
        },
        moduleName: {
          type: 'string',
          description: 'Module name',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Related file paths',
        },
      },
      required: ['moduleName'],
    },
  },
];

// ===========================================
// 服务器初始化
// ===========================================

/**
 * 启动 MCP 服务器
 */
export async function startMcpServer(): Promise<void> {
  logger.info({ name: SERVER_NAME }, '启动 MCP 服务器');

  const server = new Server(
    {
      name: SERVER_NAME,
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // 注册工具列表处理器
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    logger.debug('收到 list_tools 请求');
    return { tools: TOOLS };
  });

  // 注册工具调用处理器
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    logger.info({ tool: name }, '收到 call_tool 请求');
    const startedAt = Date.now();

    const recordGenericToolUsage = async (status: 'success' | 'error', error?: string) => {
      if (name === 'codebase-retrieval') return;
      try {
        const { recordToolUsage } = await import('../usage/usageTracker.js');
        recordToolUsage({
          source: 'mcp',
          toolName: name,
          status,
          durationMs: Date.now() - startedAt,
          error,
        });
      } catch {
        // noop
      }
    };

    // 提取 progressToken（如果客户端请求进度通知）
    const rawToken = extra._meta?.progressToken;
    const progressToken =
      typeof rawToken === 'string' || typeof rawToken === 'number' ? rawToken : undefined;

    // 创建进度通知回调
    const onProgress = progressToken
      ? async (current: number, total?: number, message?: string) => {
          try {
            await extra.sendNotification({
              method: 'notifications/progress',
              params: {
                progressToken,
                progress: current,
                total,
                message,
              },
            });
          } catch (err) {
            // 忽略通知发送失败，不影响主流程
            logger.debug({ error: (err as Error).message }, '发送进度通知失败');
          }
        }
      : undefined;

    try {
      let result: ToolTextResponse | undefined;
      switch (name) {
        case 'codebase-retrieval': {
          const parsed = codebaseRetrievalSchema.parse(args);
          result = await handleCodebaseRetrieval(parsed, onProgress);
          break;
        }
        case 'find_memory': {
          const parsed = findMemorySchema.parse(args);
          result = await handleFindMemory(parsed, process.cwd());
          break;
        }
        case 'record_memory': {
          const parsed = recordMemorySchema.parse(args);
          result = await handleRecordMemory(parsed, process.cwd());
          break;
        }
        case 'record_decision': {
          const parsed = recordDecisionSchema.parse(args);
          result = await handleRecordDecision(parsed, process.cwd());
          break;
        }
        case 'record_long_term_memory': {
          const parsed = recordLongTermMemorySchema.parse(args);
          result = await handleRecordLongTermMemory(parsed, process.cwd());
          break;
        }
        case 'manage_long_term_memory': {
          const parsed = manageLongTermMemorySchema.parse(args);
          result = await handleManageLongTermMemory(parsed, process.cwd());
          break;
        }
        case 'get_project_profile': {
          const parsed = getProjectProfileSchema.parse(args);
          result = await handleGetProjectProfile(parsed, process.cwd());
          break;
        }
        case 'delete_memory': {
          const parsed = deleteMemorySchema.parse(args);
          result = await handleDeleteMemory(parsed, process.cwd());
          break;
        }
        case 'maintain_memory_catalog': {
          const parsed = maintainMemoryCatalogSchema.parse(args);
          result = await handleMaintainMemoryCatalog(parsed, process.cwd());
          break;
        }
        case 'load_module_memory': {
          const parsed = loadModuleMemorySchema.parse(args);
          result = await handleLoadModuleMemory(parsed, process.cwd());
          break;
        }
        case 'list_memory_catalog': {
          const parsed = listMemoryCatalogSchema.parse(args);
          result = await handleListMemoryCatalog(parsed, process.cwd());
          break;
        }
        case 'query_shared_memories': {
          const parsed = querySharedMemoriesSchema.parse(args);
          result = await handleQuerySharedMemories(parsed);
          break;
        }
        case 'link_memories': {
          const parsed = linkMemoriesSchema.parse(args);
          result = await handleLinkMemories(parsed);
          break;
        }
        case 'get_dependency_chain': {
          const parsed = getDependencyChainSchema.parse(args);
          result = await handleGetDependencyChain(parsed);
          break;
        }
        case 'manage_projects': {
          const parsed = manageProjectsSchema.parse(args);
          result = await handleManageProjects(parsed);
          break;
        }
        case 'session_end': {
          const parsed = sessionEndSchema.parse(args);
          result = await handleSessionEnd(parsed);
          break;
        }
        case 'suggest_memory': {
          const parsed = suggestMemorySchema.parse(args);
          result = await handleSuggestMemory(parsed);
          break;
        }
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
      if (!result) {
        throw new Error(`Tool ${name} returned no result`);
      }
      await recordGenericToolUsage('success');
      return validateToolTextResponse(result);
    } catch (err) {
      const error = err as { message?: string; stack?: string };
      await recordGenericToolUsage('error', error.message);
      logger.error({ error: error.message, stack: error.stack, tool: name }, '工具调用失败');
      if (err instanceof ZodError) {
        return createInvalidArgumentsResponse(name, err);
      }

      return createInternalErrorResponse(name, error.message || 'Unknown error');
    }
  });

  // 启动 stdio 传输
  const transport = new StdioServerTransport();
  logger.info('MCP 服务器已启动，等待连接...');
  await server.connect(transport);
}
