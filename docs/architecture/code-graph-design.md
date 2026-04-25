# ContextAtlas 代码知识图谱功能设计

> 版本: 0.2.1 | 状态: Baseline Implemented / Advanced Items Open | 日期: 2026-04-25

## 当前实现状态

截至 2026-04-25，本文档已经不再只是纯设计稿，仓库中已有一版最小可用实现：

| 范围 | 状态 | 说明 |
|------|------|------|
| Phase 0 | ✅ 完成 | `ProcessResult.graph` 接缝、scanner graph 编排钩子、db migration 钩子已固定 |
| Phase 1 | ✅ 完成 | `symbols/relations/symbols_fts`、`GraphStore`、`SymbolExtractor`、scanner 持久化、`graph_impact` / `graph_context` 已落地 |
| Phase 2 | ✅ 最小闭环完成 | `ChangeDetector` / `detect_changes`、`ExecutionTracer` / `graph_query` 已落地 |
| Phase 3 | ✅ 第一阶段完成 | `GraphExpander` E3 已支持 graph-first / fallback-aware 扩展 |
| Phase 4 | 🟡 部分被替代 | API 契约分析已由 system-boundary 计划 P5 以轻量派生扫描覆盖；多仓库联合图和可视化仍是后续专题 |

当前已实现文件主要包括：
- `src/graph/GraphStore.ts`
- `src/graph/SymbolExtractor.ts`
- `src/graph/ChangeDetector.ts`
- `src/graph/ExecutionTracer.ts`
- `src/mcp/tools/codeGraph.ts`
- `src/search/GraphExpander.ts`

## 2026-04-25 清账说明

本文档保留原始设计背景，但部分旧验收项已由当前代码或 `docs/plans/2026-04-24-system-boundary-and-optimization-plan.md` 覆盖：

| 旧条目 | 当前状态 |
|--------|----------|
| Phase 1 基础图谱 | 已由 SQLite `symbols` / `relations` / `symbols_fts`、`GraphStore`、`SymbolExtractor`、`graph_impact`、`graph_context` 覆盖。 |
| Phase 2 执行流与变更检测 | 已由 `ExecutionTracer` / `graph_query`、`ChangeDetector` / `detect_changes` 覆盖；多语言 provider 当前覆盖 TS/JS、Python、Go、Java，未达到原文“6+ 语言”表述。 |
| Phase 3 图谱增强检索 | 已由 `GraphExpander` graph-first / fallback-aware 扩展覆盖；`graph_rename` 和“图扩展优于启发式 import 扩展”的 AB 证据仍未完成。 |
| Phase 4 API 契约分析 | 被 system-boundary 计划 P5 的 `contract_analysis` 轻量派生扫描替代；不再按本文档原 Phase 4 的多仓库联合图路径推进。 |

## 文档目的

本文档阐述在 ContextAtlas 中集成代码知识图谱能力的设计方案，包括：为什么需要图谱、如何与现有索引管线融合、前后对比、以及分阶段开发计划。

受众：项目维护者、核心开发者。

---

## 一、为什么要补图谱

### 1.1 当前检索的局限

ContextAtlas 的检索链路是「语义向量 + FTS5 关键词 → RRF 融合 → GraphExpander 扩展 → Token 感知打包」。这条链路能解决「找到相关代码」的问题，但无法回答「代码间的关系是什么」。

具体缺陷：

| 场景 | 当前行为 | 期望行为 |
|------|---------|---------|
| 改了 `updatePassword`，想知道影响范围 | `codebase-retrieval` 返回语义相似的代码块，可能遗漏间接调用 | 返回精确的下游调用链 + 风险等级 |
| 接手陌生模块 | 多次检索拼凑架构理解 | 一次查询返回完整的执行流和模块依赖 |
| 提交前检查变更影响 | 无自动手段，靠 `grep` 和记忆 | 自动检测变更符号的上下游影响 |

### 1.2 GraphExpander 的现有边界

当前 `src/search/GraphExpander.ts` 已经有三层扩展：

- **E1 同文件邻居**: 前后相邻 chunks（基于 chunk_index）
- **E2 breadcrumb 补段**: 同前缀的其他 chunks（如同一 class 的其他方法）
- **E3 跨文件引用**: 解析 import 语句获取被导入文件的 chunks

**但 E3 的局限是**：它只解析 import 语句，不解析函数调用（CALLS）、类继承（EXTENDS）、接口实现（IMPLEMENTS）等关系。它返回的是「被导入文件的 chunks」而非「精确调用目标的符号」。

### 1.3 图谱解决什么

知识图谱在 **符号级** 建立关系网络：

```
当前 (chunk 级扁平检索):
  chunk_42: "UserService.ts 第 45-68 行" (向量距离 0.12)
  chunk_43: "UserService.ts 第 70-85 行" (向量距离 0.15)

图谱 (符号级关系查询):
  (Function:updatePassword) ─CALLS→ (Function:hashPassword)
  (Function:updatePassword) ─CALLS→ (Function:invalidateCache)
  (Class:UserService) ─HAS_METHOD→ (Function:updatePassword)
  (Function:updatePassword) ←CALLS─ (Function:handlePasswordReset)  ← 谁调用了它
```

核心价值：

1. **爆破半径分析**: 改一个函数前精确知道所有受影响的上下游
2. **结构感知检索**: 检索结果按调用链和依赖关系扩展，而非纯语义猜测
3. **变更检测**: git diff → 匹配符号 → 图查询影响范围
4. **执行流追踪**: 从入口点到终止点的完整路径

### 1.4 为什么不直接用外部图谱工具

对比过 [GitNexus](https://github.com/abhigyanpatwari/GitNexus) 后，结论是：集成到 ContextAtlas 内部更合理。

| 维度 | 外部工具 (GitNexus) | 内置图谱 (本方案) |
|------|:------------------:|:----------------:|
| 索引次数 | 2 次（各自跑 tree-sitter） | 1 次（复用同一 AST） |
| 嵌入计算 | 2 次 | 1 次 |
| 运行时内存 | 1.5-2 GB（两个 MCP 进程） | 0.5-0.8 GB |
| 磁盘占用 | ~1.3 GB（两套 node_modules） | ~500 MB |
| 增量更新 | GitNexus 仅支持全量重建 | 统一增量（复用现有机制） |
| 许可证 | PolyForm Noncommercial | 纯 MIT |
| 维护负担 | 两套配置、两套索引 | 单一入口 |

**关键洞察**：图谱生成不需要引入新的数据库依赖（如 LadybugDB）。ContextAtlas 已有的 SQLite 支持递归 CTE，足以实现图遍历查询。tree-sitter 解析器已集成，`SemanticSplitter` 已经遍历 AST 并提取节点名称。图谱只是在现有流程中顺便提取符号和关系。

### 1.5 独立架构核对（基于当前代码）

下面这组结论不是设计假设，而是对当前仓库实现的直接核对结果：

1. **AST 目前只被用于分块，不会继续向后传递。**
   `processFile()` 当前流程是 `parser.parse(content)` 后立即调用 `SemanticSplitter.split(tree, ...)`，返回值仍然只有 `ProcessResult.chunks`，没有符号或关系产物，也没有保留 AST 供后续阶段复用。

2. **当前“结构信息”的持久化形式是 breadcrumb，不是符号表。**
   `ChunkMetadata` 里只有 `contextPath`，而 `Indexer` 最终写入 LanceDB 的结构字段是 `breadcrumb: contextPath.join(' > ')`。这说明系统已经具备“语义路径”这种弱结构信号，但还没有稳定的 symbol identity。

3. **SQLite 侧目前没有图谱 schema。**
   `src/db/index.ts` 的基础 schema 只有 `files`、`metadata`、`schema_migrations`，图谱需要显式新增 `symbols`、`relations` 和相应 migration，而不是挂靠在现有表上。

4. **GraphExpander 的 E3 目前是“文件级 import 扩展”，不是“符号级关系扩展”。**
   当前实现会先从 `files` 表取源码内容，再用语言 resolver 做 `extract()` 和 `resolve()`，最后直接 `getFileChunks(targetPath)` 取目标文件的 chunks。也就是说，现有 E3 的目标对象是文件，不是函数/类/方法。

基于这组事实，当前设计需要补充三个实现约束：

- **图谱是现有检索索引旁边的一套新结构索引**，不是把 `GraphExpander` 直接“升级”为图查询就能完成的。
- **最合适的集成缝在 `scanner/processor.ts` 与 `scanner/index.ts` 之间**：先让 `processFile()` 产出 `graph payload`，再由扫描/索引编排层决定何时写入 SQLite。这样能复用现有 AST，又不会把图谱逻辑塞进 `SearchService` 或 `SemanticSplitter`。
- **Phase 1 应先做稳定、低歧义的边**，例如 `HAS_METHOD`、`EXTENDS`、`IMPLEMENTS`、`IMPORTS` 和“文件内 CALLS”；跨文件 `CALLS` 的精确解析应放到后续阶段，否则首版会过早陷入名称解析和作用域绑定问题。

---

## 二、设计方案

### 2.1 架构总览

```
┌─────────────────────────────────────────────────────────────┐
│                    统一索引管线 (改造后)                       │
│                                                             │
│  源代码 → Scanner → processFiles()                          │
│                       │                                     │
│                Tree-sitter AST (一次解析)                     │
│                       │                                     │
│            ┌──────────┼──────────────┐                      │
│            ▼                         ▼                      │
│    SemanticSplitter          SymbolExtractor  ← 新增         │
│    (分块 → chunks)           (符号+关系 → graph)             │
│            │                         │                      │
│            ▼                         ▼                      │
│    LanceDB + FTS5           SQLite 关系表    ← 新增          │
│    (检索索引)               (图谱索引)                       │
│            │                         │                      │
│            └──── 共享嵌入计算 ─────────┘                     │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              查询层 (统一)                             │    │
│  │  codebase-retrieval ─→ 混合召回 + 图扩展 + 打包        │    │
│  │  graph_impact ──────→ 图遍历 BFS/DFS                  │    │
│  │  graph_context ─────→ 360° 符号视图                    │    │
│  │  detect_changes ────→ git diff → 符号匹配 → 影响查询    │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 数据模型

在现有 SQLite 数据库中新增两张表：

```sql
-- 符号表
CREATE TABLE IF NOT EXISTS symbols (
  id          TEXT PRIMARY KEY,           -- 格式: "{language}:{filePath}:{symbolName}:{startLine}"
  name        TEXT NOT NULL,              -- 符号名
  type        TEXT NOT NULL,              -- Function | Class | Method | Interface | Variable | Enum | Struct | Trait
  file_path   TEXT NOT NULL,              -- 相对路径
  language    TEXT NOT NULL,              -- 语言标识
  start_line  INTEGER NOT NULL,
  end_line    INTEGER NOT NULL,
  modifiers   TEXT,                       -- JSON: ["export", "async", "static", "private"]
  parent_id   TEXT,                       -- 父符号 ID (方法→类, 内部类→外部类)
  exported    INTEGER DEFAULT 0,          -- 是否导出 (export/public)
  FOREIGN KEY (file_path) REFERENCES files(path)
);

-- 关系表
CREATE TABLE IF NOT EXISTS relations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id     TEXT NOT NULL,              -- 源符号 ID
  to_id       TEXT NOT NULL,              -- 目标符号 ID
  type        TEXT NOT NULL,              -- CALLS | IMPORTS | EXTENDS | IMPLEMENTS | HAS_METHOD | HAS_PROPERTY | ACCESSES
  confidence  REAL DEFAULT 1.0,           -- 置信度 (0-1, AST 解析 = 1.0, 推断 < 1.0)
  reason      TEXT,                       -- 关系原因说明
  FOREIGN KEY (from_id) REFERENCES symbols(id),
  FOREIGN KEY (to_id) REFERENCES symbols(id)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_path);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_type ON symbols(type);
CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_id);
CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_id);
CREATE INDEX IF NOT EXISTS idx_relations_type ON relations(type);

-- FTS5 索引 (符号名全文搜索)
CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(name, content='symbols', content_rowid='rowid');
```

### 2.3 图谱生成：复用现有 AST

核心设计原则：**不增加额外的 tree-sitter 解析**。图谱提取在 `processFiles()` 阶段复用已有的 AST，但不把图谱写入职责塞进 `SemanticSplitter` 或搜索层。

#### 当前 processFiles() 流程

```
processor.ts:
  文件内容 → tree-sitter parse → AST tree
                                    │
                                    └→ SemanticSplitter.split(tree, code, filePath, language)
                                         → visitNode() 递归遍历
                                         → extractNodeName() 提取名称
                                         → 输出 ProcessedChunk[]
                                         → AST tree 被丢弃
```

#### 改造后流程

```
processor.ts:
  文件内容 → tree-sitter parse → AST tree
                                    │
                          ┌─────────┼─────────┐
                          ▼                   ▼
              SemanticSplitter.split()   SymbolExtractor.extract()  ← 新增
              → chunks (不变)            → graph payload
                          │                   │
                          └─────────┬─────────┘
                                    ▼
                           ProcessResult 增强返回
                                    │
                                    ▼
                        scanner/index.ts 编排写入 SQLite
```

`SymbolExtractor` 的核心逻辑：

```typescript
// src/graph/SymbolExtractor.ts (新增)

export interface ExtractedSymbol {
  id: string;          // "{language}:{filePath}:{name}:{startLine}"
  name: string;
  type: 'Function' | 'Class' | 'Method' | 'Interface' | 'Variable' | 'Enum';
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
  modifiers: string[];  // ['export', 'async', 'static', 'private']
  parentId: string | null;
  exported: boolean;
}

export interface ExtractedRelation {
  fromId: string;
  toId: string;        // 可能是外部符号 (unresolved)
  type: 'CALLS' | 'IMPORTS' | 'EXTENDS' | 'IMPLEMENTS' | 'HAS_METHOD' | 'ACCESSES';
  confidence: number;
}

export class SymbolExtractor {
  /**
   * 从已有的 tree-sitter AST 中提取符号和关系
   * @param tree - 已解析的 AST (由 processFiles 传入)
   * @param code - 源代码文本
   * @param filePath - 文件相对路径
   * @param language - 语言标识
   */
  extract(
    tree: Parser.Tree,
    code: string,
    filePath: string,
    language: string,
  ): { symbols: ExtractedSymbol[]; relations: ExtractedRelation[] } {
    // 1. 遍历 AST，识别声明节点
    //    利用 LanguageSpec 中已定义的 hierarchy 集合
    //    (class_declaration, function_declaration, method_definition 等)
    //
    // 2. 对每个声明节点：
    //    - 提取 name (复用 SemanticSplitter.extractNodeName 的逻辑)
    //    - 提取 type (function/class/interface/method/variable)
    //    - 提取 modifiers (export/async/static/private)
    //    - 提取 parent (通过 AST 层级关系)
    //
    // 3. 提取关系：
    //    - CALLS: 从 call_expression 节点提取被调用函数名
    //    - IMPORTS: 复用现有 ImportResolver.extract() 的逻辑
    //    - EXTENDS: 从 class 声明的 superclass 子句提取
    //    - IMPLEMENTS: 从 class 声明的 interfaces 子句提取
    //    - HAS_METHOD: 从 class body 中的方法声明建立
    //    - ACCESSES: 从 member_expression 提取属性访问
    //
    // 4. 返回结构化数据
  }
}
```

#### 与 SemanticSplitter 的关系

`SemanticSplitter.visitNode()` 已经做了：
- 递归遍历 AST 每个节点
- 通过 `LanguageSpec.hierarchy` 检测类/函数/方法节点
- 通过 `extractNodeName()` 提取节点名称
- 维护 `contextPath`（如 `["file.ts", "class Foo", "method bar"]`）

`SymbolExtractor` 需要做的额外工作：
- **记录**每个声明节点（SemanticSplitter 只是遍历，不持久化）
- **提取调用关系**（从 `call_expression` 节点）
- **提取继承关系**（从 `extends` / `implements` 子句）
- **解析跨文件引用**（复用现有 `ImportResolver`）

**推荐落点**：首版不要把 `SymbolExtractor` 嵌入 `SemanticSplitter.visitNode()`。更稳妥的做法是扩展 `ProcessResult`，例如新增：

```typescript
interface ProcessResult {
  // 现有字段
  chunks: ProcessedChunk[];

  // 新增字段
  graph?: {
    symbols: ExtractedSymbol[];
    relations: ExtractedRelation[];
    unresolvedRefs?: string[];
  };
}
```

这样 `processor.ts` 仍然只负责“从单文件提取产物”，而 `scanner/index.ts` 继续承担“批量写入、删除和增量同步”的编排职责。等图谱模型稳定后，再决定是否进一步把遍历逻辑并入 `SemanticSplitter` 以减少一次 AST walk。

### 2.4 增量更新

复用现有的增量索引机制，不引入新的更新策略：

```
scan() 检测变更:
  ├── added/modified 文件:
  │   ├── processFiles() → chunks → 嵌入 → 写入索引 (不变)
  │   └── SymbolExtractor → symbols + relations → 写入 SQLite (新增)
  │       先 DELETE WHERE file_path = ?
  │       再批量 INSERT
  │
  ├── deleted 文件:
  │   ├── 删除 chunks + 向量 (不变)
  │   └── DELETE symbols + relations WHERE file_path = ? (新增)
  │
  └── unchanged 文件: 跳过 (不变)
```

跨文件关系解析的处理：

```
修改了 UserService.ts:
  1. 删除 UserService.ts 的旧 symbols + relations
  2. 重新解析 → 提取新 symbols
  3. 解析 import 语句 → 定位目标文件
  4. 在 SQLite 中查找目标文件的已有 symbols → 建立 IMPORTS 关系
  5. 如果目标文件尚未被索引 → 标记为 unresolved，后续补全

修改了 UserTypes.ts (被 UserService.ts 导入):
  1. 更新 UserTypes.ts 的 symbols
  2. 通过反查 relations 表找到依赖方:
     SELECT from_id FROM relations WHERE to_id IN (旧 symbol IDs)
  3. 重新建立依赖方的 IMPORTS/CALLS 关系
```

### 2.5 图查询实现

使用 SQLite 递归 CTE (Common Table Expression) 实现图遍历，无需引入图数据库。

#### 爆破半径分析 (impact)

```sql
-- 查找符号 "updatePassword" 的所有下游依赖 (depth ≤ 3)
WITH RECURSIVE blast_radius AS (
  -- 起点: 直接被 updatePassword 调用的符号
  SELECT
    r.to_id AS node_id,
    1 AS depth,
    'direct' AS risk,
    r.type AS relation_type
  FROM relations r
  JOIN symbols s ON r.from_id = s.id
  WHERE s.name = ? AND s.file_path = ?

  UNION ALL

  -- 递归: 继续追踪下游
  SELECT
    r.to_id,
    br.depth + 1,
    CASE
      WHEN br.depth + 1 = 2 THEN 'indirect'
      WHEN br.depth + 1 >= 3 THEN 'transitive'
    END,
    r.type
  FROM relations r
  JOIN blast_radius br ON r.from_id = br.node_id
  WHERE br.depth < ?
    AND r.type IN ('CALLS', 'IMPORTS', 'ACCESSES')
)
SELECT
  s.name,
  s.type AS symbol_type,
  s.file_path,
  br.depth,
  br.risk,
  br.relation_type
FROM blast_radius br
JOIN symbols s ON s.id = br.node_id
ORDER BY br.depth, br.risk;
```

#### 360° 符号视图 (context)

```sql
-- 获取符号的所有关系 (入方向 + 出方向)
SELECT
  'incoming' AS direction,
  r.type,
  s_from.name AS source_name,
  s_from.type AS source_type,
  s_from.file_path AS source_file
FROM relations r
JOIN symbols s_from ON r.from_id = s_from.id
WHERE r.to_id = ?

UNION ALL

SELECT
  'outgoing' AS direction,
  r.type,
  s_to.name AS target_name,
  s_to.type AS target_type,
  s_to.file_path AS target_file
FROM relations r
JOIN symbols s_to ON r.to_id = s_to.id
WHERE r.from_id = ?;
```

#### 执行流追踪

```sql
-- 从入口点追踪执行流 (depth ≤ 10)
WITH RECURSIVE execution_flow AS (
  -- 起点: 入口函数 (如 main, handleRequest)
  SELECT s.id, s.name, s.file_path, 1 AS step
  FROM symbols s
  WHERE s.name = ? AND s.file_path = ?

  UNION ALL

  SELECT r.to_id, s.name, s.file_path, ef.step + 1
  FROM execution_flow ef
  JOIN relations r ON r.from_id = ef.id
  JOIN symbols s ON r.to_id = s.id
  WHERE ef.step < 10
    AND r.type = 'CALLS'
)
SELECT step, name, file_path FROM execution_flow ORDER BY step;
```

#### 性能预估

| 查询类型 | 数据规模 (中型项目) | 预估延迟 |
|---------|:------------------:|:-------:|
| 爆破半径 (depth=3) | ~3000 关系 | <5ms |
| 360° 符号视图 | ~50 关系/符号 | <2ms |
| 执行流追踪 (depth=10) | ~500 步 | <10ms |
| 符号名搜索 (FTS5) | ~800 符号 | <1ms |

SQLite 递归 CTE 在 10 万级节点上毫秒级返回，代码图谱（通常 1-5 万符号）完全在性能预算内。

### 2.6 新增 MCP 工具

在现有 MCP 工具集之上新增 4 个图谱工具：

#### `graph_impact` — 爆破半径分析

```typescript
interface GraphImpactInput {
  target: string;              // 符号名
  file_path?: string;          // 文件路径 (消歧)
  direction: 'upstream' | 'downstream' | 'both';
  max_depth?: number;          // 默认 3
  relation_types?: string[];   // 过滤关系类型
  include_tests?: boolean;     // 是否包含测试文件
}

interface GraphImpactOutput {
  target: { name: string; type: string; file_path: string };
  risk_level: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  affected: Array<{
    symbol: string;
    type: string;
    file_path: string;
    depth: number;
    risk: 'direct' | 'indirect' | 'transitive';
    relation_type: string;
  }>;
  affected_processes: string[];   // 受影响的执行流
  summary: string;
}
```

#### `graph_context` — 360° 符号视图

```typescript
interface GraphContextInput {
  name: string;                // 符号名
  file_path?: string;          // 消歧
  include_content?: boolean;   // 是否返回源码
}

interface GraphContextOutput {
  symbol: {
    name: string;
    type: string;
    file_path: string;
    start_line: number;
    end_line: number;
    modifiers: string[];
    source_code?: string;
  };
  callers: Array<{ name: string; type: string; file_path: string }>;
  callees: Array<{ name: string; type: string; file_path: string }>;
  imports: Array<{ name: string; file_path: string }>;
  imported_by: Array<{ name: string; file_path: string }>;
  extends?: string;
  implements?: string[];
  methods?: Array<{ name: string; type: string }>;
}
```

#### `graph_query` — 图谱语义查询

```typescript
interface GraphQueryInput {
  query: string;               // 自然语言或符号名
  limit?: number;              // 默认 5
  include_relations?: boolean; // 是否包含关系
}

interface GraphQueryOutput {
  symbols: Array<{
    name: string;
    type: string;
    file_path: string;
    relevance_score: number;
    relations?: Array<{ type: string; target: string }>;
  }>;
}
```

#### `detect_changes` — 变更影响检测

```typescript
interface DetectChangesInput {
  scope: 'unstaged' | 'staged' | 'all' | 'compare';
  base_ref?: string;           // compare 模式的基准 ref
}

interface DetectChangesOutput {
  changed_symbols: Array<{
    name: string;
    type: string;
    file_path: string;
    change_type: 'added' | 'modified' | 'removed';
  }>;
  affected_downstream: GraphImpactOutput;
  affected_upstream: GraphImpactOutput;
  risk_summary: {
    level: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    details: string;
  };
}
```

### 2.7 检索增强：图扩展替代启发式扩展

当前 `GraphExpander` 的 E3 扩展（跨文件引用）是基于 import 语句文本解析的启发式方法。集成图谱后，可以用精确的图关系替代：

```
当前 E3:
  import { UserService } from './UserService'
  → 解析为文件路径 → 获取该文件的所有 chunks

图谱增强 E3:
  import { UserService } from './UserService'
  → 匹配到 (Symbol:UserService) 节点
  → 沿 CALLS/EXTENDS/IMPLEMENTS 边扩展 1-2 跳
  → 只返回与查询相关的符号对应的 chunks
```

实现方式：在 `GraphExpander.expandImports()` 中，增加一个图扩展路径。当图谱数据可用时，优先使用图查询；不可用时回退到当前的文本解析。

---

## 三、前后对比

> 注：本节数字目前是设计估算，用于判断方案量级，不代表已经完成的基准测试结果。

### 3.1 索引性能对比

| 指标 | 集成前 (当前) | 集成后 | 变化 |
|------|:-----------:|:------:|:----:|
| **Tree-sitter 解析** | 1 次/文件 | 1 次/文件 | 不变 |
| **符号提取** | — | +0.1-0.5 ms/文件 | 新增 |
| **关系提取** | — | +0.2-1.0 ms/文件 | 新增 |
| **嵌入计算** | 50-200 ms/文件 | 50-200 ms/文件 | 不变 |
| **写入 SQLite** | 1-2 ms/文件 | 1.5-3 ms/文件 | +0.5-1 ms |
| **写入 LanceDB** | 2-5 ms/文件 | 2-5 ms/文件 | 不变 |
| **单文件额外开销** | — | **+1-4 ms** | — |
| **200 文件项目总开销** | ~38 秒 | ~39 秒 | **+~1 秒 (+2.6%)** |
| **首次索引 (中项目)** | 3-5 分钟 | 3-5 分钟 | 不变 |

### 3.2 存储对比

以 ContextAtlas 自身（~100 个 TS 文件，~800 符号）为基准：

| 存储项 | 集成前 | 集成后 | 变化 |
|--------|:------:|:------:|:----:|
| SQLite (meta + FTS5) | ~5 MB | ~5.5 MB | +0.5 MB |
| LanceDB (向量) | ~50 MB | ~50 MB | 不变 |
| **新增: symbols 表** | — | ~160 KB | +0.16 MB |
| **新增: relations 表** | — | ~300 KB | +0.3 MB |
| **新增: symbols_fts** | — | ~50 KB | +0.05 MB |
| **总计** | ~55 MB | ~55.5 MB | **+~0.5 MB (+1%)** |

### 3.3 运行时资源对比

| 资源 | 集成前 (单 ContextAtlas) | 如果用外部 GitNexus | 集成后 (本方案) |
|------|:----------------------:|:-----------------:|:-------------:|
| MCP 进程 | 1 | 2 | 1 |
| 内存 | ~200-500 MB | ~1.5-2 GB | ~250-600 MB |
| 磁盘 (node_modules) | ~500 MB | ~1.3 GB | ~500 MB |
| npm 依赖数 | 33 runtime | 33 + 21 = 54 | 33 |
| 增量更新 | ✅ 秒级 | ❌ 全量重建分钟级 | ✅ 秒级 |
| 许可证合规 | MIT | MIT + PolyForm | MIT |

### 3.4 能力对比

| 能力 | 集成前 | 集成后 | GitNexus (参考) |
|------|:------:|:------:|:--------------:|
| 混合检索 (向量+FTS) | ✅ | ✅ | ✅ |
| Token 感知打包 | ✅ | ✅ | ❌ |
| 项目记忆 | ✅ | ✅ | ❌ |
| 长期记忆 | ✅ | ✅ | ❌ |
| 跨项目知识共享 | ✅ | ✅ | ⚠️ (Groups) |
| 可观测性 | ✅ | ✅ | ❌ |
| 自愈索引 | ✅ | ✅ | ❌ |
| **爆破半径分析** | ❌ | ✅ | ✅ |
| **360° 符号视图** | ❌ | ✅ | ✅ |
| **变更影响检测** | ❌ | ✅ | ✅ |
| **执行流追踪** | ❌ | ✅ | ✅ |
| **安全重命名** | ❌ | ✅ (Phase 3) | ✅ |
| **多仓库联合图** | ❌ | ❌ (Phase 4+) | ✅ |
| **Web 可视化** | ❌ | ❌ | ✅ |

---

## 四、新增模块与文件结构

```
src/graph/                           ← 新模块
├── SymbolExtractor.ts               ← 符号+关系提取器
├── GraphStore.ts                    ← SQLite 关系表 CRUD + 递归 CTE 查询
├── ImpactAnalyzer.ts                ← 爆破半径分析
├── ExecutionTracer.ts               ← 执行流追踪 (Phase 2)
├── ChangeDetector.ts                ← git diff → 符号匹配 → 影响查询 (Phase 2)
├── types.ts                         ← 类型定义
└── languageSpecs.ts                 ← 各语言的符号类型映射

src/graph/languageSpecs/             ← 语言特定配置 (Phase 2+)
├── typescript.ts
├── python.ts
├── go.ts
├── java.ts
├── rust.ts
├── cpp.ts
└── csharp.ts

src/mcp/tools/                       ← 新增 MCP 工具
├── graphImpact.ts                   ← graph_impact 工具
├── graphContext.ts                  ← graph_context 工具
├── graphQuery.ts                    ← graph_query 工具
└── graphDetectChanges.ts            ← detect_changes 工具 (Phase 2)

tests/graph/                         ← 测试
├── SymbolExtractor.test.ts
├── GraphStore.test.ts
├── ImpactAnalyzer.test.ts
├── ExecutionTracer.test.ts
├── ChangeDetector.test.ts
└── languageSpecs/
    ├── typescript.test.ts
    ├── python.test.ts
    └── ...
```

### 与现有模块的关系

```
改造文件:
  src/scanner/processor.ts       ← 在 processFile() 中调用 SymbolExtractor
  src/scanner/index.ts           ← scan() 中增加图谱写入步骤
  src/db/index.ts                ← 新增 symbols/relations 表初始化
  src/search/GraphExpander.ts    ← E3 扩展增加图查询路径
  src/mcp/registry/tools.ts      ← 注册新 MCP 工具

新增文件:
  src/graph/*                    ← 全部新增
  src/mcp/tools/graph*.ts        ← 全部新增
  tests/graph/*                  ← 全部新增
```

---

## 五、执行方案

这一节不是“方向性 roadmap”，而是按当前仓库结构可直接落地的执行计划。建议严格按 Phase 顺序推进，除测试补全和文档同步外，不建议跨 Phase 并行实现。

### Phase 0: 基线与接缝固定

**目标**：在不引入图谱功能的前提下，先把后续接入点固定，避免 Phase 1 边写边改主干接口。

**改动点**：
- `src/graph/types.ts`
  定义 `ExtractedSymbol`、`ExtractedRelation`、`GraphWritePayload`、`GraphDirection`、`GraphEdgeType`
- `src/scanner/processor.ts`
  为 `ProcessResult` 预留 `graph?: GraphWritePayload` 字段，但先不写入真实数据
- `src/scanner/index.ts`
  增加图谱写入编排占位，确保后续能在 scan 生命周期中插入 graph write / delete
- `src/db/index.ts`
  预留 schema migration 常量和初始化钩子

**实施步骤**：
1. 补类型，不接业务逻辑。
2. 让扫描链路接受 `graph` 字段但默认为空。
3. 增加空实现或 no-op graph 写入入口，保证 Phase 1 只是在现有钩子中填充能力。

**验证**：
- `pnpm build`
- 搜索/索引现有测试无回归
- `cw index` 行为完全不变

**退出条件**：
- 主扫描链路已能承载 graph payload，但不产生任何新行为
- 没有污染 `SearchService`、`GraphExpander`、`SemanticSplitter` 的职责边界

### Phase 1: 基础图谱 (最小可用)

**目标**：落下最小可用图谱，支持 TypeScript/JavaScript 单语言的符号提取、关系存储、基础上下游分析。

**输入依赖**：
- 已完成 Phase 0 的类型与编排接缝
- 当前 `SemanticSplitter`、`ImportResolver`、`scanner/index.ts` 行为稳定

**核心范围**：
- `src/graph/SymbolExtractor.ts`
  从已有 AST 提取 `Function`、`Class`、`Method`、`Interface`
- `src/graph/GraphStore.ts`
  管理 `symbols`、`relations`、`symbols_fts`
- `src/graph/ImpactAnalyzer.ts`
  提供 BFS/DFS 风格的上下游关系查询
- `src/mcp/tools/graphImpact.ts`
- `src/mcp/tools/graphContext.ts`
- `src/mcp/registry/tools.ts`
  注册新工具

**首版边类型**：
- `IMPORTS`
- `HAS_METHOD`
- `EXTENDS`
- `IMPLEMENTS`
- 文件内 `CALLS`

**明确不做**：
- 跨文件精确 `CALLS`
- 重命名
- 多语言统一抽象优化
- 图驱动检索替换

**实施步骤**：
1. 在 `src/db/index.ts` 增加 `symbols`、`relations`、`symbols_fts` migration。
2. 实现 `GraphStore` 的单文件 upsert / delete / by-symbol lookup / recursive traversal。
3. 在 `SymbolExtractor` 中先做 TS/JS：
   - 声明节点识别
   - `parentId` / `exported` / `modifiers`
   - `IMPORTS` / `HAS_METHOD` / `EXTENDS` / `IMPLEMENTS`
   - 文件内 `CALLS`
4. 扩展 `processFile()`，返回 `graph` payload。
5. 在 `scanner/index.ts` 中将 graph write/delete 纳入现有增量索引事务。
6. 实现 `graph_impact` 与 `graph_context`。
7. 为空图谱场景保留 graceful fallback。

**测试计划**：
- `tests/graph/SymbolExtractor.test.ts`
- `tests/graph/GraphStore.test.ts`
- `tests/graph/ImpactAnalyzer.test.ts`
- `tests/mcp/` 下增加 graph tool 行为测试
- 增加扫描增量测试：
  修改文件、删除文件、空文件、解析失败文件

**验收标准**：
- [x] `cw index` 后 SQLite 中有 `symbols` / `relations` / `symbols_fts`
- [x] `graph_impact("SearchService", { direction: "downstream" })` 至少能返回 `IMPORTS` / `HAS_METHOD` / 文件内 `CALLS`
- [x] `graph_context("SearchService")` 返回 callers + callees + 所属文件/父符号
- [x] 修改或删除文件后图谱正确更新，无孤立 relations
- [ ] 索引时间增长 < 5%

**交付物**：
- 可用的单语言基础图谱
- 两个 MCP 工具
- 一组稳定的迁移和增量更新测试

### Phase 2: 执行流与变更检测

**目标**：在基础图谱之上支持“从查询到路径”和“从 diff 到影响”的分析闭环。

**输入依赖**：
- Phase 1 已经稳定写入图谱
- `GraphStore` 已支持递归查询和符号反查

**核心范围**：
- `src/graph/ExecutionTracer.ts`
- `src/graph/ChangeDetector.ts`
- `src/mcp/tools/graphQuery.ts`
- `src/mcp/tools/graphDetectChanges.ts`
- 多语言 `SymbolExtractor` 扩展：Python、Go、Java、Rust、C++、C#

**实施步骤**：
1. `ExecutionTracer` 基于图遍历实现：
   - 入口符号查找
   - 路径评分
   - 去环与深度限制
2. `ChangeDetector` 实现：
   - 读取 git diff
   - diff hunk 映射到符号范围
   - 批量查询上下游影响
   - 输出风险摘要
3. 将多语言支持拆成独立 language specs：
   - 每种语言先做声明节点映射
   - 再补 `IMPORTS` / `EXTENDS` / `IMPLEMENTS` / 文件内 `CALLS`
4. 暂不追求跨语言统一语义完美一致，优先保证“能提取、能查询、能标置信心”。

**测试计划**：
- `tests/graph/ExecutionTracer.test.ts`
- `tests/graph/ChangeDetector.test.ts`
- `tests/graph/languageSpecs/*.test.ts`
- staged / unstaged / merge-base diff 场景测试

**验收标准**：
- [x] `graph_query("认证流程")` 返回从入口到出口的主要执行链
- [x] `detect_changes({ scope: "staged" })` 返回变更符号和上下游影响
- [ ] 6+ 语言具备基础符号提取能力
  - 当前状态：TS/JS、Python、Go、Java 已有 provider；原“6+ 语言”验收仍未完全关闭。
- [x] unresolved 关系不会阻塞主流程，且会在输出中显式标记

**交付物**：
- 执行流追踪工具
- 变更影响检测工具
- 多语言基础覆盖

### Phase 3: 检索增强与高级能力

**目标**：把图谱从“独立分析能力”推进到“检索质量增益”。

**输入依赖**：
- Phase 2 的图谱查询稳定
- 多语言数据质量可接受

**核心范围**：
- 改造 `src/search/GraphExpander.ts`
  为 E3 增加图查询路径
- `graph_rename`
  安全重命名分析
- 社区检测
  用于模块边界或功能簇识别

**实施步骤**：
1. 在 `GraphExpander.expandImports()` 外层加 capability check：
   图谱可用时优先走 symbol relation，失败时回退旧的 import-text 扩展。
2. 设计“symbol -> chunk”映射：
   - 需要在图谱中保留 `file_path + start_line/end_line`
   - 运行时把符号命中映射回 chunk 或 segment
3. 加入检索 AB 验证：
   - 命中率
   - 上下文噪音
   - token 占用
4. `graph_rename` 只先做分析模式，不直接改文件。
5. 社区检测作为可选离线分析，不进入主检索链路。

**测试计划**：
- 检索回归测试
- 图谱可用 / 不可用双路径测试
- symbol-to-chunk 映射测试

**验收标准**：
- [x] 图谱可用时，E3 扩展优先走图查询
- [x] 图谱不可用时，现有检索结果无回归
- [ ] 至少一组基准查询显示图扩展优于原启发式 import 扩展
- [ ] `graph_rename` 能输出安全改名候选和风险点

**交付物**：
- 图谱增强版检索
- 安全重命名分析工具
- 可选社区检测能力

### Phase 4: 扩展与产品化

**目标**：把代码图谱从仓库内能力扩展到跨仓库、契约和可视化层面。

**核心范围**：
- 多仓库联合图
- API 契约分析：`route_map`、`shape_check`
- Web 可视化或调试视图
- 可能的离线预计算与物化视图

**实施步骤**：
1. 定义 project-scoped graph identity，避免 symbol id 冲突。
2. 明确“跨仓库 relation”的可信来源，只接入可验证边。
3. 把 visualization 与核心 graph query 分层，避免 UI 侵入主数据模型。
4. 对大型项目补缓存、物化视图或增量反向索引。

**验收标准**：
- [ ] 多仓库检索或依赖分析可查询
- [x] API 契约与代码实现的偏差可被检测
  - 当前状态：已由 system-boundary 计划 P5 的 `contract_analysis`、route/tool map、impact 和 contract health 覆盖；不再要求按本文原 Phase 4 方案新增持久联合图。
- [ ] 可视化视图不影响 CLI / MCP 主路径性能

### Phase 顺序与里程碑

**推荐顺序**：
1. Phase 0 固定接缝
2. Phase 1 做 TS/JS 最小图谱
3. Phase 2 做执行流与 diff impact
4. Phase 3 做检索增强
5. Phase 4 只在前 3 个阶段稳定后再评估

**每个 Phase 的统一完成定义**：
- 代码实现完成
- 对应测试补齐并通过
- 文档同步更新
- 新能力具备回退路径
- 至少一条真实仓库样例验证通过

---

## 六、开发约束与注意事项

### 6.1 不引入新依赖

本方案不引入任何新的 runtime 依赖。核心依赖关系：

| 需要的能力 | 不引入 | 因为 |
|-----------|--------|------|
| 图存储 | LadybugDB / Neo4j | SQLite 递归 CTE 够用 |
| 符号提取 | 新解析器 | tree-sitter 已集成 |
| 图算法 | graphology | BFS/DFS 用 SQL 实现，社区检测延后 |
| 嵌入计算 | transformers.js | 已有嵌入网关 |

### 6.2 向后兼容

- `symbols` 和 `relations` 表为空时，系统行为与当前完全一致
- 新增 MCP 工具是增量的，不影响已有 31 个工具
- `GraphExpander` 的图查询路径为可选增强，不可用时回退到现有逻辑

### 6.3 性能约束

- 符号提取必须在 `processFiles()` 批次内完成（当前批大小 100 文件）
- 图谱写入使用 SQLite 批量 INSERT，避免逐条写入
- 递归 CTE 查询设置 `max_depth` 上限（默认 3，最大 10）
- 查询超时设置：单个图查询 < 100ms

### 6.4 数据一致性

- 同一文件的 symbols 和 relations 在一个事务内写入
- 增量更新先 DELETE 再 INSERT，避免孤立数据
- 未解析的关系（unresolved imports）单独标记，不阻塞主流程

---

## 七、风险与缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|------|:----:|:----:|---------|
| 跨语言关系解析不准确 | 中 | 中 | Phase 1 只做 TypeScript，逐步扩展；置信度字段区分确定/推断关系 |
| 递归 CTE 性能瓶颈 | 低 | 高 | 设置 depth 上限；大型项目可考虑物化视图 |
| AST 节点类型覆盖不全 | 中 | 低 | 每语言维护 `languageSpecs`，未知节点跳过而非报错 |
| 图谱与 chunks 数据不一致 | 低 | 中 | 同一文件在同一事务内更新两套数据 |
| 开发周期超预期 | 中 | 低 | Phase 1 限定为 TypeScript 单语言，验证架构后再扩展 |
