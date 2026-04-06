import path from 'node:path';
import { generateProjectId } from '../../db/index.js';
import { type ScanStats, scanWithSnapshotSwap } from '../../scanner/index.js';
import { exitWithError, writeText } from '../helpers.js';
import { logger } from '../../utils/logger.js';
import type { CommandRegistrar } from '../types.js';

export function registerIndexingCommands(cli: CommandRegistrar): void {
  cli
    .command('index [path]', '扫描代码库并建立索引')
    .option('-f, --force', '强制重新索引')
    .action(async (targetPath: string | undefined, options: { force?: boolean }) => {
      const rootPath = targetPath ? path.resolve(targetPath) : process.cwd();
      const projectId = generateProjectId(rootPath);

      logger.info(`开始扫描: ${rootPath}`);
      logger.info(`项目 ID: ${projectId}`);
      if (options.force) {
        logger.info('强制重新索引: 是');
      }

      const startTime = Date.now();

      try {
        const { withLock } = await import('../../utils/lock.js');
        let lastLoggedPercent = 0;
        const stats: ScanStats = await withLock(
          projectId,
          'index',
          async () =>
            scanWithSnapshotSwap(rootPath, {
              force: options.force,
              onProgress: (current, total, message) => {
                if (total !== undefined) {
                  const percent = Math.floor((current / total) * 100);
                  if (percent >= lastLoggedPercent + 30 && percent < 100) {
                    logger.info(`索引进度: ${percent}% - ${message || ''}`);
                    lastLoggedPercent = Math.floor(percent / 30) * 30;
                  }
                }
              },
            }),
          10 * 60 * 1000,
        );

        writeText('');

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        logger.info(`索引完成 (${duration}s)`);
        logger.info(
          `总数:${stats.totalFiles} 新增:${stats.added} 修改:${stats.modified} 未变:${stats.unchanged} 删除:${stats.deleted} 跳过:${stats.skipped} 错误:${stats.errors}`,
        );
      } catch (err) {
        const error = err as { message?: string; stack?: string };
        exitWithError(`索引失败: ${error.message}`, { err, stack: error.stack });
      }
    });

  cli
    .command('daemon <action>', '索引守护进程（消费索引任务队列）')
    .action(async (action: string) => {
      const normalized = (action || '').trim().toLowerCase();
      if (!['start', 'once'].includes(normalized)) {
        exitWithError(`未知 daemon 动作: ${action}，可选值: start | once`);
      }

      const { runIndexDaemon, runIndexDaemonOnce } = await import('../../indexing/daemon.js');

      if (normalized === 'once') {
        const didWork = await runIndexDaemonOnce();
        if (didWork) {
          logger.info('已消费 1 个索引任务');
        } else {
          logger.info('当前没有可消费的索引任务');
        }
        return;
      }

      logger.info('索引守护进程启动，按 Ctrl+C 可停止');
      await runIndexDaemon();
    });
}
