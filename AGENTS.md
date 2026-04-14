# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

## Project Overview

ContextAtlas 是一个为 AI 代码助手设计的语义检索引擎，采用混合搜索（向量 + 词法）、智能上下文扩展和 Token 感知打包策略。

## Development Commands

```bash
# Build
pnpm build                    # 编译 TypeScript (tsup)

# Development
pnpm dev                      # Watch 模式开发

# Run locally
pnpm start                    # 运行编译后的 CLI
node dist/index.js            # 直接运行

# CLI usage
contextatlas init            # 初始化配置文件 (~/.contextatlas/.env)
contextatlas index [path]    # 索引代码库
contextatlas search          # 本地搜索
contextatlas mcp             # 启动 MCP 服务端
```

## Architecture

### Core Pipeline

```
索引: Crawler → Processor → SemanticSplitter → Indexer → VectorStore/SQLite
搜索: Query → Vector+FTS Recall → RRF Fusion → Rerank → GraphExpander → ContextPacker
```

### Architecture Layers

```
CLI commands  →  application layer  →  memory/search domain  →  storage
MCP adapters  →  (Zod schema only)  →  (business logic)      →  (SQLite/LanceDB)
```

MCP tools (`src/mcp/tools/`) are thin adapters: Zod schema validation + protocol formatting.
Business logic lives in `src/application/` (memory, retrieval) and `src/memory/` (domain).
CLI commands (`src/cli/commands/`) call application layer directly, bypassing MCP adapters.

### Key Modules

| Module | Location | Responsibility |
|--------|----------|----------------|
| **Application Layer** | `src/application/memory/` | Memory 工具业务逻辑，CLI 和 MCP adapter 统一入口 |
| **Retrieval Application** | `src/application/retrieval/` | 检索用例编排，结果卡片渲染 |
| **SearchService** | `src/search/SearchService.ts` | 搜索总编排层，串联 recall、rerank、cutoff、expand、pack |
| **HybridRecallEngine** | `src/search/HybridRecallEngine.ts` | 混合召回执行层，负责向量/词法召回、FTS 降级与 RRF 融合 |
| **RerankPolicy** | `src/search/RerankPolicy.ts` | rerank 池选择与 Smart TopK cutoff 策略 |
| **SnippetExtractor** | `src/search/SnippetExtractor.ts` | rerank 文本构造与命中片段截取 |
| **MemoryStore** | `src/memory/MemoryStore.ts` | 记忆 facade，协调 feature/project-meta/decision/long-term 四类子存储 |
| **MemoryStoreBootstrap** | `src/memory/MemoryStoreBootstrap.ts` | 项目注册、只读/可写初始化与兼容导入引导 |
| **ProjectMetaStore** | `src/memory/ProjectMetaStore.ts` | checkpoint、profile、catalog、global memory 持久化 |
| **FeatureMemoryRepository** | `src/memory/FeatureMemoryRepository.ts` | feature memory 的 SQLite CRUD |
| **FeatureMemoryCatalogCoordinator** | `src/memory/FeatureMemoryCatalogCoordinator.ts` | feature memory 与 MemoryRouter catalog 的同步 |
| **DecisionStore** | `src/memory/DecisionStore.ts` | 架构决策记录的持久化与映射 |
| **LongTermMemoryService** | `src/memory/LongTermMemoryService.ts` | 长期记忆追加、检索、合并、状态与清理 |
| **GraphExpander** | `src/search/GraphExpander.ts` | 三阶段上下文扩展 (E1 邻居/E2 面包屑/E3 导入) |
| **ContextPacker** | `src/search/ContextPacker.ts` | 段落合并和 Token 预算控制 |
| **SemanticSplitter** | `src/chunking/SemanticSplitter.ts` | AST 语义分片器 (Tree-sitter) |
| **VectorStore** | `src/vectorStore/index.ts` | LanceDB 适配层 |
| **Database** | `src/db/index.ts` | SQLite + FTS5 元数据和全文索引 |
| **MCP Server** | `src/mcp/server.ts` | Model Context Protocol 服务端实现 |

### Import Resolvers

跨文件依赖解析器位于 `src/search/resolvers/`，支持 JS/TS、Python、Go、Java、Rust。

### Configuration

- 环境变量配置: `~/.contextatlas/.env`
- 搜索参数配置: `src/search/config.ts`
- 日志文件: `~/.contextatlas/logs/app.YYYY-MM-DD.log`

## Code Conventions

- TypeScript ESM 模块 (`"type": "module"`)
- 使用 tsup 打包
- Node.js >= 20
- pnpm 作为包管理器
