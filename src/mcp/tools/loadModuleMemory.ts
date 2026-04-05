/**
 * Load Module Memory MCP Tool
 *
 * 通过 MemoryRouter 按需加载模块记忆，支持 query / scope / filePaths 路由
 */

import { z } from 'zod';
import { MemoryRouter } from '../../memory/MemoryRouter.js';
import type { FeatureMemory } from '../../memory/types.js';
import { logger } from '../../utils/logger.js';
import { responseFormatSchema } from './responseFormat.js';

// ===========================================
// Schema 定义
// ===========================================

export const loadModuleMemorySchema = z.object({
  moduleName: z.string().optional().describe('Exact module name to load'),
  query: z.string().optional().describe('Keyword to search for matching modules'),
  scope: z.string().optional().describe('Explicit scope name to load all modules within'),
  filePaths: z.array(z.string()).optional().describe('File paths to match against triggerPaths'),
  enableScopeCascade: z
    .boolean()
    .optional()
    .default(false)
    .describe('Whether to include additional modules from matched scopes'),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(8)
    .describe('Maximum number of module memories to return'),
  useMmr: z
    .boolean()
    .optional()
    .default(true)
    .describe('Whether to apply MMR reranking for novelty/diversity'),
  mmrLambda: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .default(0.65)
    .describe('MMR relevance weight (0=novelty only, 1=relevance only)'),
  format: responseFormatSchema,
});

export type LoadModuleMemoryInput = z.infer<typeof loadModuleMemorySchema>;

// ===========================================
// 工具处理函数
// ===========================================

/**
 * 按需加载模块记忆
 *
 * 路由策略：
 * 1. filePaths -> triggerPaths 前缀匹配
 * 2. query -> keywords 包含匹配
 * 3. scope -> 显式加载整个 scope
 * 4. 可选 scope cascade: enableScopeCascade=true 时联动加载同 scope 所有模块
 */
export async function handleLoadModuleMemory(
  args: LoadModuleMemoryInput,
  projectRoot: string,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const {
    moduleName,
    query,
    scope,
    filePaths,
    enableScopeCascade,
    maxResults,
    useMmr,
    mmrLambda,
    format,
  } = args;

  logger.info(
    { moduleName, query, scope, filePaths, enableScopeCascade, maxResults, useMmr, mmrLambda },
    'MCP load_module_memory 调用开始',
  );

  const router = MemoryRouter.forProject(projectRoot);

  // 确保路由器已初始化
  await router.initialize();

  const routeResult = await router.route({
    moduleName,
    query,
    scope,
    filePaths,
    enableScopeCascade,
  });

  if (routeResult.memories.length === 0) {
    const hints: string[] = [];
    if (moduleName) hints.push(`moduleName: "${moduleName}"`);
    if (query) hints.push(`query: "${query}"`);
    if (scope) hints.push(`scope: "${scope}"`);
    if (filePaths && filePaths.length > 0) hints.push(`filePaths: ${filePaths.join(', ')}`);
    if (enableScopeCascade) hints.push('enableScopeCascade: true');
    hints.push(`maxResults: ${maxResults}`);
    if (!useMmr) hints.push('useMmr: false');
    if (mmrLambda !== 0.65) hints.push(`mmrLambda: ${mmrLambda}`);

    return {
      content: [
        {
          type: 'text',
          text: `No module memories matched the given input (${hints.join(', ')}).\n\nTry refining moduleName/query/filePaths/scope first. If routing still seems wrong, use list_memory_catalog as a debug tool to inspect available modules and scopes.`,
        },
      ],
    };
  }

  const selected = applyBudget({
    memories: routeResult.memories,
    matchDetails: routeResult.matchDetails,
    query,
    maxResults,
    useMmr,
    mmrLambda,
  });
  const selectedKeys = new Set(selected.memories.map((m) => normalizeModuleName(m.name)));

  if (format === 'json') {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              tool: 'load_module_memory',
              input: {
                moduleName,
                query,
                scope,
                filePaths,
                enableScopeCascade,
                maxResults,
                useMmr,
                mmrLambda,
              },
              result_count: selected.memories.length,
              match_details: routeResult.matchDetails,
              memories: selected.memories,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  const formatted = selected.memories.map((m) => formatModuleMemory(m)).join('\n\n---\n\n');

  const matchSummary = routeResult.matchDetails
    .filter((d) => selectedKeys.has(normalizeModuleName(d.module)))
    .map((d) => `  - ${d.module}: ${d.matchedBy} (${d.detail})`)
    .join('\n');

  return {
    content: [
      {
        type: 'text',
        text: `## Loaded ${selected.memories.length} Module Memory(ies)\n\n**Budget**: maxResults=${maxResults}, useMmr=${useMmr}, mmrLambda=${mmrLambda}, candidates=${routeResult.memories.length}\n\n**Match Details:**\n${matchSummary || '  - N/A'}\n\n---\n\n${formatted}`,
      },
    ],
  };
}

// ===========================================
// 格式化函数
// ===========================================

function formatModuleMemory(memory: FeatureMemory): string {
  const endpoints =
    memory.api.endpoints && memory.api.endpoints.length > 0
      ? `\n- **Endpoints**:\n${memory.api.endpoints.map((e) => `  - ${e.method} ${e.path} -> ${e.handler}`).join('\n')}`
      : '';

  return `### ${memory.name}

- **Responsibility**: ${memory.responsibility}
- **Location**: ${memory.location.dir}
- **Files**: ${memory.location.files.join(', ') || 'N/A'}
- **Exports**: ${memory.api.exports.join(', ') || 'N/A'}${endpoints}
- **Data Flow**: ${memory.dataFlow || 'N/A'}
- **Key Patterns**: ${memory.keyPatterns.join(', ') || 'N/A'}
- **Internal Dependencies**: ${memory.dependencies.imports.join(', ') || 'N/A'}
- **External Dependencies**: ${memory.dependencies.external.join(', ') || 'N/A'}
- **Last Updated**: ${new Date(memory.lastUpdated).toLocaleString()}`;
}

type MatchDetail = {
  module: string;
  matchedBy: 'keyword' | 'path' | 'scope-cascade' | 'explicit-scope' | 'explicit-module';
  detail: string;
};

type BudgetParams = {
  memories: FeatureMemory[];
  matchDetails: MatchDetail[];
  query?: string;
  maxResults: number;
  useMmr: boolean;
  mmrLambda: number;
};

type Candidate = {
  memory: FeatureMemory;
  relevance: number;
  terms: Set<string>;
};

function applyBudget(params: BudgetParams): { memories: FeatureMemory[] } {
  const queryTokens = tokenize(params.query || '');
  const matchMap = new Map<string, MatchDetail[]>();

  for (const detail of params.matchDetails) {
    const key = normalizeModuleName(detail.module);
    const list = matchMap.get(key) || [];
    list.push(detail);
    matchMap.set(key, list);
  }

  const dedup = new Map<string, Candidate>();
  for (const memory of params.memories) {
    const key = buildMemoryKey(memory);
    if (dedup.has(key)) {
      continue;
    }
    const moduleKey = normalizeModuleName(memory.name);
    const details = matchMap.get(moduleKey) || [];
    dedup.set(key, {
      memory,
      relevance: calculateRelevance(memory, details, queryTokens),
      terms: buildTerms(memory),
    });
  }

  const candidates = Array.from(dedup.values());
  const maxResults = Math.min(params.maxResults, candidates.length);
  if (maxResults <= 0) {
    return { memories: [] };
  }

  if (!params.useMmr || candidates.length <= 1) {
    return {
      memories: candidates
        .sort((a, b) => b.relevance - a.relevance)
        .slice(0, maxResults)
        .map((c) => c.memory),
    };
  }

  const selected = selectByMmr(candidates, maxResults, params.mmrLambda);
  return {
    memories: selected.map((c) => c.memory),
  };
}

function selectByMmr(candidates: Candidate[], k: number, lambda: number): Candidate[] {
  const selected: Candidate[] = [];
  const remaining = [...candidates];
  const relevanceRange = getRelevanceRange(candidates);

  while (selected.length < k && remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    let bestRelevance = Number.NEGATIVE_INFINITY;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      const noveltyPenalty =
        selected.length === 0
          ? 0
          : Math.max(...selected.map((item) => cosineSimilarity(candidate.terms, item.terms)));

      const normalizedRelevance = normalizeRelevance(candidate.relevance, relevanceRange);
      const score = lambda * normalizedRelevance - (1 - lambda) * noveltyPenalty;
      if (score > bestScore || (score === bestScore && candidate.relevance > bestRelevance)) {
        bestIndex = i;
        bestScore = score;
        bestRelevance = candidate.relevance;
      }
    }

    selected.push(remaining[bestIndex]);
    remaining.splice(bestIndex, 1);
  }

  return selected;
}

function getRelevanceRange(candidates: Candidate[]): { min: number; max: number } {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (const candidate of candidates) {
    min = Math.min(min, candidate.relevance);
    max = Math.max(max, candidate.relevance);
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { min: 0, max: 1 };
  }

  return { min, max };
}

function normalizeRelevance(value: number, range: { min: number; max: number }): number {
  if (range.max <= range.min) {
    return 1;
  }
  return (value - range.min) / (range.max - range.min);
}

function calculateRelevance(
  memory: FeatureMemory,
  details: MatchDetail[],
  queryTokens: string[],
): number {
  const matchWeight: Record<MatchDetail['matchedBy'], number> = {
    'explicit-module': 3,
    path: 2.4,
    keyword: 2,
    'explicit-scope': 1.2,
    'scope-cascade': 0.7,
  };

  let matchSignal = 0;
  let maxSignal = 0;
  for (const detail of details) {
    const weight = matchWeight[detail.matchedBy] ?? 0;
    maxSignal = Math.max(maxSignal, weight);
    matchSignal += weight;
  }
  const normalizedMatchSignal = maxSignal + Math.min(1, Math.max(0, matchSignal - maxSignal));

  let querySignal = 0;
  if (queryTokens.length > 0) {
    const name = memory.name.toLowerCase();
    const responsibility = memory.responsibility.toLowerCase();
    const dir = memory.location.dir.toLowerCase();
    const exports = memory.api.exports.map((item) => item.toLowerCase());
    const patterns = memory.keyPatterns.map((item) => item.toLowerCase());

    for (const token of queryTokens) {
      if (token.length < 2) continue;
      if (name.includes(token)) querySignal += 1.2;
      if (responsibility.includes(token)) querySignal += 0.8;
      if (exports.some((item) => item.includes(token))) querySignal += 0.6;
      if (patterns.some((item) => item.includes(token))) querySignal += 0.6;
      if (dir.includes(token)) querySignal += 0.3;
    }

    querySignal = querySignal / Math.max(1, queryTokens.length);
  }

  const recencySignal = calculateRecencyBoost(memory.lastUpdated);
  const score = normalizedMatchSignal * 2 + querySignal + recencySignal;
  return Number.isFinite(score) && score > 0 ? score : 0.1;
}

function calculateRecencyBoost(lastUpdated: string): number {
  const updatedTime = Date.parse(lastUpdated);
  if (Number.isNaN(updatedTime)) {
    return 0;
  }
  const ageDays = (Date.now() - updatedTime) / (1000 * 60 * 60 * 24);
  return Math.max(0, 0.2 - ageDays / 3650);
}

function buildTerms(memory: FeatureMemory): Set<string> {
  const terms = new Set<string>();
  const chunks = [
    memory.name,
    memory.responsibility,
    memory.location.dir,
    ...memory.location.files,
    ...memory.api.exports,
    ...memory.keyPatterns,
    ...memory.dependencies.imports,
    ...memory.dependencies.external,
  ];

  for (const chunk of chunks) {
    for (const token of tokenize(chunk)) {
      if (token.length >= 2) {
        terms.add(token);
      }
    }
  }

  return terms;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s,./\\|[\]{}()"':;!?<>`~@#$%^&*+=-]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function cosineSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }

  let overlap = 0;
  for (const token of a) {
    if (b.has(token)) {
      overlap++;
    }
  }

  return overlap / Math.sqrt(a.size * b.size);
}

function normalizeModuleName(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-');
}

function buildMemoryKey(memory: FeatureMemory): string {
  return `${normalizeModuleName(memory.name)}::${memory.location.dir.toLowerCase().trim()}`;
}
