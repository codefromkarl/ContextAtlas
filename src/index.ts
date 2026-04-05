#!/usr/bin/env node
// 配置必须最先加载（包含环境变量初始化）
import './config.js';

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cac from 'cac';
import { generateProjectId } from './db/index.js';
import { defaultConfigEnvPath, resolveBaseDir } from './runtimePaths.js';
import { type ScanStats, scanWithSnapshotSwap } from './scanner/index.js';
import { logger } from './utils/logger.js';

// 读取 package.json 获取版本号
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgPath = path.resolve(__dirname, '../package.json');
const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));

const cli = cac('contextatlas');

// 自定义版本输出，只显示版本号
if (process.argv.includes('-v') || process.argv.includes('--version')) {
  console.log(pkg.version);
  process.exit(0);
}

cli.command('init', '初始化 ContextAtlas 配置').action(async () => {
  const envFile = defaultConfigEnvPath();
  const configDir = path.dirname(envFile);

  logger.info('开始初始化 ContextAtlas...');

  // 创建配置目录
  try {
    await fs.mkdir(configDir, { recursive: true });
    logger.info(`创建配置目录: ${configDir}`);
  } catch (err) {
    const error = err as { code?: string; message?: string; stack?: string };
    if (error.code !== 'EEXIST') {
      logger.error({ err, stack: error.stack }, `创建配置目录失败: ${error.message}`);
      process.exit(1);
    }
    logger.info(`配置目录已存在: ${configDir}`);
  }

  // 检查是否已存在 .env 文件
  try {
    await fs.access(envFile);
    logger.warn(`.env 文件已存在: ${envFile}`);
    logger.info('初始化完成！');
    return;
  } catch {
    // 文件不存在，继续创建
  }

  // 写入默认 .env 配置
  const defaultEnvContent = `# ContextAtlas 示例环境变量配置文件

# Embedding API 配置（必需）
EMBEDDINGS_API_KEY=your-api-key-here
EMBEDDINGS_BASE_URL=https://api.siliconflow.cn/v1/embeddings
EMBEDDINGS_MODEL=BAAI/bge-m3
EMBEDDINGS_MAX_CONCURRENCY=10
EMBEDDINGS_BATCH_SIZE=20
EMBEDDINGS_GLOBAL_MIN_INTERVAL_MS=200
EMBEDDINGS_DIMENSIONS=1024

# Reranker 配置（必需）
RERANK_API_KEY=your-api-key-here
RERANK_BASE_URL=https://api.siliconflow.cn/v1/rerank
RERANK_MODEL=BAAI/bge-reranker-v2-m3
RERANK_TOP_N=20

# 索引忽略模式（可选，逗号分隔，默认已包含常见忽略项）
# IGNORE_PATTERNS=.venv,node_modules
`;
  try {
    await fs.writeFile(envFile, defaultEnvContent);
    logger.info(`创建 .env 文件: ${envFile}`);
  } catch (err) {
    const error = err as { message?: string; stack?: string };
    logger.error({ err, stack: error.stack }, `创建 .env 文件失败: ${error.message}`);
    process.exit(1);
  }

  logger.info('下一步操作:');
  logger.info(`   1. 编辑配置文件: ${envFile}`);
  logger.info('   2. 填写你的 API Key 和其他配置');
  logger.info('初始化完成！');
});

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
      const { withLock } = await import('./utils/lock.js');

      // 进度日志节流：只在 30%、60%、90% 时输出（100% 由扫描完成日志代替）
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

      process.stdout.write('\n');

      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      logger.info(`索引完成 (${duration}s)`);
      logger.info(
        `总数:${stats.totalFiles} 新增:${stats.added} 修改:${stats.modified} 未变:${stats.unchanged} 删除:${stats.deleted} 跳过:${stats.skipped} 错误:${stats.errors}`,
      );
    } catch (err) {
      const error = err as { message?: string; stack?: string };
      logger.error({ err, stack: error.stack }, `索引失败: ${error.message}`);
      process.exit(1);
    }
  });

cli.command('mcp', '启动 MCP 服务器').action(async () => {
  // 动态导入并启动 MCP 服务器
  const { startMcpServer } = await import('./mcp/server.js');
  try {
    await startMcpServer();
  } catch (err) {
    const error = err as { message?: string; stack?: string };
    logger.error(
      { error: error.message, stack: error.stack },
      `MCP 服务器启动失败: ${error.message}`,
    );
    process.exit(1);
  }
});

cli
  .command('daemon <action>', '索引守护进程（消费索引任务队列）')
  .action(async (action: string) => {
    const normalized = (action || '').trim().toLowerCase();
    if (!['start', 'once'].includes(normalized)) {
      logger.error(`未知 daemon 动作: ${action}，可选值: start | once`);
      process.exit(1);
    }

    const { runIndexDaemon, runIndexDaemonOnce } = await import('./indexing/daemon.js');

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

cli
  .command('search', '本地检索（参数对齐 MCP）')
  .option('--repo-path <path>', '代码库根目录（默认当前目录）')
  .option('--information-request <text>', '自然语言问题描述（必填）')
  .option('--technical-terms <terms>', '精确术语（逗号分隔）')
  .action(
    async (options: {
      repoPath?: string;
      informationRequest?: string;
      technicalTerms?: string;
    }) => {
      const repoPath = options.repoPath ? path.resolve(options.repoPath) : process.cwd();
      const informationRequest = options.informationRequest;
      if (!informationRequest) {
        logger.error('缺少 --information-request');
        process.exit(1);
      }

      const technicalTerms = (options.technicalTerms || '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);

      const { handleCodebaseRetrieval } = await import('./mcp/tools/codebaseRetrieval.js');

      const response = await handleCodebaseRetrieval({
        repo_path: repoPath,
        information_request: informationRequest,
        technical_terms: technicalTerms.length > 0 ? technicalTerms : undefined,
      });

      const text = response.content.map((item) => item.text).join('\n');
      process.stdout.write(`${text}\n`);
    },
  );

cli
  .command('monitor:retrieval', '分析 retrieval 执行效果并给出优化建议')
  .option('--file <path>', '指定日志文件路径')
  .option('--dir <path>', '指定日志目录路径')
  .option('--days <n>', '分析最近 N 天日志', { default: 1 })
  .option('--project-id <id>', '按项目 ID 前缀过滤')
  .option('--request-id <id>', '按 requestId 精确过滤')
  .option('--json', '以 JSON 输出报告')
  .action(
    async (options: {
      file?: string;
      dir?: string;
      days?: string | number;
      projectId?: string;
      requestId?: string;
      json?: boolean;
    }) => {
      const {
        analyzeRetrievalLogDirectory,
        analyzeRetrievalLogFile,
        formatRetrievalMonitorReport,
        resolveDefaultRetrievalLogFile,
      } = await import('./monitoring/retrievalMonitor.js');

      try {
        const days = Number.parseInt(String(options.days ?? '1'), 10);
        const report =
          options.dir || options.projectId || options.requestId || days > 1
            ? analyzeRetrievalLogDirectory({
                dirPath: options.dir
                  ? path.resolve(options.dir)
                  : path.join(resolveBaseDir(), 'logs'),
                days: Number.isFinite(days) && days > 0 ? days : 1,
                projectId: options.projectId,
                requestId: options.requestId,
              })
            : analyzeRetrievalLogFile(
                options.file ? path.resolve(options.file) : resolveDefaultRetrievalLogFile(),
              );

        if (options.json) {
          process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
          return;
        }

        process.stdout.write(`${formatRetrievalMonitorReport(report)}\n`);
      } catch (err) {
        const error = err as Error;
        logger.error({ error: error.message }, '生成 retrieval 监控报告失败');
        process.exit(1);
      }
    },
  );

cli
  .command('usage:index-report', '分析日常工具使用情况并生成索引优化建议')
  .option('--days <n>', '分析最近 N 天', { default: 0 })
  .option('--project-id <id>', '按项目 ID 过滤')
  .option('--json', '以 JSON 输出报告')
  .action(async (options: { days?: string | number; projectId?: string; json?: boolean }) => {
    const { analyzeIndexOptimization, formatIndexOptimizationReport } = await import(
      './usage/usageAnalysis.js'
    );
    try {
      const days = Number.parseInt(String(options.days ?? '0'), 10);
      const report = analyzeIndexOptimization({
        days: Number.isFinite(days) && days > 0 ? days : undefined,
        projectId: options.projectId,
      });
      if (options.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        return;
      }
      process.stdout.write(`${formatIndexOptimizationReport(report)}\n`);
    } catch (err) {
      const error = err as Error;
      logger.error({ error: error.message }, '生成 usage 索引优化报告失败');
      process.exit(1);
    }
  });

// ===========================================
// Observability & Health CLI Commands
// ===========================================

cli
  .command('fts:rebuild-chunks', '从当前向量索引重建 chunk FTS')
  .option('--project-id <id>', '指定项目 ID（默认根据当前目录推导）')
  .action(async (options: { projectId?: string }) => {
    const projectId = options.projectId || generateProjectId(process.cwd());

    const { resolveCurrentSnapshotId } = await import('./storage/layout.js');
    const { initDb } = await import('./db/index.js');
    const { getEmbeddingConfig } = await import('./config.js');
    const { getVectorStore } = await import('./vectorStore/index.js');
    const { rebuildChunksFtsFromVectorStore } = await import('./search/fts.js');

    try {
      const snapshotId = resolveCurrentSnapshotId(projectId);
      const db = initDb(projectId, snapshotId);
      const vectorStore = await getVectorStore(
        projectId,
        getEmbeddingConfig().dimensions,
        snapshotId,
      );
      const result = await rebuildChunksFtsFromVectorStore(db, vectorStore);
      logger.info(
        `chunks_fts 已重建：files=${result.filesProcessed} chunks=${result.chunksIndexed}`,
      );
    } catch (err) {
      const error = err as Error;
      logger.error({ error: error.message }, '重建 chunk FTS 失败');
      process.exit(1);
    }
  });

cli
  .command('health:check', '检查索引系统健康状态（队列/快照/守护进程）')
  .option('--project-id <id>', '按项目 ID 过滤')
  .option('--json', '以 JSON 输出报告')
  .action(async (options: { projectId?: string; json?: boolean }) => {
    const { analyzeIndexHealth, formatIndexHealthReport } = await import(
      './monitoring/indexHealth.js'
    );
    try {
      const report = await analyzeIndexHealth({
        projectIds: options.projectId ? [options.projectId] : undefined,
      });
      if (options.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        return;
      }
      process.stdout.write(`${formatIndexHealthReport(report)}\n`);
    } catch (err) {
      const error = err as Error;
      logger.error({ error: error.message }, '生成健康报告失败');
      process.exit(1);
    }
  });

cli
  .command('alert:eval', '评估当前指标并触发告警')
  .option('--json', '以 JSON 输出')
  .action(async (options: { json?: boolean }) => {
    const { analyzeIndexHealth } = await import('./monitoring/indexHealth.js');
    const { evaluateAlerts, formatAlertReport } = await import('./monitoring/alertEngine.js');
    try {
      const health = await analyzeIndexHealth();
      const result = evaluateAlerts(health as unknown as Record<string, unknown>);
      if (options.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }
      process.stdout.write(`${formatAlertReport(result)}\n`);
    } catch (err) {
      const error = err as Error;
      logger.error({ error: error.message }, '告警评估失败');
      process.exit(1);
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
      const { loadAlertConfig, saveAlertConfig } = await import('./monitoring/alertEngine.js');
      try {
        if (options.reset) {
          const {
            loadAlertConfig: _lc,
            saveAlertConfig: save,
            defaultConfig,
          } = await import('./monitoring/alertEngine.js');
          save(defaultConfig());
          process.stdout.write('Alert config reset to defaults.\n');
          return;
        }

        const config = loadAlertConfig();

        if (options.enable) {
          const rule = config.rules.find((r) => r.id === options.enable);
          if (rule) {
            rule.enabled = true;
            saveAlertConfig(config);
            process.stdout.write(`Rule "${rule.name}" enabled.\n`);
          } else {
            process.stderr.write(`Rule not found: ${options.enable}\n`);
            process.exit(1);
          }
          return;
        }

        if (options.disable) {
          const rule = config.rules.find((r) => r.id === options.disable);
          if (rule) {
            rule.enabled = false;
            saveAlertConfig(config);
            process.stdout.write(`Rule "${rule.name}" disabled.\n`);
          } else {
            process.stderr.write(`Rule not found: ${options.disable}\n`);
            process.exit(1);
          }
          return;
        }

        process.stdout.write('Alert Rules:\n');
        for (const rule of config.rules) {
          const status = rule.enabled ? '✅' : '❌';
          process.stdout.write(
            `  ${status} ${rule.id}: ${rule.name} (${rule.metric} ${rule.operator} ${rule.threshold}) [${rule.severity}]\n`,
          );
        }
      } catch (err) {
        const error = err as Error;
        logger.error({ error: error.message }, '告警配置管理失败');
        process.exit(1);
      }
    },
  );

// ===========================================
// Project Memory CLI Commands
// ===========================================

cli.command('memory:find <query>', '查找功能记忆').action(async (query: string) => {
  const { MemoryFinder } = await import('./memory/MemoryFinder.js');
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
  .command('memory:record <name>', '记录功能记忆')
  .option('--desc <desc>', '模块职责描述')
  .option('--dir <dir>', '源文件目录')
  .option('--files <files>', '相关文件（逗号分隔）')
  .option('--exports <exports>', '导出符号（逗号分隔）')
  .option('--imports <imports>', '内部依赖（逗号分隔）')
  .option('--external <external>', '外部依赖（逗号分隔）')
  .option('--data-flow <flow>', '数据流描述')
  .option('--patterns <patterns>', '关键模式（逗号分隔）')
  .action(async (name: string, options: Record<string, string | undefined>) => {
    const { MemoryStore } = await import('./memory/MemoryStore.js');
    const store = new MemoryStore(process.cwd());

    const memory = {
      name,
      responsibility: options.desc || '',
      location: {
        dir: options.dir || 'src/',
        files: options.files ? options.files.split(',').map((s) => s.trim()) : [],
      },
      api: {
        exports: options.exports ? options.exports.split(',').map((s) => s.trim()) : [],
        endpoints: [],
      },
      dependencies: {
        imports: options.imports ? options.imports.split(',').map((s) => s.trim()) : [],
        external: options.external ? options.external.split(',').map((s) => s.trim()) : [],
      },
      dataFlow: options.dataFlow || options['data-flow'] || '',
      keyPatterns: options.patterns ? options.patterns.split(',').map((s) => s.trim()) : [],
      lastUpdated: new Date().toISOString(),
    };

    const filePath = await store.saveFeature(memory);
    logger.info(`功能记忆已保存到：${filePath}`);
  });

cli.command('memory:list', '列出所有功能记忆').action(async () => {
  const { MemoryFinder } = await import('./memory/MemoryFinder.js');
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
    logger.info(`    更新：${new Date(m.lastUpdated).toLocaleString()}`);
  }
});

cli.command('memory:delete <name>', '删除功能记忆').action(async (name: string) => {
  const { MemoryStore } = await import('./memory/MemoryStore.js');
  const store = new MemoryStore(process.cwd());
  const deleted = await store.deleteFeature(name);

  if (!deleted) {
    logger.info(`未找到功能记忆：${name}`);
    return;
  }

  logger.info(`功能记忆已删除：${name}`);
});

cli.command('memory:rebuild-catalog', '从当前功能记忆重建 catalog').action(async () => {
  const { MemoryRouter } = await import('./memory/MemoryRouter.js');
  const router = MemoryRouter.forProject(process.cwd());
  const catalog = await router.buildCatalog();

  logger.info(
    `Catalog 已重建：${Object.keys(catalog.modules).length} 个模块，${Object.keys(catalog.scopes).length} 个 scope`,
  );
});

cli
  .command('memory:check-consistency', '检查 feature memories 与 catalog 是否一致')
  .action(async () => {
    const { MemoryStore } = await import('./memory/MemoryStore.js');
    const { MemoryRouter } = await import('./memory/MemoryRouter.js');

    const store = new MemoryStore(process.cwd());
    const router = MemoryRouter.forProject(process.cwd());
    await router.initialize();

    const features = await store.listFeatures();
    const featureNames = new Set(
      features.map((feature) => feature.name.toLowerCase().trim().replace(/\s+/g, '-')),
    );
    const catalog = router.getCatalog();
    const catalogNames = new Set(Object.keys(catalog?.modules || {}));

    const missingFromCatalog = [...featureNames].filter((name) => !catalogNames.has(name));
    const staleCatalogEntries = [...catalogNames].filter((name) => !featureNames.has(name));

    if (missingFromCatalog.length === 0 && staleCatalogEntries.length === 0) {
      logger.info('memory consistency check: OK');
      return;
    }

    if (missingFromCatalog.length > 0) {
      logger.warn(`catalog 缺失模块：${missingFromCatalog.join(', ')}`);
    }

    if (staleCatalogEntries.length > 0) {
      logger.warn(`catalog 存在陈旧模块：${staleCatalogEntries.join(', ')}`);
    }
  });

cli
  .command('memory:prune-long-term', '批量清理过期/陈旧长期记忆')
  .option('--types <types>', '长期记忆类型，逗号分隔')
  .option('--scope <scope>', '作用域：project 或 global-user')
  .option('--include-stale', '同时清理 stale 状态的长期记忆')
  .option('--stale-days <days>', '超过多少天未核验视为 stale', { default: '30' })
  .option('--apply', '执行删除；默认仅 dry-run 预览')
  .action(async (options: Record<string, string | boolean | undefined>) => {
    const { MemoryStore } = await import('./memory/MemoryStore.js');
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
        options.scope === 'project' || options.scope === 'global-user' ? options.scope : undefined,
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
  .command('decision:record <id>', '记录架构决策')
  .option('--title <title>', '决策标题')
  .option('--context <context>', '背景上下文')
  .option('--decision <decision>', '决策内容')
  .option('--rationale <rationale>', '决策理由')
  .option('--consequences <consequences>', '后果（逗号分隔）')
  .action(async (id: string, options: Record<string, string | undefined>) => {
    const { MemoryStore } = await import('./memory/MemoryStore.js');
    const store = new MemoryStore(process.cwd());

    const decision = {
      id,
      date: new Date().toISOString().split('T')[0],
      title: options.title || '',
      context: options.context || '',
      decision: options.decision || '',
      alternatives: [],
      rationale: options.rationale || '',
      consequences: options.consequences
        ? options.consequences.split(',').map((s) => s.trim())
        : [],
      status: 'accepted' as const,
    };

    const filePath = await store.saveDecision(decision);
    logger.info(`决策记录已保存到：${filePath}`);
  });

cli.command('decision:list', '列出所有架构决策').action(async () => {
  const { MemoryStore } = await import('./memory/MemoryStore.js');
  const store = new MemoryStore(process.cwd());
  const decisions = await store.listDecisions();

  if (decisions.length === 0) {
    logger.info('暂无架构决策');
    return;
  }

  logger.info(`共 ${decisions.length} 个架构决策:`);
  for (const d of decisions) {
    logger.info(`  - [${d.date}] ${d.title}`);
    logger.info(`    决策：${d.decision}`);
    logger.info(`    理由：${d.rationale}`);
  }
});

cli.command('profile:show', '显示项目档案').action(async () => {
  const { MemoryStore } = await import('./memory/MemoryStore.js');
  const store = new MemoryStore(process.cwd());
  const profile = await store.readProfile();

  if (!profile) {
    logger.info('暂无项目档案');
    return;
  }

  logger.info(`项目：${profile.name}`);
  logger.info(`描述：${profile.description}`);
  logger.info(`技术栈：${profile.techStack.language.join(', ')}`);
  logger.info(`最后更新：${new Date(profile.lastUpdated).toLocaleString()}`);
});

// ===========================================
// MemoryHubDatabase CLI Commands (Cross-Project)
// ===========================================

cli
  .command('hub:register-project <path>', '注册项目到记忆中心')
  .option('--name <name>', '项目显示名')
  .action(async (projectPath: string, options: Record<string, string | undefined>) => {
    const { MemoryHubDatabase } = await import('./memory/MemoryHubDatabase.js');
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
    const { MemoryHubDatabase } = await import('./memory/MemoryHubDatabase.js');
    const db = new MemoryHubDatabase();

    const projects = db.listProjects();
    db.close();

    if (options.json) {
      console.log(JSON.stringify({ projects }, null, 2));
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
  .command('hub:save-memory <project> <name>', '保存功能记忆')
  .option('--desc <desc>', '职责描述')
  .option('--dir <dir>', '目录')
  .option('--files <files>', '文件列表（逗号分隔）')
  .option('--type <type>', '记忆类型（local/shared/pattern/framework）')
  .action(async (project: string, name: string, options: Record<string, string | undefined>) => {
    const { MemoryHubDatabase } = await import('./memory/MemoryHubDatabase.js');
    const { MemoryStore } = await import('./memory/MemoryStore.js');
    const db = new MemoryHubDatabase();
    const projectInfo = db.getProject(project);
    db.close();

    if (!projectInfo) {
      logger.error(`未找到项目：${project}`);
      process.exit(1);
    }

    const store = new MemoryStore(projectInfo.path);
    const memory = {
      name,
      responsibility: options.desc || 'N/A',
      location: {
        dir: options.dir || 'src/',
        files: options.files ? options.files.split(',').map((s) => s.trim()) : [],
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
    const { MemoryHubDatabase } = await import('./memory/MemoryHubDatabase.js');
    const db = new MemoryHubDatabase();

    const results = db.searchMemories({
      category: options.category as string | undefined,
      moduleName: options.module as string | undefined,
      limit: options.limit as number,
    });
    db.close();

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            query: {
              category: options.category as string | undefined,
              module: options.module as string | undefined,
              limit: options.limit as number,
            },
            results,
          },
          null,
          2,
        ),
      );
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
    const { MemoryHubDatabase } = await import('./memory/MemoryHubDatabase.js');
    const db = new MemoryHubDatabase();

    // 为中文查询添加通配符（FTS5 需要）
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
      const { MemoryHubDatabase } = await import('./memory/MemoryHubDatabase.js');
      const db = new MemoryHubDatabase();

      const fromMemory = db.getMemory(fromProject, fromModule);
      if (!fromMemory) {
        logger.error(`未找到源记忆：${fromModule} in ${fromProject}`);
        db.close();
        process.exit(1);
      }

      const toMemory = db.getMemory(toProject, toModule);
      if (!toMemory) {
        logger.error(`未找到目标记忆：${toModule} in ${toProject}`);
        db.close();
        process.exit(1);
      }

      db.createRelation(fromMemory.id, toMemory.id, type as any);
      db.close();

      logger.info(`关系已创建：${fromModule} → ${toModule} (${type})`);
    },
  );

cli
  .command('hub:deps <project> <module>', '获取模块依赖链')
  .action(async (project: string, module: string) => {
    const { MemoryHubDatabase } = await import('./memory/MemoryHubDatabase.js');
    const db = new MemoryHubDatabase();

    const memory = db.getMemory(project, module);
    if (!memory) {
      logger.error(`未找到记忆：${module} in ${project}`);
      db.close();
      process.exit(1);
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

cli
  .command('hub:stats', '显示记忆中心统计信息')
  .option('--json', '以 JSON 输出结果')
  .action(async (options: { json?: boolean }) => {
    const { MemoryHubDatabase } = await import('./memory/MemoryHubDatabase.js');
    const db = new MemoryHubDatabase();
    const stats = db.getStats();
    db.close();

    if (options.json) {
      console.log(JSON.stringify({ stats }, null, 2));
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
    const { MemoryHubDatabase } = await import('./memory/MemoryHubDatabase.js');
    const db = new MemoryHubDatabase();

    if (options.dryRun) {
      const analysis = db.analyzeProjectIdentityRepairs();
      db.close();

      if (options.json) {
        console.log(JSON.stringify({ mode: 'dry-run', ...analysis }, null, 2));
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
      console.log(JSON.stringify({ mode: 'apply', ...report }, null, 2));
      return;
    }

    logger.info('项目身份修复完成:');
    logger.info(`  扫描项目数：${report.scannedProjects}`);
    logger.info(`  已规范项目数：${report.canonicalProjects}`);
    logger.info(`  修复项目数：${report.repairedProjects}`);
    logger.info(`  删除旧项目数：${report.removedProjects}`);
  });

// ===========================================
// Memory Health & Usage Purge CLI Commands
// ===========================================

cli
  .command('memory:health', '检查记忆系统健康状态')
  .option('--stale-days <days>', '超过多少天未核验视为 stale', { default: '30' })
  .option('--json', '以 JSON 输出报告')
  .action(async (options: { staleDays?: string; json?: boolean }) => {
    const { analyzeMemoryHealth, formatMemoryHealthReport } = await import(
      './monitoring/memoryHealth.js'
    );
    try {
      const staleDays = Number.parseInt(String(options.staleDays ?? '30'), 10);
      const report = await analyzeMemoryHealth({
        staleDays: Number.isFinite(staleDays) && staleDays > 0 ? staleDays : 30,
      });
      if (options.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        return;
      }
      process.stdout.write(`${formatMemoryHealthReport(report)}\n`);
    } catch (err) {
      const error = err as Error;
      logger.error({ error: error.message }, '生成记忆健康报告失败');
      process.exit(1);
    }
  });

cli
  .command('usage:purge', '清理过期的 usage 追踪数据')
  .option('--days <n>', '保留最近 N 天的数据（默认 90）', { default: '90' })
  .option('--apply', '执行删除；默认仅 dry-run 预览')
  .action(async (options: { days?: string; apply?: boolean }) => {
    const { getUsageStats, purgeOldUsageEvents } = await import('./usage/usageTracker.js');
    try {
      const days = Number.parseInt(String(options.days ?? '90'), 10);
      if (!Number.isFinite(days) || days <= 0) {
        logger.error('--days 必须为正整数');
        process.exit(1);
      }

      const stats = getUsageStats();
      logger.info(
        `当前 usage 数据: ${stats.toolUsageCount} tool events, ${stats.indexUsageCount} index events`,
      );
      logger.info(`时间范围: ${stats.oldestDay || 'N/A'} ~ ${stats.newestDay || 'N/A'}`);

      if (options.apply) {
        const result = purgeOldUsageEvents(days);
        logger.info(
          `已清理: ${result.toolPurged} tool events, ${result.indexPurged} index events (cutoff: ${result.cutoffDay})`,
        );
      } else {
        logger.info(`[dry-run] 将保留最近 ${days} 天数据`);
        if (stats.oldestDay) {
          const cutoffDate = new Date();
          cutoffDate.setDate(cutoffDate.getDate() - days);
          const cutoffDay = cutoffDate.toISOString().slice(0, 10);
          logger.info(`[dry-run] 将清理 ${stats.oldestDay} ~ ${cutoffDay} 之前的数据`);
        }
        logger.info('使用 --apply 执行实际删除');
      }
    } catch (err) {
      const error = err as Error;
      logger.error({ error: error.message }, 'usage 数据清理失败');
      process.exit(1);
    }
  });

cli
  .command('health:full', '系统全面健康检查（索引 + 记忆 + 告警）')
  .option('--stale-days <days>', '记忆 stale 阈值天数', { default: '30' })
  .option('--json', '以 JSON 输出报告')
  .action(async (options: { staleDays?: string; json?: boolean }) => {
    const { analyzeIndexHealth, formatIndexHealthReport } = await import(
      './monitoring/indexHealth.js'
    );
    const { analyzeMemoryHealth, formatMemoryHealthReport } = await import(
      './monitoring/memoryHealth.js'
    );
    const { evaluateAlerts, formatAlertReport } = await import('./monitoring/alertEngine.js');

    try {
      const staleDays = Number.parseInt(String(options.staleDays ?? '30'), 10);

      // Run all analyses in parallel
      const [indexHealth, memoryHealth] = await Promise.all([
        analyzeIndexHealth(),
        analyzeMemoryHealth({
          staleDays: Number.isFinite(staleDays) && staleDays > 0 ? staleDays : 30,
        }),
      ]);

      // Combine metrics for alert evaluation
      const combinedMetrics: Record<string, unknown> = {
        ...indexHealth,
        memory: {
          staleRate: memoryHealth.longTermFreshness.staleRate,
          expiredRate: memoryHealth.longTermFreshness.expiredRate,
          orphanedRate: memoryHealth.featureMemoryHealth.orphanedRate,
          catalogInconsistent: !memoryHealth.catalogConsistency.isConsistent,
        },
      };

      const alertResult = evaluateAlerts(combinedMetrics);

      if (options.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              indexHealth,
              memoryHealth,
              alerts: alertResult,
            },
            null,
            2,
          )}\n`,
        );
        return;
      }

      process.stdout.write('='.repeat(60) + '\n');
      process.stdout.write('Full System Health Report\n');
      process.stdout.write('='.repeat(60) + '\n\n');

      process.stdout.write(formatIndexHealthReport(indexHealth));
      process.stdout.write('\n\n');

      process.stdout.write(formatMemoryHealthReport(memoryHealth));
      process.stdout.write('\n\n');

      process.stdout.write(formatAlertReport(alertResult));
      process.stdout.write('\n');
    } catch (err) {
      const error = err as Error;
      logger.error({ error: error.message }, '系统健康检查失败');
      process.exit(1);
    }
  });

cli.help();
cli.parse();
