# ContextAtlas 代码知识图谱功能设计

> 版本: 0.1.0 | 状态: Draft | 日期: 2026-04-10

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

核心设计原则：**不增加额外的 tree-sitter 解析**。图谱提取在 `processFiles()` 阶段复用已有的 AST。

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
              → chunks (不变)            → symbols[], relations[]
                                                    │
                                                    └→ 写入 SQLite symbols + relations 表
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

**可选优化**：将 SymbolExtractor 的逻辑直接嵌入 `SemanticSplitter.visitNode()` 中，在一次遍历中同时产出 chunks 和 symbols。避免两次遍历 AST。但这会增加 SemanticSplitter 的复杂度，建议先作为独立模块实现，验证稳定后再考虑合并。

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

新增文件:foreground，go
  src/graph/*                    ← 全部新增
  src/mcp/tools/graph*.ts        ← 全部新增
  tests/graph/*                  ← 全部新增
```

---

## 五、分阶段开发计划

### Phase 1: 基础图谱 (最小可用)

**目标**：能提取符号和关系，支持爆破半径分析。

**范围**：
- `SymbolExtractor`: TypeScript/JavaScript 语言的符号+关系提取
- `GraphStore`: SQLite 表创建、CRUD、递归 CTE 查询
- `ImpactAnalyzer`: 爆破半径 BFS 查询
- MCP 工具: `graph_impact`, `graph_context`
- 嵌入 `processFiles()` 管线

**预估规模**: ~2500 行新代码 + ~1500 行测试

**验收标准**：
- [ ] `cw index` 后 SQLite 中有 symbols 和 relations 数据
- [ ] `graph_impact("SearchService", {direction: "downstream"})` 返回正确的调用链
- [ ] `graph_context("SearchService")` 返回 callers + callees
- [ ] 增量索引正确更新图谱（修改文件后重新查询结果一致）
- [ ] 索引时间增长 < 5%

### Phase 2: 执行流与变更检测

**目标**：支持执行流追踪和 git diff 影响 analysis。

**范围**：
- `ExecutionTracer`: 从入口点追踪执行流
- `ChangeDetector`: git diff → 解析变更行 → 匹配符号 → 图查询影响
- MCP 工具: `graph_query`, `detect_changes`
- 多语言支持扩展: Python, Go, Java, Rust, C++, C#

**预估规模**: ~2500 行新代码 + ~1500 行测试

**验收标准**：
- [ ] `graph_query("认证流程")` 返回入口到出口的完整执行流
- [ ] `detect_changes({scope: "staged"})` 返回变更符号的上下游影响
- [ ] 6+ 语言的符号提取覆盖

### Phase 3: 检索增强与高级功能

**目标**：图谱驱动的检索质量提升。

**范围**：
- 改造 `GraphExpander.E3`: 用图查询替代文本 import 解析
- 安全重命名 (`graph_rename`)
- 社区检测 (Leiden 算法或简化版，用于自动划分功能模块)

**预估规模**: ~2000 行新代码 + ~1000 行测试

### Phase 4+: 扩展 (按需)

- 多仓库联合图
- API 契约分析 (route_map, shape_check)
- Web 可视化 (可选)

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
