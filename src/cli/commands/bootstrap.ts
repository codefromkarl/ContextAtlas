import os from 'node:os';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfigEnvPath } from '../../runtimePaths.js';
import { buildDefaultEnvContent } from '../../setup/defaultEnv.js';
import {
  applyLocalSetup,
  formatLocalSetupReport,
  isLocalSetupMode,
  isLocalSetupToolset,
} from '../../setup/local.js';
import { exitWithError, writeText } from '../helpers.js';
import { logger } from '../../utils/logger.js';
import type { CommandRegistrar } from '../types.js';

export { buildDefaultEnvContent } from '../../setup/defaultEnv.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export function registerBootstrapCommands(cli: CommandRegistrar): void {
  cli.command('init', '初始化 ContextAtlas 配置').action(async () => {
    const envFile = defaultConfigEnvPath();
    const configDir = path.dirname(envFile);

    logger.info('开始初始化 ContextAtlas...');

    try {
      await fs.mkdir(configDir, { recursive: true });
      logger.info(`创建配置目录: ${configDir}`);
    } catch (err) {
      const error = err as { code?: string; message?: string; stack?: string };
      if (error.code !== 'EEXIST') {
        exitWithError(`创建配置目录失败: ${error.message}`, { err, stack: error.stack });
      }
      logger.info(`配置目录已存在: ${configDir}`);
    }

    try {
      await fs.access(envFile);
      logger.warn(`.env 文件已存在: ${envFile}`);
      logger.info('初始化完成！');
      return;
    } catch {
      // 文件不存在，继续创建
    }

    const defaultEnvContent = buildDefaultEnvContent();
    try {
      await fs.writeFile(envFile, defaultEnvContent);
      logger.info(`创建 .env 文件: ${envFile}`);
    } catch (err) {
      const error = err as { message?: string; stack?: string };
      exitWithError(`创建 .env 文件失败: ${error.message}`, { err, stack: error.stack });
    }

    logger.info('下一步操作:');
    logger.info(`   1. 编辑配置文件: ${envFile}`);
    logger.info('   2. 填写你的 API Key 和其他配置');
    logger.info('初始化完成！');
  });

  cli
    .command('start [path]', '显示默认主路径入口与当前仓库索引状态')
    .action(async (targetPath: string | undefined) => {
      const repoPath = targetPath ? path.resolve(targetPath) : process.cwd();

      try {
        const { buildStartGuide } = await import('../../workflow/start.js');
        const guide = await buildStartGuide(repoPath);
        writeText(guide);
      } catch (err) {
        const error = err as { message?: string; stack?: string };
        exitWithError(`生成 start guide 失败: ${error.message}`, { err, stack: error.stack });
      }
    });

  cli.command('mcp', '启动 MCP 服务器').action(async () => {
    const { startMcpServer } = await import('../../mcp/server.js');
    try {
      await startMcpServer();
    } catch (err) {
      const error = err as { message?: string; stack?: string };
      exitWithError(`MCP 服务器启动失败: ${error.message}`, {
        error: error.message,
        stack: error.stack,
      });
    }
  });

  cli
    .command('setup:local', '按模式配置本地 ContextAtlas 接入')
    .option('--dry-run', '仅预览将要写入的文件')
    .option('--mode <mode>', '接入模式: cli-skill 或 mcp')
    .option('--toolset <toolset>', 'MCP toolset: full 或 retrieval-only')
    .action(async (options?: { dryRun?: boolean; mode?: string; toolset?: string }) => {
      const mode = options?.mode;
      if (!mode || !isLocalSetupMode(mode)) {
        exitWithError('缺少或不支持的 --mode，可选值为 cli-skill 或 mcp');
      }

      const toolset = options?.toolset ?? 'full';
      if (!isLocalSetupToolset(toolset)) {
        exitWithError(`不支持的 toolset: ${toolset}，可选值为 full 或 retrieval-only`);
      }

      try {
        const report = await applyLocalSetup({
          homeDir: os.homedir(),
          repoRoot: packageRoot,
          nodeCommand: process.execPath,
          mode,
          toolset,
          dryRun: options?.dryRun ?? false,
        });
        writeText(formatLocalSetupReport(report));
      } catch (err) {
        const error = err as { message?: string; stack?: string };
        exitWithError(`本地接入配置失败: ${error.message}`, { err, stack: error.stack });
      }
    });
}
