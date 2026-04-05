# ContextAtlas 仓库定位与设计思路

## 文档目的

这份文档参考“仓库定位”草稿，结合当前仓库的实际实现，说明 ContextAtlas 在整个 AI 工程体系里的定位、边界和设计思路。

如果你想先看功能总览与上手方式，可以直接阅读：

- [README（中文）](../README.md)
- [README（English）](../README.EN.md)

---

## 一句话定位

**ContextAtlas 不是单一的代码搜索工具，而是一套面向 AI Agent 的上下文基础设施。**

它服务的核心问题不是“能不能搜到代码”，而是：

- agent 能不能在大仓库里稳定找到正确上下文
- agent 能不能在多轮任务中复用项目理解，而不是每次重新读仓库
- 检索与记忆系统本身能不能被观测、调优和持续演进

从这个角度看，ContextAtlas 更接近 AI engineering / harness engineering 里的 **Context Infrastructure Layer**，而不是单独的搜索插件。

---

## 这个仓库在系统里的位置

如果把一个 AI coding agent 系统粗略分层，ContextAtlas 主要位于下面两层之间：

```text
Agent Runtime / Workflow
        ↓
Context Infrastructure
        ↓
Tool Exposure (CLI / MCP)
        ↓
Storage / Index / Telemetry
```

它向上为 agent、skills、MCP client 提供可调用的上下文能力，向下连接索引、数据库、向量存储和记忆存储。

因此，这个仓库的主要职责不是替 agent 做规划，而是为 agent 提供一套可靠的“找、补、存、看”能力：

- `找`：在代码库中找到相关实现
- `补`：把命中代码扩展成可消费的局部上下文
- `存`：把项目知识和长期知识沉淀下来
- `看`：让检索链路、索引状态和质量退化可被观测

---

## 它不是什么

为了让定位更清晰，也需要明确边界：

- 它不是大模型本体
- 它不是任务编排器或 planner
- 它不是完整的 verification harness
- 它不是浏览器、终端或业务 API 的执行器

ContextAtlas 解决的是“上下文工程”问题，不直接替代“任务决策”或“动作执行”。

---

## 设计思路

### 1. 给 Agent 地图，而不是给 Agent 手册

当前仓库的总体思路不是把整份代码库粗暴塞进上下文窗口，而是先建立仓库地图，再做逐步展开。

这体现在检索链路上：

- 先用混合召回缩小范围
- 再用 rerank 提高命中质量
- 再做图式扩展补上下文
- 最后在 token 预算内打包

对应实现可以在 [SearchService.ts](../src/search/SearchService.ts) 中看到，`buildContextPack()` 把这条链路组织为 `retrieve → rerank → expand → pack`。

### 2. 检索不是单点能力，而是一条可组合的流水线

这个仓库没有把“语义搜索”当成唯一答案，而是把真实仓库中的检索问题拆成多段能力：

- `SemanticSplitter` 先把源代码切成更适合理解与嵌入的语义块
- `SearchService` 负责向量召回、FTS 召回、RRF 融合和 rerank
- `GraphExpander` 负责把 seed 命中扩展成更完整的局部上下文
- `ContextPacker` 负责在预算内保留最高价值的上下文片段

这意味着 ContextAtlas 的目标不是返回“最像的一段文本”，而是构造一个更适合 agent 使用的上下文包。

### 3. 项目理解要沉淀成结构化记忆，而不是停留在单次检索结果里

仓库把记忆视为检索系统的延伸，而不是附属功能。

当前设计里至少有三层知识：

- 项目级结构知识：Feature Memory、Decision Record、Project Profile
- 协作级长期知识：用户偏好、规则、非代码状态、外部参考
- 跨项目知识：通过 Hub 复用模块经验和依赖关系

这部分能力由 [MemoryStore.ts](../src/memory/MemoryStore.ts) 及相关 `memory/` 模块承载，主存储是 `~/.contextatlas/memory-hub.db`。

### 4. 上下文系统本身必须可观测

很多 agent 失败表面上看是“模型不够好”，实际原因可能是：

- 索引没跟上
- 检索质量退化
- rerank 成本过高
- 打包预算经常耗尽

所以当前仓库把 observability 当成一等能力，而不是上线后的补丁。README 中明确把 retrieval telemetry、usage tracker、health check、index optimization 作为对外能力的一部分，这也解释了它为什么不是单纯的检索库，而是基础设施仓库。

### 5. 暴露方式要服务接入，而不是绑定某一个上层产品

当前项目同时提供：

- CLI 入口
- MCP Server
- 面向 skills / workflow 的后端能力

这使它既可以被本地 agent 工作流直接调用，也可以作为标准 MCP 服务接入其他客户端。对应实现入口见 [server.ts](../src/mcp/server.ts) 与 `package.json` 中的 CLI `bin` 配置。

---

## 核心能力与当前实现的映射

### 1. 索引层

- `src/chunking/SemanticSplitter.ts`
- `src/db/`
- `src/vectorStore/`
- `src/indexing/`

这层负责把源码转成可检索对象，包括 AST 语义分片、SQLite/FTS 元数据、向量索引以及异步索引与 daemon。

### 2. 检索层

- `src/search/SearchService.ts`
- `src/search/GraphExpander.ts`
- `src/search/ContextPacker.ts`

这是 ContextAtlas 的核心执行链路。它把“找代码”升级成“构建可供 agent 使用的上下文包”。

### 3. 记忆层

- `src/memory/`

这层负责项目记忆、长期记忆、跨项目 Hub、Catalog 路由与历史记忆兼容导入，是项目知识沉淀的主载体。

### 4. 接入层

- `src/mcp/`
- `src/index.ts`
- `package.json`

这层负责把能力以 CLI 与 MCP 工具的形式暴露给外部系统，形成真正可接入的基础设施组件。

### 5. 观测层

- `src/monitoring/`
- `src/usage/`

这层负责把索引、检索和使用质量数据化，为优化与演进提供依据。

---

## 为什么这个仓库不是“代码搜索 + 记忆数据库”的简单组合

因为它的设计重点不是单个能力点，而是把上下文工程做成闭环：

1. 代码进入系统后被语义化切分和索引。
2. 用户或 agent 发起问题后，系统通过混合检索找到候选上下文。
3. 命中结果继续经过扩展和预算裁剪，变成可消费的 context pack。
4. 经过验证的项目知识再沉淀为记忆，减少后续重复理解。
5. 全过程有观测与优化入口，便于持续调参和治理。

这条闭环决定了它更像一个上下文基础设施仓库，而不是一个点状工具仓库。

---

## 当前仓库适合承载的上层场景

- 作为 AI coding agent 的仓库检索与上下文后端
- 作为 MCP 服务器，为支持 MCP 的客户端提供代码检索和记忆工具
- 作为 skills / workflow 的本地基础设施，为复杂 agent flow 提供项目理解能力
- 作为跨项目知识中枢，沉淀模块职责、决策记录与协作经验

---

## 总结

ContextAtlas 的仓库定位可以概括为一句话：

**它把“代码检索、项目记忆、上下文打包、知识复用和检索观测”组合成一套面向 AI Agent 的上下文基础设施。**

如果从 Harness Engineering 视角理解，这个仓库最重要的价值不是“多了一个搜索能力”，而是把 agent 在真实软件工程中最容易失真的那部分能力，也就是上下文获取与上下文持续性，做成了可实现、可复用、可观测的工程底座。
