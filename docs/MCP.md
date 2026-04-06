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

- `full`：默认，暴露全部 18 个工具
- `retrieval-only`：仅暴露 7 个只读检索工具，适合把 ContextAtlas 当作纯 retrieval/memory reader 使用

## 工具总览（18 个）

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
