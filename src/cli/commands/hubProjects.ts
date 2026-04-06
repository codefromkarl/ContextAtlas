import { writeJson } from '../helpers.js';
import path from 'node:path';
import type { CommandRegistrar } from '../types.js';
import { logger } from '../../utils/logger.js';

export function registerHubProjectCommands(cli: CommandRegistrar): void {
  cli
    .command('hub:register-project <path>', '注册项目到记忆中心')
    .option('--name <name>', '项目显示名')
    .action(async (projectPath: string, options: Record<string, string | undefined>) => {
      const { MemoryHubDatabase } = await import('../../memory/MemoryHubDatabase.js');
      const db = new MemoryHubDatabase();

      const project = db.ensureProject({
        name: options.name,
        path: path.resolve(projectPath),
      });
      db.close();

      logger.info(`项目已注册：${project.name} (${project.id})`);
    });

  cli
    .command('hub:list-projects', '列出所有注册项目')
    .option('--json', '以 JSON 输出结果')
    .action(async (options: { json?: boolean }) => {
      const { MemoryHubDatabase } = await import('../../memory/MemoryHubDatabase.js');
      const db = new MemoryHubDatabase();

      const projects = db.listProjects();
      db.close();

      if (options.json) {
        writeJson({ projects });
        return;
      }

      if (projects.length === 0) {
        logger.info('暂无注册项目');
        return;
      }

      logger.info(`共 ${projects.length} 个注册项目:`);
      for (const p of projects) {
        logger.info(`  - ${p.name} (${p.id})`);
        logger.info(`    路径：${p.path}`);
      }
    });

  cli
    .command('hub:stats', '显示记忆中心统计信息')
    .option('--json', '以 JSON 输出结果')
    .action(async (options: { json?: boolean }) => {
      const { MemoryHubDatabase } = await import('../../memory/MemoryHubDatabase.js');
      const db = new MemoryHubDatabase();
      const stats = db.getStats();
      db.close();

      if (options.json) {
        writeJson({ stats });
        return;
      }

      logger.info('记忆中心统计:');
      logger.info(`  项目数：${Number(stats.totalProjects)}`);
      logger.info(`  记忆数：${Number(stats.totalMemories)}`);
      logger.info(`  关系数：${Number(stats.totalRelations)}`);
      logger.info(`  决策数：${Number(stats.totalDecisions)}`);
      logger.info(`  分类统计：${JSON.stringify(stats.byCategory)}`);
    });

  cli
    .command('hub:repair-project-identities', '修复历史项目 ID 到规范化路径派生 ID')
    .option('--dry-run', '仅输出将要执行的修复计划，不修改数据库')
    .option('--json', '以 JSON 输出结果，便于脚本消费')
    .action(async (options: { dryRun?: boolean; json?: boolean }) => {
      const { MemoryHubDatabase } = await import('../../memory/MemoryHubDatabase.js');
      const db = new MemoryHubDatabase();

      if (options.dryRun) {
        const analysis = db.analyzeProjectIdentityRepairs();
        db.close();

        if (options.json) {
          writeJson({ mode: 'dry-run', ...analysis });
          return;
        }

        logger.info('项目身份修复预览:');
        logger.info(`  扫描项目数：${analysis.scannedProjects}`);
        logger.info(`  已规范项目数：${analysis.canonicalProjects}`);
        logger.info(`  待修复项目数：${analysis.repairedProjects}`);
        for (const entry of analysis.entries.filter(
          (item) => item.action === 'migrate-to-canonical',
        )) {
          logger.info(`  - legacy=${entry.legacyProjectId} -> canonical=${entry.canonicalProjectId}`);
          logger.info(`    path=${entry.path}`);
          logger.info(
            `    featureMemories=${entry.featureMemoryCount}, meta=${entry.metaCount}, decisions=${entry.decisionCount}`,
          );
        }
        return;
      }

      const report = db.repairProjectIdentities();
      db.close();

      if (options.json) {
        writeJson({ mode: 'apply', ...report });
        return;
      }

      logger.info('项目身份修复完成:');
      logger.info(`  扫描项目数：${report.scannedProjects}`);
      logger.info(`  已规范项目数：${report.canonicalProjects}`);
      logger.info(`  修复项目数：${report.repairedProjects}`);
      logger.info(`  删除旧项目数：${report.removedProjects}`);
    });
}
