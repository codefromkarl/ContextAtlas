export interface SmokeStep {
  name: string;
  command: string[];
  expectedPatterns: RegExp[];
}

export interface SmokeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function buildReleaseSmokePlan(input: {
  cliEntry: string;
  fixtureRepoPath: string;
}): SmokeStep[] {
  const { cliEntry, fixtureRepoPath } = input;

  return [
    {
      name: 'cli-version',
      command: ['node', cliEntry, '--version'],
      expectedPatterns: [/^\d+\.\d+\.\d+$/m],
    },
    {
      name: 'start-guide',
      command: ['node', cliEntry, 'start', fixtureRepoPath],
      expectedPatterns: [/ContextAtlas Start/, /Index Status:/],
    },
    {
      name: 'seed-memory-governance',
      command: ['node', '--import', 'tsx', 'scripts/release-smoke-seed.ts', fixtureRepoPath],
      expectedPatterns: [/release-smoke-seeded/],
    },
    {
      name: 'daemon-help',
      command: ['node', cliEntry, 'daemon', '--help'],
      expectedPatterns: [/daemon <action>/],
    },
    {
      name: 'monitoring-health-full',
      command: ['node', cliEntry, 'health:full', '--json'],
      expectedPatterns: [
        /"indexHealth"/,
        /"memoryHealth"/,
        /"alerts"/,
        /"orphanedRate"\s*:\s*0\.5/,
        /"isConsistent"\s*:\s*false/,
        /"ruleId"\s*:\s*"memory-catalog-inconsistent"/,
      ],
    },
    {
      name: 'index-diagnose',
      command: ['node', cliEntry, 'index:diagnose', '--json'],
      expectedPatterns: [
        /"churnThreshold"\s*:\s*0\.35/,
        /"costThresholdRatio"\s*:\s*0\.65/,
        /"minFilesForEscalation"\s*:\s*8/,
        /"minChangedFilesForEscalation"\s*:\s*5/,
      ],
    },
    {
      name: 'mcp-help',
      command: ['node', cliEntry, 'mcp', '--help'],
      expectedPatterns: [/mcp/],
    },
    {
      name: 'health-full',
      command: ['node', cliEntry, 'health:full', '--json'],
      expectedPatterns: [
        /"indexHealth"/,
        /"memoryHealth"/,
        /"alerts"/,
        /"orphanedRate"\s*:\s*0\.5/,
        /"isConsistent"\s*:\s*false/,
        /"ruleId"\s*:\s*"memory-high-stale-rate"/,
      ],
    },
    {
      name: 'ops-summary',
      command: ['node', cliEntry, 'ops:summary', '--json'],
      expectedPatterns: [
        /"status"/,
        /"sections"/,
        /"governance"\s*:\s*"catalog=.*orphaned=[1-9]\d*%/s,
        /"index"\s*:\s*"status=/,
        /功能记忆与 catalog 不一致/,
        /contextatlas memory:rebuild-catalog/,
        /"id"\s*:\s*"rebuild-memory-catalog"[\s\S]*"id"\s*:\s*"prune-stale-memory"/,
      ],
    },
    {
      name: 'ops-metrics',
      command: ['node', cliEntry, 'ops:metrics', '--json'],
      expectedPatterns: [
        /"summary"/,
        /"governance"/,
        /"projectProfileModes"\s*:\s*\{\s*"editable"\s*:\s*[1-9]\d*,\s*"organizationReadonly"\s*:\s*0/s,
        /"sharedMemoryPolicies"\s*:\s*\{\s*"disabled"\s*:\s*0,\s*"readonly"\s*:\s*[1-9]\d*,\s*"editable"\s*:\s*0/s,
        /"longTermMemoryScopes"\s*:\s*\{\s*"project"\s*:\s*[1-9]\d*,\s*"globalUser"\s*:\s*0/s,
        /"repoQualityDistribution"/,
        /"projectName"\s*:\s*"repo"/,
        /"moduleQualityDistribution"/,
      ],
    },
    {
      name: 'alert-eval',
      command: ['node', cliEntry, 'alert:eval', '--json'],
      expectedPatterns: [
        /"triggered"/,
        /"active"/,
        /"ruleId"\s*:\s*"daemon-down"/,
        /"ruleId"\s*:\s*"memory-catalog-inconsistent"/,
        /"ruleId"\s*:\s*"memory-orphaned-features"/,
        /"ruleId"\s*:\s*"memory-high-stale-rate"/,
      ],
    },
    {
      name: 'monitoring-retrieval-help',
      command: ['node', cliEntry, 'monitor:retrieval', '--help'],
      expectedPatterns: [/monitor:retrieval/, /--json/],
    },
    {
      name: 'benchmark-small-noop',
      command: ['node', cliEntry, 'perf:benchmark', '--size', 'small', '--scenario', 'noop', '--json'],
      expectedPatterns: [/"size"\s*:\s*"small"/, /"scenario"\s*:\s*"noop"/, /"durationMs"/],
    },
    {
      name: 'parity-benchmark',
      command: ['node', cliEntry, 'parity:benchmark', '--json'],
      expectedPatterns: [
        /"caseCount"\s*:\s*8/,
        /"gitnexus-parity"\s*:\s*4/,
        /"mem0-parity"\s*:\s*1/,
        /"contextatlas-native"\s*:\s*3/,
        /"memoryRetrievalGoldenCaseCount"\s*:\s*1/,
      ],
    },
    {
      name: 'graph-health',
      command: ['node', cliEntry, 'health:graph', '--repo-path', fixtureRepoPath, '--json'],
      expectedPatterns: [/"repoPath"/, /"hasIndexDb"/, /"hasGraphTables"/, /"overall"/],
    },
    {
      name: 'cold-start-search',
      command: [
        'node',
        cliEntry,
        'search',
        '--repo-path',
        fixtureRepoPath,
        '--information-request',
        'smoke login flow',
        '--technical-terms',
        'smokeLogin',
      ],
      expectedPatterns: [/词法降级结果/, /smokeLogin/, /smoke\/auth\.ts/],
    },
  ];
}

export function validateSmokeResult(step: SmokeStep, result: SmokeResult): void {
  if (result.exitCode !== 0) {
    throw new Error(
      `${step.name} failed with exit code ${result.exitCode}: ${result.stderr || result.stdout}`,
    );
  }

  for (const pattern of step.expectedPatterns) {
    if (!pattern.test(result.stdout)) {
      throw new Error(
        `${step.name} missing expected pattern ${pattern}: ${result.stdout}`,
      );
    }
  }
}
