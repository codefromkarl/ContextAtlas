/**
 * MemoryHealth — 记忆健康分析模块
 *
 * 提供长期记忆新鲜度分析、功能记忆一致性检查、孤立记忆检测和项目记忆质量评分。
 */

import fs from 'node:fs';
import path from 'node:path';
import { MemoryHubDatabase } from '../memory/MemoryHubDatabase.js';
import { MemoryStore } from '../memory/MemoryStore.js';
import type {
  FeatureMemory,
  LongTermMemoryType,
  LongTermMemoryScope,
  ResolvedLongTermMemoryItem,
} from '../memory/types.js';
import { resolveBaseDir } from '../runtimePaths.js';
import { logger } from '../utils/logger.js';

// ===========================================
// Types
// ===========================================

export interface LongTermMemoryFreshness {
  total: number;
  active: number;
  stale: number;
  expired: number;
  activeRate: number;
  staleRate: number;
  expiredRate: number;
  byType: Record<LongTermMemoryType, { total: number; active: number; stale: number; expired: number }>;
  byScope: Record<LongTermMemoryScope, { total: number; active: number; stale: number; expired: number }>;
}

export interface FeatureMemoryHealth {
  total: number;
  withValidPaths: number;
  withOrphanedPaths: number;
  orphanedRate: number;
  avgKeyPatterns: number;
  avgExports: number;
  emptyResponsibilityCount: number;
}

export interface CatalogConsistency {
  isConsistent: boolean;
  missingFromCatalog: string[];
  staleInCatalog: string[];
  totalFeatures: number;
  totalCatalogEntries: number;
}

export interface ProjectMemoryScore {
  projectId: string;
  projectName: string;
  featureCount: number;
  longTermCount: number;
  freshnessScore: number; // 0-100, higher is better
  catalogConsistent: boolean;
  issues: string[];
}

export interface MemoryHealthReport {
  longTermFreshness: LongTermMemoryFreshness;
  featureMemoryHealth: FeatureMemoryHealth;
  catalogConsistency: CatalogConsistency;
  projectScores: ProjectMemoryScore[];
  overall: {
    status: 'healthy' | 'degraded' | 'unhealthy';
    issues: string[];
    recommendations: string[];
  };
}

// ===========================================
// Helpers
// ===========================================

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// ===========================================
// Analysis functions
// ===========================================

function analyzeLongTermFreshness(
  items: ResolvedLongTermMemoryItem[],
): LongTermMemoryFreshness {
  const total = items.length;
  let active = 0;
  let stale = 0;
  let expired = 0;

  const byType: Record<string, { total: number; active: number; stale: number; expired: number; superseded: number }> = {};
  const byScope: Record<string, { total: number; active: number; stale: number; expired: number; superseded: number }> = {};

  for (const item of items) {
    if (item.status === 'active') active++;
    else if (item.status === 'stale') stale++;
    else if (item.status === 'expired') expired++;

    const typeBucket = byType[item.type] || { total: 0, active: 0, stale: 0, expired: 0, superseded: 0 };
    typeBucket.total++;
    typeBucket[item.status]++;
    byType[item.type] = typeBucket;

    const scopeBucket = byScope[item.scope] || { total: 0, active: 0, stale: 0, expired: 0, superseded: 0 };
    scopeBucket.total++;
    scopeBucket[item.status]++;
    byScope[item.scope] = scopeBucket;
  }

  return {
    total,
    active,
    stale,
    expired,
    activeRate: total > 0 ? round(active / total) : 0,
    staleRate: total > 0 ? round(stale / total) : 0,
    expiredRate: total > 0 ? round(expired / total) : 0,
    byType: byType as LongTermMemoryFreshness['byType'],
    byScope: byScope as LongTermMemoryFreshness['byScope'],
  };
}

function analyzeFeatureMemoryHealth(
  features: FeatureMemory[],
  projectRoot?: string,
): FeatureMemoryHealth {
  let withValidPaths = 0;
  let withOrphanedPaths = 0;
  let totalKeyPatterns = 0;
  let totalExports = 0;
  let emptyResponsibilityCount = 0;

  for (const feature of features) {
    // Check path validity
    const hasOrphan = projectRoot
      ? feature.location.files.some((file) => {
          const fullPath = path.join(projectRoot, feature.location.dir, file);
          return !fs.existsSync(fullPath);
        })
      : false;

    if (hasOrphan) {
      withOrphanedPaths++;
    } else {
      withValidPaths++;
    }

    totalKeyPatterns += feature.keyPatterns.length;
    totalExports += feature.api.exports.length;

    if (!feature.responsibility || feature.responsibility.trim().length === 0) {
      emptyResponsibilityCount++;
    }
  }

  const total = features.length;

  return {
    total,
    withValidPaths,
    withOrphanedPaths,
    orphanedRate: total > 0 ? round(withOrphanedPaths / total) : 0,
    avgKeyPatterns: total > 0 ? round(totalKeyPatterns / total, 1) : 0,
    avgExports: total > 0 ? round(totalExports / total, 1) : 0,
    emptyResponsibilityCount,
  };
}

function analyzeCatalogConsistency(
  features: FeatureMemory[],
  catalogModules: Record<string, unknown>,
): CatalogConsistency {
  const featureNames = new Set(
    features.map((f) => f.name.toLowerCase().trim().replace(/\s+/g, '-')),
  );
  const catalogNames = new Set(Object.keys(catalogModules));

  const missingFromCatalog = [...featureNames].filter((name) => !catalogNames.has(name));
  const staleInCatalog = [...catalogNames].filter((name) => !featureNames.has(name));

  return {
    isConsistent: missingFromCatalog.length === 0 && staleInCatalog.length === 0,
    missingFromCatalog,
    staleInCatalog,
    totalFeatures: featureNames.size,
    totalCatalogEntries: catalogNames.size,
  };
}

function calculateProjectScore(
  featureHealth: FeatureMemoryHealth,
  freshness: LongTermMemoryFreshness,
  catalogConsistency: CatalogConsistency,
): { score: number; issues: string[] } {
  let score = 100;
  const issues: string[] = [];

  // Deduct for stale long-term memories
  if (freshness.staleRate > 0.3) {
    score -= 20;
    issues.push(`长期记忆 stale 比例过高: ${Math.round(freshness.staleRate * 100)}%`);
  }

  // Deduct for expired memories
  if (freshness.expiredRate > 0.1) {
    score -= 15;
    issues.push(`长期记忆过期比例: ${Math.round(freshness.expiredRate * 100)}%`);
  }

  // Deduct for orphaned feature paths
  if (featureHealth.orphanedRate > 0.2) {
    score -= 15;
    issues.push(`功能记忆孤立路径比例: ${Math.round(featureHealth.orphanedRate * 100)}%`);
  }

  // Deduct for catalog inconsistency
  if (!catalogConsistency.isConsistent) {
    score -= 10;
    if (catalogConsistency.missingFromCatalog.length > 0) {
      issues.push(`catalog 缺失 ${catalogConsistency.missingFromCatalog.length} 个模块`);
    }
    if (catalogConsistency.staleInCatalog.length > 0) {
      issues.push(`catalog 存在 ${catalogConsistency.staleInCatalog.length} 个陈旧条目`);
    }
  }

  // Deduct for empty responsibilities
  if (featureHealth.emptyResponsibilityCount > 0) {
    score -= 5;
    issues.push(`${featureHealth.emptyResponsibilityCount} 个功能记忆缺少职责描述`);
  }

  return { score: Math.max(0, score), issues };
}

function buildOverallAssessment(report: MemoryHealthReport): void {
  const issues: string[] = [];
  const recommendations: string[] = [];

  // Long-term memory freshness issues
  if (report.longTermFreshness.expired > 0) {
    issues.push(`${report.longTermFreshness.expired} 条长期记忆已过期`);
    recommendations.push('清理过期记忆: contextatlas memory:prune-long-term --apply');
  }

  if (report.longTermFreshness.staleRate > 0.3) {
    issues.push(`${Math.round(report.longTermFreshness.staleRate * 100)}% 的长期记忆陈旧`);
    recommendations.push('核验或清理陈旧记忆: contextatlas memory:prune-long-term --include-stale --apply');
  }

  // Feature memory issues
  if (report.featureMemoryHealth.orphanedRate > 0.1) {
    issues.push(
      `${Math.round(report.featureMemoryHealth.orphanedRate * 100)}% 的功能记忆引用了不存在的文件`,
    );
    recommendations.push('重建记忆以修复路径引用: contextatlas memory:rebuild-catalog');
  }

  // Catalog issues
  if (!report.catalogConsistency.isConsistent) {
    issues.push('功能记忆与 catalog 不一致');
    recommendations.push('重建 catalog: contextatlas memory:rebuild-catalog');
  }

  // Project-level issues
  const unhealthyProjects = report.projectScores.filter((p) => p.freshnessScore < 60);
  if (unhealthyProjects.length > 0) {
    issues.push(`${unhealthyProjects.length} 个项目记忆质量评分低于 60`);
    for (const project of unhealthyProjects) {
      recommendations.push(`项目 ${project.projectName}: ${project.issues[0] || '需要维护'}`);
    }
  }

  const status: 'healthy' | 'degraded' | 'unhealthy' =
    issues.length === 0
      ? 'healthy'
      : issues.some((i) => i.includes('过期') || i.includes('不存在'))
        ? 'unhealthy'
        : 'degraded';

  report.overall = { status, issues, recommendations };
}

// ===========================================
// Main analysis
// ===========================================

export async function analyzeMemoryHealth(
  options: { projectRoots?: string[]; staleDays?: number } = {},
): Promise<MemoryHealthReport> {
  const hub = new MemoryHubDatabase();
  try {
    const allowedProjectRoots = options.projectRoots?.length
      ? new Set(options.projectRoots.map((projectRoot) => path.resolve(projectRoot)))
      : null;
    // 1. Long-term memory freshness (across all projects)
    let allLongTermItems: ResolvedLongTermMemoryItem[] = [];
    const projects = hub.listProjects().filter((project) => {
      if (!allowedProjectRoots) {
        return true;
      }
      return allowedProjectRoots.has(path.resolve(project.path));
    });

    for (const project of projects) {
      try {
        const store = new MemoryStore(project.path);
        const items = await store.listLongTermMemories({
          includeExpired: true,
          staleDays: options.staleDays,
        });
        allLongTermItems.push(...items);
      } catch {
        // skip projects that cannot be loaded
      }
    }

    const longTermFreshness = analyzeLongTermFreshness(allLongTermItems);

    // 2. Feature memory health + catalog consistency per project
    const projectScores: ProjectMemoryScore[] = [];
    const aggregatedMissingFromCatalog: string[] = [];
    const aggregatedStaleInCatalog: string[] = [];
    let aggregatedCatalogEntryCount = 0;
    let aggregatedFeatureCount = 0;
    let aggregatedValidPaths = 0;
    let aggregatedOrphanedPaths = 0;
    let aggregatedKeyPatterns = 0;
    let aggregatedExports = 0;
    let aggregatedEmptyResponsibilityCount = 0;

    for (const project of projects) {
      try {
        const store = new MemoryStore(project.path);
        await store.initializeReadOnly();
        const features = await store.listFeatures();

        const catalog = await store.readCatalog();

        // Per-project analysis
        const projectFeatures = features;
        const projectLongTerm = await store.listLongTermMemories({
          scope: 'project',
          includeExpired: true,
          staleDays: options.staleDays,
        });

        const featureHealth = analyzeFeatureMemoryHealth(
          projectFeatures,
          project.path.startsWith('contextatlas://') ? undefined : project.path,
        );
        aggregatedValidPaths += featureHealth.withValidPaths;
        aggregatedOrphanedPaths += featureHealth.withOrphanedPaths;
        aggregatedKeyPatterns += featureHealth.avgKeyPatterns * featureHealth.total;
        aggregatedExports += featureHealth.avgExports * featureHealth.total;
        aggregatedEmptyResponsibilityCount += featureHealth.emptyResponsibilityCount;

        const freshness = analyzeLongTermFreshness(projectLongTerm);
        const consistency = analyzeCatalogConsistency(
          projectFeatures,
          catalog?.modules || {},
        );
        aggregatedFeatureCount += consistency.totalFeatures;
        aggregatedCatalogEntryCount += consistency.totalCatalogEntries;
        aggregatedMissingFromCatalog.push(
          ...consistency.missingFromCatalog.map((name) => `${project.id}:${name}`),
        );
        aggregatedStaleInCatalog.push(
          ...consistency.staleInCatalog.map((name) => `${project.id}:${name}`),
        );

        const { score, issues } = calculateProjectScore(featureHealth, freshness, consistency);

        projectScores.push({
          projectId: project.id,
          projectName: project.name,
          featureCount: features.length,
          longTermCount: projectLongTerm.length,
          freshnessScore: score,
          catalogConsistent: consistency.isConsistent,
          issues,
        });
      } catch {
        // skip projects that cannot be analyzed
      }
    }

    // 3. Global feature memory health
    const featureMemoryHealth: FeatureMemoryHealth = {
      total: aggregatedFeatureCount,
      withValidPaths: aggregatedValidPaths,
      withOrphanedPaths: aggregatedOrphanedPaths,
      orphanedRate:
        aggregatedFeatureCount > 0 ? round(aggregatedOrphanedPaths / aggregatedFeatureCount) : 0,
      avgKeyPatterns:
        aggregatedFeatureCount > 0 ? round(aggregatedKeyPatterns / aggregatedFeatureCount) : 0,
      avgExports:
        aggregatedFeatureCount > 0 ? round(aggregatedExports / aggregatedFeatureCount) : 0,
      emptyResponsibilityCount: aggregatedEmptyResponsibilityCount,
    };

    // 4. Catalog consistency (aggregated)
    const catalogConsistency: CatalogConsistency = {
      isConsistent: projectScores.every((p) => p.catalogConsistent),
      missingFromCatalog: aggregatedMissingFromCatalog,
      staleInCatalog: aggregatedStaleInCatalog,
      totalFeatures: aggregatedFeatureCount,
      totalCatalogEntries: aggregatedCatalogEntryCount,
    };

    const report: MemoryHealthReport = {
      longTermFreshness,
      featureMemoryHealth,
      catalogConsistency,
      projectScores,
      overall: { status: 'healthy', issues: [], recommendations: [] },
    };

    buildOverallAssessment(report);
    return report;
  } finally {
    hub.close();
  }
}

// ===========================================
// Formatting
// ===========================================

export function formatMemoryHealthReport(report: MemoryHealthReport): string {
  const lines: string[] = [];

  lines.push('Memory Health Report');
  lines.push(`Status: ${report.overall.status.toUpperCase()}`);
  lines.push('');

  // Long-term memory freshness
  lines.push('Long-term Memory Freshness:');
  const lt = report.longTermFreshness;
  lines.push(`  Total: ${lt.total} | Active: ${lt.active} | Stale: ${lt.stale} | Expired: ${lt.expired}`);
  lines.push(`  Active Rate: ${Math.round(lt.activeRate * 100)}% | Stale Rate: ${Math.round(lt.staleRate * 100)}% | Expired Rate: ${Math.round(lt.expiredRate * 100)}%`);

  if (Object.keys(lt.byType).length > 0) {
    lines.push('  By Type:');
    for (const [type, stats] of Object.entries(lt.byType)) {
      lines.push(`    ${type}: ${stats.total} total (${stats.active} active, ${stats.stale} stale, ${stats.expired} expired)`);
    }
  }
  lines.push('');

  // Feature memory health
  lines.push('Feature Memory Health:');
  const fm = report.featureMemoryHealth;
  lines.push(`  Total: ${fm.total} | Valid Paths: ${fm.withValidPaths} | Orphaned: ${fm.withOrphanedPaths}`);
  lines.push(`  Orphaned Rate: ${Math.round(fm.orphanedRate * 100)}%`);
  lines.push(`  Avg Key Patterns: ${fm.avgKeyPatterns} | Avg Exports: ${fm.avgExports}`);
  if (fm.emptyResponsibilityCount > 0) {
    lines.push(`  Missing Responsibility: ${fm.emptyResponsibilityCount}`);
  }
  lines.push('');

  // Catalog consistency
  lines.push('Catalog Consistency:');
  const cc = report.catalogConsistency;
  lines.push(`  Consistent: ${cc.isConsistent ? 'Yes' : 'No'}`);
  lines.push(`  Features: ${cc.totalFeatures} | Catalog Entries: ${cc.totalCatalogEntries}`);
  if (cc.missingFromCatalog.length > 0) {
    lines.push(`  Missing from Catalog: ${cc.missingFromCatalog.join(', ')}`);
  }
  if (cc.staleInCatalog.length > 0) {
    lines.push(`  Stale in Catalog: ${cc.staleInCatalog.join(', ')}`);
  }
  lines.push('');

  // Project scores
  if (report.projectScores.length > 0) {
    lines.push('Project Scores:');
    for (const ps of report.projectScores) {
      const icon = ps.freshnessScore >= 80 ? '🟢' : ps.freshnessScore >= 60 ? '🟡' : '🔴';
      lines.push(`  ${icon} ${ps.projectName} (${ps.projectId}): ${ps.freshnessScore}/100`);
      lines.push(`     Features: ${ps.featureCount} | Long-term: ${ps.longTermCount} | Catalog: ${ps.catalogConsistent ? 'OK' : 'Inconsistent'}`);
      if (ps.issues.length > 0) {
        for (const issue of ps.issues) {
          lines.push(`     - ${issue}`);
        }
      }
    }
    lines.push('');
  }

  // Issues and recommendations
  if (report.overall.issues.length > 0) {
    lines.push('Issues:');
    for (const issue of report.overall.issues) {
      lines.push(`  - ${issue}`);
    }
    lines.push('');
  }

  if (report.overall.recommendations.length > 0) {
    lines.push('Recommendations:');
    for (const rec of report.overall.recommendations) {
      lines.push(`  - ${rec}`);
    }
  } else {
    lines.push('No issues detected. Memory system is healthy.');
  }

  return lines.join('\n');
}
