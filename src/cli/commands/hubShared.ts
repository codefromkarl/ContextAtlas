import os from 'node:os';
import path from 'node:path';
import {
  exitWithError,
  splitCommaSeparated,
  writeJson,
  writeText,
} from '../helpers.js';
import type { CommandRegistrar } from '../types.js';

export function registerSharedMemoryCommands(cli: CommandRegistrar): void {
  cli
    .command('shared:contribute', '将当前项目的模块记忆贡献到共享记忆库')
    .option('--repo <path>', '项目路径（默认当前目录）')
    .option('--category <category>', '共享分类: commons | frameworks | patterns')
    .option('--name <name>', '模块名')
    .option('--desc <desc>', '职责描述')
    .option('--dir <dir>', '目录')
    .option('--files <files>', '文件列表（逗号分隔）')
    .option('--exports <exports>', '导出符号（逗号分隔）')
    .option('--json', '以 JSON 输出结果')
    .action(async (options: Record<string, string | boolean | undefined>) => {
      if (!options.category || !options.name || !options.desc || !options.dir) {
        exitWithError('缺少 --category / --name / --desc / --dir');
      }

      const repoRoot = options.repo ? path.resolve(String(options.repo)) : process.cwd();
      const { SharedMemoryHub } = await import('../../memory/SharedMemoryHub.js');
      const hub = new SharedMemoryHub();
      const ref = await hub.contribute(
        options.category as 'commons' | 'frameworks' | 'patterns',
        {
          name: String(options.name),
          responsibility: String(options.desc),
          location: {
            dir: String(options.dir),
            files: typeof options.files === 'string' ? splitCommaSeparated(options.files) : [],
          },
          api: {
            exports:
              typeof options.exports === 'string' ? splitCommaSeparated(options.exports) : [],
            endpoints: [],
          },
          dependencies: {
            imports: [],
            external: [],
          },
          dataFlow: '',
          keyPatterns: [],
          lastUpdated: new Date().toISOString(),
        },
        {
          contributor: os.userInfo().username,
          sourceProject: repoRoot,
          projectRoot: repoRoot,
        },
      );

      if (options.json) {
        writeJson({
          category: options.category,
          name: options.name,
          ref,
        });
        return;
      }

      writeText(`Shared memory contributed: ${options.name} -> ${ref}`);
    });

  cli
    .command('shared:list', '列出共享记忆库中的记忆')
    .option('--category <category>', '共享分类: commons | frameworks | patterns')
    .option('--json', '以 JSON 输出结果')
    .action(async (options: { category?: string; json?: boolean }) => {
      const { SharedMemoryHub } = await import('../../memory/SharedMemoryHub.js');
      const hub = new SharedMemoryHub();
      const results = await hub.list(
        options.category as 'commons' | 'frameworks' | 'patterns' | undefined,
      );

      if (options.json) {
        writeJson({ result_count: results.length, results });
        return;
      }

      if (results.length === 0) {
        writeText('No shared memories found.');
        return;
      }

      for (const item of results) {
        writeText(`- ${item.category}/${item.name}: ${item.path}`);
      }
    });

  cli
    .command('shared:sync', '从共享记忆库同步记忆到项目')
    .option('--repo <path>', '目标仓库路径（默认当前目录）')
    .option('--category <category>', '共享分类: commons | frameworks | patterns')
    .option('--name <name>', '共享记忆名')
    .option('--as <alias>', '同步到项目中的模块别名')
    .option('--json', '以 JSON 输出结果')
    .action(async (options: Record<string, string | boolean | undefined>) => {
      if (!options.category || !options.name) {
        exitWithError('缺少 --category / --name');
      }

      const repoRoot = options.repo ? path.resolve(String(options.repo)) : process.cwd();
      const { SharedMemoryHub } = await import('../../memory/SharedMemoryHub.js');
      const hub = new SharedMemoryHub();
      const result = await hub.syncToProject(
        options.category as 'commons' | 'frameworks' | 'patterns',
        String(options.name),
        repoRoot,
        {
          as: typeof options.as === 'string' ? options.as : undefined,
        },
      );

      if (options.json) {
        writeJson(result);
        return;
      }

      writeText(result.message);
    });
}
