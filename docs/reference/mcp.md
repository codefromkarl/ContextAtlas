# MCP 工具参考

本文档描述 MCP 接入模式。如果你只需要终端命令行，请参考 [CLI 参考](./cli.md)。

## 配置

### setup

运行以下命令完成 MCP 模式的全部初始化：

```bash
contextatlas setup:local --mode mcp
```

该命令会写入以下文件：

| 文件 | 说明 |
|------|------|
| `~/.contextatlas/.env` | 共享配置 |
| `~/.claude/mcp.json` | MCP 模式 |
| Claude Desktop MCP config | MCP 模式 |
| `~/.gemini/settings.json` | MCP 模式 |
| `~/.codex/config.toml` | MCP block，MCP 模式 |
| `~/.claude/CLAUDE.md` | prompt block，共享 |
| `~/.codex/AGENTS.md` | prompt block，共享 |
| `~/.gemini/GEMINI.md` | prompt block，共享 |
| `~/.codex/skills/contextatlas-mcp/SKILL.md` | MCP 模式 |

注意：MCP 模式下 **不会** 写入 CLI skill 文件。

### Claude Desktop

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

### 启动服务器

```bash
contextatlas mcp
```

如需降低客户端的工具选择负担，可以通过环境变量切换 MCP 工具集：

```json
{
  "mcpServers": {
    "contextatlas": {
      "command": "contextatlas",
      "args": ["mcp"],
      "env": {
        "CONTEXTATLAS_MCP_TOOLSET": "retrieval-only"
      }
    }
  }
}
```

- `full`：默认，暴露全部 32 个工具
- `retrieval-only`：仅暴露 12 个只读检索、图谱、契约和记忆读取工具，适合把 ContextAtlas 当作纯 retrieval/memory reader 使用

`retrieval-only` 是读取口径，不是迁移工具集。它保留 code retrieval、graph context / impact、contract analysis 和记忆读取能力，但不暴露索引写入、长期记忆写入、hub 管理或 schema 修复入口。旧 memory hub 修复、旧 graph schema 重建和升级验收应通过 CLI 完成：

```bash
contextatlas hub:repair-project-identities --dry-run
contextatlas health:graph
contextatlas health:full
```

## 工具总览（32 个）

### 代码检索

| 工具 | 用途 |
|------|------|
| `codebase-retrieval` | 混合语义+词法代码检索（核心工具） |
| `contract_analysis` | 轻量 API / MCP tool 契约分析：route map、api impact、tool map、contract health |

### 代码图谱

| 工具 | 用途 |
|------|------|
| `graph_context` | 查看单个符号的直接上下游关系、调用点和候选匹配 |
| `graph_impact` | 分析符号上下游影响范围，输出置信度和 unresolved 说明 |
| `graph_query` | 从入口符号追踪执行流，返回流程摘要、关键符号和关键文件 |
| `detect_changes` | 将 git diff 映射到符号和影响分组 |

### 项目记忆

| 工具 | 用途 |
|------|------|
| `find_memory` | 快速查找模块记忆 |
| `record_memory` | 记录模块职责、API、依赖 |
| `delete_memory` | 删除模块记忆 |
| `record_decision` | 记录架构决策 |
| `get_project_profile` | 获取技术栈、结构、约定 |
| `maintain_memory_catalog` | 目录维护（check / rebuild） |
| `load_module_memory` | 渐进式按需加载模块记忆 |
| `list_memory_catalog` | 查看目录索引（调试用） |

### 长期记忆

| 工具 | 用途 |
|------|------|
| `record_long_term_memory` | 记录用户偏好、协作规则、外部参考、evidence、temporal fact |
| `manage_long_term_memory` | 查找/列举/清理/删除/失效长期记忆，也可用 `action=suggest` 只生成抽取建议 |
| `record_agent_diary` | 追加 agent diary 条目 |
| `read_agent_diary` | 读取某个 agent 的最近 diary |
| `find_agent_diary` | 按关键词搜索 diary |
| `record_result_feedback` | 记录结果有帮助/没帮助/记忆过期/绑定错误等反馈 |

### 跨项目 Hub

| 工具 | 用途 |
|------|------|
| `query_shared_memories` | 跨项目搜索模块记忆 |
| `link_memories` | 创建记忆间关系（depends_on / extends / references / implements） |
| `get_dependency_chain` | 递归依赖链分析 |
| `manage_projects` | 项目管理（action: register / list / stats） |

### 自动记录

| 工具 | 用途 |
|------|------|
| `session_end` | 会话结束时自动分析并建议记录记忆 |
| `suggest_memory` | AI 辅助提取模块记忆 |

### 上下文生命周期

| 工具 | 用途 |
|------|------|
| `create_checkpoint` | 创建任务 checkpoint 和可恢复上下文 |
| `load_checkpoint` | 读取 checkpoint 并返回恢复包 |
| `list_checkpoints` | 列出当前仓库 checkpoint |
| `prepare_handoff` | 基于 checkpoint 组装交接/恢复包 |
| `assemble_context` | 按 phase/profile 组装最小可用上下文 |
| `suggest_phase_boundary` | 建议下一阶段及阻塞项 |

#### 生命周期工具说明

`prepare_handoff`

- 输入：`repo_path`、`checkpoint_id`，可选 `agent_name` / `topic` / `diary_limit`
- 输出重点：`handoffSummary`、`referencedBlockIds`、`unresolvedBlockIds`
- 语义：在 checkpoint 自身的 task-state block 之外，会尽量补出可解析的模块摘要、supporting refs、已检视代码引用，以及按需带上的最近 diary，便于下一位 agent 直接接手

`assemble_context`

- 输入：`repo_path`，可选 `phase` / `profile` / `checkpoint_id` / `moduleName` / `query` / `filePaths` / `includeDiary` / `agentName` / `diaryTopic` / `diaryLimit`
- 输出重点：`selectedContext.contextBlocks`、`references`、`assemblyProfile`、`wakeupLayers`
- 语义：按阶段装配“最小可用上下文包”；`phase=research` 会映射到 `overview` profile，`profile` 当前仅支持 `overview/debug/implementation/verification/handoff`。输出会显式给出 L0-L3 wakeup layers，并在命中的 evidence / temporal fact / diary 存在时一并暴露

`suggest_phase_boundary`

- 输入：`repo_path`、`current_phase`，可选 `checkpoint_id` / `checkpoint` / `retrieval_signal` / `assembly_signal`
- 输出重点：`recommendedPhase`、`transition`、`shouldTransition`、`blockers`
- 语义：这是边界判断器，不是固定推进器；当证据不足、存在 blocker 或 phase 冲突时，会明确返回保持当前阶段

## 推荐使用顺序

1. **先** `find_memory` 定位已有模块知识
2. **再** `codebase-retrieval` 查看具体实现
3. **完成后** `record_memory` / `record_decision` / `record_result_feedback` / `session_end` 回写稳定知识
4. **跨项目复用时** `query_shared_memories` 查找相似实现

## 典型调用示例

### 代码检索

`codebase-retrieval` 现在默认会附带一段轻量直接图谱摘要；只有在你明确不需要时，才传 `include_graph_context: false` 关闭。

```json
{
  "repo_path": "/path/to/repo",
  "information_request": "Trace the execution flow of the login process",
  "technical_terms": ["AuthService", "login"]
}
```

### 记录模块记忆

```json
{
  "name": "SearchService",
  "responsibility": "Hybrid semantic + lexical code retrieval",
  "dir": "src/search/",
  "files": ["SearchService.ts", "GraphExpander.ts", "ContextPacker.ts"],
  "exports": ["SearchService"],
  "imports": ["VectorStore", "Database"],
  "external": ["lancedb", "better-sqlite3"],
  "confirmationStatus": "human-confirmed"
}
```

### 记录架构决策

```json
{
  "id": "2026-04-02-memory-routing",
  "title": "引入渐进式记忆路由",
  "context": "需要控制代理加载的上下文大小",
  "decision": "使用 catalog -> global -> feature 三层加载",
  "owner": "search-owner",
  "reviewer": "ops-lead",
  "rationale": "先路由再按需加载，减少 token 开销",
  "alternatives": [],
  "consequences": ["决策记录需要可追责的 owner/reviewer 元数据"]
}
```

### 管理长期记忆

```json
{
  "action": "find",
  "query": "user preferences"
}
```

### 记录结果反馈

```json
{
  "outcome": "memory-stale",
  "targetType": "feature-memory",
  "query": "Trace retrieval flow",
  "targetId": "SearchService",
  "details": "Memory still points to legacy path"
}
```

```json
{
  "action": "prune",
  "dryRun": true
}
```

### 跨项目搜索

```json
{
  "category": "auth"
}
```

### 依赖链分析

```json
{
  "project": "ctx",
  "module": "AuthService",
  "recursive": true
}
```

### 交接包

```json
{
  "repo_path": "/path/to/repo",
  "checkpoint_id": "chk_1234567890ab",
  "format": "json"
}
```

### 上下文装配

```json
{
  "repo_path": "/path/to/repo",
  "phase": "implementation",
  "checkpoint_id": "chk_1234567890ab",
  "moduleName": "SearchService",
  "query": "Trace retrieval flow",
  "filePaths": ["src/search/SearchService.ts"],
  "format": "json"
}
```

### 阶段边界建议

```json
{
  "repo_path": "/path/to/repo",
  "current_phase": "debug",
  "checkpoint_id": "chk_1234567890ab",
  "retrieval_signal": {
    "codeBlocks": 3,
    "memoryBlocks": 1,
    "decisionBlocks": 0,
    "confidence": "high",
    "mode": "expanded"
  },
  "assembly_signal": {
    "profile": "debug",
    "source": "phase",
    "budgetUsed": 4,
    "budgetLimit": 8
  },
  "format": "json"
}
```

## 与 CLI 模式的区别

- **MCP 模式**通过标准 MCP 协议暴露工具，适合 MCP 客户端（Claude Desktop、Gemini、Codex 等）直接调用。
- **CLI 模式**通过 `contextatlas` 命令行操作，适合终端使用和 skill 集成。
- 两种模式的 `setup` 互斥：`setup:local --mode mcp` 不会写入 CLI skill 文件，`setup:local --mode cli` 不会写入 MCP 配置。
