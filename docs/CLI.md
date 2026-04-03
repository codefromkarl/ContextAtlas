# CLI 命令参考

## 安装与初始化

```bash
npm install -g @codefromkarl/context-atlas
contextatlas init
```

配置文件位于 `~/.contextatlas/.env`，详见 [README.md](../README.md#配置)。

## 检索与索引

```bash
# 索引代码库
contextatlas index [path]
contextatlas index --force          # 强制全量索引

# 守护进程（后台消费索引队列）
contextatlas daemon start
contextatlas daemon once            # 单次执行

# 本地搜索
cw search --information-request "用户认证流程是如何实现的？"
cw search \
  --repo-path /path/to/repo \
  --information-request "数据库连接逻辑" \
  --technical-terms "DatabasePool,Connection"
```

## 项目记忆

```bash
contextatlas memory:find "auth"
contextatlas memory:record "Auth Module" --desc "用户认证" --dir "src/auth"
contextatlas memory:list
contextatlas memory:delete "Auth Module"
contextatlas memory:rebuild-catalog
contextatlas memory:check-consistency
contextatlas memory:prune-long-term --include-stale
```

## 架构决策与项目档案

```bash
contextatlas decision:record "2026-04-02-memory-routing" \
  --title "引入渐进式记忆路由" \
  --context "需要控制代理加载的上下文大小" \
  --decision "使用 catalog -> global -> feature 三层加载" \
  --rationale "先路由再按需加载，减少 token 开销"

contextatlas decision:list
contextatlas profile:show
```

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
```

## MCP 服务器

```bash
contextatlas mcp
```

MCP 工具详情见 [MCP.md](./MCP.md)。

## 开发命令

```bash
pnpm build
pnpm build:release
pnpm dev
node dist/index.js
```
