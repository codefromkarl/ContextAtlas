# 首次使用

这份文档面向第一次接入 ContextAtlas 的用户，目标是在 10 分钟内跑通默认闭环：

`Connect Repo -> Check Index Status -> Ask -> Review Result -> Give Feedback / Save Memory`

## 先认清三个名字

- 仓库名：`ContextAtlas`
- npm 包名：`@codefromkarl/context-atlas`
- CLI 命令：`contextatlas`

兼容短别名 `cw` 仍然可用，但默认文档、示例命令和 MCP 配置统一使用 `contextatlas`。

## 1. 安装

```bash
npm install -g @codefromkarl/context-atlas
```

安装完成后，主要使用的命令是：

```bash
contextatlas
```

## 2. 初始化配置

```bash
contextatlas init
```

默认配置文件会生成到：

```bash
~/.contextatlas/.env
```

至少需要填写：

```bash
EMBEDDINGS_API_KEY=
EMBEDDINGS_BASE_URL=
EMBEDDINGS_MODEL=

RERANK_API_KEY=
RERANK_BASE_URL=
RERANK_MODEL=
```

如果你想调节 `index:plan` / `index:update` 在“高 churn”或“增量成本接近全量”时何时升级为 `full`，还可以额外配置：

```bash
INDEX_UPDATE_CHURN_THRESHOLD=0.35
INDEX_UPDATE_COST_RATIO_THRESHOLD=0.65
INDEX_UPDATE_MIN_FILES=8
INDEX_UPDATE_MIN_CHANGED_FILES=5
```

## 3. 用 `start` 看当前仓库状态

```bash
contextatlas start /path/to/repo
```

这个入口会直接告诉你：

- 当前连接的是哪个仓库
- 对应的 `projectId`
- 索引是否已就绪
- 当前是完整模式还是部分词法模式
- 下一步该执行什么命令

## 4. 建索引并保持后台更新

```bash
contextatlas index /path/to/repo
contextatlas daemon start
```

如果你想先判断是全量还是增量，可以先看：

```bash
contextatlas index:plan /path/to/repo --json
```

如果索引已经入队但你想知道系统卡在哪，可以直接看：

```bash
contextatlas task:status --project-id <projectId>
contextatlas task:inspect <taskId>
contextatlas health:check --project-id <projectId>
```

## 5. 发起第一次检索

```bash
contextatlas search \
  --repo-path /path/to/repo \
  --information-request "用户认证流程是如何实现的？"
```

如果你已经知道精确标识符，也可以补上：

```bash
contextatlas search \
  --repo-path /path/to/repo \
  --information-request "数据库连接逻辑" \
  --technical-terms "DatabasePool,Connection"
```

## 6. 看结果卡片，而不是只看代码片段

默认主路径下，结果卡片会固定展示：

- 代码命中
- 相关模块记忆
- 相关决策记录
- 为什么命中这些结果
- 来源层级与可信规则
- 下一步反馈或沉淀命令

如果索引还没完成，系统会先返回可用的部分词法结果，并明确告诉你当前还在冷启动阶段。

## 7. 做一次最小反馈闭环

```bash
contextatlas feedback:record \
  --outcome helpful \
  --target-type code \
  --query "用户认证流程是如何实现的？"
```

如果你确认某个模块结论值得沉淀，再记录记忆：

```bash
contextatlas memory:record "Auth Module" --desc "用户认证模块" --dir "src/auth"
```

## 常见下一步

- 想排查“索引为什么还没好”：先用 `contextatlas task:status` / `contextatlas task:inspect <taskId>`
- 想看当前项目的文本存储占比：用 `contextatlas storage:analyze --project-id <projectId>`
- 想跑最小离线性能基准：用 `contextatlas perf:benchmark --size small --scenario noop --json`
- 想看所有命令：见 [CLI 命令参考](../reference/cli.md)
- 想接入 Claude Desktop / Cursor / Windsurf：见 [部署手册](../guides/deployment.md)
- 想了解 MCP 工具：见 [MCP 工具参考](../reference/mcp.md)
