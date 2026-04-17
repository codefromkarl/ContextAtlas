import path from 'node:path';
import { exitWithError, writeJson, writeText } from '../helpers.js';
import type { CommandRegistrar } from '../types.js';

export function registerOpsWorkbenchCommands(cli: CommandRegistrar): void {
  cli
    .command('ops:summary', '团队级运维摘要（索引 + 记忆 + 告警 + 使用优化）')
    .option('--days <days>', 'usage 统计窗口天数', { default: '7' })
    .option('--stale-days <days>', '记忆 stale 阈值天数', { default: '30' })
    .option('--json', '以 JSON 输出摘要')
    .action(async (options: { days?: string; staleDays?: string; json?: boolean }) => {
      const { analyzeIndexHealth } = await import('../../monitoring/indexHealth.js');
      const { analyzeMemoryHealth } = await import('../../monitoring/memoryHealth.js');
      const { analyzeMcpProcessHealth } = await import('../../monitoring/mcpProcessHealth.js');
      const { evaluateAlerts } = await import('../../monitoring/alertEngine.js');
      const { analyzeIndexOptimization } = await import('../../usage/usageAnalysis.js');
      const { buildAlertEvaluationMetrics } = await import('../../monitoring/healthFull.js');
      const { formatOpsSummaryReport, summarizeOpsSnapshot } = await import(
        '../../monitoring/opsSummary.js'
      );

      try {
        const days = Number.parseInt(String(options.days ?? '7'), 10);
        const staleDays = Number.parseInt(String(options.staleDays ?? '30'), 10);

        const [indexHealth, memoryHealth, mcpProcessHealth] = await Promise.all([
          analyzeIndexHealth(),
          analyzeMemoryHealth({
            staleDays: Number.isFinite(staleDays) && staleDays > 0 ? staleDays : 30,
          }),
          Promise.resolve(analyzeMcpProcessHealth()),
        ]);

        const usageReport = analyzeIndexOptimization({
          days: Number.isFinite(days) && days > 0 ? days : 7,
        });

        const alertResult = evaluateAlerts(
          buildAlertEvaluationMetrics({ indexHealth, memoryHealth, mcpProcessHealth }),
        );

        const summary = summarizeOpsSnapshot({
          indexHealth,
          memoryHealth,
          mcpProcessHealth,
          usageReport,
          alertResult,
        });

        if (options.json) {
          writeJson(summary);
          return;
        }

        writeText(formatOpsSummaryReport(summary));
      } catch (err) {
        const error = err as Error;
        exitWithError('生成运维摘要失败', { error: error.message });
      }
    });

  cli
    .command('ops:metrics', '汇总团队级稳定指标与仓库质量分布')
    .option('--days <days>', '统计窗口天数', { default: '7' })
    .option('--stale-days <days>', '记忆 stale 阈值天数', { default: '30' })
    .option('--log-dir <path>', 'retrieval 日志目录')
    .option('--json', '以 JSON 输出结果')
    .action(
      async (options: { days?: string; staleDays?: string; logDir?: string; json?: boolean }) => {
        const { analyzeOpsMetrics, formatOpsMetricsReport } = await import(
          '../../monitoring/opsMetrics.js'
        );

        try {
          const days = Number.parseInt(String(options.days ?? '7'), 10);
          const staleDays = Number.parseInt(String(options.staleDays ?? '30'), 10);
          const report = await analyzeOpsMetrics({
            days: Number.isFinite(days) && days > 0 ? days : 7,
            staleDays: Number.isFinite(staleDays) && staleDays > 0 ? staleDays : 30,
            logDir: options.logDir ? path.resolve(options.logDir) : undefined,
          });

          if (options.json) {
            writeJson(report);
            return;
          }

          writeText(formatOpsMetricsReport(report));
        } catch (err) {
          const error = err as Error;
          exitWithError('生成团队级稳定指标失败', { error: error.message });
        }
      },
    );

  cli
    .command('ops:apply <actionId>', '执行 ops:summary 中的低风险修复动作')
    .option('--project-id <id>', '为 project-scoped 动作显式指定 projectId')
    .option('--repo <path>', '为 repo-scoped 动作指定仓库路径（默认当前目录）')
    .option('--days <days>', 'usage 统计窗口天数', { default: '7' })
    .option('--stale-days <days>', '记忆 stale 阈值天数', { default: '30' })
    .option('--dry-run', '仅解析动作，不执行')
    .option('--skip-verify', '执行后不重新跑 ops:summary 复检')
    .option('--json', '以 JSON 输出结果')
    .action(
      async (
        actionId: string,
        options: {
          projectId?: string;
          repo?: string;
          days?: string;
          staleDays?: string;
          dryRun?: boolean;
          skipVerify?: boolean;
          json?: boolean;
        },
      ) => {
        const { analyzeIndexHealth } = await import('../../monitoring/indexHealth.js');
        const { analyzeMemoryHealth } = await import('../../monitoring/memoryHealth.js');
        const { analyzeMcpProcessHealth } = await import('../../monitoring/mcpProcessHealth.js');
        const { evaluateAlerts } = await import('../../monitoring/alertEngine.js');
        const { analyzeIndexOptimization } = await import('../../usage/usageAnalysis.js');
        const {
          applyOpsActionPlan,
          applyOpsActionWithVerification,
          formatOpsApplyReport,
          formatOpsApplyVerificationReport,
          planOpsAction,
        } = await import(
          '../../monitoring/opsApply.js'
        );

        try {
          const days = Number.parseInt(String(options.days ?? '7'), 10);
          const staleDays = Number.parseInt(String(options.staleDays ?? '30'), 10);
          const repoPath = options.repo ? path.resolve(options.repo) : process.cwd();

          const [indexHealth, memoryHealth, mcpProcessHealth] = await Promise.all([
            analyzeIndexHealth(),
            analyzeMemoryHealth({
              staleDays: Number.isFinite(staleDays) && staleDays > 0 ? staleDays : 30,
            }),
            Promise.resolve(analyzeMcpProcessHealth()),
          ]);

          const usageReport = analyzeIndexOptimization({
            days: Number.isFinite(days) && days > 0 ? days : 7,
          });

          const { buildAlertEvaluationMetrics } = await import('../../monitoring/healthFull.js');
          const alertResult = evaluateAlerts(
            buildAlertEvaluationMetrics({ indexHealth, memoryHealth, mcpProcessHealth }),
          );

          const plan = planOpsAction(
            {
              indexHealth,
              memoryHealth,
              mcpProcessHealth,
              usageReport,
              alertResult,
            },
            {
              actionId,
              projectId: options.projectId,
              repoPath,
            },
          );

          if (options.dryRun) {
            const preview = { ...plan, status: 'planned' as const };
            if (options.json) {
              writeJson(preview);
              return;
            }
            writeText(formatOpsApplyReport(preview));
            return;
          }

          if (options.skipVerify) {
            const result = await applyOpsActionPlan(plan, { cliEntryPath: process.argv[1] });
            if (options.json) {
              writeJson(result);
              return;
            }
            writeText(formatOpsApplyReport(result));
            return;
          }

          const result = await applyOpsActionWithVerification(
            plan,
            {
              repoPath,
              days: Number.isFinite(days) && days > 0 ? days : 7,
              staleDays: Number.isFinite(staleDays) && staleDays > 0 ? staleDays : 30,
              verificationDelayMs: plan.kind === 'daemon-start' ? 500 : 0,
              verificationRetries: plan.kind === 'daemon-start' ? 3 : 1,
            },
            {
              applyPlan: async (resolvedPlan) =>
                applyOpsActionPlan(resolvedPlan, { cliEntryPath: process.argv[1] }),
            },
          );
          if (options.json) {
            writeJson(result);
            return;
          }
          writeText(formatOpsApplyVerificationReport(result));
        } catch (err) {
          const error = err as Error;
          exitWithError('执行运维修复动作失败', { error: error.message });
        }
      },
    );
}
