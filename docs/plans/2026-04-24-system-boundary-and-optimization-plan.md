# ContextAtlas 系统边界与后续优化计划

适用时间点：`2026-04-24`

本文档用于约束下一阶段优化范围：在不引入重型依赖的前提下，逐步补齐代码图谱、影响分析和长期记忆智能能力。

---

## 一、系统边界

### 1. ContextAtlas 是什么

ContextAtlas 的核心定位是 **面向 AI coding agent 的本地上下文基础设施**。

它负责：

- 代码检索：混合召回、rerank、上下文扩展和 token-aware packing。
- 代码结构理解：符号表、关系图、变更影响、执行流和模块摘要。
- 项目记忆：模块职责、架构决策、项目 profile、跨项目可复用知识。
- 长期记忆：用户偏好、协作规则、外部约束、失败经验、handoff 状态。
- 可观测性：索引健康、检索质量、记忆健康、反馈闭环和发布门禁。
- Agent 接入：CLI、MCP、skill/backend 集成和最小上下文装配。

### 2. ContextAtlas 不是什么

ContextAtlas 不应扩张为：

- 通用图数据库产品。
- 通用聊天记忆 SaaS。
- 工作流编排平台。
- 全功能 IDE / Web IDE。
- 自动编码执行器。
- 业务 API 网关或线上生产服务治理平台。

这些能力可以通过接口对接，但不应进入核心运行时路径。

### 3. 核心边界原则

- 代码事实优先：可从当前代码、索引、Git diff 推导的信息，不写入长期记忆作为真相源。
- 记忆只保存不可推导事实：用户偏好、外部约束、协作约定、失败经验、任务结论。
- 本地优先：默认能力应能在本地 CLI / MCP 中运行，不依赖常驻远端服务。
- 渐进启用：重计算能力默认关闭或按需触发，不进入每次检索的热路径。
- 单索引复用：尽量复用一次扫描、一次 AST、同一 SQLite/LanceDB 后端，避免重复索引。
- 可观测后扩展：新增智能能力必须同时提供 health、staleness、fallback 或验收信号。

---

## 二、依赖策略

### 1. 默认不引入重型依赖

下一阶段默认禁止把以下依赖纳入核心包：

- 专用图数据库：Neo4j、Kuzu、LadybugDB 等。
- Python NLP 运行时：spaCy、大型 NER pipeline、独立 Python 服务。
- 常驻服务框架：需要额外 daemon 才能完成核心检索的服务端框架。
- 默认 Web UI 栈：React/Vite/Next 等不进入核心 CLI/MCP 包。
- 大型本地模型运行时：LLM、embedding、rerank 模型运行不内置到核心包。

### 2. 优先复用现有依赖

下一阶段优先使用当前已有基础：

- Tree-sitter parser：扩展多语言符号和关系提取。
- SQLite + FTS5：存储符号、关系、调用点、记忆、契约和健康状态。
- LanceDB：继续作为代码块和记忆向量索引。
- OpenAI-compatible API：继续承接 embedding、rerank、可选 LLM 记忆抽取。
- MCP SDK：继续作为 agent 接入层。
- 现有 CLI / monitoring / health 结构：承接新增能力的运维入口。

### 3. 新依赖准入条件

只有同时满足以下条件，才允许引入新依赖：

- 已有实现无法在合理复杂度内满足验收目标。
- 有可复现 benchmark 证明当前方案成为瓶颈。
- 依赖能按 feature flag 或 optional path 隔离，不污染默认路径。
- 依赖许可证、安装体积、构建平台、离线可用性已经评估。
- 有回退方案，依赖不可用时核心检索仍可工作。

---

## 三、能力分层

### L0 默认能力

默认安装、默认启用，必须保持轻量。

- 混合代码检索。
- SQLite FTS 降级检索。
- 轻量图谱摘要。
- 手动/结构化项目记忆。
- 长期记忆的 FTS 检索和治理状态。
- 索引健康和基础运维命令。

### L1 按需能力

安装后可用，但只在显式命令、配置或索引阶段启用。

- 深度代码图谱索引。
- 跨文件调用解析。
- 变更影响分析。
- 执行流追踪。
- API / tool 契约分析。
- LLM 辅助记忆抽取。

### L2 可选扩展

不进入核心包，后续可以独立插件化。

- Web graph explorer。
- 大型语言模型本地运行。
- 企业级多租户权限。
- 外部服务 contract registry。
- 高级 NER / NLP pipeline。

---

## 四、后续优化计划

### P0：基线与验收框架

目标：先能衡量，不先堆功能。

- 首批落地（2026-04-24）：
  - [x] 新增内置系统边界 golden fixture，覆盖 `GitNexus parity`、`mem0 parity`、`ContextAtlas native advantage` 三条 track。
  - [x] 新增 `parity:benchmark` CLI，默认不依赖发布包外文件，可用 `--fixture` 覆盖外部 fixture。
  - [x] 将 `parity:benchmark` 纳入 release smoke。

- 第二批落地（2026-04-24）：
  - [x] 建立 `GitNexus parity`、`mem0 parity`、`ContextAtlas native advantage` 三列表。
  - [x] 准备 6 个轻量评测仓库元数据，覆盖 TS/JS、Python、Go、Java、Rust。
  - [x] 为 benchmark case 增加失败分类：功能缺失、解析错误、召回排序差、输出格式不稳定。

- 第三批落地（2026-04-24）：
  - [x] 固定 golden cases：符号查找、调用链、影响分析、diff 命中、记忆召回、冷启动降级。
  - [x] 为每个 case 记录 expected output 结构，包括 shape version、字段路径、类型和必填性。

- [x] 把 benchmark 接入现有 release/smoke 或独立 `ops` 命令。

验收标准：

- [x] 每轮图谱或记忆改动都能跑同一组 benchmark。
  - 关闭依据：`parity:benchmark` 默认使用内置 fixture，release smoke 已覆盖该命令；也支持 `--fixture` 跑同一组外部 golden case。
- [x] 能明确区分“功能缺失”“解析错误”“召回排序差”“输出格式不稳定”。
  - 关闭依据：benchmark summary 输出 `byFailureCategory`、`failureCategoryCoverage` 和 `benchmarkPassed`；文本报告显示四类 failure category 覆盖情况，JSON 报告提供稳定字段。

### P1：轻量图谱内核稳定化

目标：不换数据库，先把现有 SQLite 图谱做扎实。

- 首批落地（2026-04-24）：
  - [x] 新增只读 `health:graph` CLI，不修改 schema，不创建缺失 index DB。
  - [x] 输出 graph tables、symbol totals、relation totals、unresolved ratio、invocation resolved ratio、average relation confidence。
  - [x] 输出 language coverage 与 relation-level resolved/unresolved/confidence。
  - [x] 将 `health:graph` 纳入 release smoke。

- 第二批落地（2026-04-24）：
  - [x] 为 `symbols`、`relations`、`invocations` 增加只读 schema health 输出。
  - [x] 检查关键表、列、索引、FTS 虚表和已知 schema migrations。
  - [x] 缺失列时降级为 degraded 报告，不执行自动迁移或 schema 修改。

- 第三批落地（2026-04-24）：
  - [x] 把 `SymbolExtractor` 改为 provider 架构，保留现有 facade API。
  - [x] 将 TS/JS 解析逻辑机械迁移到 `TsJsSymbolProvider`，不改变解析行为。
  - [x] 为 unsupported language fallback 和重复 provider language 注册增加测试。

- 第四批落地（2026-04-24）：
  - [x] 固定 symbol identity 规则：语言、文件、owner、名称、参数数量、起止行。
  - [x] 为 TS/JS class field 和 interface property 生成 `Variable` 符号与 `HAS_PROPERTY` 关系。
  - [x] 为 `this.x` 读写生成轻量 `ACCESSES` 关系，使用 `reason=read:x` / `reason=write:x` 区分访问模式。
  - [x] 补齐 default import、namespace import 和 named import alias 的本地绑定提取。

验收标准：

- [x] 当前 TS/JS 项目的 `graph_context` 和 `graph_impact` 结果稳定。
- [x] 图谱健康能显示哪些语言、文件或关系没有覆盖。

### P2：多语言覆盖扩展

目标：优先覆盖最常见 coding-agent 场景，不追求一次性全语言完整。

- 第一批落地（2026-04-24）：
  - [x] 支持 Python provider。
  - [x] 支持 Python class/function/method/property/import/call/self access 的最小图谱提取。

- 第二批落地（2026-04-24）：
  - [x] 支持 Go provider。
  - [x] 支持 Go struct/function/method/field/import/call/receiver access 的最小图谱提取。

- 第三批落地（2026-04-24）：
  - [x] 支持 Java provider。
  - [x] 支持 Java class/interface/method/field/import/extends/implements/call/this access 的最小图谱提取。

- [x] 每种语言都必须有符号提取、import 提取、基础 call 提取和最小测试仓库。
- [x] 对不支持语言明确降级为 chunks + FTS + import-level context，不假装有深图谱。

验收标准：

- [x] 每新增一种语言，都有独立 fixture、图谱统计和失败样例。
- [x] 多语言索引失败不影响其他语言和基础检索。

### P3：跨文件解析与影响分析

目标：把“相关代码”升级为“谁依赖谁、改动影响谁”。

- 第一批落地（2026-04-24）：
  - [x] 升级 `detect_changes`：diff 行号 -> 符号 -> 上下游关系 -> 风险等级。
  - [x] 输出按深度分组：direct break、likely affected、needs testing。
  - [x] 在 direct relation 输出中外显 confidence 和 reason，便于区分 resolved/unresolved 与低置信度关系。

- [x] 实现三层解析：same-file、import-scoped、global fallback。
- [x] 增加 receiver/type inference 的最小实现：构造函数、类字段、显式类型、返回类型。
- [x] 增加 method override / implements 关系的最小实现。

验收标准：

- [x] 对核心 fixture 能回答“谁调用了它”“它调用了谁”“本次 diff 影响谁”。
- [x] 影响分析结果带置信度和 unresolved 说明。

### P4：执行流与检索融合

目标：让检索结果从 chunk 列表升级为流程级上下文。

- [x] 定义 entry point 规则：API route、CLI command、MCP tool、test、main/bootstrap。
- [x] 建立 execution trace 派生视图，不新增持久表。
- [x] 在 `codebase-retrieval` 中按需附带 process-level summary。
- [x] 增加模块/社区近似聚类，先使用目录、调用密度和 shared dependencies，不引入重型聚类依赖。
- [x] 增加流程级排序：query match、入口相关性、调用深度、风险权重。

验收状态：

- [x] 常见查询能返回“相关流程 + 关键符号 + 关键文件”，而不是只有相似片段。
- [x] 关闭深图谱时仍能回退到现有混合检索。

### P5：API / Tool 契约分析

目标：优先服务真实工程改动风险，而不是做泛化静态分析平台。

- [x] 增加 route extraction 的最小支持，覆盖 Next App Router、pages API 和 Express-like route。
- [x] 增加 route -> handler -> consumer 的轻量派生映射；暂不新增持久关系表。
- [x] 增加 response shape keys 与 consumer property access 的轻量对比。
- [x] 增加 MCP/RPC tool definition -> handler 的映射。
- [x] 增加 `contract_analysis` MCP tool，支持 `route_map`、`api_impact`、`tool_map`、`tool_impact`、`contract_health`。

验收状态：

- [x] 能在改 API handler 前列出消费者、访问字段和潜在 mismatch。
- [x] 契约分析不可用时，不影响基础图谱和检索。

### P6：长期记忆智能化

目标：补 mem0 式记忆质量，但不把 ContextAtlas 变成通用聊天记忆平台。

- [ ] 增加可选 LLM additive extraction：从对话、反馈、handoff 中抽取不可推导事实。
- [x] 增加规则型 `suggest`：从对话、反馈、handoff 文本中抽取候选不可推导事实。
- [x] 把抽取结果写入现有长期记忆 schema，而不是另起一套记忆库；默认只建议，`apply=true` 才写入。
- [x] 增加 factKey 候选去重、source/confidence/provenance 约束。
- [ ] 增加 hash 去重和更完整的 factKey 合并策略。
- [ ] 增加 memory history：created、merged、invalidated、verified。
- [ ] 增加实体候选提取的轻量实现，优先使用规则和 LLM 输出，不引入重型 NER。

验收标准：

- [x] 自动抽取默认只生成建议，不默认污染长期记忆。
- [x] 长期记忆仍严格遵守“只保存不可推导信息”。

### P7：多信号记忆检索

目标：提升记忆找回率，同时保持可解释。

- [x] 在长期记忆检索中融合 FTS、entity boost、recency、confidence；embedding 当前显式标记为 disabled。
- [x] 为每条记忆结果显示 matchFields 和分数来源。
- [x] 支持按 scope、type 和 stale/expired 可见性过滤；status/source 过滤保留为后续项。
- [x] 对 stale / expired / superseded 记忆降低权重或默认隐藏。
- [x] 增加 memory retrieval benchmark。

验收状态：

- [x] 记忆召回能解释“为什么命中”。
- [x] 过期或冲突记忆不会静默压过当前代码事实。

### P8：产品化收口

目标：把新增能力收进现有主路径，而不是新增一堆孤立工具。

- [x] 按 `full`、`retrieval-only` 梳理 MCP toolset；`graph-aware`、`memory-aware` 保留为后续项。
- [x] 更新 `setup:local` 输出，使图谱、契约和长期记忆建议都是显式后续操作。
- [x] 增加 graph health 和 contract health；memory extraction health 保留为后续项。
- [x] 更新 README、CLI reference、MCP reference 和首次使用文档。
- [x] 补迁移说明，保证旧 memory hub 和旧 graph schema 可平滑升级。

验收状态：

- [x] 默认用户仍能轻量使用 ContextAtlas。
- [x] 高阶用户能按需打开图谱、契约和长期记忆建议能力。
- [x] 工具数量增长不会显著增加 agent 选择负担。

---

## 五、推荐执行顺序

1. 先做 P0，建立 benchmark 和验收门禁。
2. 再做 P1 和 P2，把现有图谱基础扩成稳定轻量内核。
3. 然后做 P3 和 P4，让图谱能力进入真实检索与改动影响分析。
4. 接着做 P5，补工程改动中最有价值的 API / tool 契约风险。
5. 最后做 P6 和 P7，把长期记忆从手工结构化输入升级为可解释智能召回。
6. P8 贯穿各阶段，但只在每批能力验收后收口文档、toolset 和 setup。

最小可交付切片：

- P0 benchmark。
- P1 TS/JS 图谱稳定化。
- P2 Python 最小图谱支持。
- P3 diff -> symbol -> impact 的闭环。
- P6 手动触发的长期记忆抽取建议；当前为规则型建议，LLM 抽取保留为可选后续项。

---

## 六、风险与降级

### 1. 性能风险

风险：深图谱索引显著拖慢默认索引。

降级策略：

- 默认保持轻量图谱。
- 深图谱按 flag 启用。
- 图谱失败不阻塞 chunks、FTS、vector 索引。

### 2. 准确性风险

风险：跨文件调用解析误连，导致错误影响分析。

降级策略：

- 所有关系带 confidence。
- unresolved 和 fuzzy match 必须外显。
- 影响分析按置信度分层展示。

### 3. 记忆污染风险

风险：LLM 自动抽取把可推导代码事实或错误结论写成长期记忆。

降级策略：

- 默认只建议，不自动确认。
- 写入前检查是否可从代码或图谱推导。
- stale、conflict、source、confidence 必须进入结果展示。

### 4. 工具体积风险

风险：能力增加导致 MCP 工具过多，agent 选择困难。

降级策略：

- 维护 toolset 分层。
- 高频主路径保持少量入口。
- 专项能力通过二级 action 或 profile 暴露。
