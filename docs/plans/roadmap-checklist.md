# ContextAtlas 路线图执行清单

基于 [产品路线图](../product/roadmap.md) 整理。

目标不是继续横向堆功能，而是按版本节奏把现有能力压缩成：

- 一条主路径
- 一套可信机制
- 一组可运维闭环

---

## 当前进展

### 已完成的基础工程收口

- [x] CLI 主注册层收口为纯组合层
- [x] `ops` 命令按职责拆分为 usage / health / alert / workbench
- [x] `hub` 命令按职责拆分为 projects / shared / explore
- [x] `memory` 命令按职责拆分为 features / catalog / knowledge
- [x] MCP `server.ts` 收口为启动壳层，`TOOLS` 与 `call_tool` runtime orchestration 已拆出
- [x] CLI 通用 helper 初步落地：逗号分隔解析、JSON/text 输出、MCP text content 拼接

### 仍待继续的基础工程项

- [x] 抽统一 CLI 错误退出 helper，收口 `logger.error(...); process.exit(1)`
- [x] 抽统一 CLI JSON/text 响应 helper 到更多命令模块
- [x] 评估是否继续收大模块：`src/mcp/tools/codebaseRetrieval.ts`、`src/search/SearchService.ts`

验收记录：

- [模块收口评估（2026-04-08）](../archive/iterations/2026-04-08/iteration-1-module-closure-evaluation.md)

---

## Phase A

## v0.8 / v0.9

目标：把主路径做通，形成可用预发布产品。

### P0 主路径产品化

- [x] 把 `contextatlas start [path]` 做成真正的默认入口，而不只是说明文本
- [x] 明确输出 `Connect Repo -> Check Index Status -> Ask -> Review Result -> Give Feedback / Save Memory`
- [x] 把首次接入路径压缩到 10 分钟内可跑通
- [x] 补一份面向新用户的“首次使用”文档，避免 README 继续偏 infra 能力总览

### P0 结果卡片统一

- [x] 固定结果结构：代码命中
- [x] 固定结果结构：相关模块记忆
- [x] 固定结果结构：相关决策记录
- [x] 固定结果结构：为什么命中这些结果
- [x] 统一 CLI 与 MCP 主路径输出格式，减少同能力多种展现

### P0 冷启动体验

- [x] 索引未完成时优先 lexical / FTS 降级查询
- [x] 明确显示“索引中 / 可部分回答 / 完整模式未就绪”
- [x] 索引完成后自动切换到完整混合检索
- [x] 补冷启动 smoke / 集成验证，确保降级路径长期可用

### P0 产品身份统一

- [x] 统一 README、包名、仓库名、CLI 名的产品身份表述
- [x] 检查发布页、安装说明、示例命令是否全部使用 `contextatlas`
- [x] 清理旧品牌或旧命名残留

### P0 验收标准

- [x] 新用户 10 分钟内完成首次接入与问答
- [x] 首次结果结构固定，不再只是长文本堆叠
- [x] 索引未完成时可返回有限结果，不会直接卡死
- [x] 仓库名、CLI 名、README、包名、发布信息统一

验收记录：

- [Iteration 1 验收报告（2026-04-08）](../archive/iterations/2026-04-08/iteration-1-acceptance-report.md)

---

## Phase B

## v1.0

目标：把可信度、解释性和记忆治理补齐，形成可持续使用的正式版本。

注：以下勾选以当前 CLI / MCP 主路径结果卡片与默认写入流程为准。

### P1 来源解释

- [x] 每条回答显式标注来源层级：Code / Feature Memory / Decision Record / Long-term Memory / Cross-project Hub
- [x] 统一展示来源层级优先规则
- [x] 明确说明“为什么这条结果可信”

### P1 freshness / confidence / conflict

- [x] 外显最后核验时间
- [x] 外显 stale 状态
- [x] 外显 conflict 状态
- [x] 外显人工确认状态 / confidence

### P1 冲突规则产品化

- [x] 代码优先于旧 memory
- [x] 新 decision record 优先于旧 profile
- [x] 长期记忆只补充代码推不出来的事实
- [x] 冲突发生时直接展示，不做静默覆盖

### P1 记忆写入治理

- [x] 默认走建议写入，而不是盲目自动落库
- [x] feature memory 相似项去重或合并提示
- [x] 源码或路径大变动时自动标记“待复核”
- [x] 人工确认状态成为高质量记忆的显式门槛

### P1 反馈闭环

- [x] 提供极简反馈动作：helpful / not-helpful / memory-stale / wrong-module
- [x] 把反馈真正接入主路径，而不只是保留命令入口
- [x] 让反馈反哺检索和记忆治理

### P1 验收标准

- [x] 每条回答都能解释来源层级
- [x] memory 具备 freshness / stale / conflict 状态
- [x] 用户能标记错误记忆为过期或冲突
- [x] 新增记忆存在去重与人工确认机制

---

## Phase C

## v2.0

目标：把运维、发布门禁和团队能力做完整，形成团队试点版本。

### P2 索引健康与可运维性

- [x] 索引健康面板：当前状态、上次成功时间、队列长度、最近失败任务
- [x] 快照版本可见
- [x] 全量 / 增量模式可见
- [x] 故障恢复路径明确

### P2 增量更新策略

- [x] repo 变化后的增量索引触发机制
- [x] AST / embedding schema 变化时提示全量重建
- [x] 记忆受影响范围提示
- [x] 增量更新策略进入日常可依赖状态

### P2 发布门禁

- [x] build / test / smoke gate 全量纳入发布路径
- [x] 发布前 smoke 检查透明化
- [x] CLI / MCP / monitoring / queue / daemon 回归验证纳入门禁
- [x] 发布失败可快速定位是构建、测试还是 smoke 阶段

### P2 团队级指标

- [x] 查询成功率
- [x] 空结果率
- [x] 用户纠错率
- [x] memory stale 比例
- [x] 查询延迟
- [x] 索引失败率
- [x] 每仓库 / 每模块质量分布

### P2 shared / personal memory 分层

- [x] shared memory 与 personal memory 分层
- [x] 组织级只读 project profile
- [x] 决策记录 reviewer / owner 约束
- [x] 跨项目 Hub 的权限边界与来源边界

验收记录：

- [Iteration 2 记忆治理边界设计（2026-04-08）](../archive/iterations/2026-04-08/iteration-2-memory-governance-design.md)
- [Iteration 3 治理能力实现记录（2026-04-08）](../archive/iterations/2026-04-08/iteration-3-governance-implementation.md)

### P2 验收标准

- [x] 产品能稳定处理 repo 日常变化，不需要频繁人工全量重建
- [x] 发版前存在明确测试与 smoke gate
- [x] 管理者能看到“是否在用、哪里不准、哪里在坏”
- [x] 团队能共享高价值 memory，但不会互相污染

验收记录：

- [Iteration 4 团队级验收报告（2026-04-08）](../archive/iterations/2026-04-08/iteration-4-team-acceptance-report.md)

---

## 推荐执行顺序

### 下一批迭代

1. [x] 抽统一 CLI 错误退出 helper
2. [x] 强化 `start` 主路径入口
3. [x] 统一结果卡片结构
4. [x] 冷启动降级体验外显
5. [x] 产品身份与文档统一收尾

### 再下一批迭代

1. [x] freshness / stale / conflict / confidence 全部外显
2. [x] 来源层级说明稳定化
3. [x] 反馈闭环接入主路径
4. [x] 记忆写入治理与人工确认门槛

### 第三批迭代

1. [x] 索引健康面板
2. [x] 增量更新策略
3. [x] 发布门禁与 smoke gate
4. [x] 团队级指标
5. [x] shared / personal memory 分层

---

## Phase D

## vNext / Context Lifecycle

目标：把 ContextAtlas 从“检索 + 记忆 + 打包”推进为“上下文生命周期系统”。

设计基线见：[ContextAtlas 工程定位 / 下一版上下文 / 记忆架构草图](../architecture/harness-engineering.md#下一版上下文--记忆架构草图)

### P3 对象模型

- [x] 定义 `ContextBlock` 类型与 block 分类
- [x] 定义 `TaskCheckpoint` 类型
- [x] 定义 `MemoryKind`：procedural / semantic / episodic / task-state
- [x] 统一 retrieval / memory / feedback 输出到 block-first 结构

### P3 checkpoint / handoff / resume

- [x] 增加 checkpoint 存储模型与 CLI / MCP 入口
- [x] 新增 `create_checkpoint` / `load_checkpoint` / `list_checkpoints`
- [x] 让 `autoRecord` 支持生成正式 checkpoint，而不只是建议写入
- [x] 支持 handoff bundle 与 resume bundle

### P3 progressive retrieval

- [x] `SearchService` 支持 `overview` / `expanded` 两种结果模式
- [x] `GraphExpander` 输出 exploration candidates 与 next-inspection suggestions
- [x] retrieval 结果优先返回引用与结构，再按需展开正文

### P3 phase-aware context assembly

- [x] `MemoryRouter` 支持按 phase/profile 装配上下文
- [x] `loadModuleMemory` 支持 debug / implementation / handoff 等用途参数
- [x] `ContextPacker` 增加 block 级预算，而不只是 span / chars 预算

### P3 记忆治理

- [x] `MemoryAutoRecorder` 增加 dedupe / merge / generalize / supersede
- [x] 自动写入附带 provenance / confidence
- [x] 区分稳定记忆与任务态临时记忆
- [x] stale / expired / superseded 生命周期与 UI/MCP 输出对齐

### P3 验收标准

- [x] retrieval 结果可输出 block-first 结构
- [x] 长周期任务可通过 checkpoint 恢复，而不依赖自由文本总结
- [x] memory 可以明确区分 procedural / semantic / episodic / task-state
- [x] agent 可以先拿 overview，再按需展开代码正文
- [x] 记忆不会因自动写入而快速碎片化或污染
