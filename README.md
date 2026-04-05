<h1 align="center">ContextAtlas</h1>

<p align="center">
  <strong>为 AI Agent 提供稳定、可复用、可观测的代码上下文基础设施</strong>
</p>

<p align="center">
  <em>Hybrid Retrieval · Project Memory · MCP Server · Retrieval Observability</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node >=20" />
  <img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript 5.x" />
  <img src="https://img.shields.io/badge/MCP-Server-6C47FF?style=flat-square" alt="MCP Server" />
  <img src="https://img.shields.io/github/license/codefromkarl/ContextAtlas?style=flat-square" alt="License" />
  <img src="https://img.shields.io/github/stars/codefromkarl/ContextAtlas?style=flat-square" alt="GitHub stars" />
</p>

<p align="center">
  <a href="./README.EN.md">English</a> ·
  <a href="./docs/DEPLOYMENT.md">部署手册</a> ·
  <a href="./docs/CLI.md">CLI</a> ·
  <a href="./docs/MCP.md">MCP</a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/codefromkarl/ContextAtlas/main/docs/contextatlas-architecture.png" alt="ContextAtlas architecture" width="900" />
</p>

## 目录

- [为什么需要 ContextAtlas](#为什么需要-contextatlas)
- [适合什么场景](#适合什么场景)
- [核心能力](#核心能力)
- [快速亮点](#快速亮点)
- [工程定位](#工程定位)
- [技术栈](#技术栈)
- [安装](#安装)
- [配置](#配置)
- [快速开始](#快速开始)
- [接入方式](#接入方式)
- [使用流程](#使用流程)
- [常用命令](#常用命令)
- [架构概览](#架构概览)
- [项目结构](#项目结构)
- [注意事项](#注意事项)
- [当前限制](#当前限制)
- [文档导航](#文档导航)
- [贡献](#贡献)
- [开发](#开发)
- [友情链接](#友情链接)
- [License](#license)

ContextAtlas 不是单一的“代码搜索工具”。它解决的是更实际的工程问题：

- agent 能不能在大仓库里更快找到正确代码
- agent 能不能把项目理解沉淀下来，而不是每次重读整个仓库
- 检索、索引和记忆系统本身能不能被观测、优化和治理

如果你正在构建 Claude Code、MCP 客户端或自定义 agent workflow，ContextAtlas 提供的是一层 **context infrastructure**：检索、记忆、上下文打包和观测。

## 为什么需要 ContextAtlas

在真实项目里，AI agent 失败往往不是因为“模型不够聪明”，而是因为上下文系统不可靠：

- 找不到真正相关的代码
- 找到的是碎片，缺少依赖和上下文
- 同一个模块反复理解，无法沉淀稳定知识
- 索引过期、检索退化、预算耗尽却没有观测信号

ContextAtlas 把这些问题拆成一套可组合的基础能力：

- **找**：混合检索找到相关实现
- **补**：图扩展和 token packing 补足局部上下文
- **存**：项目记忆、长期记忆、跨项目 Hub 沉淀知识
- **看**：索引健康、检索 telemetry、usage 和 alert 让系统可观测

## 适合什么场景

- 作为 coding agent 的仓库检索后端
- 作为 MCP server，为外部客户端提供代码检索和记忆工具
- 作为本地 CLI / skill backend，嵌入脚本、CI 或 agent workflow
- 作为跨项目知识中枢，复用模块职责、决策记录和协作经验

## 核心能力

| 能力 | 说明 |
|------|------|
| **Hybrid Retrieval** | 向量召回 + FTS 词法召回 + RRF 融合 + rerank |
| **Context Expansion** | 基于邻居、breadcrumb、import 的局部上下文扩展 |
| **Token-aware Packing** | 在有限 token 预算内优先保留高价值上下文 |
| **Project Memory** | Feature Memory、Decision Record、Project Profile |
| **Long-term Memory** | 保存无法从代码稳定推导的规则、偏好、外部参考 |
| **Cross-project Hub** | 跨仓库共享模块记忆、依赖链和关系图谱 |
| **Async Indexing** | SQLite 队列 + daemon 消费 + 快照原子切换 |
| **Observability** | retrieval monitor、usage report、index health、memory health、alert evaluation |

## 快速亮点

### 1. 不只是搜代码，而是构建上下文包

ContextAtlas 的目标不是返回“最像的一段文本”，而是通过：

- 向量召回
- FTS 精确召回
- RRF 融合
- rerank 精排
- graph expansion
- token-aware packing

把结果组织成更适合 agent 消费的局部上下文。

### 2. 项目理解可以沉淀，而不是每次重来

除了代码检索，ContextAtlas 还提供：

- Feature Memory：模块职责、文件、依赖、数据流
- Decision Record：架构决策和理由
- Project Profile：技术栈、结构、约定
- Long-term Memory：规则、偏好、外部参考

### 3. 检索系统本身可观测

你可以看到的不只是结果，还有系统状态：

- 索引是否健康
- 检索是否退化
- 长期记忆是否 stale / expired
- usage 数据是否提示需要增量索引或重建

### 4. 可作为 CLI，也可作为 MCP Server

同一套能力可以：

- 直接供本地命令行、脚本和 skills 使用
- 作为 MCP server 提供给 Claude Desktop / 其他 MCP 客户端

## 工程定位

**ContextAtlas 是 AI agent 的上下文基础设施层。**

它负责回答的是：

> 当上层 agent 开始工作时，如何稳定拿到高价值、低噪声、可持续复用的代码上下文和项目知识？

它**不负责**：

- agent 推理本身
- workflow / planner / orchestrator
- 测试门禁或完整 verification harness
- 浏览器、终端、业务 API 的动作执行

换句话说，ContextAtlas 决定的是 **“给什么上下文”**，而不是 **“任务怎么推进”**。

如果你想看完整的工程定位说明，见 [ContextAtlas 工程定位文档](./docs/ContextAtlas-Harness-Engineering.md)。

## 技术栈

- **TypeScript / Node.js 20+**
- **Tree-sitter**：语义分片
- **SQLite + FTS5**：元数据、检索、队列、memory hub
- **LanceDB**：向量存储
- **Model Context Protocol SDK**：MCP server

## 安装

```bash
npm install -g @codefromkarl/context-atlas
```

可执行命令：

- `contextatlas`
- `cw`（短别名）

## 配置

先初始化配置目录和示例环境变量：

```bash
contextatlas init
```

默认配置文件位置：

```bash
~/.contextatlas/.env
```

至少需要配置：

```bash
EMBEDDINGS_API_KEY=
EMBEDDINGS_BASE_URL=
EMBEDDINGS_MODEL=

RERANK_API_KEY=
RERANK_BASE_URL=
RERANK_MODEL=
```

> `init` 会写入一份可直接编辑的示例 `.env`，包括默认的 SiliconFlow endpoint 和推荐模型配置。

## 快速开始

### 1）初始化并填写 API 配置

```bash
contextatlas init
# 编辑 ~/.contextatlas/.env
```

### 2）索引仓库

```bash
contextatlas index /path/to/repo
```

### 3）本地检索

```bash
cw search \
  --repo-path /path/to/repo \
  --information-request "用户认证流程是如何实现的？"
```

### 4）启动守护进程（推荐）

```bash
contextatlas daemon start
```

### 5）作为 MCP Server 暴露给客户端

```bash
contextatlas mcp
```

## 接入方式

### 1. 作为本地 CLI / Skill Backend

适合：

- 自定义 agent skills
- shell workflow / CI 脚本
- 本地调试与检索分析

示例：

```bash
# 检索
cw search --repo-path /path/to/repo --information-request "支付重试策略在哪里实现？"

# 项目记忆
contextatlas memory:find "search"
contextatlas decision:list

# 健康检查
contextatlas health:full
```

### 2. 作为 MCP Server

适合：

- 支持 MCP 的桌面客户端
- 需要以标准 tool 调用 ContextAtlas 能力的 agent 系统

Claude Desktop 配置示例：

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

ContextAtlas 的 MCP 工具覆盖：

- 代码检索
- 项目记忆
- 长期记忆
- 跨项目 Hub
- 自动记录与建议写回

## 使用流程

```text
1. init
   ↓
2. index
   ↓
3. search / MCP retrieval
   ↓
4. 理解代码与依赖关系
   ↓
5. 记录 project memory / long-term memory（可选）
   ↓
6. 持续通过 health / monitor / usage 观测系统状态
```

一个典型工作流如下：

1. 用 `contextatlas init` 初始化环境
2. 用 `contextatlas index /path/to/repo` 为仓库建立索引
3. 用 `cw search` 或 MCP 工具获取相关代码和记忆
4. 在任务完成后记录模块知识、决策或长期记忆
5. 定期执行 `health:full`、`monitor:retrieval`、`usage:index-report` 和 `memory:health`

### 推荐写入 CLAUDE.md 的启动约束

如果你在 Claude Code 或其他基于会话的 agent workflow 中使用 ContextAtlas，建议把下面这段规则写进 `CLAUDE.md`：

```md
在每次对话开始时：
1. 先查询项目记忆（如 `project-memory-hub` / `memory-load` / `find_memory`）
2. 立即执行仓库索引（`contextatlas index /path/to/repo`）
3. 然后再开始检索、分析和实现
```

这样做的目的很简单：

- 先拿到已有项目知识，减少重复探索
- 先执行索引，减少“代码已变更但检索结果仍然过旧”的问题
- 让后续的检索、规划和实现建立在更新后的上下文基础上

## 常用命令

### 检索与索引

```bash
contextatlas index /path/to/repo
contextatlas index --force
contextatlas daemon start
cw search --repo-path /path/to/repo --information-request "数据库连接逻辑"
```

### 项目记忆与长期记忆

```bash
contextatlas memory:find "auth"
contextatlas memory:record "Auth Module" --desc "用户认证模块" --dir "src/auth"
contextatlas memory:list
contextatlas memory:prune-long-term --include-stale
contextatlas decision:list
contextatlas profile:show
```

### 跨项目 Hub

```bash
contextatlas hub:list-projects
contextatlas hub:search --category search
contextatlas hub:deps <projectId> <moduleName>
```

### 观测与运维

```bash
contextatlas monitor:retrieval --days 7
contextatlas usage:index-report --days 7
contextatlas health:check
contextatlas memory:health
contextatlas health:full
contextatlas alert:eval
contextatlas usage:purge --days 90 --apply
```

## 架构概览

### 检索链路

```text
用户问题
  → 向量召回
  → FTS 词法召回
  → RRF 融合
  → rerank 精排
  → graph expansion
  → token-aware packing
  → 返回结构化上下文
```

### 索引链路

```text
文件变更
  → scanner/ 发现变更
  → chunking/ 语义分片
  → indexer/ embedding + vector store 写入
  → storage/ 快照原子切换
  → indexing/ 队列状态更新
```

## 项目结构

```text
src/
├── api/                  # Embedding / Rerank / Unicode 处理
├── chunking/             # Tree-sitter 语义分片
├── db/                   # SQLite + FTS + 文件元数据
├── indexer/              # 向量索引编排
├── indexing/             # 索引队列与 daemon
├── mcp/                  # MCP server 与工具定义
├── memory/               # 项目记忆 / 长期记忆 / 跨项目 Hub
├── monitoring/           # 检索监控 / 健康检查 / 告警
├── scanner/              # 文件发现与增量扫描
├── search/               # SearchService / GraphExpander / ContextPacker
├── storage/              # 快照布局与原子切换
├── usage/                # 使用追踪与优化分析
└── vectorStore/          # LanceDB 向量存储
```

## 注意事项

- **第一次全量索引可能较慢**：大仓库建议先索引，再用 daemon 保持增量更新
- **长期记忆不要存代码里能推导出来的事实**：它更适合规则、偏好、外部参考和非代码状态
- **MCP 和 CLI 是互补关系**：MCP 适合工具接入，CLI 适合脚本、技能和手工排障
- **健康检查应该常态化**：当结果变差时，不要只怀疑模型，先看索引、记忆和检索指标

## 当前限制

- 目前不支持多租户 / 权限隔离
- 记忆写入质量门禁仍依赖上层 workflow 控制
- 跨项目 Hub 暂无冲突检测
- 自动增量索引触发仍需 daemon 或外部调度配合
- 检索结果还没有统一的置信度评分接口

## 文档导航

| 文档 | 用途 |
|------|------|
| [部署手册](./docs/DEPLOYMENT.md) | 安装、部署场景、MCP 集成、运维建议 |
| [CLI 命令参考](./docs/CLI.md) | 所有 CLI 命令的分类说明和示例 |
| [MCP 工具参考](./docs/MCP.md) | MCP 工具总览、参数和调用顺序 |
| [项目记忆详解](./PROJECT_MEMORY.md) | Feature Memory、Decision Record、Catalog 路由 |
| [仓库定位](./docs/REPOSITORY_POSITIONING.md) | 仓库角色、设计思路、系统边界 |
| [工程定位文档](./docs/ContextAtlas-Harness-Engineering.md) | ContextAtlas 在 harness engineering 中的定位 |
| [产品路线图](./PRODUCT_EVOLUTION_ROADMAP.md) | 后续版本规划和演进方向 |

## 贡献

欢迎通过以下方式参与改进 ContextAtlas：

- 提交 issue 报告 bug 或文档问题
- 提交 PR 修复检索、记忆、监控或文档问题
- 补充真实使用场景、部署经验和 benchmark 数据
- 改进 README、CLI 文档和 MCP 工具示例

如果你准备提交代码，建议先：

1. 运行 `pnpm build` 确认可以构建
2. 确认命令示例、README 和文档与当前实现一致
3. 尽量把功能、文档和运维说明一起补齐

## 开发

```bash
pnpm build
pnpm build:release
pnpm dev
node dist/index.js
```

## 友情链接

https://linux.do/

## License

MIT
