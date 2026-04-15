import path from 'node:path';
import type { CommandRegistrar } from '../types.js';
import { generateProjectId } from '../../db/index.js';
import { exitWithError, writeJson, writeText } from '../helpers.js';
import { logger } from '../../utils/logger.js';

export function registerOpsHealthCommands(cli: CommandRegistrar): void {
  cli
    .command('fts:rebuild-chunks', '从当前向量索引重建 chunk FTS')
    .option('--project-id <id>', '指定项目 ID（默认根据当前目录推导）')
    .action(async (options: { projectId?: string }) => {
      const projectId = options.projectId || generateProjectId(process.cwd());

      const { resolveCurrentSnapshotId } = await import('../../storage/layout.js');
      const { initDb } = await import('../../db/index.js');
      const { getEmbeddingConfig } = await import('../../config.js');
      const { getVectorStore } = await import('../../vectorStore/index.js');
      const { rebuildChunksFtsFromVectorStore } = await import('../../search/fts.js');

      try {
        const snapshotId = resolveCurrentSnapshotId(projectId);
        const db = initDb(projectId, snapshotId);
        const vectorStore = await getVectorStore(
          projectId,
          getEmbeddingConfig().dimensions,
          snapshotId,
        );
        const result = await rebuildChunksFtsFromVectorStore(db, vectorStore);
        logger.info(
          `chunks_fts 已重建：files=${result.filesProcessed} chunks=${result.chunksIndexed}`,
        );
      } catch (err) {
        const error = err as Error;
        exitWithError('重建 chunk FTS 失败', { error: error.message });
      }
    });

  cli
    .command('health:check', '检查索引系统健康状态（队列/快照/守护进程）')
    .option('--project-id <id>', '按项目 ID 过滤')
    .option('--quick', '快速模式：跳过 VectorStore 和策略分析')
    .option('--json', '以 JSON 输出报告')
    .action(async (options: { projectId?: string; quick?: boolean; json?: boolean }) => {
      const { analyzeIndexHealth, formatIndexHealthReport } = await import(
        '../../monitoring/indexHealth.js'
      );
      try {
        const report = await analyzeIndexHealth({
          projectIds: options.projectId ? [options.projectId] : undefined,
          quick: options.quick,
        });
        if (options.json) {
          writeJson(report);
          return;
        }
        writeText(formatIndexHealthReport(report));
      } catch (err) {
        const error = err as Error;
        exitWithError('生成健康报告失败', { error: error.message });
      }
    });

  cli
    .command('memory:health', '检查记忆系统健康状态')
    .option('--stale-days <days>', '超过多少天未核验视为 stale', { default: '30' })
    .option('--json', '以 JSON 输出报告')
    .action(async (options: { staleDays?: string; json?: boolean }) => {
      const { analyzeMemoryHealth, formatMemoryHealthReport } = await import(
        '../../monitoring/memoryHealth.js'
      );
      try {
        const staleDays = Number.parseInt(String(options.staleDays ?? '30'), 10);
        const report = await analyzeMemoryHealth({
          staleDays: Number.isFinite(staleDays) && staleDays > 0 ? staleDays : 30,
        });
        if (options.json) {
          writeJson(report);
          return;
        }
        writeText(formatMemoryHealthReport(report));
      } catch (err) {
        const error = err as Error;
        exitWithError('生成记忆健康报告失败', { error: error.message });
      }
    });

  cli
    .command('health:full', '系统全面健康检查（索引 + 记忆 + 告警）')
    .option('--stale-days <days>', '记忆 stale 阈值天数', { default: '30' })
    .option('--json', '以 JSON 输出报告')
    .action(async (options: { staleDays?: string; json?: boolean }) => {
      const { analyzeIndexHealth } = await import('../../monitoring/indexHealth.js');
      const { analyzeMemoryHealth } = await import('../../monitoring/memoryHealth.js');
      const { evaluateAlerts } = await import('../../monitoring/alertEngine.js');
      const { buildAlertEvaluationMetrics, buildHealthFullReport } = await import(
        '../../monitoring/healthFull.js'
      );

      try {
        const staleDays = Number.parseInt(String(options.staleDays ?? '30'), 10);

        const [indexHealth, memoryHealth] = await Promise.all([
          analyzeIndexHealth(),
          analyzeMemoryHealth({
            staleDays: Number.isFinite(staleDays) && staleDays > 0 ? staleDays : 30,
          }),
        ]);

        const alertResult = evaluateAlerts(
          buildAlertEvaluationMetrics({ indexHealth, memoryHealth }),
        );

        if (options.json) {
          writeJson({
            indexHealth,
            memoryHealth,
            alerts: alertResult,
          });
          return;
        }

        writeText(
          buildHealthFullReport({
            indexHealth,
            memoryHealth,
            alerts: alertResult,
          }),
        );
      } catch (err) {
        const error = err as Error;
        exitWithError('系统健康检查失败', { error: error.message });
      }
    });

  cli
    .command('index:plan [path]', '分析当前仓库应走全量还是增量更新，并提示影响范围')
    .option('--json', '以 JSON 输出结果')
    .action(async (targetPath: string | undefined, options: { json?: boolean }) => {
      const repoPath = targetPath ? path.resolve(targetPath) : process.cwd();

      try {
        const { analyzeIndexUpdatePlan, formatIndexUpdatePlanReport } = await import(
          '../../indexing/updateStrategy.js'
        );
        const plan = await analyzeIndexUpdatePlan(repoPath);
        if (options.json) {
          writeJson(plan);
          return;
        }
        writeText(formatIndexUpdatePlanReport(plan));
      } catch (err) {
        const error = err as Error;
        exitWithError('生成索引更新计划失败', { error: error.message });
      }
    });

  cli
    .command('index:diagnose', '显示当前索引升级阈值与升级判定配置')
    .option('--json', '以 JSON 输出结果')
    .action(async (options: { json?: boolean }) => {
      try {
        const {
          formatIndexUpdateStrategyDiagnosticsReport,
          getIndexUpdateStrategyDiagnostics,
        } = await import('../../indexing/updateStrategy.js');
        const diagnostics = getIndexUpdateStrategyDiagnostics();
        if (options.json) {
          writeJson(diagnostics);
          return;
        }
        writeText(formatIndexUpdateStrategyDiagnosticsReport(diagnostics));
      } catch (err) {
        const error = err as Error;
        exitWithError('生成索引阈值诊断失败', { error: error.message });
      }
    });

  cli
    .command('index:update [path]', '按当前仓库变化自动触发全量或增量索引任务')
    .option('--json', '以 JSON 输出结果')
    .action(async (targetPath: string | undefined, options: { json?: boolean }) => {
      const repoPath = targetPath ? path.resolve(targetPath) : process.cwd();

      try {
        const { executeIndexUpdatePlan, formatIndexUpdatePlanReport } = await import(
          '../../indexing/updateStrategy.js'
        );
        const result = await executeIndexUpdatePlan(repoPath);

        if (options.json) {
          writeJson(result);
          return;
        }

        const lines = [formatIndexUpdatePlanReport(result.plan), ''];
        if (!result.enqueued) {
          lines.push('Queue Action: no task enqueued');
        } else {
          lines.push(
            `Queue Action: enqueued ${result.plan.mode} task ${result.taskId}${result.reusedExisting ? ' (reused existing task)' : ''}`,
          );
          lines.push('Next Step: keep daemon running with `contextatlas daemon start`');
        }

        writeText(lines.join('\n'));
      } catch (err) {
        const error = err as Error;
        exitWithError('执行索引更新计划失败', { error: error.message });
      }
    });

  cli
    .command('task:status', '查看索引任务队列状态、卡住任务和最近失败摘要')
    .option('--project-id <id>', '按项目 ID 过滤')
    .option('--json', '以 JSON 输出结果')
    .action(async (options: { projectId?: string; json?: boolean }) => {
      try {
        const { formatTaskStatusReport, getTaskStatusReport } = await import(
          '../../indexing/queue.js'
        );
        const report = getTaskStatusReport({
          projectId: options.projectId,
        });
        if (options.json) {
          writeJson(report);
          return;
        }
        writeText(formatTaskStatusReport(report));
      } catch (err) {
        const error = err as Error;
        exitWithError('生成任务状态报告失败', { error: error.message });
      }
    });

  cli
    .command('task:inspect <taskId>', '查看单个索引任务详情')
    .option('--json', '以 JSON 输出结果')
    .action(async (taskId: string, options: { json?: boolean }) => {
      try {
        const { formatTaskInspectReport, getTaskById } = await import('../../indexing/queue.js');
        const task = getTaskById(taskId);
        if (!task) {
          exitWithError('找不到索引任务', { taskId });
          return;
        }
        if (options.json) {
          writeJson(task);
          return;
        }
        writeText(formatTaskInspectReport(task));
      } catch (err) {
        const error = err as Error;
        exitWithError('读取任务详情失败', { error: error.message, taskId });
      }
    });
}
