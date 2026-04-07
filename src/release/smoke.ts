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
      name: 'daemon-help',
      command: ['node', cliEntry, 'daemon', '--help'],
      expectedPatterns: [/daemon <action>/],
    },
    {
      name: 'monitoring-health-full',
      command: ['node', cliEntry, 'health:full', '--json'],
      expectedPatterns: [/"indexHealth"/, /"memoryHealth"/, /"alerts"/],
    },
    {
      name: 'mcp-help',
      command: ['node', cliEntry, 'mcp', '--help'],
      expectedPatterns: [/mcp/],
    },
    {
      name: 'health-full',
      command: ['node', cliEntry, 'health:full', '--json'],
      expectedPatterns: [/"indexHealth"/, /"memoryHealth"/, /"alerts"/],
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
