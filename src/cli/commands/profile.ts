import path from 'node:path';
import { splitCommaSeparated, writeJson } from '../helpers.js';
import type { CommandRegistrar } from '../types.js';
import type { ProjectProfile } from '../../memory/types.js';
import { logger } from '../../utils/logger.js';

export function registerProfileCommands(cli: CommandRegistrar): void {
  cli
    .command('profile:record', '记录或更新项目档案')
    .option('--name <name>', '项目名称')
    .option('--desc <desc>', '项目描述')
    .option('--languages <items>', '语言列表，逗号分隔')
    .option('--frameworks <items>', '框架列表，逗号分隔')
    .option('--databases <items>', '数据库列表，逗号分隔')
    .option('--tools <items>', '工具列表，逗号分隔')
    .option('--src-dir <dir>', '源码目录', { default: 'src' })
    .option('--entry <path>', '主入口文件', { default: 'src/index.ts' })
    .option(
      '--shared-memory <policy>',
      'shared memory 策略: disabled | readonly | editable',
      { default: 'readonly' },
    )
    .option(
      '--personal-memory <scope>',
      'personal memory 默认作用域: project | global-user',
      { default: 'global-user' },
    )
    .option('--readonly', '将项目档案标记为 organization-readonly')
    .option('--force', '覆盖只读项目档案')
    .option('--json', '以 JSON 输出结果')
    .action(async (options: Record<string, string | boolean | undefined>) => {
      const { MemoryStore } = await import('../../memory/MemoryStore.js');
      const store = new MemoryStore(process.cwd());
      const existing = await store.readProfile();
      const split = (value: string | boolean | undefined) =>
        typeof value === 'string' ? splitCommaSeparated(value) : [];

      const profile: ProjectProfile = {
        name:
          (typeof options.name === 'string' && options.name)
          || existing?.name
          || path.basename(process.cwd()),
        description:
          (typeof options.desc === 'string' && options.desc) || existing?.description || '',
        techStack: {
          language: split(options.languages).length
            ? split(options.languages)
            : (existing?.techStack.language || []),
          frameworks: split(options.frameworks).length
            ? split(options.frameworks)
            : (existing?.techStack.frameworks || []),
          databases: split(options.databases).length
            ? split(options.databases)
            : (existing?.techStack.databases || []),
          tools: split(options.tools).length
            ? split(options.tools)
            : (existing?.techStack.tools || []),
        },
        structure: {
          srcDir:
            (typeof options['src-dir'] === 'string' && options['src-dir'])
            || existing?.structure.srcDir
            || 'src',
          mainEntry:
            (typeof options.entry === 'string' && options.entry)
            || existing?.structure.mainEntry
            || 'src/index.ts',
          keyModules: existing?.structure.keyModules || [],
        },
        conventions: existing?.conventions || {
          namingConventions: [],
          codeStyle: [],
          gitWorkflow: '',
        },
        commands: existing?.commands || {
          build: ['pnpm build'],
          test: ['pnpm test'],
          dev: ['pnpm dev'],
          start: ['pnpm start'],
        },
        governance: {
          profileMode: options.readonly ? 'organization-readonly' : 'editable',
          sharedMemory:
            options['shared-memory'] === 'disabled'
            || options['shared-memory'] === 'readonly'
            || options['shared-memory'] === 'editable'
              ? options['shared-memory']
              : existing?.governance?.sharedMemory || 'readonly',
          personalMemory:
            options['personal-memory'] === 'project' || options['personal-memory'] === 'global-user'
              ? options['personal-memory']
              : existing?.governance?.personalMemory || 'global-user',
        },
        lastUpdated: new Date().toISOString(),
      };

      const uri = await store.saveProfile(profile, { force: Boolean(options.force) });
      if (options.json) {
        writeJson({ profile, uri });
        return;
      }
      logger.info(`项目档案已保存：${uri}`);
    });

  cli
    .command('profile:show', '显示项目档案')
    .option('--repo <path>', '目标仓库路径（默认当前目录）')
    .option('--json', '以 JSON 输出')
    .action(async (options: { repo?: string; json?: boolean }) => {
      const { MemoryStore } = await import('../../memory/MemoryStore.js');
      const repoRoot = options.repo ? path.resolve(options.repo) : process.cwd();
      const store = new MemoryStore(repoRoot);
      const profile = await store.readProfile();

      if (!profile) {
        logger.info('暂无项目档案');
        return;
      }

      const writableState =
        profile.governance?.profileMode === 'organization-readonly' ? 'readonly' : 'editable';

      if (options.json) {
        writeJson({
          ...profile,
          source: 'project profile',
          writableState,
        });
        return;
      }

      logger.info(`项目：${profile.name}`);
      logger.info(`描述：${profile.description}`);
      logger.info(`技术栈：${profile.techStack.language.join(', ')}`);
      logger.info('来源：project profile');
      logger.info(`可写状态：${writableState}`);
      logger.info(
        `治理：profile=${profile.governance?.profileMode || 'editable'}, shared=${profile.governance?.sharedMemory || 'readonly'}, personal=${profile.governance?.personalMemory || 'global-user'}`,
      );
      logger.info(`最后更新：${new Date(profile.lastUpdated).toLocaleString()}`);
    });

  cli
    .command('profile:import-omc', '将 .omc/project-memory.json 导入 SQLite 项目记忆')
    .option('--force', '覆盖已存在的 SQLite profile/global 记忆')
    .action(async (options: { force?: boolean }) => {
      const { MemoryStore } = await import('../../memory/MemoryStore.js');
      const { importOmcProjectProfile } = await import('../../memory/OmcProjectMemoryImporter.js');
      const store = new MemoryStore(process.cwd());
      const result = await importOmcProjectProfile({
        projectRoot: process.cwd(),
        store,
        force: Boolean(options.force),
      });

      if (!result.imported) {
        if (result.reason === 'missing-file') {
          logger.warn(`未找到 ${result.source}`);
          return;
        }
        logger.info('SQLite 中已存在 project profile，跳过导入');
        return;
      }

      logger.info(`已从 ${result.source} 导入: ${result.importedGlobals.join(', ')}`);
    });
}
