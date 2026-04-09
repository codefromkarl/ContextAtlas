# 部署手册

## 目录

- [环境要求](#环境要求)
- [安装方式](#安装方式)
- [配置详解](#配置详解)
- [部署场景](#部署场景)
  - [场景一：本地 CLI 使用](#场景一本地-cli-使用)
  - [场景一补充：Embedding Gateway](#场景一补充embedding-gateway)
  - [场景二：Claude Desktop MCP 集成](#场景二claude-desktop-mcp-集成)
  - [场景三：Cursor / Windsurf MCP 集成](#场景三cursor--windsurf-mcp-集成)
  - [场景四：多项目共享 Hub](#场景四多项目共享-hub)
  - [场景五：CI/CD 预索引](#场景五cicd-预索引)
- [配套提示词](#配套提示词)
  - [系统提示词模板](#系统提示词模板)
  - [工具使用策略提示词](#工具使用策略提示词)
  - [记忆记录提示词](#记忆记录提示词)
- [运维与监控](#运维与监控)
- [故障排查](#故障排查)

---

## 环境要求

| 组件 | 最低版本 | 推荐版本 |
|------|---------|---------|
| Node.js | 20.x | 22.x LTS |
| pnpm | 8.x | 10.x |
| 磁盘空间 | 2 GB | 5 GB（含索引） |
| 内存 | 4 GB | 8 GB（大型项目） |

---

如果你是第一次接入，建议先读 [首次使用](../guides/first-use.md)，再回到本页选择部署场景。

产品身份映射：

- 仓库名：`ContextAtlas`
- npm 包名：`@codefromkarl/context-atlas`
- CLI 命令：`contextatlas`

---

## 安装方式

### npm 全局安装（推荐）

```bash
npm install -g @codefromkarl/context-atlas
```

### pnpm 全局安装

```bash
pnpm add -g @codefromkarl/context-atlas
```

### 从源码构建

```bash
git clone https://github.com/codefromkarl/ContextAtlas.git
cd ContextAtlas
pnpm install
pnpm build
# 使用
node dist/index.js
```

---

## 配置详解

运行 `contextatlas init` 后生成 `~/.contextatlas/.env`：

```bash
# ─── Embedding API ─────────────────────────────────────────
EMBEDDINGS_API_KEY=your-api-key
EMBEDDINGS_BASE_URL=https://api.siliconflow.cn/v1/embeddings
EMBEDDINGS_MODEL=BAAI/bge-m3
EMBEDDINGS_MAX_CONCURRENCY=10        # 并发请求数，根据 API 配额调整
EMBEDDINGS_BATCH_SIZE=20             # 每批处理文件数
EMBEDDINGS_GLOBAL_MIN_INTERVAL_MS=200 # 请求间隔（ms），避免限流
EMBEDDINGS_DIMENSIONS=1024           # 向量维度

# ─── Rerank API ────────────────────────────────────────────
RERANK_API_KEY=your-api-key
RERANK_BASE_URL=https://api.siliconflow.cn/v1/rerank
RERANK_MODEL=BAAI/bge-reranker-v2-m3
RERANK_TOP_N=20                      # 精排后返回数量

# ─── 可选配置 ──────────────────────────────────────────────
# IGNORE_PATTERNS=.venv,node_modules,dist,.git
# CONTEXTATLAS_BASE_DIR=~/.contextatlas
# CONTEXTATLAS_USAGE_DB_PATH=~/.contextatlas/usage-tracker.db
# INDEX_UPDATE_CHURN_THRESHOLD=0.35
# INDEX_UPDATE_COST_RATIO_THRESHOLD=0.65
# INDEX_UPDATE_MIN_FILES=8
# INDEX_UPDATE_MIN_CHANGED_FILES=5

# ─── Embedding Gateway（可选）──────────────────────────────
# EMBEDDING_GATEWAY_HOST=127.0.0.1
# EMBEDDING_GATEWAY_PORT=8787
# EMBEDDING_GATEWAY_TIMEOUT_MS=30000
# EMBEDDING_GATEWAY_FAILOVER_COOLDOWN_MS=30000
# EMBEDDING_GATEWAY_CACHE_TTL_MS=60000
# EMBEDDING_GATEWAY_CACHE_MAX_ENTRIES=500
# EMBEDDING_GATEWAY_CACHE_BACKEND=memory
# EMBEDDING_GATEWAY_REDIS_URL=redis://127.0.0.1:6379/0
# EMBEDDING_GATEWAY_REDIS_KEY_PREFIX=contextatlas:gateway:embeddings:
# EMBEDDING_GATEWAY_COALESCE_IDENTICAL_REQUESTS=true
# EMBEDDING_GATEWAY_VALIDATE_UPSTREAMS=true
# EMBEDDING_GATEWAY_VALIDATE_MODELS=BAAI/bge-m3
# EMBEDDING_GATEWAY_VALIDATE_INPUT=dimension-probe
# EMBEDDING_GATEWAY_API_KEYS=local-gateway-token
# EMBEDDING_GATEWAY_UPSTREAMS=[{"name":"siliconflow-primary","baseUrl":"https://api.siliconflow.cn/v1/embeddings","apiKey":"your-api-key-here","weight":1,"models":["BAAI/bge-m3"]}]
```

### 配置项说明

| 变量 | 必填 | 说明 |
|------|------|------|
| `EMBEDDINGS_API_KEY` | ✅ | Embedding 服务 API Key |
| `EMBEDDINGS_BASE_URL` | ✅ | Embedding API 地址 |
| `EMBEDDINGS_MODEL` | ✅ | 模型名称 |
| `RERANK_API_KEY` | ✅ | Rerank 服务 API Key |
| `RERANK_BASE_URL` | ✅ | Rerank API 地址 |
| `RERANK_MODEL` | ✅ | Rerank 模型名称 |
| `EMBEDDINGS_MAX_CONCURRENCY` | 否 | 默认 10，降低可避免 API 限流 |
| `IGNORE_PATTERNS` | 否 | 逗号分隔的忽略路径 |
| `INDEX_UPDATE_CHURN_THRESHOLD` | 否 | 改动文件占比达到阈值时，`index:plan` / `index:update` 更倾向 `full` |
| `INDEX_UPDATE_COST_RATIO_THRESHOLD` | 否 | 估算增量处理成本接近全量时触发 `full` |
| `INDEX_UPDATE_MIN_FILES` | 否 | 启用上述升级策略所需的最小仓库文件数 |
| `INDEX_UPDATE_MIN_CHANGED_FILES` | 否 | 启用上述升级策略所需的最小改动文件数 |
| `EMBEDDING_GATEWAY_UPSTREAMS` | 否 | JSON 数组，声明 gateway 的上游 embeddings provider 列表 |
| `EMBEDDING_GATEWAY_API_KEYS` | 否 | 逗号分隔；配置后 gateway 要求 Bearer Token |
| `EMBEDDING_GATEWAY_CACHE_TTL_MS` | 否 | 本地内存缓存 TTL，默认 0 表示关闭 |
| `EMBEDDING_GATEWAY_CACHE_MAX_ENTRIES` | 否 | 本地内存缓存最大条目数，默认 500 |
| `EMBEDDING_GATEWAY_CACHE_BACKEND` | 否 | `memory`、`redis` 或 `hybrid`，默认 `memory` |
| `EMBEDDING_GATEWAY_REDIS_URL` | 否 | 当缓存 backend 为 `redis` 或 `hybrid` 时必填 |
| `EMBEDDING_GATEWAY_REDIS_KEY_PREFIX` | 否 | Redis key 前缀，默认 `contextatlas:gateway:embeddings:` |
| `EMBEDDING_GATEWAY_COALESCE_IDENTICAL_REQUESTS` | 否 | 是否合并并发相同请求，默认开启 |
| `EMBEDDING_GATEWAY_VALIDATE_UPSTREAMS` | 否 | 是否在启动时探测上游 embedding 维度一致性，默认开启 |
| `EMBEDDING_GATEWAY_VALIDATE_MODELS` | 否 | 逗号分隔；显式指定要探测的逻辑模型名 |
| `EMBEDDING_GATEWAY_VALIDATE_INPUT` | 否 | 启动探测时发送给上游的样本文本，默认 `dimension-probe` |

---

## 部署场景

### 场景一：本地 CLI 使用

适合个人开发者快速检索代码。

```bash
# 1. 安装
npm install -g @codefromkarl/context-atlas

# 2. 初始化
contextatlas init

# 3. 编辑 ~/.contextatlas/.env，填入 API 密钥

# 4. 索引项目
contextatlas index /path/to/your/project

# 5. 启动守护进程（后台消费索引队列）
contextatlas daemon start

# 6. 搜索
contextatlas search --information-request "用户登录流程是如何实现的？"
contextatlas search --information-request "用户登录流程是如何实现的？" --json
```

说明：安装时使用 npm 包名 `@codefromkarl/context-atlas`，实际运行命令统一使用 `contextatlas`。

### 场景一补充：Embedding Gateway

适合把 ContextAtlas 继续配置成单 endpoint 客户端，但把流量扇出、故障切换放到本地网关层。

```bash
# 1. 在 ~/.contextatlas/.env 中配置网关
EMBEDDING_GATEWAY_API_KEYS=local-gateway-token
EMBEDDING_GATEWAY_CACHE_TTL_MS=60000
EMBEDDING_GATEWAY_CACHE_MAX_ENTRIES=500
EMBEDDING_GATEWAY_CACHE_BACKEND=hybrid
EMBEDDING_GATEWAY_REDIS_URL=redis://127.0.0.1:6379/0
EMBEDDING_GATEWAY_VALIDATE_UPSTREAMS=true
EMBEDDING_GATEWAY_VALIDATE_MODELS=BAAI/bge-m3
EMBEDDING_GATEWAY_UPSTREAMS='[
  {"name":"siliconflow-primary","baseUrl":"https://api.siliconflow.cn/v1/embeddings","apiKey":"your-api-key-here","weight":1,"models":["BAAI/bge-m3"]}
]'

# 2. 启动网关
contextatlas gateway:embeddings --port 8787

# 3. 让 ContextAtlas 自己改为指向网关
EMBEDDINGS_BASE_URL=http://127.0.0.1:8787/v1/embeddings
EMBEDDINGS_API_KEY=local-gateway-token
```

如果当前机器访问外网依赖 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`，启动 gateway 时请显式开启环境代理透传：

```bash
NODE_USE_ENV_PROXY=1 contextatlas gateway:embeddings --port 8787
```

如果你想直接挂到 Hugging Face Inference 的 `BAAI/bge-m3`，可以把上游声明改成：

```bash
EMBEDDING_GATEWAY_UPSTREAMS='[
  {"name":"hf-bge-m3","baseUrl":"https://router.huggingface.co/hf-inference/models/BAAI/bge-m3/pipeline/feature-extraction","apiKey":"hf_your_token_here","weight":1,"models":["BAAI/bge-m3"],"protocol":"hf-feature-extraction"}
]'
```

其中 `protocol="hf-feature-extraction"` 会把 Hugging Face 的 `inputs` 请求体和向量数组响应自动适配成 ContextAtlas 需要的 OpenAI-compatible `/v1/embeddings` 形状。

当前 gateway 提供：

- `POST /v1/embeddings`：OpenAI-compatible embeddings 转发
- `GET /healthz`：查看 provider 汇总、provider 级成功/失败/延迟/冷却指标和 cache 面板
- 可插拔缓存后端：支持内存缓存、Redis 缓存和 `hybrid` 两级缓存（L1 memory + L2 Redis）
- 并发请求合并：相同请求同时到达时只触发一次上游调用
- 启动校验：对可探测模型执行上游维度一致性检查，避免把不同维度写进同一个索引
- 加权轮询：按 `weight` 分配请求
- 失败切换：遇到网络错误、`429`、`5xx` 时自动切换到下一个上游
- 临时摘除：失败上游在 `EMBEDDING_GATEWAY_FAILOVER_COOLDOWN_MS` 窗口内不会继续接单

如果你当前只想先接一家的免费或试用 embeddings 服务，最简单的做法就是先接 `SiliconFlow + BAAI/bge-m3`。它和 ContextAtlas 当前默认 embedding 配置一致，接入成本最低。

### 场景二：Claude Desktop MCP 集成

适合在 Claude Desktop 中获得代码检索能力。

**1. 编辑 Claude Desktop 配置：**

macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "contextatlas": {
      "command": "contextatlas",
      "args": ["mcp"],
      "env": {
        "EMBEDDINGS_API_KEY": "your-key",
        "EMBEDDINGS_BASE_URL": "https://api.siliconflow.cn/v1/embeddings",
        "EMBEDDINGS_MODEL": "BAAI/bge-m3",
        "RERANK_API_KEY": "your-key",
        "RERANK_BASE_URL": "https://api.siliconflow.cn/v1/rerank",
        "RERANK_MODEL": "BAAI/bge-reranker-v2-m3",
        "CONTEXTATLAS_MCP_TOOLSET": "retrieval-only"
      }
    }
  }
}
```

`CONTEXTATLAS_MCP_TOOLSET` 可选值：

- `full`：默认，暴露全部 21 个工具
- `retrieval-only`：仅暴露 7 个只读检索工具，适合降低上下文和工具选择负担

**2. 重启 Claude Desktop**，确认 MCP 工具列表中出现 ContextAtlas 的 21 个工具；若启用了 `retrieval-only`，则会显示 7 个工具。

**3. 在对话中直接使用**，无需额外提示词——工具已自动注册。

### 场景三：Cursor / Windsurf MCP 集成

**Cursor**（Settings → Features → MCP）：

```json
{
  "mcpServers": {
    "contextatlas": {
      "command": "contextatlas",
      "args": ["mcp"]
    }
  }
}
```

**Windsurf**（`.cursor/mcp.json` 或项目级配置）：

```json
{
  "mcpServers": {
    "contextatlas": {
      "command": "contextatlas",
      "args": ["mcp"]
    }
  }
}
```

### 场景四：多项目共享 Hub

适合团队在多个项目间共享模块知识。

```bash
# 1. 注册所有项目
contextatlas hub:register-project /path/to/project-a --name "ProjectA"
contextatlas hub:register-project /path/to/project-b --name "ProjectB"

# 2. 分别为每个项目建立索引
contextatlas index /path/to/project-a
contextatlas index /path/to/project-b

# 3. 启动守护进程
contextatlas daemon start

# 4. 跨项目搜索
contextatlas hub:search --category auth

# 5. 建立项目间关系
contextatlas hub:link ProjectA AuthService ProjectB AuthLib depends_on
```

### 场景五：CI/CD 预索引

在 CI 流程中自动索引，确保 AI 始终获取最新代码上下文。

```yaml
# GitHub Actions 示例
- name: Index codebase
  run: |
    npm install -g @codefromkarl/context-atlas
    contextatlas init
    contextatlas index . --force
    contextatlas daemon once
  env:
    EMBEDDINGS_API_KEY: ${{ secrets.EMBEDDINGS_API_KEY }}
    RERANK_API_KEY: ${{ secrets.RERANK_API_KEY }}
```

---

## 配套提示词

### 系统提示词模板

将以下内容添加到 AI 助手的系统提示中，确保正确使用 ContextAtlas：

```
## ContextAtlas 使用指南

你拥有 ContextAtlas MCP 工具，用于检索和理解当前代码库。

### 核心原则

1. **先检索，后编码**：在修改任何代码前，必须使用 codebase-retrieval 了解现有实现
2. **先查记忆，后检索**：使用 find_memory 检查是否已有模块知识，避免重复工作
3. **完成后回写**：开发完成后用 record_memory 记录新模块的稳定知识

### 工具调用顺序

面对新任务时：
1. find_memory({ query: "关键词" }) — 检查是否已有模块记忆
2. codebase-retrieval({ information_request: "描述目标" }) — 检索相关代码
3. 阅读返回的代码，理解实现
4. 制定修改计划
5. 实施修改
6. record_memory({ name, responsibility, dir, ... }) — 回写新模块知识

### 查询技巧

- information_request 用自然语言描述"代码在做什么"，而非类名
- technical_terms 填入你 100% 确定存在的类名/函数名
- 如果首次搜索结果太宽泛，增加 technical_terms 缩小范围

### 不要做的事

- 不要猜测文件路径，用 codebase-retrieval 搜索
- 不要凭记忆写代码，总是先检索验证
- 不要在未理解现有实现的情况下直接修改
```

### 工具使用策略提示词

```
## ContextAtlas 工具选择策略

| 你的意图 | 使用工具 | 示例 |
|---------|---------|------|
| "这个模块在哪里？" | find_memory | find_memory({ query: "auth" }) |
| "代码是怎么实现的？" | codebase-retrieval | codebase-retrieval({ information_request: "用户登录流程" }) |
| "这个函数的签名是什么？" | codebase-retrieval + technical_terms | codebase-retrieval({ information_request: "登录函数", technical_terms: ["login"] }) |
| "其他项目有类似实现吗？" | query_shared_memories | query_shared_memories({ category: "auth" }) |
| "这个模块依赖什么？" | get_dependency_chain | get_dependency_chain({ project: "ctx", module: "SearchService" }) |
| "记录这个新模块" | record_memory | record_memory({ name: "AuthService", responsibility: "...", dir: "src/auth/" }) |
| "记录架构决策" | record_decision | record_decision({ id: "2026-04-03-auth", title: "...", decision: "..." }) |
| "会话结束，保存知识" | session_end | session_end({ summary: "创建了 AuthService..." }) |
```

### 记忆记录提示词

```
## 记忆记录规范

### Feature Memory 记录时机
- 新建模块超过 3 个文件
- 实现新的 API 端点
- 添加新的服务层/中间件
- 修改了模块的公开接口

### Feature Memory 必填字段
```json
{
  "name": "模块名（kebab-case）",
  "responsibility": "一句话描述模块职责",
  "dir": "源码目录路径",
  "files": ["主要文件列表"],
  "exports": ["导出的符号"],
  "imports": ["内部依赖模块"],
  "external": ["外部依赖库"],
  "dataFlow": "数据流向描述"
}
```

### Decision Record 记录时机
- 选择了特定的架构方案
- 在多个方案中做出了取舍
- 引入了新的依赖或技术
- 改变了现有的设计模式

### Decision Record 必填字段
```json
{
  "id": "日期-简短描述",
  "title": "决策标题",
  "context": "背景和问题",
  "decision": "做了什么决定",
  "rationale": "为什么这样决定",
  "alternatives": [
    { "name": "方案A", "pros": ["优点"], "cons": ["缺点"] }
  ]
}
```
```

---

## 运维与监控

### 索引状态检查

```bash
# 查看检索性能报告
contextatlas monitor:retrieval --days 7

# 查看索引优化建议
contextatlas usage:index-report --days 7

# 检查索引系统健康度
contextatlas health:check
contextatlas health:check --project-id <projectId>
contextatlas health:full

# 查看队列与单任务详情
contextatlas task:status
contextatlas task:status --project-id <projectId>
contextatlas task:inspect <taskId>

# 修复 chunk FTS 覆盖不足
contextatlas fts:rebuild-chunks --project-id <projectId>

# 团队级运维摘要
contextatlas ops:summary

# 团队级稳定指标
contextatlas ops:metrics --days 7 --stale-days 30

# 更新策略与影响范围分析
contextatlas index:plan /path/to/repo
contextatlas index:plan /path/to/repo --json
contextatlas index:diagnose
contextatlas index:diagnose --json
contextatlas index:update /path/to/repo

# 评估告警
contextatlas alert:eval
contextatlas alert:eval --stale-days 30

# 分析文本存储冗余
contextatlas storage:analyze --project-id <projectId>

# 运行离线索引基准
contextatlas perf:benchmark --size small --scenario noop --json
contextatlas perf:benchmark --matrix
```

### 守护进程管理

```bash
# 启动常驻守护进程
contextatlas daemon start

# 单次执行（适合 CI）
contextatlas daemon once

# 查看队列状态
contextatlas task:status
contextatlas task:inspect <taskId>
```

运维排查时，建议把 `ops:summary --stale-days <days>` 与 `alert:eval --stale-days <days>` 配套使用。两者现在共享同一套 memory health 告警口径，便于先看团队摘要，再下钻单独告警结果，而不会因为 stale 阈值不一致造成判断漂移。

### 数据目录

```text
~/.contextatlas/
├── .env                           # 配置文件
├── memory-hub.db                  # 项目记忆主存储
├── usage-tracker.db               # 使用追踪数据
├── logs/                          # 运行日志
│   └── app.YYYY-MM-DD.log
└── <projectId>/                   # 各项目的索引快照
    ├── current                    # 当前活跃快照（符号链接）
    └── snapshots/                 # 历史快照
        ├── snap-...
        └── snap-...
```

### 清理与维护

```bash
# 清理过期的长期记忆
contextatlas memory:prune-long-term --include-stale

# 重建记忆目录索引
contextatlas memory:rebuild-catalog

# 检查记忆一致性
contextatlas memory:check-consistency
```

---

## 故障排查

### 索引失败

**症状**：`contextatlas index` 报错或卡住

**排查**：
```bash
# 查看日志
cat ~/.contextatlas/logs/app.$(date +%Y-%m-%d).log

# 看看当前卡在哪
contextatlas health:check --project-id <projectId>
contextatlas task:status --project-id <projectId>
contextatlas task:inspect <taskId>

# 判断是否应走增量还是全量
contextatlas index:plan /path/to/repo --json
contextatlas index:diagnose --json

# 自动按当前状态触发更新
contextatlas index:update /path/to/repo

# 必要时强制重建
contextatlas index /path/to/repo --force
```

### API 限流

**症状**：Embedding 请求返回 429 错误

**解决**：
```bash
# 降低并发和批次大小
EMBEDDINGS_MAX_CONCURRENCY=5
EMBEDDINGS_BATCH_SIZE=10
EMBEDDINGS_GLOBAL_MIN_INTERVAL_MS=500
```

### MCP 工具未出现

**症状**：AI 助手中看不到 ContextAtlas 工具

**排查**：
1. 确认 `contextatlas mcp` 能正常启动（手动运行测试）
2. 检查 MCP 配置文件路径是否正确
3. 重启 AI 助手应用
4. 查看 MCP 日志输出

### 搜索结果为空

**排查**：
```bash
# 确认索引健康与当前状态
contextatlas health:check --project-id <projectId>

# 检查项目是否已索引
ls ~/.contextatlas/

# 看看是否仍在排队或执行中
contextatlas task:status --project-id <projectId>

# 分析是否该增量更新 / 全量重建
contextatlas index:plan /path/to/repo --json
contextatlas index:diagnose --json

# 重新索引
contextatlas index:update /path/to/repo
contextatlas daemon once
```

### 存储占用偏高

**症状**：索引目录增长过快，想判断哪些文本副本最占空间

**排查**：
```bash
contextatlas storage:analyze --project-id <projectId>
```

它会量化：

- `files.content`
- `files_fts.content`
- `chunks_fts.content`
- LanceDB `display_code`
- LanceDB `vector_text`

用于判断当前是否值得继续做存储裁剪。

### 发布前想确认性能没有明显退化

**最小检查**：
```bash
contextatlas perf:benchmark --size small --scenario noop --json
```

**完整矩阵**：
```bash
contextatlas perf:benchmark --matrix
```
