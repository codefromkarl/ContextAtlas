# ContextAtlas 后续任务执行清单

本文档用于把当前仓库中已经明确但尚未完全关闭的后续任务，整理成一份可执行、可跟踪、可验收的任务板。

适用时间点：`2026-04-08`

主要依据：

- `docs/plans/roadmap-checklist.md`
- `docs/product/roadmap.md`
- `docs/plans/mempalace-absorption-execution-plan.md`
- `docs/changelog/2026-04-08.md`

---

## 一、执行原则

- 优先补验收和治理闭环，不优先继续横向加功能。
- 对已经“功能基本存在但验收未关闭”的事项，统一按“待验收”处理。
- 每一批任务尽量做到可独立提交、可独立验证、可独立回滚。
- 涉及主路径、记忆治理、handoff 的任务，必须同时补测试和文档。

---

## 二、P0：先收口现有能力

目标：先把“已经基本做出来”的能力正式验收并收尾，避免路线图长期处于半完成状态。

### 1. 大模块收口评估

- [x] 评估是否继续拆分或收口 `src/mcp/tools/codebaseRetrieval.ts`
- [x] 评估是否继续拆分或收口 `src/search/SearchService.ts`
- [x] 如果决定继续拆分：给出边界、迁移顺序、测试补位方案
- [x] 如果决定暂不拆分：记录理由并关闭该待办

当前结论：**两者都暂不继续拆分，先收口 P0 验收项。**

理由如下：

- `src/search/SearchService.ts` 当前约 381 行，已经是检索编排 facade；混合召回、rerank 策略、snippet 构造、扩展和打包均已下沉到 `HybridRecallEngine`、`RerankPolicy`、`SnippetExtractor`、`GraphExpander`、`ContextPacker`，继续拆分的收益已经明显下降。
- `src/search/SearchService.ts` 还承担一部分查询意图判定和 query-aware config，这部分与 facade 角色强耦合，强拆只会增加跨文件跳转成本。
- `src/mcp/tools/codebaseRetrieval.ts` 当前约 2185 行，确实偏大，但它在最近几轮迭代里刚收口了 `evidence`、`temporal-fact`、feedback、cold-start fallback、block-first payload、checkpoint candidate 等主路径逻辑；此时继续拆分会与 P0 验收同时进行，回归风险高于收益。
- `codebaseRetrieval` 目前虽然文件大，但职责边界已经能识别：检索准备/telemetry、result card ranking、context block 组装、cold-start fallback、格式化输出。更合理的做法是先完成首次接入、结果卡片、冷启动降级的正式验收，再基于热点和回归压力决定是否二次拆分。

后续触发条件：

- 如果 `codebaseRetrieval` 再继续增长，或结果卡片/冷启动/反馈治理出现高频冲突，再单独开“模块化二次拆分”任务。
- 如果 `SearchService` 再重新吸收 recall/rerank/packing 细节，再重新评估 facade 边界。

详细记录：见 [Iteration 1 模块收口评估（2026-04-08）](../archive/iterations/2026-04-08/iteration-1-module-closure-evaluation.md)

### 2. 首次接入闭环验收

- [x] 按 `docs/guides/first-use.md` 实走一次默认闭环
- [x] 验证新用户可在 10 分钟内完成首次接入与问答
- [x] 补充验收记录或 smoke 证据

验收记录：

- 样本仓库：`/home/yuanzhi/Develop/tools/ContextAtlas`
- 执行命令：`contextatlas start`、`contextatlas health:check`、`contextatlas index:plan --json`、`contextatlas search`、`contextatlas feedback:record`
- `start` 已正确输出 repo、projectId、索引状态、默认流程和下一步动作
- `index:plan --json` 已正确给出模式、变更摘要、受影响记忆和建议命令
- `search` 在完整索引可用时能直接返回结果卡片，不需要先学习额外命令集
- `feedback:record` 可直接形成最小反馈闭环
- 从执行链路和人工操作量看，本地首次接入与问答可在 10 分钟内完成

观察项：

- `health:check` 当前会显示其他历史任务残留导致的全局 queue/failed 状态，这不阻塞当前仓库首次问答，但会影响“第一次看到的健康面板是否足够干净”，后续可作为运维噪音单独治理。

### 3. 结果卡片结构验收

- [x] 验证 CLI 输出稳定包含：代码命中
- [x] 验证 CLI 输出稳定包含：相关模块记忆
- [x] 验证 CLI 输出稳定包含：相关决策记录
- [x] 验证 CLI 输出稳定包含：为什么命中这些结果
- [x] 验证 MCP 主路径输出与 CLI 主路径结构一致

验收记录：

- 使用查询 `SearchService 的检索编排逻辑是什么？` + technical terms `SearchService,buildContextPack`
- CLI 主路径已稳定展示：`代码命中`、`相关模块记忆`、`相关决策记录`、`为什么命中这些结果`
- CLI 主路径同时展示：`索引状态`、`来源层级与可信规则`、`下一步动作`
- MCP 主路径一致性由现有回归测试覆盖：`tests/codebase-retrieval.test.ts`、`tests/assemble-context.test.ts`、`tests/mcp-stdio.test.ts`

### 4. 冷启动降级验收

- [x] 验证索引未完成时会走 lexical / FTS 降级查询
- [x] 验证输出明确展示“索引中 / 可部分回答 / 完整模式未就绪”
- [x] 验证系统不会因冷启动直接卡死
- [x] 补一条长期可回归的 cold-start smoke 用例

验收记录：

- 主路径实现证据：
  - `src/mcp/tools/codebaseRetrieval.ts` 已显式输出 `索引缺失，当前返回词法降级结果`
  - `src/mcp/tools/codebaseRetrieval.ts` 已显式输出 `完整模式未就绪`
  - `src/workflow/start.ts` 已显式区分 full hybrid / partial lexical / first indexing 三种模式
- 测试证据：
  - `tests/codebase-retrieval.test.ts`
    - `handleCodebaseRetrieval returns lexical fallback when project is not indexed`
    - `handleCodebaseRetrieval enqueues indexing and still returns lexical fallback`
  - `tests/release-smoke.test.ts`
    - `cold-start-search`
- 路线图状态证据：
  - `docs/plans/roadmap-checklist.md` 中 `P0 冷启动体验` 相关条目已完成

### 5. 产品身份统一验收

- [x] 检查 `README.md`、`README.EN.md`、包名、CLI 名、发布信息是否完全统一
- [x] 清理可能残留的旧命名或旧品牌文案
- [x] 补验收记录并关闭对应路线图勾选项

验收记录：

- `package.json` 已统一为：
  - 包名 `@codefromkarl/context-atlas`
  - CLI 主命令 `contextatlas`
  - 兼容短别名 `cw`
- `README.md`、`README.EN.md`、`docs/guides/first-use.md`、`docs/reference/cli.md`、`docs/guides/deployment.md` 均以 `contextatlas` 作为默认命令名。
- `.github/workflows/release.yml` 的发布说明已统一使用：
  - npm 包名 `@codefromkarl/context-atlas`
  - 默认 CLI 命令 `contextatlas`
- 仓库检索未发现 `CodeWeaver`、`ContextWeaver` 等旧品牌残留。
- `cw` 仍被保留，但仅作为兼容短别名，不影响产品身份统一。

详细记录：见 [Iteration 1 验收报告（2026-04-08）](../archive/iterations/2026-04-08/iteration-1-acceptance-report.md)

### 5.1 发布门禁回归修复（2026-04-09）

- [x] 把 `src/scanner/index.ts` 重新纳入 `build` / `build:release` / `dev` 的 tsup 入口
- [x] 为打包脚本补回归测试，避免再次漏掉 `scanner` 独立产物
- [x] 让 `crawler` 的 dist 测试同时兼容 `dist/scanner/index.js` 与旧 `dist/scanner-*.js` 命名
- [x] 重新验证 `pnpm test` 与 `pnpm release:gate`

验收记录：

- 根因：`tests/crawler.test.mjs` 依赖 dist 中可直接 import 的 scanner 入口，而 `package.json` 的 tsup 入口曾遗漏 `src/scanner/index.ts`
- 修复：
  - `package.json` 中 `build` / `build:release` / `dev` 已纳入 `src/scanner/index.ts`
  - `tests/package-scripts.test.ts` 新增对 scanner 构建入口的回归保护
  - `tests/crawler.test.mjs` 现在优先加载 `dist/scanner/index.js`，并兼容旧的平铺命名
- 验证：
  - `pnpm build`
  - `pnpm test`
  - `pnpm release:gate`

---

## 三、P1：补团队治理与产品边界

目标：把当前系统从“单机可用”推进到“团队可控、可共享、可治理”。

设计基线：

- [Iteration 2 记忆治理边界设计（2026-04-08）](../archive/iterations/2026-04-08/iteration-2-memory-governance-design.md)
- [Iteration 3 治理能力实现记录（2026-04-08）](../archive/iterations/2026-04-08/iteration-3-governance-implementation.md)
- [Iteration 4 团队级验收报告（2026-04-08）](../archive/iterations/2026-04-08/iteration-4-team-acceptance-report.md)

### 6. 共享与个人记忆分层

- [x] 设计 `shared memory` 与 `personal memory` 的边界
- [x] 明确读取优先级、写入权限和冲突处理规则
- [x] 为 CLI / MCP 输出补来源标识
- [x] 补权限与污染防护测试

### 7. 组织级只读档案

- [x] 为 `project profile` 增加组织级只读模式
- [x] 明确哪些字段允许本地覆盖，哪些字段不可覆盖
- [x] 让结果中可见 profile 来源与可写状态

### 8. 决策记录治理

- [x] 为 `decision record` 增加 `reviewer` / `owner` 约束
- [x] 明确未审核决策与已审核决策的可信差异
- [x] 将这些状态接入 CLI / MCP 主路径输出

### 9. Cross-project Hub 边界

- [x] 明确跨项目 Hub 的权限边界
- [x] 明确跨项目 Hub 的来源边界
- [x] 防止团队共享高价值 memory 时互相污染
- [x] 为跨项目引用补充可追溯来源展示

### 10. 团队级验收闭环

- [x] 验证产品可稳定处理 repo 日常变化，尽量不依赖人工全量重建
- [x] 让管理者可见“是否在用、哪里不准、哪里在坏”
- [x] 验证团队共享 memory 后不会互相污染

---

## 四、已完成项说明

以下 Context Lifecycle 相关阶段已在 `docs/plans/mempalace-absorption-execution-plan.md` 中标记为完成：

- Phase 3：证据回链与时态主路径
- Phase 4：Agent Diary 生命周期接入
- Phase 5：写入治理与冲突提示
- Phase 6：文档、验证与收尾

这意味着它们不应再作为“当前后续待办”继续占据优先级。

当前更合理的处理方式是：

- 将其视为已完成能力，纳入后续回归与质量保护范围
- 如果后续发现主路径回退、文档失配或治理失效，再单独开新一轮收口任务

---

## 五、P2：继续完善 Embedding Gateway

目标：在当前“可稳定使用”的基础上继续补性能与观测。

### 12.1 控制面观测补充（2026-04-09）

- [x] 为索引阈值补独立 CLI 诊断输出 / 当前值回显
- [x] 把长期记忆治理指标纳入团队看板
- [x] 把策略摘要接入 `health:full` 项目摘要

验收记录：

- `contextatlas index:diagnose` 已可输出当前 churn / cost / min-files 阈值及对应环境变量键名
- `contextatlas ops:metrics` 已补充治理策略分布与长期记忆 scope 分布
- `contextatlas health:full` 已在 per-project summary 中展示策略模式、changed files、churn、cost 与 triggers
- `contextatlas alert:eval` 已并入 `memoryHealth` 指标，catalog inconsistency / orphaned feature memory 现在会直接参与告警评估
- `release smoke` 已覆盖：
  - `contextatlas index:diagnose --json`
  - `contextatlas ops:summary --json`
  - `contextatlas ops:metrics --json`
  - `contextatlas alert:eval --json`
  - 且已引入 `seed-memory-governance` 场景化种子步骤，用于复现 feature / catalog 不一致、orphaned memory 与 stale memory
- 对应回归覆盖已补到：
  - `tests/index-plan.test.ts`
  - `tests/cli-registration.test.ts`
  - `tests/ops-metrics.test.ts`
  - `tests/index-strategy-ops.test.ts`
  - `tests/release-smoke.test.ts`
  - `tests/release-gate.test.ts`

### 11. 两级缓存

- [x] 实现 `L1 memory + L2 Redis` 两级缓存
- [x] 明确缓存命中优先级与失效策略
- [x] 补充命中率与延迟验证

### 12. Provider 级指标与面板

- [x] 为 provider 增加成功率、失败率、延迟、熔断/冷却指标
- [x] 在健康检查或工作台中暴露 provider 级状态
- [x] 补充可观测性验证与文档

交付记录：

- [Iteration 5 Gateway 增强报告（2026-04-08）](../archive/iterations/2026-04-08/iteration-5-gateway-enhancement-report.md)

---

## 六、建议执行顺序

建议按下面顺序推进：

1. 先完成 P0，把未关的验收项和大模块评估收掉。
2. 再做 P1，把 shared/personal、只读 profile、decision reviewer/owner、Hub 边界补齐。
3. 最后做 P2，在不打断主路径收口的前提下继续增强 embedding gateway。

---

## 七、完成定义

一项任务只有同时满足下面条件，才应标记为完成：

- 代码已落地
- 测试已补齐或已有验证证据
- 相关文档已同步
- 路线图 / 执行清单中的对应状态已更新

如果只是“功能看起来已经有了”，但没有完成验收或文档同步，应继续保留为未完成状态。
