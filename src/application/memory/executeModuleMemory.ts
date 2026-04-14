/**
 * LoadModuleMemory Application Layer
 *
 * CLI 和 MCP adapter 统一通过此入口调用模块记忆加载业务逻辑。
 * 包含 MMR 算法、路由决策和结果格式化。
 */

import { MemoryRouter } from '../../memory/MemoryRouter.js';
import type { AssemblyPlan, AssemblyProfileName } from '../../memory/MemoryRouter.js';
import type { FeatureMemory } from '../../memory/types.js';
import { logger } from '../../utils/logger.js';
import type { ResponseFormat, MemoryToolResponse } from './memoryTypes.js';

// ===========================================
// Input 类型
// ===========================================

export interface LoadModuleMemoryInput {
  moduleName?: string;
  query?: string;
  scope?: string;
  filePaths?: string[];
  phase?: AssemblyProfileName;
  profile?: AssemblyProfileName;
  enableScopeCascade?: boolean;
  maxResults?: number;
  useMmr?: boolean;
  mmrLambda?: number;
  format: ResponseFormat;
}

// ===========================================
// 内部类型
// ===========================================

interface LoadModuleMemoryPayload {
  tool: 'load_module_memory';
  input: {
    moduleName?: string;
    query?: string;
    scope?: string;
    filePaths?: string[];
    phase?: AssemblyProfileName;
    profile: AssemblyProfileName;
    enableScopeCascade: boolean;
    maxResults: number;
    useMmr: boolean;
    mmrLambda: number;
  };
  assembly: AssemblyPlan;
  routing: LoadModuleMemoryRoutingSummary;
  result_count: number;
  match_details: LoadModuleMemoryMatchDetail[];
  memories: FeatureMemory[];
  message?: string;
}

interface LoadModuleMemoryMatchDetail {
  module: string;
  matchedBy: 'keyword' | 'path' | 'scope-cascade' | 'explicit-scope' | 'explicit-module';
  detail: string;
}

interface LoadModuleMemoryRoutingSummary {
  candidateCount: number;
  selectedCount: number;
  selectionStrategy: 'mmr' | 'ranked';
  routeStrategy: string;
  routeBreakdown: Array<{ matchedBy: LoadModuleMemoryMatchDetail['matchedBy']; count: number }>;
  scopeCascadeApplied: boolean;
  selectedModules: string[];
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

// ===========================================
// Handler
// ===========================================

export async function executeLoadModuleMemory(
  args: LoadModuleMemoryInput,
  projectRoot: string,
): Promise<MemoryToolResponse> {
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
    phase,
    profile,
  } = args;

  logger.info(
    {
      moduleName,
      query,
      scope,
      filePaths,
      phase,
      profile,
      enableScopeCascade,
      maxResults,
      useMmr,
      mmrLambda,
    },
    'MCP load_module_memory 调用开始',
  );

  const router = MemoryRouter.forProject(projectRoot);
  await router.initialize();

  const routed = await router.routeWithAssembly({
    moduleName,
    query,
    scope,
    filePaths,
    phase,
    profile,
    enableScopeCascade: enableScopeCascade ?? false,
    maxResults: maxResults ?? 8,
    useMmr: useMmr ?? true,
    mmrLambda: mmrLambda ?? 0.65,
  });
  const { assembly, routeResult } = routed;

  if (routeResult.memories.length === 0) {
    const routing = buildRoutingSummary(routeResult.matchDetails, assembly, routeResult.memories.length, 0, []);
    const assemblyInput = buildAssemblyInput({
      moduleName,
      query,
      scope,
      filePaths,
      phase,
      assembly,
    });

    if (format === 'json') {
      const payload: LoadModuleMemoryPayload = {
        tool: 'load_module_memory',
        input: assemblyInput,
        assembly,
        routing,
        result_count: 0,
        match_details: routeResult.matchDetails,
        memories: [],
      };
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ...payload,
              message: 'No module memories matched the given input.',
            }, null, 2),
          },
        ],
      };
    }

    const hints: string[] = [];
    if (moduleName) hints.push(`moduleName: "${moduleName}"`);
    if (query) hints.push(`query: "${query}"`);
    if (scope) hints.push(`scope: "${scope}"`);
    if (filePaths && filePaths.length > 0) hints.push(`filePaths: ${filePaths.join(', ')}`);
    hints.push(`profile: ${assembly.name}`);
    hints.push(`source: ${assembly.source}`);
    hints.push(`maxResults: ${assembly.maxResults}`);
    if (assembly.enableScopeCascade) hints.push('enableScopeCascade: true');
    if (!assembly.useMmr) hints.push('useMmr: false');
    if (assembly.mmrLambda !== 0.65) hints.push(`mmrLambda: ${assembly.mmrLambda}`);

    return {
      content: [
        {
          type: 'text',
          text: `No module memories matched the given input (${hints.join(', ')}).\n\nTry refining moduleName/query/filePaths/scope first. If routing still seems wrong, use list_memory_catalog as a debug tool to inspect available modules and scopes.\n\n${formatAssemblyText(assembly)}\n${formatRoutingText(routeResult, assembly, 0, 'ranked', [])}`,
        },
      ],
    };
  }

  const selected = applyBudget({
    memories: routeResult.memories,
    matchDetails: routeResult.matchDetails,
    query,
    maxResults: assembly.maxResults,
    useMmr: assembly.useMmr,
    mmrLambda: assembly.mmrLambda,
  });
  const routing = buildRoutingSummary(
    routeResult.matchDetails,
    assembly,
    routeResult.memories.length,
    selected.memories.length,
    selected.memories.map((m) => m.name),
  );
  const assemblyInput = buildAssemblyInput({
    moduleName,
    query,
    scope,
    filePaths,
    phase,
    assembly,
  });

  if (format === 'json') {
    const payload: LoadModuleMemoryPayload = {
      tool: 'load_module_memory',
      input: assemblyInput,
      assembly,
      routing,
      result_count: selected.memories.length,
      match_details: routeResult.matchDetails,
      memories: selected.memories,
    };
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  }

  const formatted = selected.memories.map((m) => formatModuleMemory(m)).join('\n\n---\n\n');

  return {
    content: [
      {
        type: 'text',
        text: [
          `## Loaded ${selected.memories.length} Module Memory(ies)`,
          '',
          formatAssemblyText(assembly),
          formatRoutingText(
            routeResult,
            assembly,
            selected.memories.length,
            routing.selectionStrategy,
            selected.memories.map((memory) => memory.name),
          ),
          '',
          '#### Match Details',
          ...(routeResult.matchDetails.length > 0
            ? routeResult.matchDetails.map((detail) => `- ${detail.module}: ${detail.matchedBy} (${detail.detail})`)
            : ['- N/A']),
          '',
          '---',
          '',
          formatted,
        ].join('\n'),
      },
    ],
  };
}

// ===========================================
// Routing Summary
// ===========================================

function summarizeRouteBreakdown(
  matchDetails: LoadModuleMemoryMatchDetail[],
): Array<{ matchedBy: LoadModuleMemoryMatchDetail['matchedBy']; count: number }> {
  const counts = new Map<LoadModuleMemoryMatchDetail['matchedBy'], number>();
  for (const detail of matchDetails) {
    counts.set(detail.matchedBy, (counts.get(detail.matchedBy) || 0) + 1);
  }
  return Array.from(counts.entries()).map(([matchedBy, count]) => ({ matchedBy, count }));
}

function summarizeRouteStrategy(matchDetails: LoadModuleMemoryMatchDetail[]): string {
  if (matchDetails.length === 0) {
    return 'unmatched';
  }

  const kinds = Array.from(new Set(matchDetails.map((detail) => detail.matchedBy)));
  return kinds.join(' + ');
}

function buildRoutingSummary(
  matchDetails: LoadModuleMemoryMatchDetail[],
  assembly: AssemblyPlan,
  candidateCount: number,
  selectedCount: number,
  selectedModules: string[],
): LoadModuleMemoryRoutingSummary {
  return {
    candidateCount,
    selectedCount,
    selectionStrategy: assembly.useMmr ? 'mmr' : 'ranked',
    routeStrategy: summarizeRouteStrategy(matchDetails),
    routeBreakdown: summarizeRouteBreakdown(matchDetails),
    scopeCascadeApplied: assembly.enableScopeCascade && matchDetails.some((detail) => detail.matchedBy === 'scope-cascade'),
    selectedModules,
  };
}

// ===========================================
// Formatting
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
- **Confirmation Status**: ${memory.confirmationStatus || 'human-confirmed'}
- **Data Flow**: ${memory.dataFlow || 'N/A'}
- **Key Patterns**: ${memory.keyPatterns.join(', ') || 'N/A'}
- **Internal Dependencies**: ${memory.dependencies.imports.join(', ') || 'N/A'}
- **External Dependencies**: ${memory.dependencies.external.join(', ') || 'N/A'}
- **Last Updated**: ${new Date(memory.lastUpdated).toLocaleString()}`;
}

function buildAssemblyInput(params: {
  moduleName?: string;
  query?: string;
  scope?: string;
  filePaths?: string[];
  phase?: AssemblyProfileName;
  assembly: AssemblyPlan;
}): LoadModuleMemoryPayload['input'] {
  return {
    moduleName: params.moduleName,
    query: params.query,
    scope: params.scope,
    filePaths: params.filePaths,
    phase: params.phase,
    profile: params.assembly.name,
    enableScopeCascade: params.assembly.enableScopeCascade,
    maxResults: params.assembly.maxResults,
    useMmr: params.assembly.useMmr,
    mmrLambda: params.assembly.mmrLambda,
  };
}

function formatAssemblyText(assembly: AssemblyPlan): string {
  return [
    '#### Context Assembly',
    `- **Assembly Profile**: ${assembly.name}`,
    `- **Assembly Source**: ${assembly.source}`,
    `- **Budget**: maxResults=${assembly.maxResults}, useMmr=${assembly.useMmr}, mmrLambda=${assembly.mmrLambda}, enableScopeCascade=${assembly.enableScopeCascade}`,
  ].join('\n');
}

function formatRoutingText(
  routeResult: {
    matchedModules: string[];
    matchDetails: LoadModuleMemoryMatchDetail[];
    memories: FeatureMemory[];
  },
  assembly: AssemblyPlan,
  selectedCount: number,
  selectionStrategy: 'mmr' | 'ranked',
  selectedModules: string[],
): string {
  const summary = buildRoutingSummary(
    routeResult.matchDetails,
    assembly,
    routeResult.memories.length,
    selectedCount,
    selectedModules,
  );
  return [
    '#### Routing Decision',
    `- **Route Strategy**: ${summary.routeStrategy}`,
    `- **Candidate Count**: ${summary.candidateCount}`,
    `- **Selected Count**: ${summary.selectedCount}`,
    `- **Selection Strategy**: ${selectionStrategy === 'mmr' ? 'MMR' : 'ranked'}`,
    `- **Scope Cascade**: ${summary.scopeCascadeApplied ? 'enabled' : 'disabled'}`,
    `- **Selected Modules**: ${summary.selectedModules.length > 0 ? summary.selectedModules.join(', ') : 'N/A'}`,
    `- **Budget Used**: ${selectedCount}/${assembly.maxResults}`,
  ].join('\n');
}

// ===========================================
// MMR Budget Selection
// ===========================================

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
    if (memory.confirmationStatus === 'suggested') {
      continue;
    }
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
  const score =
    normalizedMatchSignal * 2
    + querySignal
    + recencySignal
    + getConfirmationStatusBoost(memory.confirmationStatus);
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

function getConfirmationStatusBoost(
  status: FeatureMemory['confirmationStatus'],
): number {
  switch (status) {
    case 'human-confirmed':
      return 0.6;
    case 'agent-inferred':
      return 0.15;
    case 'suggested':
      return -10;
    default:
      return 0.4;
  }
}
