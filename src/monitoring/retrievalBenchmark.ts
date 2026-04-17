import fs from 'node:fs';
import path from 'node:path';
import { generateProjectId } from '../db/index.js';
import { resolveRetrievalQueries } from '../application/retrieval/executeRetrieval.js';
import { SearchService } from '../search/SearchService.js';
import { hasIndexedData } from '../storage/layout.js';

export interface RetrievalBenchmarkCase {
  id: string;
  query: string;
  technicalTerms?: string[];
  expectedFiles: string[];
  tags?: string[];
  notes?: string;
}

export interface RetrievalBenchmarkFixture {
  version: 1;
  name: string;
  repoPathHint?: string;
  cases: RetrievalBenchmarkCase[];
}

export interface RetrievalBenchmarkCaseResult {
  id: string;
  query: string;
  tags: string[];
  expectedFiles: string[];
  actualTopFiles: string[];
  actualPrimaryFiles: string[];
  actualVisibleFiles: string[];
  matchedFiles: string[];
  primaryMatchedFiles: string[];
  visibleMatchedFiles: string[];
  fileHit: boolean;
  expectedCoverage: number;
  primaryCoverage: number;
  dualTrackCoverage: number;
}

export interface RetrievalBenchmarkSummary {
  caseCount: number;
  fileHitAtK: number;
  expectedFileCoverage: number;
  primaryFileCoverage: number;
  dualTrackFileCoverage: number;
  entryFileCoverage: number;
  architectureCoverage: number;
  graphCoverage: number;
}

export interface RetrievalBenchmarkReport {
  fixture: {
    name: string;
    version: number;
    path: string;
  };
  repoPath: string;
  projectId: string;
  topK: number;
  summary: RetrievalBenchmarkSummary;
  results: RetrievalBenchmarkCaseResult[];
}

interface CoverageAccumulator {
  total: number;
  hits: number;
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function ratio(hit: number, total: number): number {
  if (total === 0) return 0;
  return round(hit / total);
}

function hasTag(tags: string[], expected: string): boolean {
  return tags.some((tag) => tag.toLowerCase() === expected.toLowerCase());
}

export function loadRetrievalBenchmarkFixture(fixturePath: string): RetrievalBenchmarkFixture {
  const raw = fs.readFileSync(fixturePath, 'utf8');
  const parsed = JSON.parse(raw) as RetrievalBenchmarkFixture;

  if (parsed.version !== 1) {
    throw new Error(`Unsupported retrieval benchmark fixture version: ${String((parsed as { version?: unknown }).version)}`);
  }

  if (!Array.isArray(parsed.cases) || parsed.cases.length === 0) {
    throw new Error('Retrieval benchmark fixture must contain at least one case');
  }

  return parsed;
}

export function summarizeRetrievalBenchmark(
  results: RetrievalBenchmarkCaseResult[],
): RetrievalBenchmarkSummary {
  const entry: CoverageAccumulator = { total: 0, hits: 0 };
  const architecture: CoverageAccumulator = { total: 0, hits: 0 };
  const graph: CoverageAccumulator = { total: 0, hits: 0 };
  let fileHits = 0;
  let expectedCoverageSum = 0;
  let primaryCoverageSum = 0;
  let primaryCoverageCases = 0;
  let dualTrackCoverageSum = 0;

  for (const result of results) {
    if (result.fileHit) {
      fileHits++;
    }
    expectedCoverageSum += result.expectedCoverage;
    dualTrackCoverageSum += result.dualTrackCoverage;

    if (hasTag(result.tags, 'entry')) {
      entry.total++;
      if (result.fileHit) entry.hits++;
    }

    if (hasTag(result.tags, 'architecture')) {
      architecture.total++;
      if (result.fileHit) architecture.hits++;
      if (result.expectedCoverage < 1) {
        primaryCoverageSum += result.primaryCoverage;
        primaryCoverageCases++;
      }
    }

    if (hasTag(result.tags, 'graph')) {
      graph.total++;
      if (result.fileHit) graph.hits++;
    }
  }

  return {
    caseCount: results.length,
    fileHitAtK: ratio(fileHits, results.length),
    expectedFileCoverage: results.length > 0 ? round(expectedCoverageSum / results.length) : 0,
    primaryFileCoverage: primaryCoverageCases > 0 ? round(primaryCoverageSum / primaryCoverageCases) : 0,
    dualTrackFileCoverage: results.length > 0 ? round(dualTrackCoverageSum / results.length) : 0,
    entryFileCoverage: ratio(entry.hits, entry.total),
    architectureCoverage: ratio(architecture.hits, architecture.total),
    graphCoverage: ratio(graph.hits, graph.total),
  };
}

export async function runRetrievalBenchmark(input: {
  repoPath: string;
  fixturePath: string;
  topK?: number;
}): Promise<RetrievalBenchmarkReport> {
  const repoPath = path.resolve(input.repoPath);
  const fixturePath = path.resolve(input.fixturePath);
  const topK = Math.max(1, input.topK ?? 5);
  const fixture = loadRetrievalBenchmarkFixture(fixturePath);
  const projectId = generateProjectId(repoPath);

  if (!hasIndexedData(projectId)) {
    throw new Error(`Project is not indexed: ${repoPath}`);
  }

  const searchService = new SearchService(projectId, repoPath);
  await searchService.init();

  const results: RetrievalBenchmarkCaseResult[] = [];

  for (const testCase of fixture.cases) {
    const { semanticQuery, lexicalQuery } = resolveRetrievalQueries(
      testCase.query,
      testCase.technicalTerms ?? [],
    );
    const contextPack = await searchService.buildContextPack(testCase.query, undefined, {
      technicalTerms: testCase.technicalTerms,
      semanticQuery,
      lexicalQuery,
      responseMode: 'expanded',
    });
    const actualTopFiles = contextPack.files.slice(0, topK).map((file) => file.filePath);
    const actualPrimaryFiles = (contextPack.architecturePrimaryFiles ?? []).slice(0, topK);
    const actualVisibleFiles = Array.from(new Set([...actualTopFiles, ...actualPrimaryFiles]));
    const matchedFiles = testCase.expectedFiles.filter((expected) => actualTopFiles.includes(expected));
    const missingExpectedFiles = testCase.expectedFiles.filter((expected) => !actualTopFiles.includes(expected));
    const primaryMatchedFiles = missingExpectedFiles.filter((expected) => actualPrimaryFiles.includes(expected));
    const visibleMatchedFiles = testCase.expectedFiles.filter((expected) => actualVisibleFiles.includes(expected));
    const expectedCoverage = testCase.expectedFiles.length > 0
      ? round(matchedFiles.length / testCase.expectedFiles.length)
      : 0;
    const primaryCoverage = missingExpectedFiles.length > 0
      ? round(primaryMatchedFiles.length / missingExpectedFiles.length)
      : 0;
    const dualTrackCoverage = testCase.expectedFiles.length > 0
      ? round(visibleMatchedFiles.length / testCase.expectedFiles.length)
      : 0;

    results.push({
      id: testCase.id,
      query: testCase.query,
      tags: testCase.tags ?? [],
      expectedFiles: testCase.expectedFiles,
      actualTopFiles,
      actualPrimaryFiles,
      actualVisibleFiles,
      matchedFiles,
      primaryMatchedFiles,
      visibleMatchedFiles,
      fileHit: matchedFiles.length > 0,
      expectedCoverage,
      primaryCoverage,
      dualTrackCoverage,
    });
  }

  return {
    fixture: {
      name: fixture.name,
      version: fixture.version,
      path: fixturePath,
    },
    repoPath,
    projectId,
    topK,
    summary: summarizeRetrievalBenchmark(results),
    results,
  };
}

export function formatRetrievalBenchmarkReport(report: RetrievalBenchmarkReport): string {
  const lines: string[] = [];
  lines.push(`Fixture: ${report.fixture.name}`);
  lines.push(`Repo: ${report.repoPath}`);
  lines.push(`Project ID: ${report.projectId.slice(0, 10)}`);
  lines.push(`Top K: ${report.topK}`);
  lines.push('');
  lines.push('Summary');
  lines.push(`- Cases: ${report.summary.caseCount}`);
  lines.push(`- File Hit@${report.topK}: ${(report.summary.fileHitAtK * 100).toFixed(1)}%`);
  lines.push(`- Expected File Coverage: ${(report.summary.expectedFileCoverage * 100).toFixed(1)}%`);
  lines.push(`- Primary File Coverage: ${(report.summary.primaryFileCoverage * 100).toFixed(1)}%`);
  lines.push(`- Dual-Track File Coverage: ${(report.summary.dualTrackFileCoverage * 100).toFixed(1)}%`);
  lines.push(`- Entry File Coverage: ${(report.summary.entryFileCoverage * 100).toFixed(1)}%`);
  lines.push(`- Architecture Coverage: ${(report.summary.architectureCoverage * 100).toFixed(1)}%`);
  lines.push(`- Graph Coverage: ${(report.summary.graphCoverage * 100).toFixed(1)}%`);
  lines.push('');
  lines.push('Cases');

  for (const result of report.results) {
    const status = result.fileHit ? 'hit' : 'miss';
    lines.push(`- [${status}] ${result.id}`);
    lines.push(`  query: ${result.query}`);
    lines.push(`  expected: ${result.expectedFiles.join(', ')}`);
    lines.push(`  expected_coverage: ${(result.expectedCoverage * 100).toFixed(1)}%`);
    lines.push(`  dual_track_coverage: ${(result.dualTrackCoverage * 100).toFixed(1)}%`);
    lines.push(`  actual_top_files: ${result.actualTopFiles.join(', ')}`);
    if (result.actualPrimaryFiles.length > 0) {
      lines.push(`  primary_coverage: ${(result.primaryCoverage * 100).toFixed(1)}%`);
      lines.push(`  actual_primary_files: ${result.actualPrimaryFiles.join(', ')}`);
      lines.push(`  actual_visible_files: ${result.actualVisibleFiles.join(', ')}`);
    }
  }

  return lines.join('\n');
}
