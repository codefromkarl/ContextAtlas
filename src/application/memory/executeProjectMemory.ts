/**
 * ProjectMemory Application Layer
 *
 * CLI 和 MCP adapter 统一通过此入口调用项目记忆业务逻辑。
 */

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
import type { ResponseFormat, MemoryToolResponse } from './memoryTypes.js';

// ===========================================
// Input 类型
// ===========================================

export interface FindMemoryInput {
  query: string;
  limit?: number;
  minScore?: number;
  format: ResponseFormat;
}

export interface RecordMemoryInput {
  name: string;
  responsibility: string;
  dir: string;
  files?: string[];
  exports?: string[];
  endpoints?: Array<{ method: string; path: string; handler: string; description?: string }>;
  imports?: string[];
  external?: string[];
  dataFlow?: string;
  keyPatterns?: string[];
  confirmationStatus?: 'suggested' | 'agent-inferred' | 'human-confirmed';
  reviewStatus?: 'verified' | 'needs-review';
  reviewReason?: string;
  reviewMarkedAt?: string;
  evidenceRefs?: string[];
}

export interface RecordDecisionInput {
  id: string;
  title: string;
  context: string;
  decision: string;
  owner?: string;
  reviewer?: string;
  alternatives?: Array<{ name: string; pros: string[]; cons: string[] }>;
  rationale: string;
  consequences?: string[];
  evidenceRefs?: string[];
}

export interface GetProjectProfileInput {
  format: ResponseFormat;
}

export interface DeleteMemoryInput {
  name: string;
  format: ResponseFormat;
}

export interface MaintainMemoryCatalogInput {
  action: 'check' | 'rebuild';
  format: ResponseFormat;
}

// ===========================================
// Formatting
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

// ===========================================
// Handlers
// ===========================================

export async function executeFindMemory(
  args: FindMemoryInput,
  projectRoot: string,
): Promise<MemoryToolResponse> {
  const { query, limit, minScore, format } = args;

  logger.info({ query, limit, minScore }, 'MCP find_memory 调用开始');

  const finder = new MemoryFinder(projectRoot);
  const results = await finder.find(query, { limit: limit ?? 10, minScore: minScore ?? 1 });

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

export async function executeRecordMemory(
  args: RecordMemoryInput,
  projectRoot: string,
): Promise<MemoryToolResponse> {
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
    confirmationStatus: confirmationStatus ?? 'human-confirmed',
    reviewStatus: reviewStatus ?? 'verified',
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
        text: `## Feature Memory Recorded\n\n- **Name**: ${name}\n- **Location**: ${dir}\n- **Responsibility**: ${responsibility}\n- **Confirmation Status**: ${memory.confirmationStatus}\n- **Review Status**: ${memory.reviewStatus}${reviewReason ? ` (${reviewReason})` : ''}\n- **Saved to**: ${filePath}\n\n${diagnosticsSection}`,
      },
    ],
  };
}

export async function executeRecordDecision(
  args: RecordDecisionInput,
  projectRoot: string,
): Promise<MemoryToolResponse> {
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

export async function executeGetProjectProfile(
  args: GetProjectProfileInput,
  projectRoot: string,
): Promise<MemoryToolResponse> {
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

export async function executeDeleteMemory(
  args: DeleteMemoryInput,
  projectRoot: string,
): Promise<MemoryToolResponse> {
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
  args: { format: ResponseFormat },
  projectRoot: string,
): Promise<MemoryToolResponse> {
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
  args: { format: ResponseFormat },
  projectRoot: string,
): Promise<MemoryToolResponse> {
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

export async function executeMaintainMemoryCatalog(
  args: MaintainMemoryCatalogInput,
  projectRoot: string,
): Promise<MemoryToolResponse> {
  if (args.action === 'check') {
    return handleCheckMemoryConsistency({ format: args.format }, projectRoot);
  }

  return handleRebuildMemoryCatalog({ format: args.format }, projectRoot);
}
