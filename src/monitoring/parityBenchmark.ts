import fs from 'node:fs';
import path from 'node:path';

export type ParityBenchmarkTrack =
  | 'gitnexus-parity'
  | 'mem0-parity'
  | 'contextatlas-native';

export type ParityBenchmarkCapability =
  | 'retrieval'
  | 'graph'
  | 'impact'
  | 'memory'
  | 'cold-start'
  | 'contract';

export type ParityBenchmarkStatus = 'baseline' | 'partial' | 'target';

export type ParityBenchmarkFailureCategory =
  | 'missing-capability'
  | 'parse-error'
  | 'ranking-drift'
  | 'unstable-output';

export type ParityBenchmarkGoldenCase =
  | 'symbol-lookup'
  | 'call-chain'
  | 'impact-analysis'
  | 'diff-hit'
  | 'memory-recall'
  | 'cold-start-fallback'
  | 'retrieval-card'
  | 'memory-retrieval';

export type ParityBenchmarkFieldType = 'string' | 'number' | 'boolean' | 'array' | 'object';

export interface ParityBenchmarkExpectedField {
  path: string;
  type: ParityBenchmarkFieldType;
  required: boolean;
}

export type ParityBenchmarkMemoryStatus = 'active' | 'stale' | 'expired' | 'superseded';

export interface ParityBenchmarkMemoryRetrievalResult {
  id: string;
  status: ParityBenchmarkMemoryStatus;
  score: number;
  matchFields: string[];
  scoreBreakdown: Record<string, number | string>;
}

export interface ParityBenchmarkMemoryRetrievalGoldenOutput {
  query: string;
  expectedTopId: string;
  embeddingMode: 'disabled';
  activeMustRankBefore: ParityBenchmarkMemoryStatus[];
  requiredMatchFields: string[];
  requiredScoreBreakdownKeys: string[];
  results: ParityBenchmarkMemoryRetrievalResult[];
}

export interface ParityBenchmarkRepository {
  id: string;
  label: string;
  languages: string[];
  focus: string;
}

export interface ParityBenchmarkCase {
  id: string;
  track: ParityBenchmarkTrack;
  capability: ParityBenchmarkCapability;
  status: ParityBenchmarkStatus;
  goldenCase: ParityBenchmarkGoldenCase;
  query: string;
  expectedOutput: {
    shapeVersion: 1;
    requiredFields: string[];
    fields: ParityBenchmarkExpectedField[];
    failureCategories?: ParityBenchmarkFailureCategory[];
    memoryRetrieval?: ParityBenchmarkMemoryRetrievalGoldenOutput;
    notes?: string;
  };
  tags?: string[];
}

export interface ParityBenchmarkFixture {
  version: 1;
  name: string;
  evaluationRepositories?: ParityBenchmarkRepository[];
  cases: ParityBenchmarkCase[];
}

export interface ParityBenchmarkReport {
  fixture: {
    name: string;
    version: number;
    path: string;
  };
  summary: {
    caseCount: number;
    byTrack: Record<ParityBenchmarkTrack, number>;
    byCapability: Record<ParityBenchmarkCapability, number>;
    byStatus: Record<ParityBenchmarkStatus, number>;
    byFailureCategory: Record<ParityBenchmarkFailureCategory, number>;
    failureCategoryCoverage: {
      required: ParityBenchmarkFailureCategory[];
      covered: ParityBenchmarkFailureCategory[];
      missing: ParityBenchmarkFailureCategory[];
      complete: boolean;
    };
    byGoldenCase: Record<ParityBenchmarkGoldenCase, number>;
    evaluationRepositoryCount: number;
    evaluationLanguages: string[];
    memoryRetrievalGoldenCaseCount: number;
    memoryRetrievalGoldenCasePassCount: number;
    memoryRetrievalGoldenCaseFailCount: number;
    benchmarkPassed: boolean;
  };
  trackLists: Record<ParityBenchmarkTrack, string[]>;
  evaluationRepositories: ParityBenchmarkRepository[];
  memoryRetrievalGoldenCases: ParityBenchmarkMemoryRetrievalEvaluation[];
  cases: ParityBenchmarkCase[];
}

export interface ParityBenchmarkMemoryRetrievalEvaluation {
  caseId: string;
  query: string;
  expectedTopId: string;
  topId: string | null;
  passed: boolean;
  checks: {
    hasExpectedTopResult: boolean;
    includesRequiredMatchFields: boolean;
    includesRequiredScoreBreakdown: boolean;
    embeddingModeDisabled: boolean;
    activeRanksBeforeStaleOrExpired: boolean;
  };
}

export const DEFAULT_PARITY_BENCHMARK_FIXTURE: ParityBenchmarkFixture = {
  version: 1,
  name: 'ContextAtlas System Boundary Baseline',
  evaluationRepositories: [
    {
      id: 'contextatlas-ts',
      label: 'TypeScript CLI/MCP repository',
      languages: ['typescript', 'javascript'],
      focus: 'retrieval, graph health, CLI command coverage',
    },
    {
      id: 'python-service',
      label: 'Python service fixture',
      languages: ['python'],
      focus: 'symbol extraction, import resolution, cold-start fallback',
    },
    {
      id: 'go-cli',
      label: 'Go CLI fixture',
      languages: ['go'],
      focus: 'package imports, call relations, impact analysis',
    },
    {
      id: 'java-service',
      label: 'Java service fixture',
      languages: ['java'],
      focus: 'class methods, interface relations, API boundary analysis',
    },
    {
      id: 'rust-crate',
      label: 'Rust crate fixture',
      languages: ['rust'],
      focus: 'module imports, impl methods, fallback behavior',
    },
    {
      id: 'polyglot-agent-tool',
      label: 'Polyglot agent tool fixture',
      languages: ['typescript', 'python', 'go'],
      focus: 'mixed-language degradation and stable output shape',
    },
  ],
  cases: [
    {
      id: 'gitnexus-symbol-lookup',
      track: 'gitnexus-parity',
      capability: 'graph',
      status: 'partial',
      goldenCase: 'symbol-lookup',
      query: 'Show callers, callees, and direct relations for SearchService',
      expectedOutput: {
        shapeVersion: 1,
        requiredFields: ['symbol', 'upstream', 'downstream', 'confidence'],
        fields: [
          { path: 'symbol.name', type: 'string', required: true },
          { path: 'symbol.filePath', type: 'string', required: true },
          { path: 'upstream', type: 'array', required: true },
          { path: 'downstream', type: 'array', required: true },
          { path: 'confidence', type: 'number', required: true },
        ],
        failureCategories: ['missing-capability', 'parse-error'],
      },
      tags: ['graph', 'context'],
    },
    {
      id: 'gitnexus-call-chain',
      track: 'gitnexus-parity',
      capability: 'graph',
      status: 'partial',
      goldenCase: 'call-chain',
      query: 'Trace the call chain from codebase retrieval entrypoint to SearchService',
      expectedOutput: {
        shapeVersion: 1,
        requiredFields: ['entrypoint', 'steps', 'terminal', 'confidence'],
        fields: [
          { path: 'entrypoint', type: 'object', required: true },
          { path: 'steps', type: 'array', required: true },
          { path: 'terminal', type: 'object', required: true },
          { path: 'confidence', type: 'number', required: true },
        ],
        failureCategories: ['missing-capability', 'parse-error'],
      },
      tags: ['graph', 'call-chain'],
    },
    {
      id: 'gitnexus-impact-analysis',
      track: 'gitnexus-parity',
      capability: 'impact',
      status: 'target',
      goldenCase: 'impact-analysis',
      query: 'Map SearchService changes to affected callers and risk level',
      expectedOutput: {
        shapeVersion: 1,
        requiredFields: ['targetSymbol', 'affectedSymbols', 'affectedModules', 'riskLevel'],
        fields: [
          { path: 'targetSymbol', type: 'object', required: true },
          { path: 'affectedSymbols', type: 'array', required: true },
          { path: 'affectedModules', type: 'array', required: true },
          { path: 'riskLevel', type: 'string', required: true },
        ],
        failureCategories: ['missing-capability', 'parse-error'],
      },
      tags: ['graph', 'impact'],
    },
    {
      id: 'gitnexus-diff-hit',
      track: 'gitnexus-parity',
      capability: 'impact',
      status: 'target',
      goldenCase: 'diff-hit',
      query: 'Map changed lines to affected symbols and risk level',
      expectedOutput: {
        shapeVersion: 1,
        requiredFields: ['changedSymbols', 'affectedRelations', 'riskLevel'],
        fields: [
          { path: 'changedSymbols', type: 'array', required: true },
          { path: 'affectedRelations', type: 'array', required: true },
          { path: 'riskLevel', type: 'string', required: true },
        ],
        failureCategories: ['missing-capability', 'parse-error'],
      },
      tags: ['graph', 'diff'],
    },
    {
      id: 'mem0-long-term-memory',
      track: 'mem0-parity',
      capability: 'memory',
      status: 'partial',
      goldenCase: 'memory-recall',
      query: 'Recall durable user or project preference with source and status',
      expectedOutput: {
        shapeVersion: 1,
        requiredFields: ['memory', 'scope', 'source', 'confidence', 'status'],
        fields: [
          { path: 'memory', type: 'string', required: true },
          { path: 'scope', type: 'string', required: true },
          { path: 'source', type: 'string', required: true },
          { path: 'confidence', type: 'number', required: true },
          { path: 'status', type: 'string', required: true },
        ],
        failureCategories: ['missing-capability', 'ranking-drift'],
      },
      tags: ['memory'],
    },
    {
      id: 'contextatlas-cold-start',
      track: 'contextatlas-native',
      capability: 'cold-start',
      status: 'baseline',
      goldenCase: 'cold-start-fallback',
      query: 'Return partial lexical context before vector index is ready',
      expectedOutput: {
        shapeVersion: 1,
        requiredFields: ['mode', 'fallbackReason', 'codeBlocks'],
        fields: [
          { path: 'mode', type: 'string', required: true },
          { path: 'fallbackReason', type: 'string', required: true },
          { path: 'codeBlocks', type: 'array', required: true },
        ],
        failureCategories: ['unstable-output'],
      },
      tags: ['retrieval', 'fallback'],
    },
    {
      id: 'contextatlas-retrieval-card',
      track: 'contextatlas-native',
      capability: 'retrieval',
      status: 'baseline',
      goldenCase: 'retrieval-card',
      query: 'Return a stable result card with code, memory, decisions, and rationale',
      expectedOutput: {
        shapeVersion: 1,
        requiredFields: ['codeHits', 'memoryHits', 'decisionHits', 'whyMatched'],
        fields: [
          { path: 'codeHits', type: 'array', required: true },
          { path: 'memoryHits', type: 'array', required: true },
          { path: 'decisionHits', type: 'array', required: true },
          { path: 'whyMatched', type: 'string', required: true },
        ],
        failureCategories: ['ranking-drift', 'unstable-output'],
      },
      tags: ['retrieval'],
    },
    {
      id: 'contextatlas-long-term-memory-retrieval',
      track: 'contextatlas-native',
      capability: 'memory',
      status: 'target',
      goldenCase: 'memory-retrieval',
      query: 'Recall active retrieval benchmark preference with explainable memory scoring',
      expectedOutput: {
        shapeVersion: 1,
        requiredFields: ['results', 'matchFields', 'scoreBreakdown', 'status'],
        fields: [
          { path: 'results', type: 'array', required: true },
          { path: 'results[].matchFields', type: 'array', required: true },
          { path: 'results[].scoreBreakdown', type: 'object', required: true },
          { path: 'results[].scoreBreakdown.embedding', type: 'string', required: true },
          { path: 'results[].status', type: 'string', required: true },
        ],
        failureCategories: ['ranking-drift', 'unstable-output'],
        memoryRetrieval: {
          query: 'memory retrieval benchmark preference',
          expectedTopId: 'active-p7-memory-benchmark',
          embeddingMode: 'disabled',
          activeMustRankBefore: ['stale', 'expired'],
          requiredMatchFields: ['title', 'summary', 'tags'],
          requiredScoreBreakdownKeys: ['fts', 'embedding', 'title', 'summary', 'tags', 'status', 'total'],
          results: [
            {
              id: 'active-p7-memory-benchmark',
              status: 'active',
              score: 53,
              matchFields: ['title', 'summary', 'tags'],
              scoreBreakdown: {
                fts: 0,
                embedding: 'disabled',
                title: 20,
                summary: 12,
                tags: 4,
                confidence: 9,
                status: 8,
                total: 53,
              },
            },
            {
              id: 'stale-p7-memory-benchmark',
              status: 'stale',
              score: 37,
              matchFields: ['title', 'summary', 'tags'],
              scoreBreakdown: {
                fts: 0,
                embedding: 'disabled',
                title: 20,
                summary: 12,
                tags: 4,
                confidence: 9,
                status: -8,
                total: 37,
              },
            },
            {
              id: 'expired-p7-memory-benchmark',
              status: 'expired',
              score: 25,
              matchFields: ['title', 'summary', 'tags'],
              scoreBreakdown: {
                fts: 0,
                embedding: 'disabled',
                title: 20,
                summary: 12,
                tags: 4,
                confidence: 9,
                status: -20,
                total: 25,
              },
            },
          ],
        },
      },
      tags: ['memory', 'benchmark', 'p7'],
    },
  ],
};

const TRACKS: ParityBenchmarkTrack[] = [
  'gitnexus-parity',
  'mem0-parity',
  'contextatlas-native',
];

const CAPABILITIES: ParityBenchmarkCapability[] = [
  'retrieval',
  'graph',
  'impact',
  'memory',
  'cold-start',
  'contract',
];

const STATUSES: ParityBenchmarkStatus[] = ['baseline', 'partial', 'target'];

const FAILURE_CATEGORIES: ParityBenchmarkFailureCategory[] = [
  'missing-capability',
  'parse-error',
  'ranking-drift',
  'unstable-output',
];

const GOLDEN_CASES: ParityBenchmarkGoldenCase[] = [
  'symbol-lookup',
  'call-chain',
  'impact-analysis',
  'diff-hit',
  'memory-recall',
  'cold-start-fallback',
  'retrieval-card',
  'memory-retrieval',
];

const REQUIRED_GOLDEN_CASES: ParityBenchmarkGoldenCase[] = [
  'symbol-lookup',
  'call-chain',
  'impact-analysis',
  'diff-hit',
  'memory-recall',
  'cold-start-fallback',
];

const FIELD_TYPES: ParityBenchmarkFieldType[] = ['string', 'number', 'boolean', 'array', 'object'];

const MEMORY_STATUSES: ParityBenchmarkMemoryStatus[] = [
  'active',
  'stale',
  'expired',
  'superseded',
];

function emptyCounts<T extends string>(keys: T[]): Record<T, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
}

function resolveFixtureLabel(fixturePath: string): string {
  if (fixturePath.startsWith('builtin:')) {
    return fixturePath;
  }
  return path.resolve(fixturePath);
}

function assertKnownValue<T extends string>(
  value: string,
  allowed: readonly T[],
  label: string,
): asserts value is T {
  if (!allowed.includes(value as T)) {
    throw new Error(`Unsupported parity benchmark ${label}: ${value}`);
  }
}

function validateCase(testCase: ParityBenchmarkCase, index: number): void {
  if (!testCase.id) {
    throw new Error(`Parity benchmark case at index ${index} is missing id`);
  }
  assertKnownValue(testCase.track, TRACKS, 'track');
  assertKnownValue(testCase.capability, CAPABILITIES, 'capability');
  assertKnownValue(testCase.status, STATUSES, 'status');
  assertKnownValue(testCase.goldenCase, GOLDEN_CASES, 'golden case');
  if (!testCase.query.trim()) {
    throw new Error(`Parity benchmark case "${testCase.id}" is missing query`);
  }
  if (testCase.expectedOutput.shapeVersion !== 1) {
    throw new Error(`Parity benchmark case "${testCase.id}" must define expectedOutput.shapeVersion=1`);
  }
  if (!Array.isArray(testCase.expectedOutput.requiredFields) || testCase.expectedOutput.requiredFields.length === 0) {
    throw new Error(`Parity benchmark case "${testCase.id}" must define requiredFields`);
  }
  if (!Array.isArray(testCase.expectedOutput.fields) || testCase.expectedOutput.fields.length === 0) {
    throw new Error(`Parity benchmark case "${testCase.id}" must define structured expectedOutput.fields`);
  }
  for (const field of testCase.expectedOutput.fields) {
    if (!field.path || !field.type || typeof field.required !== 'boolean') {
      throw new Error(`Parity benchmark case "${testCase.id}" has invalid expectedOutput.fields entry`);
    }
    assertKnownValue(field.type, FIELD_TYPES, 'field type');
  }
  for (const category of testCase.expectedOutput.failureCategories ?? []) {
    assertKnownValue(category, FAILURE_CATEGORIES, 'failure category');
  }
  validateMemoryRetrievalGoldenOutput(testCase);
}

function validateMemoryRetrievalGoldenOutput(testCase: ParityBenchmarkCase): void {
  const goldenOutput = testCase.expectedOutput.memoryRetrieval;
  if (!goldenOutput) {
    return;
  }
  if (testCase.goldenCase !== 'memory-retrieval') {
    throw new Error(`Parity benchmark case "${testCase.id}" must use goldenCase=memory-retrieval when memoryRetrieval is defined`);
  }
  if (!goldenOutput.query.trim()) {
    throw new Error(`Parity benchmark case "${testCase.id}" memoryRetrieval query is missing`);
  }
  if (!goldenOutput.expectedTopId) {
    throw new Error(`Parity benchmark case "${testCase.id}" memoryRetrieval expectedTopId is missing`);
  }
  if (goldenOutput.embeddingMode !== 'disabled') {
    throw new Error(`Parity benchmark case "${testCase.id}" memoryRetrieval must declare embeddingMode=disabled`);
  }
  if (!Array.isArray(goldenOutput.results) || goldenOutput.results.length === 0) {
    throw new Error(`Parity benchmark case "${testCase.id}" memoryRetrieval must define results`);
  }
  if (!Array.isArray(goldenOutput.requiredMatchFields) || goldenOutput.requiredMatchFields.length === 0) {
    throw new Error(`Parity benchmark case "${testCase.id}" memoryRetrieval must define requiredMatchFields`);
  }
  if (!Array.isArray(goldenOutput.requiredScoreBreakdownKeys) || goldenOutput.requiredScoreBreakdownKeys.length === 0) {
    throw new Error(`Parity benchmark case "${testCase.id}" memoryRetrieval must define requiredScoreBreakdownKeys`);
  }
  for (const status of goldenOutput.activeMustRankBefore) {
    assertKnownValue(status, MEMORY_STATUSES, 'memory status');
  }
  for (const result of goldenOutput.results) {
    if (!result.id || !Array.isArray(result.matchFields) || typeof result.score !== 'number') {
      throw new Error(`Parity benchmark case "${testCase.id}" memoryRetrieval has invalid result entry`);
    }
    assertKnownValue(result.status, MEMORY_STATUSES, 'memory status');
    if (!result.scoreBreakdown || typeof result.scoreBreakdown !== 'object') {
      throw new Error(`Parity benchmark case "${testCase.id}" memoryRetrieval result "${result.id}" is missing scoreBreakdown`);
    }
  }
}

function validateEvaluationRepositories(repositories: ParityBenchmarkRepository[] | undefined): void {
  if (repositories === undefined) {
    return;
  }
  if (repositories.length < 5 || repositories.length > 8) {
    throw new Error('Parity benchmark evaluationRepositories must contain 5 to 8 entries');
  }
  for (const repository of repositories) {
    if (!repository.id || !repository.label || !repository.focus) {
      throw new Error('Parity benchmark evaluation repositories must define id, label, and focus');
    }
    if (!Array.isArray(repository.languages) || repository.languages.length === 0) {
      throw new Error(`Parity benchmark repository "${repository.id}" must define languages`);
    }
  }
}

export function evaluateMemoryRetrievalGoldenCases(
  cases: ParityBenchmarkCase[],
): ParityBenchmarkMemoryRetrievalEvaluation[] {
  return cases.flatMap((testCase) => {
    const goldenOutput = testCase.expectedOutput.memoryRetrieval;
    if (!goldenOutput) {
      return [];
    }

    const results = [...goldenOutput.results].sort((a, b) => b.score - a.score);
    const top = results[0] ?? null;
    const expectedTop = results.find((result) => result.id === goldenOutput.expectedTopId);
    const activeResults = results.filter((result) => result.status === 'active');
    const blockedResults = results.filter((result) =>
      goldenOutput.activeMustRankBefore.includes(result.status),
    );
    const checks = {
      hasExpectedTopResult: top?.id === goldenOutput.expectedTopId,
      includesRequiredMatchFields: Boolean(expectedTop)
        && goldenOutput.requiredMatchFields.every((field) => expectedTop.matchFields.includes(field)),
      includesRequiredScoreBreakdown: Boolean(expectedTop)
        && goldenOutput.requiredScoreBreakdownKeys.every((key) =>
          Object.prototype.hasOwnProperty.call(expectedTop.scoreBreakdown, key),
        ),
      embeddingModeDisabled: results.every(
        (result) => result.scoreBreakdown.embedding === goldenOutput.embeddingMode,
      ),
      activeRanksBeforeStaleOrExpired: activeResults.length > 0
        && blockedResults.length > 0
        && activeResults.every((active) =>
          blockedResults.every((blocked) => active.score > blocked.score),
        ),
    };

    return [{
      caseId: testCase.id,
      query: goldenOutput.query,
      expectedTopId: goldenOutput.expectedTopId,
      topId: top?.id ?? null,
      passed: Object.values(checks).every(Boolean),
      checks,
    }];
  });
}

export function loadParityBenchmarkFixture(fixturePath: string): ParityBenchmarkFixture {
  const resolvedPath = path.resolve(fixturePath);
  const parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf8')) as ParityBenchmarkFixture;

  if (parsed.version !== 1) {
    throw new Error(`Unsupported parity benchmark fixture version: ${String((parsed as { version?: unknown }).version)}`);
  }
  if (!parsed.name) {
    throw new Error('Parity benchmark fixture must define name');
  }
  if (!Array.isArray(parsed.cases) || parsed.cases.length === 0) {
    throw new Error('Parity benchmark fixture must contain at least one case');
  }

  validateEvaluationRepositories(parsed.evaluationRepositories);
  parsed.cases.forEach(validateCase);
  return parsed;
}

export function summarizeParityBenchmark(
  fixture: ParityBenchmarkFixture,
  fixturePath: string,
): ParityBenchmarkReport {
  if (fixture.version !== 1 || !Array.isArray(fixture.cases) || fixture.cases.length === 0) {
    throw new Error('Invalid parity benchmark fixture');
  }
  validateEvaluationRepositories(fixture.evaluationRepositories);
  fixture.cases.forEach(validateCase);

  const byTrack = emptyCounts(TRACKS);
  const byCapability = emptyCounts(CAPABILITIES);
  const byStatus = emptyCounts(STATUSES);
  const byFailureCategory = emptyCounts(FAILURE_CATEGORIES);
  const byGoldenCase = emptyCounts(GOLDEN_CASES);
  const trackLists = Object.fromEntries(TRACKS.map((track) => [track, []])) as Record<
    ParityBenchmarkTrack,
    string[]
  >;

  for (const testCase of fixture.cases) {
    byTrack[testCase.track]++;
    byCapability[testCase.capability]++;
    byStatus[testCase.status]++;
    byGoldenCase[testCase.goldenCase]++;
    trackLists[testCase.track].push(testCase.id);
    for (const category of testCase.expectedOutput.failureCategories ?? []) {
      byFailureCategory[category]++;
    }
  }
  const evaluationRepositories = fixture.evaluationRepositories ?? [];
  const evaluationLanguages = Array.from(
    new Set(evaluationRepositories.flatMap((repository) => repository.languages)),
  ).sort();
  const missingRequiredGoldenCases = REQUIRED_GOLDEN_CASES.filter((goldenCase) => byGoldenCase[goldenCase] === 0);
  if (missingRequiredGoldenCases.length > 0) {
    throw new Error(`Parity benchmark fixture is missing required golden cases: ${missingRequiredGoldenCases.join(', ')}`);
  }
  const coveredFailureCategories = FAILURE_CATEGORIES.filter((category) => byFailureCategory[category] > 0);
  const missingFailureCategories = FAILURE_CATEGORIES.filter((category) => byFailureCategory[category] === 0);
  const memoryRetrievalGoldenCases = evaluateMemoryRetrievalGoldenCases(fixture.cases);
  const failedMemoryRetrievalCases = memoryRetrievalGoldenCases.filter((result) => !result.passed);
  if (failedMemoryRetrievalCases.length > 0) {
    throw new Error(`Parity benchmark memory retrieval golden cases failed: ${failedMemoryRetrievalCases.map((result) => result.caseId).join(', ')}`);
  }
  const memoryRetrievalGoldenCasePassCount = memoryRetrievalGoldenCases.length
    - failedMemoryRetrievalCases.length;

  return {
    fixture: {
      name: fixture.name,
      version: fixture.version,
      path: resolveFixtureLabel(fixturePath),
    },
    summary: {
      caseCount: fixture.cases.length,
      byTrack,
      byCapability,
      byStatus,
      byFailureCategory,
      failureCategoryCoverage: {
        required: [...FAILURE_CATEGORIES],
        covered: coveredFailureCategories,
        missing: missingFailureCategories,
        complete: missingFailureCategories.length === 0,
      },
      byGoldenCase,
      evaluationRepositoryCount: evaluationRepositories.length,
      evaluationLanguages,
      memoryRetrievalGoldenCaseCount: memoryRetrievalGoldenCases.length,
      memoryRetrievalGoldenCasePassCount,
      memoryRetrievalGoldenCaseFailCount: failedMemoryRetrievalCases.length,
      benchmarkPassed: missingFailureCategories.length === 0
        && failedMemoryRetrievalCases.length === 0,
    },
    trackLists,
    evaluationRepositories,
    memoryRetrievalGoldenCases,
    cases: fixture.cases,
  };
}

export function runParityBenchmark(input: {
  fixturePath?: string;
} = {}): ParityBenchmarkReport {
  if (!input.fixturePath) {
    return summarizeParityBenchmark(
      DEFAULT_PARITY_BENCHMARK_FIXTURE,
      'builtin:contextatlas-system-boundary',
    );
  }

  const fixturePath = path.resolve(input.fixturePath);
  const fixture = loadParityBenchmarkFixture(fixturePath);
  return summarizeParityBenchmark(fixture, fixturePath);
}

function formatCounts<T extends string>(counts: Record<T, number>): string {
  return Object.entries(counts)
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
}

export function formatParityBenchmarkReport(report: ParityBenchmarkReport): string {
  const lines: string[] = [];
  lines.push(`Fixture: ${report.fixture.name}`);
  lines.push(`Version: ${report.fixture.version}`);
  lines.push(`Cases: ${report.summary.caseCount}`);
  lines.push('');
  lines.push('Summary');
  lines.push(`- Tracks: ${formatCounts(report.summary.byTrack)}`);
  lines.push(`- Capabilities: ${formatCounts(report.summary.byCapability)}`);
  lines.push(`- Statuses: ${formatCounts(report.summary.byStatus)}`);
  lines.push(`- Golden Cases: ${formatCounts(report.summary.byGoldenCase)}`);
  lines.push(`- Failure Categories: ${formatCounts(report.summary.byFailureCategory)}`);
  lines.push(`- Benchmark Passed: ${report.summary.benchmarkPassed}`);
  lines.push(
    `- Failure Category Coverage: complete=${report.summary.failureCategoryCoverage.complete} covered=${report.summary.failureCategoryCoverage.covered.join(', ') || 'none'} missing=${report.summary.failureCategoryCoverage.missing.join(', ') || 'none'}`,
  );
  lines.push(`- Evaluation Repositories: ${report.summary.evaluationRepositoryCount}`);
  lines.push(`- Evaluation Languages: ${report.summary.evaluationLanguages.join(', ') || 'none'}`);
  lines.push(`- Memory Retrieval Golden Cases: ${report.summary.memoryRetrievalGoldenCaseCount}`);
  lines.push(
    `- Memory Retrieval Golden Case Results: pass=${report.summary.memoryRetrievalGoldenCasePassCount} fail=${report.summary.memoryRetrievalGoldenCaseFailCount}`,
  );
  lines.push('');
  lines.push('Track Lists');
  for (const track of TRACKS) {
    lines.push(`- ${track}: ${report.trackLists[track].join(', ') || 'none'}`);
  }
  lines.push('');
  lines.push('Evaluation Repositories');
  if (report.evaluationRepositories.length === 0) {
    lines.push('- none');
  } else {
    for (const repository of report.evaluationRepositories) {
      lines.push(
        `- ${repository.id}: languages=${repository.languages.join(', ')} focus=${repository.focus}`,
      );
    }
  }
  lines.push('');
  lines.push('Memory Retrieval Golden Cases');
  if (report.memoryRetrievalGoldenCases.length === 0) {
    lines.push('- none');
  } else {
    for (const result of report.memoryRetrievalGoldenCases) {
      lines.push(
        `- ${result.caseId}: passed=${result.passed} top=${result.topId ?? 'none'} expected=${result.expectedTopId}`,
      );
      lines.push(
        `  checks: ${Object.entries(result.checks).map(([key, value]) => `${key}=${value}`).join(', ')}`,
      );
    }
  }
  lines.push('');
  lines.push('Cases');
  for (const testCase of report.cases) {
    lines.push(
      `- [${testCase.status}] ${testCase.id} (${testCase.track}/${testCase.capability})`,
    );
    lines.push(`  golden_case: ${testCase.goldenCase}`);
    lines.push(`  shape_version: ${testCase.expectedOutput.shapeVersion}`);
    lines.push(`  required_fields: ${testCase.expectedOutput.requiredFields.join(', ')}`);
    lines.push(
      `  structured_fields: ${testCase.expectedOutput.fields.map((field) => `${field.path}:${field.type}${field.required ? '!' : ''}`).join(', ')}`,
    );
    lines.push(
      `  failure_categories: ${(testCase.expectedOutput.failureCategories ?? []).join(', ') || 'none'}`,
    );
  }
  return lines.join('\n');
}
