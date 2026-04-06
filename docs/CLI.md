# CLI 命令参考

## 安装与初始化

```bash
npm install -g @codefromkarl/context-atlas
contextatlas init
```

配置文件位于 `~/.contextatlas/.env`，详见 [README.md](../README.md#配置)。

产品身份映射：

- 仓库名：`ContextAtlas`
- npm 包名：`@codefromkarl/context-atlas`
- CLI 命令：`contextatlas`

如果你是第一次接入，先看 [首次使用](./FIRST_USE.md)。

## 检索与索引

```bash
# 主路径入口
contextatlas start [path]

# 索引代码库
contextatlas index [path]
contextatlas index --force          # 强制全量索引
contextatlas index:plan [path]      # 分析应走全量还是增量，并显示受影响模块
contextatlas index:plan [path] --json
contextatlas index:update [path]    # 按当前仓库变化自动入队 full / incremental 索引任务
contextatlas index:update [path] --json

# 守护进程（后台消费索引队列）
contextatlas daemon start
contextatlas daemon once            # 单次执行

# 本地搜索
contextatlas search --information-request "用户认证流程是如何实现的？"
contextatlas search \
  --repo-path /path/to/repo \
  --information-request "数据库连接逻辑" \
  --technical-terms "DatabasePool,Connection"
contextatlas search \
  --repo-path /path/to/repo \
  --information-request "支付重试逻辑" \
  --json
```

其中 `cw` 仍然可用，但文档默认统一使用 `contextatlas`。

补充说明：

- `contextatlas search --json` 会输出脚本友好的结构化载荷，包含查询参数、原始 `content` 数组和拼接后的 `text`
- 交互式 TTY 下直接执行 `contextatlas` 会显示 `start` 引导
- 非 TTY 环境下直接执行 `contextatlas` 会自动切换到 MCP stdio 模式，便于 Claude Desktop / Cursor 之类客户端直接拉起

`contextatlas start [path]` 现在会直接给出默认闭环入口：

- 当前仓库与 `projectId`
- 索引状态与当前模式
- `Connect Repo → Check Index Status → Ask → Review Result → Give Feedback / Save Memory`
- 可直接复制的 `feedback:record`、`decision:record`、`memory:record-long-term` 命令

`contextatlas index:plan --json` 会返回结构化结果，核心字段包括：

- `mode`: `none` / `incremental` / `full`
- `reasons`: 触发当前模式的原因码和说明
- `schemaStatus.snapshot`: 当前使用 `snapshot` 还是 `legacy` 布局，以及 `vectors.lance` 是否存在
- `schemaStatus.embeddings`: 当前 embedding 维度与已存储维度是否兼容
- `schemaStatus.contentSchema`: 当前 AST / semantic chunking 内容 schema 版本是否兼容
- `schemaStatus.memoryCatalog`: catalog schema 版本、drift 计数，以及 `missingModuleNames` / `staleModuleNames`
- `impactedMemories`: 受影响模块记忆、命中原因、影响范围（`direct` / `routed` / `broad-review`）和对应文件路径

`contextatlas index:update [path]` 会在 `index:plan` 的基础上直接执行日常触发策略：

- repo 文件新增 / 修改 / 删除时自动入队 `incremental`
- embedding schema、AST/chunking content schema 或向量索引漂移时自动入队 `full`
- 无变化时明确返回“不入队”
- 文本和 JSON 输出都会显示计划结论以及是否复用了已有队列任务
- `full` / schema drift 场景会额外提示需要“广泛复核”的 feature memories（`broad-review`）

## 项目记忆

```bash
contextatlas memory:find "auth"
contextatlas memory:suggest "Auth Module" --files "src/auth/auth.service.ts"
contextatlas memory:record "Auth Module" --desc "用户认证" --dir "src/auth"
contextatlas memory:record "SearchService" --desc "混合检索核心" --dir "src/search" --confirmation-status human-confirmed
contextatlas memory:record-long-term --type reference --title "Grafana Dashboard" --summary "Dashboard URL https://grafana.example.com/d/abc123"
contextatlas memory:list
contextatlas memory:delete "Auth Module"
contextatlas memory:rebuild-catalog
contextatlas memory:check-consistency
contextatlas memory:prune-long-term --include-stale
contextatlas feedback:record \
  --outcome memory-stale \
  --target-type feature-memory \
  --query "Trace retrieval flow" \
  --target-id "SearchService" \
  --details "记忆仍指向旧路径"
```

主路径默认优先建议写入：

- 先用 `memory:suggest` 看建议，再决定是否 `memory:record`
- `memory:list` / 检索结果卡片会外显 `复核状态`
- 当代码路径与既有 feature memory 明显漂移时，系统会自动把该记忆标成 `needs-review`

## 架构决策与项目档案

```bash
contextatlas decision:record "2026-04-02-memory-routing" \
  --title "引入渐进式记忆路由" \
  --reviewer "ops-lead" \
  --context "需要控制代理加载的上下文大小" \
  --decision "使用 catalog -> global -> feature 三层加载" \
  --rationale "先路由再按需加载，减少 token 开销"

contextatlas decision:list
contextatlas profile:record --name "ContextAtlas" --desc "AI 检索基础设施" --readonly
contextatlas profile:show
contextatlas profile:show --json
contextatlas profile:import-omc
contextatlas profile:import-omc --force
```

当 `profile.governance.personalMemory` 被设置后，`memory:record-long-term` 和对应 MCP 写入入口在未显式传 `scope` 时会默认继承该作用域。

## 跨项目 Hub

```bash
contextatlas hub:register-project /path/to/project --name "My Project"
contextatlas hub:list-projects
contextatlas hub:save-memory <projectId> "SearchService" --desc "混合搜索核心" --dir "src/search"
contextatlas hub:search --category search
contextatlas hub:fts "向量 搜索"
contextatlas hub:link <fromProject> <fromModule> <toProject> <toModule> depends_on
contextatlas hub:deps <projectId> <moduleName>
contextatlas hub:stats
contextatlas hub:repair-project-identities --dry-run
```

## 观测与优化

```bash
# Retrieval 监控
contextatlas monitor:retrieval
contextatlas monitor:retrieval --json
contextatlas monitor:retrieval --days 7
contextatlas monitor:retrieval --dir ~/.contextatlas/logs --days 7
contextatlas monitor:retrieval --days 7 --project-id <projectId>
contextatlas monitor:retrieval --dir ~/.contextatlas/logs --request-id <requestId> --json

# 使用追踪与索引优化
contextatlas usage:index-report
contextatlas usage:index-report --json
contextatlas usage:index-report --days 7
contextatlas usage:index-report --days 7 --project-id <projectId>

# 索引健康度
contextatlas health:check
contextatlas health:check --json
contextatlas health:check --project-id <projectId>

# 团队运维摘要
contextatlas ops:summary
contextatlas ops:summary --json
contextatlas ops:summary --days 7 --stale-days 30
contextatlas ops:apply start-daemon
contextatlas ops:apply rebuild-chunk-fts --project-id <projectId>
contextatlas ops:apply rebuild-memory-catalog --skip-verify

# 团队级稳定指标
contextatlas ops:metrics
contextatlas ops:metrics --json
contextatlas ops:metrics --days 7 --stale-days 30

# 告警评估
contextatlas alert:eval
contextatlas alert:eval --json

# 告警配置
contextatlas alert:config --list
contextatlas alert:config --enable <rule-id>
contextatlas alert:config --disable <rule-id>
contextatlas alert:config --reset
```

`contextatlas ops:metrics` 现在会输出团队级质量指标，包括：

- 查询成功率
- 空结果率
- 用户纠错率
- memory stale 比例
- 查询延迟
- 索引失败率
- 仓库质量分布（repo quality distribution）
- 模块质量分布（module quality distribution）

模块质量分布会综合：

- `reviewStatus`（如 `needs-review`）
- 与模块绑定的反馈信号（如 `memory-stale` / `wrong-module` / `not-helpful`）

用于识别需要优先复核的 feature memories。

默认 `contextatlas search` / MCP `codebase-retrieval` 结果卡片现在会固定补充：

- `Source` 层级：Code / Feature Memory / Decision Record / Long-term Memory / Cross-project Hub
- 可信规则：`Code > Feature Memory > Decision Record > Long-term Memory`
- freshness / conflict / confidence 信号
- 下一步动作：helpful / not-helpful / memory-stale / wrong-module / save decision / save reference

`contextatlas health:check` 现在会直接输出一份面向运维的索引健康面板，除队列、快照和 daemon 状态外，还会显示每个项目：

- 总览状态（当前状态 / 队列长度 / 最近成功索引）
- 最近失败任务
- 最近一次成功索引时间
- 最近一次成功索引的模式：`full` / `incremental`
- 当前快照版本与 chunk FTS 覆盖情况
- 建议恢复路径（如启动 daemon、重建 chunk FTS、强制重建索引）

## MCP 服务器

```bash
contextatlas mcp
```

MCP 工具详情见 [MCP.md](./MCP.md)。

## 开发命令

```bash
pnpm build
pnpm build:release
pnpm release:gate
pnpm smoke:release
pnpm dev
node dist/index.js
```

`pnpm release:gate` 会按阶段执行发布门禁，并输出结构化报告：

- `build`
- `test`
- `smoke`

其中 smoke 会显式覆盖：

- CLI 基础启动
- daemon 帮助路径
- MCP 帮助路径
- monitoring 健康/检索命令
- 冷启动搜索降级路径

失败时会直接标明是 `build` / `test` / `smoke` 哪一阶段失败；若是 smoke，还会显示失败的 step 名称。
