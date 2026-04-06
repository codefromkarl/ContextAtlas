# ContextAtlas 工程定位

## 这篇文章解决什么问题

README 列出了 ContextAtlas 的功能列表。但当你试图把它集成到 Claude Code、Cursor 或自建 agent 系统时，会碰到一个实际问题：

> 它到底该放在架构的哪一层？和 agent runtime、MCP server、orchestrator 的关系是什么？

本文给出明确的工程定位和模块地图。

---

## 核心定位

**ContextAtlas 是 AI agent 的上下文基础设施层。** 它不决定任务怎么推进，只解决一个问题：

> agent 工作时，如何稳定获得高价值、低噪声的代码上下文和项目知识。

具体承担三件事：

1. **检索底座** — 把代码库变成可检索、可扩展、可打包的语义对象
2. **记忆底座** — 把项目知识、架构决策和长期记忆持久化为可复用的上下文资产
3. **观测底座** — 让检索、索引和记忆系统本身可诊断、可告警

### 它不是什么

- 不是 agent runtime（不做推理、不做任务编排）
- 不是 orchestrator（不做 workflow 控制）
- 不是 verification harness（不做测试门禁）
- 不是端到端任务控制平面

---

## 架构分层位置

在一个典型的 AI agent 系统中，ContextAtlas 处于这一层：

```text
┌─────────────────────────────────────────────┐
│  用户任务                                     │
├─────────────────────────────────────────────┤
│  Agent Runtime / Orchestrator                │
│  (Claude Code, Cursor, 自建 agent)           │
├──────────────────┬──────────────────────────┤
│  Verification /  │  ContextAtlas ◀ 你在这里  │
│  Governance      │  ├─ 检索 (向量+FTS+扩展)  │
│                  │  ├─ 记忆 (功能/长期/Hub)   │
│                  │  ├─ 打包 (token 预算)      │
│                  │  └─ 观测 (健康/告警/usage) │
├──────────────────┴──────────────────────────┤
│  Storage (SQLite / LanceDB / Memory Hub)     │
├─────────────────────────────────────────────┤
│  External APIs (Embedding / Rerank)          │
└─────────────────────────────────────────────┘
```

ContextAtlas 通过 CLI 和 MCP 协议暴露能力，上层 agent 在需要上下文时调用，完成后可选写回记忆。

---

## 内部模块地图

| 模块 | 职责 | 关键实现 |
|------|------|---------|
| `scanner/` | 文件发现与变更检测 | crawler 遍历 + hash 增量 + filter 排除 |
| `chunking/` | 语义分片 | Tree-sitter AST 分片 + ParserPool 并行 |
| `indexer/` | 向量索引编排 | chunking → embedding → LanceDB 写入，含自愈和单调版本 |
| `search/` | 混合检索 | 向量召回 + FTS 精确召回 + RRF 融合 + rerank + 图扩展 |
| `memory/` | 项目记忆系统 | 功能记忆 + 决策记录 + 长期记忆 + 跨项目 Hub + catalog 路由 |
| `indexing/` | 异步索引队列 | SQLite 任务队列 + daemon 消费 + 快照原子切换 |
| `storage/` | 存储布局 | 快照版本管理 + prepare/commit/prune |
| `mcp/` | MCP 协议层 | 18 个 MCP 工具，涵盖检索、记忆、索引策略 |
| `monitoring/` | 系统健康 | 索引健康 + 记忆健康 + 检索监控 + 告警引擎 |
| `usage/` | 使用追踪 | 工具调用 + 索引事件记录 + 索引优化分析 |
| `api/` | 外部 API 封装 | Embedding 批量调用 + Rerank 排序 + Unicode 规范化 |
| `db/` | 数据访问层 | SQLite schema 管理 + 项目 ID 派生 + 文件元数据 |
| `vectorStore/` | 向量存储 | LanceDB 读写 + chunk CRUD |
| `config/` | 配置管理 | 环境变量 + .env 文件 + 运行时路径 |

### 数据流

一次完整的检索请求经过的路径：

```text
用户查询
  → search/SearchService
    → 向量召回 (vectorStore + embedding)
    → FTS 召回 (SQLite FTS5)
    → RRF 融合
    → rerank (外部 API)
    → graph 扩展 (import/邻居)
    → context packing (token 预算裁剪)
  → 返回结构化上下文
```

一次完整的索引流程：

```text
文件变更
  → scanner/ (crawl + hash diff)
  → chunking/ (AST 分片)
  → indexer/ (embedding batch → LanceDB)
  → storage/ (快照原子切换)
  → indexing/ (队列状态更新)
```

---

## 与上层系统的集成模式

### 模式 1：作为 MCP Server

最常见的方式。Claude Code、Cursor 等支持 MCP 的客户端直接连接：

```bash
contextatlas mcp
```

上层 agent 默认通过 18 个 MCP 工具调用检索、记忆和索引能力；如设置 `CONTEXTATLAS_MCP_TOOLSET=retrieval-only`，则会收缩为 7 个只读检索工具。

### 模式 2：作为 CLI 工具

CI/CD 脚本、pre-commit hook 或自动化流程中直接调用：

```bash
# 索引代码库
contextatlas index /path/to/repo

# 本地检索
contextatlas search --repo-path /path/to/repo --information-request "支付重试逻辑"
contextatlas search --repo-path /path/to/repo --information-request "支付重试逻辑" --json

# 健康检查
contextatlas health:full --json
```

### 模式 3：作为 Python/JS SDK

通过 `MemoryStore`、`SearchService` 等类直接在代码中调用（需自行 import TypeScript 源码或编译产物）。

---

## 典型协作流程

一个完整的软件工程任务中，ContextAtlas 的参与方式：

1. **任务开始** — agent 调用 `codebase-retrieval`，获取相关代码 + 模块记忆 + 决策记录
2. **理解阶段** — agent 基于上下文分析影响范围，必要时触发增量索引
3. **执行阶段** — agent 修改代码，ContextAtlas 不参与
4. **任务收尾** — agent 可选写回新的功能记忆或长期记忆
5. **运维观测** — 团队通过 `health:full`、`memory:health`、`alert:eval` 监控系统状态

---

## 技术约束与设计决策

| 决策 | 理由 |
|------|------|
| SQLite 作为主存储 | 零运维、单文件、WAL 模式支持并发读、足够支撑单机项目规模 |
| LanceDB 作为向量存储 | 嵌入式、无需外部服务、支持增量更新 |
| 快照原子切换 | `prepare → write → commit` 三阶段，避免索引过程中读到不一致状态 |
| 异步索引队列 | 检索和索引解耦，daemon 消费避免阻塞 MCP 调用 |
| Token 预算打包 | 有限上下文窗口内优先保留高价值代码，而非全量拼入 |
| FTS5 + 向量混合检索 | FTS 精确匹配（变量名、错误信息）+ 向量语义匹配互补 |

---

## 当前边界与已知限制

**当前能做好的：**
- 单项目代码检索和上下文打包
- 项目级功能记忆和长期记忆
- 索引健康和检索质量观测

**当前做不到或不完善的：**
- 不支持多租户 / 权限隔离
- 记忆写入无质量门禁（依赖上层 agent 自律）
- 无自动增量索引触发（需 daemon 或手动调用）
- 跨项目 Hub 无冲突检测
- 检索结果无置信度评分

**合理的演进方向：**
- retrieval quality evaluation（检索结果质量自动评估）
- memory lifecycle governance（记忆自动标记 stale/expired 并清理）
- 与 orchestrator 的更深层集成（如 agent 侧的 context budget 管理）
- 索引变更触发记忆复核
