# MCP 工具参考

如果你是第一次接入 ContextAtlas，建议先读 [首次使用](./FIRST_USE.md)，确认默认 CLI 入口和索引状态，再配置 MCP。

## 配置

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

- `full`：默认，暴露全部 21 个工具
- `retrieval-only`：仅暴露 7 个只读检索工具，适合把 ContextAtlas 当作纯 retrieval/memory reader 使用

## 工具总览（21 个）

### 代码检索

| 工具 | 用途 |
|------|------|
| `codebase-retrieval` | 混合语义+词法代码检索（核心工具） |

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
| `record_long_term_memory` | 记录用户偏好、协作规则、外部参考 |
| `manage_long_term_memory` | 查找/列举/清理/删除长期记忆（action: find / list / prune / delete） |
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
| `prepare_handoff` | 基于 checkpoint 组装交接/恢复包 |
| `assemble_context` | 按 phase/profile 组装最小可用上下文 |
| `suggest_phase_boundary` | 建议下一阶段及阻塞项 |

#### 生命周期工具说明

`prepare_handoff`

- 输入：`repo_path`、`checkpoint_id`
- 输出重点：`handoffSummary`、`referencedBlockIds`、`unresolvedBlockIds`
- 语义：在 checkpoint 自身的 task-state block 之外，会尽量补出可解析的模块摘要和已检视代码引用，便于下一位 agent 直接接手

`assemble_context`

- 输入：`repo_path`，可选 `phase` / `profile` / `checkpoint_id` / `moduleName` / `query` / `filePaths`
- 输出重点：`selectedContext.contextBlocks`、`references`、`assemblyProfile`
- 语义：按阶段装配“最小可用上下文包”；`phase=research` 会映射到 `overview` profile，`profile` 当前仅支持 `overview/debug/implementation/verification/handoff`

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
