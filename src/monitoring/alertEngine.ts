import fs from 'node:fs';
import path from 'node:path';
import { resolveBaseDir } from '../runtimePaths.js';

const ALERT_CONFIG_FILE = 'alert-config.json';

export type AlertSeverity = 'info' | 'warning' | 'critical';
export type AlertStatus = 'active' | 'resolved' | 'acknowledged';

export interface AlertRule {
  id: string;
  name: string;
  metric: string;
  operator: '>' | '>=' | '<' | '<=' | '==';
  threshold: number;
  severity: AlertSeverity;
  message: string;
  enabled: boolean;
}

export interface AlertEvent {
  id: string;
  ruleId: string;
  ruleName: string;
  severity: AlertSeverity;
  status: AlertStatus;
  metric: string;
  value: number;
  threshold: number;
  message: string;
  triggeredAt: string;
  resolvedAt?: string;
}

export interface AlertConfig {
  rules: AlertRule[];
  notify: {
    log: boolean;
    console: boolean;
  };
}

export interface AlertEvaluationResult {
  triggered: AlertEvent[];
  resolved: AlertEvent[];
  active: AlertEvent[];
}

const DEFAULT_RULES: AlertRule[] = [
  {
    id: 'queue-backlog',
    name: '队列积压',
    metric: 'queue.queued',
    operator: '>',
    threshold: 5,
    severity: 'warning',
    message: '索引队列积压超过阈值',
    enabled: true,
  },
  {
    id: 'stale-queue',
    name: '排队任务超时',
    metric: 'queue.oldestAgeMinutes',
    operator: '>',
    threshold: 30,
    severity: 'critical',
    message: '最老排队任务等待超过 30 分钟',
    enabled: true,
  },
  {
    id: 'index-failure',
    name: '索引失败',
    metric: 'queue.failed',
    operator: '>',
    threshold: 0,
    severity: 'critical',
    message: '存在索引任务执行失败',
    enabled: true,
  },
  {
    id: 'no-seed-rate',
    name: '零种子率过高',
    metric: 'retrieval.noSeedRate',
    operator: '>',
    threshold: 0.2,
    severity: 'warning',
    message: '检索零种子比例超过 20%',
    enabled: true,
  },
  {
    id: 'budget-exhausted',
    name: '打包预算耗尽',
    metric: 'retrieval.budgetExhaustedRate',
    operator: '>',
    threshold: 0.3,
    severity: 'warning',
    message: '超过 30% 的检索请求在打包阶段耗尽预算',
    enabled: true,
  },
  {
    id: 'db-corrupted',
    name: '索引数据库损坏',
    metric: 'snapshot.corruptedCount',
    operator: '>',
    threshold: 0,
    severity: 'critical',
    message: '发现索引数据库损坏',
    enabled: true,
  },
  {
    id: 'daemon-down',
    name: '守护进程离线',
    metric: 'daemon.isRunning',
    operator: '==',
    threshold: 0,
    severity: 'warning',
    message: '索引守护进程未运行',
    enabled: true,
  },
];

export function defaultConfig(): AlertConfig {
  return {
    rules: DEFAULT_RULES,
    notify: {
      log: true,
      console: true,
    },
  };
}

function resolveConfigPath(baseDir?: string): string {
  return path.join(baseDir || resolveBaseDir(), ALERT_CONFIG_FILE);
}

export function loadAlertConfig(baseDir?: string): AlertConfig {
  const configPath = resolveConfigPath(baseDir);
  if (!fs.existsSync(configPath)) {
    return defaultConfig();
  }
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return {
      rules: raw.rules || DEFAULT_RULES,
      notify: {
        log: raw.notify?.log ?? true,
        console: raw.notify?.console ?? true,
      },
    };
  } catch {
    return defaultConfig();
  }
}

export function saveAlertConfig(config: AlertConfig, baseDir?: string): void {
  const configPath = resolveConfigPath(baseDir);
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

function compareOperator(value: number, operator: string, threshold: number): boolean {
  switch (operator) {
    case '>':
      return value > threshold;
    case '>=':
      return value >= threshold;
    case '<':
      return value < threshold;
    case '<=':
      return value <= threshold;
    case '==':
      return value === threshold;
    default:
      return false;
  }
}

function extractMetrics(healthReport: Record<string, unknown>): Record<string, number> {
  const metrics: Record<string, number> = {};

  const queue = healthReport.queue as Record<string, unknown> | undefined;
  if (queue) {
    metrics['queue.queued'] = Number(queue.queued ?? 0);
    metrics['queue.running'] = Number(queue.running ?? 0);
    metrics['queue.failed'] = Number(queue.failed ?? 0);
    metrics['queue.done'] = Number(queue.done ?? 0);
    if (queue.oldestQueuedAgeMs) {
      metrics['queue.oldestAgeMinutes'] = Number(queue.oldestQueuedAgeMs) / 60000;
    }
  }

  const daemon = healthReport.daemon as Record<string, unknown> | undefined;
  if (daemon) {
    metrics['daemon.isRunning'] = daemon.isRunning ? 1 : 0;
  }

  const snapshots = healthReport.snapshots as Array<Record<string, unknown>> | undefined;
  if (snapshots) {
    metrics['snapshot.total'] = snapshots.length;
    metrics['snapshot.corruptedCount'] = snapshots.filter(
      (s) => s.dbIntegrity === 'corrupted',
    ).length;
    metrics['snapshot.missingCount'] = snapshots.filter((s) => !s.hasCurrentSnapshot).length;
  }

  const retrieval = healthReport.retrieval as Record<string, unknown> | undefined;
  if (retrieval) {
    const rates = retrieval.rates as Record<string, unknown> | undefined;
    if (rates) {
      metrics['retrieval.noSeedRate'] = Number(rates.noSeedRate ?? 0);
      metrics['retrieval.budgetExhaustedRate'] = Number(rates.budgetExhaustedRate ?? 0);
      metrics['retrieval.noLexicalRate'] = Number(rates.noLexicalRate ?? 0);
      metrics['retrieval.noExpansionRate'] = Number(rates.noExpansionRate ?? 0);
    }
  }

  return metrics;
}

export function evaluateAlerts(
  healthReport: Record<string, unknown>,
  config?: AlertConfig,
): AlertEvaluationResult {
  const cfg = config || loadAlertConfig();
  const metrics = extractMetrics(healthReport);
  const triggered: AlertEvent[] = [];
  const resolved: AlertEvent[] = [];
  const active: AlertEvent[] = [];

  for (const rule of cfg.rules) {
    if (!rule.enabled) continue;

    const value = metrics[rule.metric] ?? 0;
    const isFiring = compareOperator(value, rule.operator, rule.threshold);

    const event: AlertEvent = {
      id: `${rule.id}-${Date.now()}`,
      ruleId: rule.id,
      ruleName: rule.name,
      severity: rule.severity,
      status: isFiring ? 'active' : 'resolved',
      metric: rule.metric,
      value,
      threshold: rule.threshold,
      message: rule.message,
      triggeredAt: new Date().toISOString(),
    };

    if (isFiring) {
      triggered.push(event);
    }
  }

  return { triggered, resolved, active: triggered };
}

export function formatAlertReport(result: AlertEvaluationResult): string {
  const lines: string[] = [];

  if (result.triggered.length === 0) {
    return 'No alerts triggered. All metrics within thresholds.';
  }

  lines.push('Alert Report');
  lines.push(`Triggered: ${result.triggered.length}`);
  lines.push('');

  for (const alert of result.triggered) {
    const icon = alert.severity === 'critical' ? '🔴' : alert.severity === 'warning' ? '🟡' : '🔵';
    lines.push(`${icon} [${alert.severity.toUpperCase()}] ${alert.ruleName}`);
    lines.push(`   Metric: ${alert.metric} = ${alert.value} (threshold: ${alert.threshold})`);
    lines.push(`   ${alert.message}`);
    lines.push('');
  }

  return lines.join('\n');
}
