import fs from 'node:fs';
import path from 'node:path';
import { resolveBaseDir } from '../runtimePaths.js';

type LexicalStrategy = 'chunks_fts' | 'files_fts' | 'none';

export interface RetrievalLogRecord {
  requestId?: string;
  projectId?: string;
  totalMs?: number;
  seedCount?: number;
  expandedCount?: number;
  totalChars?: number;
  timingMs?: Record<string, number>;
  retrievalStats?: {
    lexicalStrategy?: LexicalStrategy;
    vectorCount?: number;
    lexicalCount?: number;
    fusedCount?: number;
    topMCount?: number;
    rerankedCount?: number;
  };
  resultStats?: {
    seedCount?: number;
    expandedCount?: number;
    fileCount?: number;
    segmentCount?: number;
    totalChars?: number;
    budgetLimitChars?: number;
    budgetUsedChars?: number;
    budgetExhausted?: boolean;
    filesConsidered?: number;
    filesIncluded?: number;
  };
  rerankUsage?: {
    inputTokens?: number;
    billedSearchUnits?: number;
  };
}

export interface RetrievalStageStats {
  avg: number;
  p50: number;
  p95: number;
}

export interface RetrievalMonitorReport {
  filters: {
    filePath?: string;
    dirPath?: string;
    days?: number;
    projectId?: string;
    requestId?: string;
  };
  summary: {
    requestCount: number;
    stageStats: Record<string, RetrievalStageStats>;
    stageShares: Record<string, number>;
    lexicalStrategyBreakdown: Record<string, number>;
    averages: {
      totalMs: number;
      rerankInputTokens: number;
      totalChars: number;
      seedCount: number;
      expandedCount: number;
    };
    rates: {
      noSeedRate: number;
      budgetExhaustedRate: number;
      noLexicalRate: number;
      noExpansionRate: number;
    };
  };
  timeSeries: {
    daily: Array<{
      date: string;
      requestCount: number;
      avgTotalMs: number;
      noSeedRate: number;
      budgetExhaustedRate: number;
      avgRerankInputTokens: number;
    }>;
  };
  recommendations: Array<{
    id: string;
    severity: 'low' | 'medium' | 'high';
    title: string;
    reason: string;
    evidence: Record<string, number | string>;
  }>;
}

const COMPLETION_LOG_MESSAGE = 'MCP codebase-retrieval 完成';
const DEFAULT_LOG_DIR = path.join(resolveBaseDir(), 'logs');

export interface AnalyzeRetrievalDirectoryOptions {
  dirPath: string;
  days?: number;
  projectId?: string;
  requestId?: string;
}

function safeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[idx];
}

function rate(
  values: RetrievalLogRecord[],
  predicate: (record: RetrievalLogRecord) => boolean,
): number {
  if (values.length === 0) return 0;
  return values.filter(predicate).length / values.length;
}

function stageMetrics(records: RetrievalLogRecord[], stage: string): RetrievalStageStats {
  const values = records.map((record) => safeNumber(record.timingMs?.[stage]));
  return {
    avg: round(average(values), 2),
    p50: round(percentile(values, 0.5), 2),
    p95: round(percentile(values, 0.95), 2),
  };
}

function buildRecommendations(
  report: RetrievalMonitorReport,
): RetrievalMonitorReport['recommendations'] {
  const recs: RetrievalMonitorReport['recommendations'] = [];
  const { stageShares, lexicalStrategyBreakdown, averages, rates, requestCount } = report.summary;
  const filesFtsRate =
    requestCount > 0 ? (lexicalStrategyBreakdown.files_fts || 0) / requestCount : 0;
  const noneLexicalRate =
    requestCount > 0 ? (lexicalStrategyBreakdown.none || 0) / requestCount : 0;

  if (stageShares.init >= 0.25) {
    recs.push({
      id: 'reduce-init-overhead',
      severity: 'medium',
      title: '降低查询冷启动开销',
      reason: '初始化阶段占比偏高，说明查询时较多时间花在连接/依赖初始化而非真正检索。',
      evidence: {
        initShare: round(stageShares.init, 3),
        avgInitMs: report.summary.stageStats.init.avg,
        avgTotalMs: averages.totalMs,
      },
    });
  }

  if (filesFtsRate >= 0.3 || noneLexicalRate >= 0.3) {
    recs.push({
      id: 'promote-chunks-fts',
      severity: 'high',
      title: '提高 chunk 级 FTS 覆盖率',
      reason: '词法分支经常走 files_fts 降级路径或完全未参与，混合检索的实际收益可能没有发挥出来。',
      evidence: {
        filesFtsRate: round(filesFtsRate, 3),
        noLexicalRate: round(noneLexicalRate, 3),
      },
    });
  }

  if (stageShares.rerank >= 0.25 && averages.rerankInputTokens >= 1500) {
    recs.push({
      id: 'trim-rerank-cost',
      severity: 'high',
      title: '收缩 rerank 成本',
      reason: '精排阶段耗时和输入 token 都偏高，说明 rerank 是当前链路的重要成本中心。',
      evidence: {
        rerankShare: round(stageShares.rerank, 3),
        avgRerankMs: report.summary.stageStats.rerank.avg,
        avgRerankInputTokens: averages.rerankInputTokens,
      },
    });
  }

  if (rates.budgetExhaustedRate >= 0.2) {
    recs.push({
      id: 'reduce-pack-budget-pressure',
      severity: 'medium',
      title: '缓解打包预算压力',
      reason: '有较多请求在打包阶段耗尽预算，说明前面的召回/扩展结果过大，最终无法完整进入上下文。',
      evidence: {
        budgetExhaustedRate: round(rates.budgetExhaustedRate, 3),
        avgTotalChars: averages.totalChars,
      },
    });
  }

  if (rates.noSeedRate >= 0.2) {
    recs.push({
      id: 'inspect-zero-seed-queries',
      severity: 'high',
      title: '排查零种子查询',
      reason: '存在较高比例的查询没有产出 seeds，说明当前召回或 rerank 质量不足以支撑稳定命中。',
      evidence: {
        noSeedRate: round(rates.noSeedRate, 3),
      },
    });
  }

  if (rates.noExpansionRate >= 0.6 && stageShares.expand >= 0.15) {
    recs.push({
      id: 'tighten-expand-trigger',
      severity: 'low',
      title: '收紧扩展触发条件',
      reason: '扩展阶段耗时不低，但大多数请求并没有带来有效扩展结果，可能存在无效扩展。',
      evidence: {
        expandShare: round(stageShares.expand, 3),
        noExpansionRate: round(rates.noExpansionRate, 3),
      },
    });
  }

  const daily = report.timeSeries.daily;
  if (daily.length >= 2) {
    const first = daily[0];
    const last = daily[daily.length - 1];
    if (first.avgTotalMs > 0 && last.avgTotalMs >= first.avgTotalMs * 1.2) {
      recs.push({
        id: 'latency-regression-trend',
        severity: 'high',
        title: '存在时序上的延迟回归',
        reason: '最近一天的平均总耗时相比窗口起点明显上升，说明检索链路可能出现性能退化。',
        evidence: {
          firstDate: first.date,
          firstAvgTotalMs: first.avgTotalMs,
          lastDate: last.date,
          lastAvgTotalMs: last.avgTotalMs,
        },
      });
    }

    if (last.noSeedRate >= first.noSeedRate + 0.15) {
      recs.push({
        id: 'quality-regression-trend',
        severity: 'high',
        title: '存在时序上的命中质量回归',
        reason: '最近一天的零种子比例高于窗口起点，说明检索命中质量可能在下降。',
        evidence: {
          firstDate: first.date,
          firstNoSeedRate: first.noSeedRate,
          lastDate: last.date,
          lastNoSeedRate: last.noSeedRate,
        },
      });
    }
  }

  return recs;
}

function extractDateFromLogFileName(filePath: string): string | null {
  const match = path.basename(filePath).match(/^app\.(\d{4}-\d{2}-\d{2})\.log$/);
  return match?.[1] || null;
}

function parseRetrievalLogFileWithMeta(
  filePath: string,
): Array<RetrievalLogRecord & { _date?: string }> {
  const date = extractDateFromLogFileName(filePath) || undefined;
  return parseRetrievalLogText(fs.readFileSync(filePath, 'utf8')).map((record) => ({
    ...record,
    _date: date,
  }));
}

function buildDailySeries(
  records: Array<RetrievalLogRecord & { _date?: string }>,
): RetrievalMonitorReport['timeSeries']['daily'] {
  const groups = new Map<string, RetrievalLogRecord[]>();
  for (const record of records) {
    const date = record._date;
    if (!date) continue;
    const bucket = groups.get(date) || [];
    bucket.push(record);
    groups.set(date, bucket);
  }

  return Array.from(groups.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, dayRecords]) => ({
      date,
      requestCount: dayRecords.length,
      avgTotalMs: round(average(dayRecords.map((record) => safeNumber(record.totalMs))), 2),
      noSeedRate: round(
        rate(dayRecords, (record) => safeNumber(record.seedCount) === 0),
        3,
      ),
      budgetExhaustedRate: round(
        rate(dayRecords, (record) => record.resultStats?.budgetExhausted === true),
        3,
      ),
      avgRerankInputTokens: round(
        average(dayRecords.map((record) => safeNumber(record.rerankUsage?.inputTokens))),
        2,
      ),
    }));
}

export function parseRetrievalLogText(text: string): RetrievalLogRecord[] {
  return text
    .split('\n')
    .filter((line) => line.includes(COMPLETION_LOG_MESSAGE))
    .map((line) => {
      const jsonStart = line.indexOf('{');
      if (jsonStart < 0) return null;
      try {
        return JSON.parse(line.slice(jsonStart)) as RetrievalLogRecord;
      } catch {
        return null;
      }
    })
    .filter((record): record is RetrievalLogRecord => record !== null);
}

export function analyzeRetrievalLogRecords(records: RetrievalLogRecord[]): RetrievalMonitorReport {
  const stageNames = [
    'init',
    'retrieve',
    'retrieveVector',
    'retrieveLexical',
    'retrieveFuse',
    'rerank',
    'smartCutoff',
    'expand',
    'pack',
  ];
  const totalMsSum = records.reduce((sum, record) => sum + safeNumber(record.totalMs), 0);
  const stageTotals = Object.fromEntries(
    stageNames.map((stage) => [
      stage,
      records.reduce((sum, record) => sum + safeNumber(record.timingMs?.[stage]), 0),
    ]),
  );
  const lexicalStrategyBreakdown = records.reduce<Record<string, number>>((acc, record) => {
    const key = record.retrievalStats?.lexicalStrategy || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  const report: RetrievalMonitorReport = {
    filters: {},
    summary: {
      requestCount: records.length,
      stageStats: Object.fromEntries(
        stageNames.map((stage) => [stage, stageMetrics(records, stage)]),
      ),
      stageShares: Object.fromEntries(
        stageNames.map((stage) => [
          stage,
          totalMsSum > 0 ? round(stageTotals[stage] / totalMsSum, 3) : 0,
        ]),
      ),
      lexicalStrategyBreakdown,
      averages: {
        totalMs: round(average(records.map((record) => safeNumber(record.totalMs))), 2),
        rerankInputTokens: round(
          average(records.map((record) => safeNumber(record.rerankUsage?.inputTokens))),
          2,
        ),
        totalChars: round(
          average(
            records.map((record) =>
              safeNumber(record.resultStats?.totalChars ?? record.totalChars),
            ),
          ),
          2,
        ),
        seedCount: round(average(records.map((record) => safeNumber(record.seedCount))), 2),
        expandedCount: round(average(records.map((record) => safeNumber(record.expandedCount))), 2),
      },
      rates: {
        noSeedRate: round(
          rate(records, (record) => safeNumber(record.seedCount) === 0),
          3,
        ),
        budgetExhaustedRate: round(
          rate(records, (record) => record.resultStats?.budgetExhausted === true),
          3,
        ),
        noLexicalRate: round(
          rate(records, (record) => safeNumber(record.retrievalStats?.lexicalCount) === 0),
          3,
        ),
        noExpansionRate: round(
          rate(records, (record) => safeNumber(record.expandedCount) === 0),
          3,
        ),
      },
    },
    timeSeries: {
      daily: [],
    },
    recommendations: [],
  };

  report.recommendations = buildRecommendations(report);
  return report;
}

export function analyzeRetrievalLogText(text: string): RetrievalMonitorReport {
  return analyzeRetrievalLogRecords(parseRetrievalLogText(text));
}

export function analyzeRetrievalLogFile(filePath: string): RetrievalMonitorReport {
  const text = fs.readFileSync(filePath, 'utf8');
  const report = analyzeRetrievalLogText(text);
  report.filters.filePath = filePath;
  return report;
}

export function analyzeRetrievalLogDirectory({
  dirPath,
  days,
  projectId,
  requestId,
}: AnalyzeRetrievalDirectoryOptions): RetrievalMonitorReport {
  if (!fs.existsSync(dirPath)) {
    throw new Error(`日志目录不存在: ${dirPath}`);
  }

  let files = fs
    .readdirSync(dirPath)
    .filter((name) => /^app\.\d{4}-\d{2}-\d{2}\.log$/.test(name))
    .sort()
    .map((name) => path.join(dirPath, name));

  if (days && days > 0) {
    files = files.slice(-days);
  }

  const records = files.flatMap((filePath) => parseRetrievalLogFileWithMeta(filePath));
  const filtered = records.filter((record) => {
    if (projectId && !(record.projectId || '').startsWith(projectId)) {
      return false;
    }
    if (requestId && record.requestId !== requestId) {
      return false;
    }
    return true;
  });

  const report = analyzeRetrievalLogRecords(filtered);
  report.filters = {
    dirPath,
    days,
    projectId,
    requestId,
  };
  report.timeSeries.daily = buildDailySeries(filtered);
  report.recommendations = buildRecommendations(report);
  return report;
}

export function resolveDefaultRetrievalLogFile(baseDir = DEFAULT_LOG_DIR): string {
  if (!fs.existsSync(baseDir)) {
    throw new Error(`日志目录不存在: ${baseDir}`);
  }

  const files = fs
    .readdirSync(baseDir)
    .filter((name) => /^app\.\d{4}-\d{2}-\d{2}\.log$/.test(name))
    .sort();

  if (files.length === 0) {
    throw new Error(`日志目录中未找到检索日志: ${baseDir}`);
  }

  return path.join(baseDir, files[files.length - 1]);
}

export function formatRetrievalMonitorReport(report: RetrievalMonitorReport): string {
  const lines: string[] = [];
  lines.push('Retrieval Monitor Report');
  lines.push(`Requests: ${report.summary.requestCount}`);
  if (report.filters.projectId) {
    lines.push(`Project Filter: ${report.filters.projectId}`);
  }
  if (report.filters.days) {
    lines.push(`Window: last ${report.filters.days} day(s)`);
  }
  lines.push(`Avg Total: ${report.summary.averages.totalMs}ms`);
  lines.push(`Avg Rerank Tokens: ${report.summary.averages.rerankInputTokens}`);
  lines.push(`No Seed Rate: ${Math.round(report.summary.rates.noSeedRate * 100)}%`);
  lines.push(
    `Budget Exhausted Rate: ${Math.round(report.summary.rates.budgetExhaustedRate * 100)}%`,
  );
  lines.push('');
  lines.push('Stage Shares:');
  for (const [stage, share] of Object.entries(report.summary.stageShares)) {
    lines.push(`- ${stage}: ${Math.round(share * 100)}%`);
  }
  lines.push('');
  if (report.timeSeries.daily.length > 0) {
    lines.push('Daily Trend:');
    for (const item of report.timeSeries.daily) {
      lines.push(
        `- ${item.date}: requests=${item.requestCount}, avgTotal=${item.avgTotalMs}ms, noSeed=${Math.round(item.noSeedRate * 100)}%`,
      );
    }
    lines.push('');
  }
  lines.push('Recommendations:');
  if (report.recommendations.length === 0) {
    lines.push('- 当前没有明显的性能异常。');
  } else {
    for (const recommendation of report.recommendations) {
      lines.push(
        `- [${recommendation.severity}] ${recommendation.title}: ${recommendation.reason}`,
      );
    }
  }
  return lines.join('\n');
}
