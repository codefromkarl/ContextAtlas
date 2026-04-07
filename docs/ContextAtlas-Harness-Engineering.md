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

---

## 下一版上下文 / 记忆架构草图

这一节不是推翻当前实现，而是在现有 `SearchService + GraphExpander + ContextPacker + MemoryStore + MCP tools` 之上，补出 **长周期 agent 工作流真正缺失的“上下文生命周期层”**。

目标不是继续把 ContextAtlas 做成更大的搜索工具，而是把它推进为：

> 一个为 AI agent 提供 **typed context blocks、checkpoint、resume/handoff、记忆分层与压缩治理** 的上下文状态底座。

### 设计原则

1. **保留现有主路径**：混合检索、图扩展、记忆与 MCP 工具不推倒重来
2. **先补对象模型，再补算法**：先定义 block / checkpoint / memory kind，再优化 rerank / compaction 策略
3. **引用优先于正文**：优先返回可导航、可展开的引用结构，而不是一开始塞满正文
4. **区分 packing 与 compaction**：`ContextPacker` 负责本轮结果装配；新层负责长周期状态压缩与恢复
5. **记忆按运行时语义分层**：procedural / semantic / episodic / task-state，而不是只有存储分类

---

## 演进后的位置变化

当前定位是“上下文基础设施层”；演进后仍保持这个定位，但内部会分成两层：

```text
┌──────────────────────────────────────────────────────┐
│ Agent Runtime / Orchestrator                        │
├──────────────────────────────────────────────────────┤
│ Context Lifecycle Layer  ◀ 新增                      │
│ ├─ Context Blocks                                   │
│ ├─ Task Checkpoints                                 │
│ ├─ Handoff / Resume                                 │
│ ├─ Phase-aware Assembly                             │
│ └─ Memory Governance                                │
├──────────────────────────────────────────────────────┤
│ Retrieval & Memory Infra  ◀ 现有主干                 │
│ ├─ SearchService facade                             │
│ ├─ HybridRecallEngine / RerankPolicy                │
│ ├─ GraphExpander                                    │
│ ├─ ContextPacker                                    │
│ ├─ MemoryStore facade / MemoryRouter                │
│ └─ MCP tools                                        │
├──────────────────────────────────────────────────────┤
│ Storage (SQLite / LanceDB / Memory Hub)             │
└──────────────────────────────────────────────────────┘
```

也就是说：

- **SearchService** 仍负责组织“找”的主流程
- **GraphExpander** 仍负责“补关系”
- **ContextPacker** 仍负责“装”
- **新增的 lifecycle 层** 负责“存、压、交接、恢复、治理”

---

## 新增核心对象模型

### 1. `ContextBlock`

`ContextBlock` 是新的基础上下文单元，用来替代“只有片段列表或长文本结果卡”的组织方式。

建议字段：

```ts
type ContextBlockType =
  | 'repo-rules'
  | 'module-summary'
  | 'decision-context'
  | 'task-state'
  | 'recent-findings'
  | 'open-questions'
  | 'code-evidence'
  | 'feedback-signals';

interface ContextBlock {
  id: string;
  type: ContextBlockType;
  title: string;
  purpose: string;
  content: string;
  priority: 'high' | 'medium' | 'low';
  pinned: boolean;
  expandable: boolean;
  budgetChars?: number;
  provenance: Array<{
    source: 'code' | 'feature-memory' | 'decision-record' | 'long-term-memory' | 'feedback';
    ref: string;
  }>;
  freshness?: {
    lastVerifiedAt?: string;
    stale?: boolean;
    confidence?: 'high' | 'medium' | 'low';
  };
}
```

它与当前 `SearchService` / `codebaseRetrieval` 的关系：

- 现有的代码命中片段 → `code-evidence`
- 现有的功能记忆 → `module-summary`
- 现有的决策记录 → `decision-context`
- 现有的 feedback → `feedback-signals`
- 未来新增的任务状态 → `task-state` / `recent-findings` / `open-questions`

### 2. `TaskCheckpoint`

`TaskCheckpoint` 是跨轮、跨会话、跨模型恢复状态的正式对象，不再依赖自由文本总结。

建议字段：

```ts
interface TaskCheckpoint {
  id: string;
  repoPath: string;
  title: string;
  goal: string;
  phase: 'overview' | 'research' | 'debug' | 'implementation' | 'verification' | 'handoff';
  summary: string;
  activeBlockIds: string[];
  exploredRefs: string[];
  keyFindings: string[];
  unresolvedQuestions: string[];
  nextSteps: string[];
  createdAt: string;
  updatedAt: string;
}
```

作用：

- **resume**：恢复昨天做到哪里
- **handoff**：把当前理解交给另一个 agent 或另一个人
- **compaction**：把长历史收敛成正式状态对象

### 3. `MemoryKind` 分层

当前记忆系统已经有 feature memory、decision record、long-term memory，但对 agent runtime 来说仍不够清晰。

建议显式增加运行时分层：

```ts
type MemoryKind = 'procedural' | 'semantic' | 'episodic' | 'task-state';
```

建议映射：

| MemoryKind | 含义 | 当前大致来源 |
|---|---|---|
| `procedural` | 仓库规则、工作流、构建/测试约定、架构约束 | project profile / long-term memory / AGENTS 类内容 |
| `semantic` | 模块职责、依赖关系、稳定 API、决策事实 | feature memory / decision record |
| `episodic` | 这次任务看过什么、排除了什么、失败过什么 | 当前几乎缺失 |
| `task-state` | 当前目标、阶段、下一步、进行中的假设 | 当前几乎缺失 |

---

## 模块级改造草图

### `src/search/SearchService.ts`

**当前职责**：混合召回 → 融合 → 精排 → 扩展 → 打包

**新增职责**：支持两类结果模式

1. `overview`：返回最小导航骨架
   - top files
   - top symbols
   - expansion candidates
   - why relevant
2. `expanded`：在 overview 基础上展开正文与代码证据

建议新增输出能力：

- `contextBlocks`
- `references`
- `nextInspectionSuggestions`
- `checkpointCandidate`

### `src/search/GraphExpander.ts`

**当前职责**：自动做邻居 / breadcrumb / import 扩展

**新增方向**：从“系统自动扩”升级为“同时输出 agent 可消费的探索图提示”。

建议新增：

- `expansionCandidates`
- 每个 candidate 带上 `relation`、`reason`、`priority`
- 输出“下一步建议看哪里”，而不仅是直接塞进 pack

### `src/search/ContextPacker.ts`

**当前职责**：对代码片段做 span merge + char budget packing

**新增方向**：保持现有职责，同时新增一层 block 级 packing 能力。

建议拆成两种模式：

1. **Evidence Packing**（保留现有）
   - 面向本轮代码结果
2. **Checkpoint Packing**（新增）
   - 面向长周期状态压缩
   - 输入是 `ContextBlock[]`
   - 输出是 `TaskCheckpoint` 或 `HandoffBundle`

### `src/memory/MemoryStore.ts`

**当前职责**：feature / decision / long-term 的存储与查询

**新增方向**：引入 runtime-facing 类型层，而不是只有存储层类型。

建议：

- 新增 `MemoryKind`
- 新增 task-scoped / session-scoped 读写接口
- 允许 checkpoint 提升为 semantic / procedural memory

### `src/memory/MemoryRouter.ts`

**当前职责**：catalog → global → feature 按层加载

**新增方向**：扩展为四层：

1. catalog
2. global / procedural
3. semantic / module
4. episodic / task-state

并新增按阶段装配：

- `overview`
- `debug`
- `implementation`
- `verification`
- `handoff`

### `src/memory/MemoryAutoRecorder.ts`

**当前职责**：从 session summary / 文件变更中抽取记忆候选

**新增方向**：从 recorder 升级为 recorder + consolidation pipeline。

建议追加：

- duplicate detection
- merge / generalize
- supersede link
- confidence / provenance 标注

### `src/mcp/tools/codebaseRetrieval.ts`

**当前职责**：返回代码命中 + 相关记忆 + 决策 + feedback 的结果卡片

**新增方向**：升级为 block-first 输出，同时保留 text 渲染。

建议输出：

```json
{
  "contextBlocks": [...],
  "references": [...],
  "nextInspectionSuggestions": [...],
  "checkpointCandidate": {...}
}
```

### 新增 MCP 工具族

建议新增而不是塞进现有 retrieval 工具：

- `contextatlas.create_checkpoint`
- `contextatlas.load_checkpoint`
- `contextatlas.list_checkpoints`
- `contextatlas.prepare_handoff`
- `contextatlas.assemble_context`
- `contextatlas.suggest_phase_boundary`

---

## 推荐的最小落地顺序

### Phase 1：先补对象模型，不碰大逻辑

目标：让系统能说清楚“上下文对象是什么”。

最小交付：

- `ContextBlock` 类型定义
- `TaskCheckpoint` 类型定义
- `MemoryKind` 显式分层
- `codebaseRetrieval` 能返回 block 化结构（即便底层逻辑先复用现有结果卡）

### Phase 2：补 checkpoint / resume / handoff

目标：让 ContextAtlas 真正支撑长周期任务。

最小交付：

- 新增 checkpoint 存储
- 新增 MCP tools：create/load/list checkpoint
- `autoRecord` 从“会话总结提炼”升级为“生成正式 checkpoint”

### Phase 3：把 retrieval 变成 progressive retrieval

目标：从 payload-first 变成 reference-first。

最小交付：

- `overview` / `expanded` 两种模式
- `GraphExpander` 输出 exploration candidates
- `SearchService` 输出 next-inspection suggestions

### Phase 4：补记忆治理

目标：避免长期记忆污染和碎片化。

最小交付：

- merge / dedupe / generalize
- provenance / confidence
- supersede / stale lifecycle

---

## 哪些任务应该先做，哪些不要急

### 应先做

- typed context blocks
- checkpoint / handoff / resume
- procedural / semantic / episodic / task-state 分层
- block 级预算与 phase-aware assembly

### 暂时不要优先做

- 复杂图记忆推理（多图 memory / belief revision）
- 追求“万能总结 prompt”
- 无质量门槛的自动长期记忆写入

原因很简单：当前真正的缺口不在“更复杂的 memory 算法”，而在“缺少可持续的上下文状态对象与治理机制”。

---

## 一句话总结这个草图

ContextAtlas 的下一步，不是继续把“搜索结果做得更长更全”，而是把现有的检索、扩展、记忆和 MCP 能力收敛成：

> 一套可类型化、可压缩、可交接、可恢复、可治理的上下文生命周期系统。

这会让它从 **retrieval infra** 升级为更完整的 **agent context substrate**。

---
