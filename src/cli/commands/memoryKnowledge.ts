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
                .filter(Boolean) as Array<
                  'user' | 'feedback' | 'project-state' | 'reference' | 'journal' | 'evidence' | 'temporal-fact'
                >)
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
    .command('memory:record-long-term', '显式记录长期记忆（reference / project-state / feedback / user / journal / evidence / temporal-fact）')
    .option('--repo <path>', '目标仓库路径（默认当前目录）')
    .option('--type <type>', '长期记忆类型: user | feedback | project-state | reference | journal | evidence | temporal-fact')
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
    .option('--fact-key <key>', '时态事实或证据条目的稳定键')
    .option('--json', '以 JSON 输出结果')
    .action(async (options: Record<string, string | boolean | undefined>) => {
      if (!options.type || !options.title || !options.summary) {
        exitWithError('缺少 --type / --title / --summary');
      }

      const repoRoot = options.repo ? path.resolve(String(options.repo)) : process.cwd();
      const { executeRecordLongTermMemory } = await import('../../application/memory/executeLongTermMemory.js');
      const response = await executeRecordLongTermMemory(
        {
          type: options.type as
            | 'user'
            | 'feedback'
            | 'project-state'
            | 'reference'
            | 'journal'
            | 'evidence'
            | 'temporal-fact',
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
          factKey: typeof options['fact-key'] === 'string' ? options['fact-key'] : undefined,
          format: options.json ? 'json' : 'text',
        },
        repoRoot,
      );
      writeText(joinToolText(response));
    });

  cli
    .command('memory:diary-write', '记录 agent diary 条目')
    .option('--repo <path>', '目标仓库路径（默认当前目录）')
    .option('--agent <name>', 'agent 名称')
    .option('--entry <text>', '日志内容')
    .option('--topic <topic>', '主题', { default: 'general' })
    .option('--scope <scope>', '作用域: project | global-user', { default: 'project' })
    .option('--tags <tags>', '标签，逗号分隔')
    .option('--json', '以 JSON 输出结果')
    .action(async (options: Record<string, string | boolean | undefined>) => {
      if (!options.agent || !options.entry) {
        exitWithError('缺少 --agent / --entry');
      }

      const repoRoot = options.repo ? path.resolve(String(options.repo)) : process.cwd();
      const { executeRecordAgentDiary } = await import('../../application/memory/executeAgentDiary.js');
      const response = await executeRecordAgentDiary(
        {
          agent_name: String(options.agent),
          entry: String(options.entry),
          topic: typeof options.topic === 'string' ? options.topic : 'general',
          scope:
            options.scope === 'project' || options.scope === 'global-user'
              ? options.scope
              : 'project',
          tags: typeof options.tags === 'string' ? splitCommaSeparated(options.tags) : [],
          format: options.json ? 'json' : 'text',
        },
        repoRoot,
      );
      writeText(joinToolText(response));
    });

  cli
    .command('memory:diary-read', '读取 agent diary 条目')
    .option('--repo <path>', '目标仓库路径（默认当前目录）')
    .option('--agent <name>', 'agent 名称')
    .option('--topic <topic>', '主题过滤')
    .option('--last-n <count>', '读取最近多少条', { default: '10' })
    .option('--scope <scope>', '作用域: project | global-user', { default: 'project' })
    .option('--json', '以 JSON 输出结果')
    .action(async (options: Record<string, string | boolean | undefined>) => {
      if (!options.agent) {
        exitWithError('缺少 --agent');
      }

      const repoRoot = options.repo ? path.resolve(String(options.repo)) : process.cwd();
      const { executeReadAgentDiary } = await import('../../application/memory/executeAgentDiary.js');
      const response = await executeReadAgentDiary(
        {
          agent_name: String(options.agent),
          topic: typeof options.topic === 'string' ? options.topic : undefined,
          last_n: typeof options['last-n'] === 'string' ? Number(options['last-n']) || 10 : 10,
          scope:
            options.scope === 'project' || options.scope === 'global-user'
              ? options.scope
              : 'project',
          format: options.json ? 'json' : 'text',
        },
        repoRoot,
      );
      writeText(joinToolText(response));
    });

  cli
    .command('memory:diary-find', '搜索 agent diary 条目')
    .option('--repo <path>', '目标仓库路径（默认当前目录）')
    .option('--query <query>', '搜索词')
    .option('--agent <name>', 'agent 名称')
    .option('--topic <topic>', '主题过滤')
    .option('--limit <count>', '最大返回条数', { default: '10' })
    .option('--scope <scope>', '作用域: project | global-user', { default: 'project' })
    .option('--json', '以 JSON 输出结果')
    .action(async (options: Record<string, string | boolean | undefined>) => {
      if (!options.query) {
        exitWithError('缺少 --query');
      }

      const repoRoot = options.repo ? path.resolve(String(options.repo)) : process.cwd();
      const { executeFindAgentDiary } = await import('../../application/memory/executeAgentDiary.js');
      const response = await executeFindAgentDiary(
        {
          query: String(options.query),
          agent_name: typeof options.agent === 'string' ? options.agent : undefined,
          topic: typeof options.topic === 'string' ? options.topic : undefined,
          limit: typeof options.limit === 'string' ? Number(options.limit) || 10 : 10,
          scope:
            options.scope === 'project' || options.scope === 'global-user'
              ? options.scope
              : 'project',
          format: options.json ? 'json' : 'text',
        },
        repoRoot,
      );
      writeText(joinToolText(response));
    });

  cli
    .command('memory:invalidate-long-term', '将长期记忆条目标记为失效')
    .option('--repo <path>', '目标仓库路径（默认当前目录）')
    .option('--type <type>', '长期记忆类型')
    .option('--id <id>', '条目 ID')
    .option('--fact-key <key>', '时态事实稳定键')
    .option('--scope <scope>', '作用域: project | global-user', { default: 'project' })
    .option('--ended <date>', '失效时间 ISO 日期')
    .option('--reason <text>', '失效原因')
    .option('--json', '以 JSON 输出结果')
    .action(async (options: Record<string, string | boolean | undefined>) => {
      if (!options.type || (!options.id && !options['fact-key'])) {
        exitWithError('缺少 --type，且必须提供 --id 或 --fact-key');
      }

      const repoRoot = options.repo ? path.resolve(String(options.repo)) : process.cwd();
      const { executeManageLongTermMemory } = await import('../../application/memory/executeLongTermMemory.js');
      const response = await executeManageLongTermMemory(
        {
          action: 'invalidate',
          types: [
            options.type as
              | 'user'
              | 'feedback'
              | 'project-state'
              | 'reference'
              | 'journal'
              | 'evidence'
              | 'temporal-fact',
          ],
          id: typeof options.id === 'string' ? options.id : undefined,
          factKey: typeof options['fact-key'] === 'string' ? options['fact-key'] : undefined,
          scope:
            options.scope === 'project' || options.scope === 'global-user'
              ? options.scope
              : 'project',
          ended: typeof options.ended === 'string' ? options.ended : undefined,
          reason: typeof options.reason === 'string' ? options.reason : undefined,
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

        const { executeRecordResultFeedback } = await import('../../application/memory/executeFeedbackLoop.js');
        const response = await executeRecordResultFeedback(
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
    .option('--owner <owner>', '责任人')
    .option('--reviewer <reviewer>', '审核人')
    .option('--context <context>', '背景上下文')
    .option('--decision <decision>', '决策内容')
    .option('--rationale <rationale>', '决策理由')
    .option('--consequences <consequences>', '后果（逗号分隔）')
    .action(async (id: string, options: Record<string, string | undefined>) => {
      const { executeRecordDecision } = await import('../../application/memory/executeProjectMemory.js');
      const response = await executeRecordDecision(
        {
          id,
          title: options.title || '',
          context: options.context || '',
          decision: options.decision || '',
          alternatives: [],
          rationale: options.rationale || '',
          consequences: options.consequences
            ? splitCommaSeparated(options.consequences)
            : [],
          owner: options.owner || undefined,
          reviewer: options.reviewer || undefined,
        },
        process.cwd(),
      );

      writeText(joinToolText(response));
    });

  cli
    .command('decision:list', '列出所有架构决策')
    .option('--repo <path>', '目标仓库路径（默认当前目录）')
    .option('--owner <owner>', '按 owner 过滤')
    .option('--reviewer <reviewer>', '按 reviewer 过滤')
    .option('--json', '以 JSON 输出结果')
    .action(async (options: { repo?: string; owner?: string; reviewer?: string; json?: boolean }) => {
      const { MemoryStore } = await import('../../memory/MemoryStore.js');
      const store = new MemoryStore(options.repo ? path.resolve(options.repo) : process.cwd());
      const decisions = await store.listDecisions();
      const filtered = decisions.filter((decision) => {
        if (options.owner && decision.owner !== options.owner) {
          return false;
        }
        if (options.reviewer && decision.reviewer !== options.reviewer) {
          return false;
        }
        return true;
      });

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
        if (d.owner) {
          logger.info(`    责任人：${d.owner}`);
        }
        if (d.reviewer) {
          logger.info(`    审核人：${d.reviewer}`);
        }
        logger.info(`    决策：${d.decision}`);
        logger.info(`    理由：${d.rationale}`);
      }
    });

  cli
    .command('memory:create-checkpoint', '创建任务检查点')
    .option('--repo <path>', '目标仓库路径（默认当前目录）')
    .option('--title <title>', '检查点标题')
    .option('--goal <goal>', '任务目标')
    .option('--phase <phase>', '阶段: overview | research | debug | implementation | verification | handoff')
    .option('--summary <summary>', '检查点摘要')
    .option('--active-block-ids <ids>', '激活的上下文块 ID，逗号分隔')
    .option('--explored-refs <refs>', '已探索引用，逗号分隔')
    .option('--supporting-refs <refs>', '支持性证据引用，逗号分隔')
    .option('--key-findings <items>', '关键发现，逗号分隔')
    .option('--unresolved-questions <items>', '未解决问题，逗号分隔')
    .option('--next-steps <items>', '下一步，逗号分隔')
    .option('--json', '以 JSON 输出结果')
    .action(async (options: Record<string, string | boolean | undefined>) => {
      if (!options.title || !options.goal || !options.phase || !options.summary) {
        exitWithError('缺少 --title / --goal / --phase / --summary');
      }

      const phase = options.phase;
      if (
        phase !== 'overview' &&
        phase !== 'research' &&
        phase !== 'debug' &&
        phase !== 'implementation' &&
        phase !== 'verification' &&
        phase !== 'handoff'
      ) {
        exitWithError(`不支持的 --phase: ${phase}`);
      }

      const { executeCreateCheckpoint } = await import('../../application/memory/executeCheckpoints.js');
      const response = await executeCreateCheckpoint({
        repo_path: options.repo ? path.resolve(String(options.repo)) : process.cwd(),
        title: String(options.title),
        goal: String(options.goal),
        phase,
        summary: String(options.summary),
        activeBlockIds: splitCommaSeparated(typeof options['active-block-ids'] === 'string' ? options['active-block-ids'] : undefined),
        exploredRefs: splitCommaSeparated(typeof options['explored-refs'] === 'string' ? options['explored-refs'] : undefined),
        supportingRefs: splitCommaSeparated(typeof options['supporting-refs'] === 'string' ? options['supporting-refs'] : undefined),
        keyFindings: splitCommaSeparated(typeof options['key-findings'] === 'string' ? options['key-findings'] : undefined),
        unresolvedQuestions: splitCommaSeparated(typeof options['unresolved-questions'] === 'string' ? options['unresolved-questions'] : undefined),
        nextSteps: splitCommaSeparated(typeof options['next-steps'] === 'string' ? options['next-steps'] : undefined),
        format: options.json ? 'json' : 'text',
      });
      writeText(joinToolText(response));
    });

  cli
    .command('memory:load-checkpoint <checkpointId>', '加载任务检查点')
    .option('--repo <path>', '目标仓库路径（默认当前目录）')
    .option('--json', '以 JSON 输出结果')
    .action(async (checkpointId: string, options: Record<string, string | boolean | undefined>) => {
      const { executeLoadCheckpoint } = await import('../../application/memory/executeCheckpoints.js');
      const response = await executeLoadCheckpoint({
        repo_path: options.repo ? path.resolve(String(options.repo)) : process.cwd(),
        checkpoint_id: checkpointId,
        format: options.json ? 'json' : 'text',
      });
      writeText(joinToolText(response));
    });

  cli
    .command('memory:list-checkpoints', '列出任务检查点')
    .option('--repo <path>', '目标仓库路径（默认当前目录）')
    .option('--json', '以 JSON 输出结果')
    .action(async (options: Record<string, string | boolean | undefined>) => {
      const { executeListCheckpoints } = await import('../../application/memory/executeCheckpoints.js');
      const response = await executeListCheckpoints({
        repo_path: options.repo ? path.resolve(String(options.repo)) : process.cwd(),
        format: options.json ? 'json' : 'text',
      });
      writeText(joinToolText(response));
    });
}
