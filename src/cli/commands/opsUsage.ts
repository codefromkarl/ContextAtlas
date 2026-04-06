import { exitWithError, writeJson, writeText } from '../helpers.js';
import type { CommandRegistrar } from '../types.js';
import { logger } from '../../utils/logger.js';

export function registerOpsUsageCommands(cli: CommandRegistrar): void {
  cli
    .command('usage:index-report', '分析日常工具使用情况并生成索引优化建议')
    .option('--days <n>', '分析最近 N 天', { default: 0 })
    .option('--project-id <id>', '按项目 ID 过滤')
    .option('--json', '以 JSON 输出报告')
    .action(async (options: { days?: string | number; projectId?: string; json?: boolean }) => {
      const { analyzeIndexOptimization, formatIndexOptimizationReport } = await import(
        '../../usage/usageAnalysis.js'
      );
      try {
        const days = Number.parseInt(String(options.days ?? '0'), 10);
        const report = analyzeIndexOptimization({
          days: Number.isFinite(days) && days > 0 ? days : undefined,
          projectId: options.projectId,
        });
        if (options.json) {
          writeJson(report);
          return;
        }
        writeText(formatIndexOptimizationReport(report));
      } catch (err) {
        const error = err as Error;
        exitWithError('生成 usage 索引优化报告失败', { error: error.message });
      }
    });

  cli
    .command('usage:purge', '清理过期的 usage 追踪数据')
    .option('--days <n>', '保留最近 N 天的数据（默认 90）', { default: '90' })
    .option('--apply', '执行删除；默认仅 dry-run 预览')
    .action(async (options: { days?: string; apply?: boolean }) => {
      const { getUsageStats, purgeOldUsageEvents } = await import('../../usage/usageTracker.js');
      try {
        const days = Number.parseInt(String(options.days ?? '90'), 10);
        if (!Number.isFinite(days) || days <= 0) {
          exitWithError('--days 必须为正整数');
        }

        const stats = getUsageStats();
        logger.info(
          `当前 usage 数据: ${stats.toolUsageCount} tool events, ${stats.indexUsageCount} index events`,
        );
        logger.info(`时间范围: ${stats.oldestDay || 'N/A'} ~ ${stats.newestDay || 'N/A'}`);

        if (options.apply) {
          const result = purgeOldUsageEvents(days);
          logger.info(
            `已清理: ${result.toolPurged} tool events, ${result.indexPurged} index events (cutoff: ${result.cutoffDay})`,
          );
        } else {
          logger.info(`[dry-run] 将保留最近 ${days} 天数据`);
          if (stats.oldestDay) {
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - days);
            const cutoffDay = cutoffDate.toISOString().slice(0, 10);
            logger.info(`[dry-run] 将清理 ${stats.oldestDay} ~ ${cutoffDay} 之前的数据`);
          }
          logger.info('使用 --apply 执行实际删除');
        }
      } catch (err) {
        const error = err as Error;
        exitWithError('usage 数据清理失败', { error: error.message });
      }
    });
}
