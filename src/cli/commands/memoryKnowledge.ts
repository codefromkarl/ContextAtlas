import path from 'node:path';
import {
  exitWithError,
  joinToolText,
  splitCommaSeparated,
  writeJson,
  writeText,
} from '../helpers.js';
import type { CommandRegistrar } from '../types.js';
import { logger } from '../../utils/logger.js';

export function registerMemoryKnowledgeCommands(cli: CommandRegistrar): void {
  cli
    .command('memory:prune-long-term', '批量清理过期/陈旧长期记忆')
    .option('--types <types>', '长期记忆类型，逗号分隔')
    .option('--scope <scope>', '作用域：project 或 global-user')
    .option('--include-stale', '同时清理 stale 状态的长期记忆')
    .option('--stale-days <days>', '超过多少天未核验视为 stale', { default: '30' })
    .option('--apply', '执行删除；默认仅 dry-run 预览')
    .action(async (options: Record<string, string | boolean | undefined>) => {
      const { MemoryStore } = await import('../../memory/MemoryStore.js');
      const store = new MemoryStore(process.cwd());
      const result = await store.pruneLongTermMemories({
        types:
          typeof options.types === 'string'
            ? (options.types
                .split(',')
                .map((item) => item.trim())
                .filter(Boolean) as Array<'user' | 'feedback' | 'project-state' | 'reference'>)
            : undefined,
        scope:
          options.scope === 'project' || options.scope === 'global-user'
            ? options.scope
            : undefined,
        includeExpired: true,
        includeStale: Boolean(options['include-stale']),
        staleDays:
          typeof options['stale-days'] === 'string' ? Number(options['stale-days']) || 30 : 30,
        dryRun: !options.apply,
      });

      logger.info(
        `scanned=${result.scannedCount} pruned=${result.prunedCount} dryRun=${!options.apply}`,
      );
      if (result.prunedCount > 0) {
        logger.info(`pruned ids: ${result.pruned.map((memory) => memory.id).join(', ')}`);
      }
    });

  cli
    .command('memory:record-long-term', '显式记录长期记忆（reference / project-state / feedback / user）')
    .option('--repo <path>', '目标仓库路径（默认当前目录）')
    .option('--type <type>', '长期记忆类型: user | feedback | project-state | reference')
    .option('--title <title>', '标题')
    .option('--summary <summary>', '核心摘要')
    .option('--why <why>', '为什么要记住')
    .option('--how-to-apply <text>', '后续如何应用')
    .option('--tags <tags>', '标签，逗号分隔')
    .option('--scope <scope>', '作用域: project | global-user', { default: 'project' })
    .option('--source <source>', '来源: user-explicit | agent-inferred | tool-result', {
      default: 'user-explicit',
    })
    .option('--confidence <confidence>', '置信度 0-1', { default: '1' })
    .option('--links <links>', '外部链接，逗号分隔')
    .option('--valid-from <date>', '生效时间 ISO 日期')
    .option('--valid-until <date>', '失效时间 ISO 日期')
    .option('--last-verified-at <date>', '上次核验时间 ISO 日期')
    .option('--json', '以 JSON 输出结果')
    .action(async (options: Record<string, string | boolean | undefined>) => {
      if (!options.type || !options.title || !options.summary) {
        exitWithError('缺少 --type / --title / --summary');
      }

      const repoRoot = options.repo ? path.resolve(String(options.repo)) : process.cwd();
      const { handleRecordLongTermMemory } = await import('../../mcp/tools/longTermMemory.js');
      const response = await handleRecordLongTermMemory(
        {
          type: options.type as 'user' | 'feedback' | 'project-state' | 'reference',
          title: String(options.title),
          summary: String(options.summary),
          why: typeof options.why === 'string' ? options.why : undefined,
          howToApply:
            typeof options['how-to-apply'] === 'string' ? options['how-to-apply'] : undefined,
          tags:
            typeof options.tags === 'string' ? splitCommaSeparated(options.tags) : [],
          scope:
            options.scope === 'project' || options.scope === 'global-user'
              ? options.scope
              : 'project',
          source:
            options.source === 'agent-inferred' || options.source === 'tool-result'
              ? options.source
              : 'user-explicit',
          confidence:
            typeof options.confidence === 'string' ? Number(options.confidence) || 1 : 1,
          links:
            typeof options.links === 'string' ? splitCommaSeparated(options.links) : [],
          validFrom: typeof options['valid-from'] === 'string' ? options['valid-from'] : undefined,
          validUntil:
            typeof options['valid-until'] === 'string' ? options['valid-until'] : undefined,
          lastVerifiedAt:
            typeof options['last-verified-at'] === 'string'
              ? options['last-verified-at']
              : undefined,
          format: options.json ? 'json' : 'text',
        },
        repoRoot,
      );
      writeText(joinToolText(response));
    });

  cli
    .command('feedback:record', '记录检索结果反馈（helpful / stale / wrong-module）')
    .option('--outcome <outcome>', '反馈结果: helpful | not-helpful | memory-stale | wrong-module')
    .option(
      '--target-type <type>',
      '反馈目标: code | feature-memory | decision-record | long-term-memory',
    )
    .option('--query <query>', '原始检索问题')
    .option('--target-id <id>', '目标标识，例如模块名或决策 ID')
    .option('--title <title>', '反馈标题')
    .option('--details <details>', '详细说明')
    .option('--json', '以 JSON 输出结果')
    .action(
      async (options: {
        outcome?: string;
        targetType?: string;
        query?: string;
        targetId?: string;
        title?: string;
        details?: string;
        json?: boolean;
      }) => {
        if (!options.outcome || !options.targetType || !options.query) {
          exitWithError('缺少 --outcome / --target-type / --query');
        }

        const { handleRecordResultFeedback } = await import('../../mcp/tools/feedbackLoop.js');
        const response = await handleRecordResultFeedback(
          {
            outcome: options.outcome as 'helpful' | 'not-helpful' | 'memory-stale' | 'wrong-module',
            targetType: options.targetType as
              | 'code'
              | 'feature-memory'
              | 'decision-record'
              | 'long-term-memory',
            query: options.query,
            targetId: options.targetId,
            title: options.title,
            details: options.details,
            format: options.json ? 'json' : 'text',
          },
          process.cwd(),
        );
        writeText(joinToolText(response));
      },
    );

  cli
    .command('decision:record <id>', '记录架构决策')
    .option('--title <title>', '决策标题')
    .option('--reviewer <reviewer>', '审核人 / 责任人')
    .option('--context <context>', '背景上下文')
    .option('--decision <decision>', '决策内容')
    .option('--rationale <rationale>', '决策理由')
    .option('--consequences <consequences>', '后果（逗号分隔）')
    .action(async (id: string, options: Record<string, string | undefined>) => {
      const { MemoryStore } = await import('../../memory/MemoryStore.js');
      const store = new MemoryStore(process.cwd());

      const decision = {
        id,
        date: new Date().toISOString().split('T')[0],
        reviewer: options.reviewer || undefined,
        title: options.title || '',
        context: options.context || '',
        decision: options.decision || '',
        alternatives: [],
        rationale: options.rationale || '',
        consequences: options.consequences
          ? splitCommaSeparated(options.consequences)
          : [],
        status: 'accepted' as const,
      };

      const filePath = await store.saveDecision(decision);
      logger.info(`决策记录已保存到：${filePath}`);
    });

  cli
    .command('decision:list', '列出所有架构决策')
    .option('--repo <path>', '目标仓库路径（默认当前目录）')
    .option('--reviewer <reviewer>', '按 reviewer 过滤')
    .option('--json', '以 JSON 输出结果')
    .action(async (options: { repo?: string; reviewer?: string; json?: boolean }) => {
      const { MemoryStore } = await import('../../memory/MemoryStore.js');
      const store = new MemoryStore(options.repo ? path.resolve(options.repo) : process.cwd());
      const decisions = await store.listDecisions();
      const filtered = options.reviewer
        ? decisions.filter((decision) => decision.reviewer === options.reviewer)
        : decisions;

      if (options.json) {
        writeJson({
          result_count: filtered.length,
          decisions: filtered,
        });
        return;
      }

      if (filtered.length === 0) {
        logger.info('暂无架构决策');
        return;
      }

      logger.info(`共 ${filtered.length} 个架构决策:`);
      for (const d of filtered) {
        logger.info(`  - [${d.date}] ${d.title}`);
        if (d.reviewer) {
          logger.info(`    审核人：${d.reviewer}`);
        }
        logger.info(`    决策：${d.decision}`);
        logger.info(`    理由：${d.rationale}`);
      }
    });
}
