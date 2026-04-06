import { exitWithError, exitWithStderr, writeJson, writeText } from '../helpers.js';
import type { CommandRegistrar } from '../types.js';

export function registerOpsAlertCommands(cli: CommandRegistrar): void {
  cli
    .command('alert:eval', '评估当前指标并触发告警')
    .option('--json', '以 JSON 输出')
    .action(async (options: { json?: boolean }) => {
      const { analyzeIndexHealth } = await import('../../monitoring/indexHealth.js');
      const { evaluateAlerts, formatAlertReport } = await import('../../monitoring/alertEngine.js');
      try {
        const health = await analyzeIndexHealth();
        const result = evaluateAlerts(health as unknown as Record<string, unknown>);
        if (options.json) {
          writeJson(result);
          return;
        }
        writeText(formatAlertReport(result));
      } catch (err) {
        const error = err as Error;
        exitWithError('告警评估失败', { error: error.message });
      }
    });

  cli
    .command('alert:config', '管理告警规则配置')
    .option('--list', '列出所有告警规则')
    .option('--enable <id>', '启用指定规则')
    .option('--disable <id>', '禁用指定规则')
    .option('--reset', '重置为默认配置')
    .action(
      async (options: { list?: boolean; enable?: string; disable?: string; reset?: boolean }) => {
        const { loadAlertConfig, saveAlertConfig } = await import('../../monitoring/alertEngine.js');
        try {
          if (options.reset) {
            const { saveAlertConfig: save, defaultConfig } = await import(
              '../../monitoring/alertEngine.js'
            );
            save(defaultConfig());
            writeText('Alert config reset to defaults.');
            return;
          }

          const config = loadAlertConfig();

          if (options.enable) {
            const rule = config.rules.find((r) => r.id === options.enable);
            if (rule) {
              rule.enabled = true;
              saveAlertConfig(config);
              writeText(`Rule "${rule.name}" enabled.`);
            } else {
              exitWithStderr(`Rule not found: ${options.enable}`);
            }
            return;
          }

          if (options.disable) {
            const rule = config.rules.find((r) => r.id === options.disable);
            if (rule) {
              rule.enabled = false;
              saveAlertConfig(config);
              writeText(`Rule "${rule.name}" disabled.`);
            } else {
              exitWithStderr(`Rule not found: ${options.disable}`);
            }
            return;
          }

          writeText('Alert Rules:');
          for (const rule of config.rules) {
            const status = rule.enabled ? '✅' : '❌';
            writeText(
              `  ${status} ${rule.id}: ${rule.name} (${rule.metric} ${rule.operator} ${rule.threshold}) [${rule.severity}]`,
            );
          }
        } catch (err) {
          const error = err as Error;
          exitWithError('告警配置管理失败', { error: error.message });
        }
      },
    );
}
