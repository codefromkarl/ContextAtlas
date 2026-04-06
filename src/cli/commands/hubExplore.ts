import { exitWithError, splitCommaSeparated, writeJson } from '../helpers.js';
import type { CommandRegistrar } from '../types.js';
import { logger } from '../../utils/logger.js';

export function registerHubExploreCommands(cli: CommandRegistrar): void {
  cli
    .command('hub:save-memory <project> <name>', '保存功能记忆')
    .option('--desc <desc>', '职责描述')
    .option('--dir <dir>', '目录')
    .option('--files <files>', '文件列表（逗号分隔）')
    .option('--type <type>', '记忆类型（local/shared/pattern/framework）')
    .action(async (project: string, name: string, options: Record<string, string | undefined>) => {
      const { MemoryHubDatabase } = await import('../../memory/MemoryHubDatabase.js');
      const { MemoryStore } = await import('../../memory/MemoryStore.js');
      const db = new MemoryHubDatabase();
      const projectInfo = db.getProject(project);
      db.close();

      if (!projectInfo) {
        exitWithError(`未找到项目：${project}`);
      }

      const store = new MemoryStore(projectInfo.path);
      const memory = {
        name,
        responsibility: options.desc || 'N/A',
        location: {
          dir: options.dir || 'src/',
          files: splitCommaSeparated(options.files),
        },
        api: {
          exports: [],
          endpoints: [],
        },
        dependencies: {
          imports: [],
          external: [],
        },
        dataFlow: '',
        keyPatterns: [],
        memoryType: (options.type as any) || 'local',
        lastUpdated: new Date().toISOString(),
      };

      const filePath = await store.saveFeature(memory);
      logger.info(`功能记忆已保存到：${filePath}`);
    });

  cli
    .command('hub:search', '跨项目搜索记忆')
    .option('--category <cat>', '分类（auth/database/api/search/cache）')
    .option('--module <name>', '模块名匹配')
    .option('--limit <n>', '结果数量', { default: 20 })
    .option('--json', '以 JSON 输出结果')
    .action(async (options: Record<string, string | number | undefined>) => {
      const { MemoryHubDatabase } = await import('../../memory/MemoryHubDatabase.js');
      const db = new MemoryHubDatabase();

      const results = db.searchMemories({
        category: options.category as string | undefined,
        moduleName: options.module as string | undefined,
        limit: options.limit as number,
      });
      db.close();

      if (options.json) {
        writeJson({
          query: {
            category: options.category as string | undefined,
            module: options.module as string | undefined,
            limit: options.limit as number,
          },
          results,
        });
        return;
      }

      if (results.length === 0) {
        logger.info('未找到匹配的记忆');
        return;
      }

      logger.info(`找到 ${results.length} 个记忆:`);
      for (const r of results) {
        logger.info(`  - ${r.name} (${r.project_name})`);
        logger.info(`    职责：${r.responsibility}`);
        logger.info(`    位置：${r.location_dir}`);
      }
    });

  cli
    .command('hub:fts <query>', 'FTS5 全文搜索记忆')
    .option('--limit <n>', '结果数量', { default: 20 })
    .action(async (query: string, options: { limit?: number }) => {
      const { MemoryHubDatabase } = await import('../../memory/MemoryHubDatabase.js');
      const db = new MemoryHubDatabase();

      const ftsQuery = query
        .split(/\s+/)
        .map((term) => `${term}*`)
        .join(' ');
      const results = db.searchMemoriesFTS(ftsQuery, options.limit || 20);
      db.close();

      if (results.length === 0) {
        logger.info(`未找到匹配 "${query}" 的记忆`);
        return;
      }

      logger.info(`找到 ${results.length} 个记忆:`);
      for (const r of results) {
        logger.info(`  - ${r.name} (${r.project_name})`);
        logger.info(`    职责：${r.responsibility}`);
      }
    });

  cli
    .command('hub:link <fromProject> <fromModule> <toProject> <toModule> <type>', '创建记忆关系')
    .action(
      async (
        fromProject: string,
        fromModule: string,
        toProject: string,
        toModule: string,
        type: string,
      ) => {
        const { MemoryHubDatabase } = await import('../../memory/MemoryHubDatabase.js');
        const db = new MemoryHubDatabase();

        const fromMemory = db.getMemory(fromProject, fromModule);
        if (!fromMemory) {
          db.close();
          exitWithError(`未找到源记忆：${fromModule} in ${fromProject}`);
        }

        const toMemory = db.getMemory(toProject, toModule);
        if (!toMemory) {
          db.close();
          exitWithError(`未找到目标记忆：${toModule} in ${toProject}`);
        }

        db.createRelation(fromMemory.id, toMemory.id, type as any);
        db.close();

        logger.info(`关系已创建：${fromModule} → ${toModule} (${type})`);
      },
    );

  cli
    .command('hub:deps <project> <module>', '获取模块依赖链')
    .action(async (project: string, module: string) => {
      const { MemoryHubDatabase } = await import('../../memory/MemoryHubDatabase.js');
      const db = new MemoryHubDatabase();

      const memory = db.getMemory(project, module);
      if (!memory) {
        db.close();
        exitWithError(`未找到记忆：${module} in ${project}`);
      }

      const deps = db.getDependencies(memory.id);
      db.close();

      if (deps.length <= 1) {
        logger.info('无依赖');
        return;
      }

      logger.info(`${module} 的依赖链 (${deps.length - 1} 个):`);
      for (const d of deps.slice(1)) {
        logger.info(`  - ${d.name} (${d.location_dir})`);
        logger.info(`    职责：${d.responsibility}`);
      }
    });
}
