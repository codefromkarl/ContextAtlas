# Iteration 1 模块收口评估（2026-04-08）

本文档用于完成 `Iteration 1` 中的“大模块收口评估”任务，评估对象为：

- `src/search/SearchService.ts`
- `src/mcp/tools/codebaseRetrieval.ts`

评估目标不是机械地按文件行数拆分，而是判断当前模块是否仍符合职责边界、是否影响本轮验收闭环，以及是否需要在当前迭代立即拆分。

---

## 一、评估结论

结论如下：

1. `SearchService.ts` 当前不建议继续拆分。
2. `codebaseRetrieval.ts` 仍然偏大，但本轮建议先不继续重构。
3. `Iteration 1` 应优先完成验收收口，而不是在主路径上再做高风险结构调整。

---

## 二、SearchService 评估

文件：`src/search/SearchService.ts`

### 当前判断

`SearchService` 已经基本符合“检索编排 facade”的定位，没有明显继续拆分的迫切性。

### 依据

- 文件规模约 `381` 行，仍处于可读、可维护范围内。
- 主要职责集中在：
  - 检索依赖初始化
  - query intent 判断
  - query-aware config 派生
  - recall / rerank / expand / pack 主流程编排
- 混合召回、rerank 策略、snippet 构造、图扩展、context packing 已下沉到独立模块：
  - `HybridRecallEngine`
  - `RerankPolicy`
  - `SnippetExtractor`
  - `GraphExpander`
  - `ContextPacker`
- 对外核心公开接口仍然集中在 `buildContextPack()`。

### 风险判断

- 如果继续拆分，收益有限。
- 继续拆分更容易把“主流程可读性”拆散到多个文件，增加跨文件跳转成本。
- 当前它更像“编排层”，不是“所有实现细节堆在同一处”的 God file。

### 结论

- `SearchService.ts`：本轮不继续拆分。

---

## 三、codebaseRetrieval 评估

文件：`src/mcp/tools/codebaseRetrieval.ts`

### 当前判断

`codebaseRetrieval.ts` 仍然偏大，存在后续继续拆分的空间，但不建议在 `Iteration 1` 中立即实施重构。

### 依据

- 文件规模约 `2185` 行，明显大于常规工具模块。
- 当前单文件承担了多类职责：
  - MCP 输入 schema 与查询参数归一化
  - 自动索引 / 冷启动策略
  - 主检索流程调度
  - text/json 两类响应组装
  - 结果卡片构建
  - feature / decision / long-term / feedback 排序与格式化
  - block-first payload 组装
  - lexical fallback 构建
- 从结构上看，它更像多个子能力被保存在同一文件中，而不是严格单一职责。

### 但为什么本轮不拆

- 当前主路径行为已经有较完整测试覆盖：
  - 默认结果卡片
  - `response_format=json`
  - `response_mode=overview`
  - stale/conflict 外显
  - 冷启动 lexical fallback
  - 入队后继续返回 fallback
- `Iteration 1` 的目标是验收闭环，不是高风险重构。
- 在刚完成结果卡片、block-first、context lifecycle 等能力收口后立刻再次拆分，容易引入回归。

### 建议拆分边界

如果后续安排专门重构迭代，建议优先按下面边界拆：

1. `retrievalResultCard.ts`
2. `retrievalResultCardRanking.ts`
3. `retrievalBlockPayload.ts`
4. `retrievalColdStartFallback.ts`
5. `retrievalFormatting.ts`

### 结论

- `codebaseRetrieval.ts`：确认“有继续拆分空间”。
- 但本轮结论是“评估完成，暂不执行拆分”。

---

## 四、最终建议

对当前路线图中的“评估是否继续收大模块”这一项，建议按下面方式关闭：

- `SearchService.ts`：结论为“不继续拆分”
- `codebaseRetrieval.ts`：结论为“暂不在 Iteration 1 拆分，后续进入专门重构迭代处理”

这意味着该项已经完成“评估”，不应继续保留为未完成状态。
