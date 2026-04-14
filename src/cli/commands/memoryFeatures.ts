import { joinToolText, splitCommaSeparated, writeText } from '../helpers.js';
import type { CommandRegistrar } from '../types.js';
import { logger } from '../../utils/logger.js';

export function registerMemoryFeatureCommands(cli: CommandRegistrar): void {
  cli.command('memory:find <query>', '查找功能记忆').action(async (query: string) => {
    const { MemoryFinder } = await import('../../memory/MemoryFinder.js');
    const finder = new MemoryFinder(process.cwd());
    const results = await finder.find(query, { limit: 10, minScore: 1 });

    if (results.length === 0) {
      logger.info(`未找到与 "${query}" 相关的功能记忆`);
      return;
    }

    logger.info(`找到 ${results.length} 个功能记忆:`);
    for (const r of results) {
      logger.info(`  - ${r.memory.name} (score: ${r.score}, 匹配字段：${r.matchFields.join(', ')})`);
      logger.info(`    职责：${r.memory.responsibility}`);
      logger.info(`    位置：${r.memory.location.dir}`);
    }
  });

  cli
    .command('memory:suggest <name>', '建议记录功能记忆，默认不直接落库')
    .option('--files <files>', '相关文件（逗号分隔）')
    .action(async (name: string, options: Record<string, string | undefined>) => {
      const { executeSuggestMemory } = await import('../../application/memory/executeAutoRecord.js');
      const response = await executeSuggestMemory({
        moduleName: name,
        files: splitCommaSeparated(options.files),
      });

      logger.info(response.content[0]?.text || '未生成建议');
    });

  cli
    .command('memory:record <name>', '记录功能记忆')
    .option('--desc <desc>', '模块职责描述')
    .option('--dir <dir>', '源文件目录')
    .option('--files <files>', '相关文件（逗号分隔）')
    .option('--exports <exports>', '导出符号（逗号分隔）')
    .option('--imports <imports>', '内部依赖（逗号分隔）')
    .option('--external <external>', '外部依赖（逗号分隔）')
    .option('--data-flow <flow>', '数据流描述')
    .option('--patterns <patterns>', '关键模式（逗号分隔）')
    .option(
      '--confirmation-status <status>',
      '确认状态：suggested | agent-inferred | human-confirmed',
    )
    .action(async (name: string, options: Record<string, string | undefined>) => {
      const { executeRecordMemory } = await import('../../application/memory/executeProjectMemory.js');
      const response = await executeRecordMemory(
        {
          name,
          responsibility: options.desc || '',
          dir: options.dir || 'src/',
          files: splitCommaSeparated(options.files),
          exports: splitCommaSeparated(options.exports),
          imports: splitCommaSeparated(options.imports),
          external: splitCommaSeparated(options.external),
          dataFlow: options.dataFlow || options['data-flow'] || '',
          keyPatterns: splitCommaSeparated(options.patterns),
          confirmationStatus:
            options['confirmation-status'] === 'suggested'
            || options['confirmation-status'] === 'agent-inferred'
            || options['confirmation-status'] === 'human-confirmed'
              ? options['confirmation-status']
              : 'human-confirmed',
        },
        process.cwd(),
      );

      writeText(joinToolText(response));
    });

  cli.command('memory:list', '列出所有功能记忆').action(async () => {
    const { MemoryFinder } = await import('../../memory/MemoryFinder.js');
    const finder = new MemoryFinder(process.cwd());
    const memories = await finder.listAll();

    if (memories.length === 0) {
      logger.info('暂无功能记忆');
      return;
    }

    logger.info(`共 ${memories.length} 个功能记忆:`);
    for (const m of memories) {
      logger.info(`  - ${m.name}`);
      logger.info(`    职责：${m.responsibility}`);
      logger.info(`    位置：${m.location.dir}`);
      if (m.reviewStatus === 'needs-review') {
        logger.info(`    复核：待复核${m.reviewReason ? ` (${m.reviewReason})` : ''}`);
      }
      logger.info(`    更新：${new Date(m.lastUpdated).toLocaleString()}`);
    }
  });

  cli.command('memory:delete <name>', '删除功能记忆').action(async (name: string) => {
    const { MemoryStore } = await import('../../memory/MemoryStore.js');
    const store = new MemoryStore(process.cwd());
    const deleted = await store.deleteFeature(name);

    if (!deleted) {
      logger.info(`未找到功能记忆：${name}`);
      return;
    }

    logger.info(`功能记忆已删除：${name}`);
  });
}
