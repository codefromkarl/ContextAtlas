# ContextAtlas 后续任务执行清单

本文档用于把当前仓库中已经明确但尚未完全关闭的后续任务，整理成一份可执行、可跟踪、可验收的任务板。

适用时间点：`2026-04-08`

主要依据：

- `docs/ROADMAP_CHECKLIST.md`
- `PRODUCT_EVOLUTION_ROADMAP.md`
- `docs/MEMPALACE_ABSORPTION_EXECUTION_PLAN.md`
- `docs/UPDATE_2026_04_08.md`

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

### 2. 首次接入闭环验收

- [ ] 按 `docs/FIRST_USE.md` 实走一次默认闭环
- [ ] 验证新用户可在 10 分钟内完成首次接入与问答
- [ ] 补充验收记录或 smoke 证据
- [ ] 关闭 `Phase A / P0 验收标准` 中对应未打勾项

### 3. 结果卡片结构验收

- [ ] 验证 CLI 输出稳定包含：代码命中
- [ ] 验证 CLI 输出稳定包含：相关模块记忆
- [ ] 验证 CLI 输出稳定包含：相关决策记录
- [ ] 验证 CLI 输出稳定包含：为什么命中这些结果
- [ ] 验证 MCP 主路径输出与 CLI 主路径结构一致

### 4. 冷启动降级验收

- [ ] 验证索引未完成时会走 lexical / FTS 降级查询
- [ ] 验证输出明确展示“索引中 / 可部分回答 / 完整模式未就绪”
- [ ] 验证系统不会因冷启动直接卡死
- [ ] 补一条长期可回归的 cold-start smoke 用例

### 5. 产品身份统一验收

- [ ] 检查 `README.md`、`README.EN.md`、包名、CLI 名、发布信息是否完全统一
- [ ] 清理可能残留的旧命名或旧品牌文案
- [ ] 补验收记录并关闭对应路线图勾选项

---

## 三、P1：补团队治理与产品边界

目标：把当前系统从“单机可用”推进到“团队可控、可共享、可治理”。

### 6. 共享与个人记忆分层

- [ ] 设计 `shared memory` 与 `personal memory` 的边界
- [ ] 明确读取优先级、写入权限和冲突处理规则
- [ ] 为 CLI / MCP 输出补来源标识
- [ ] 补权限与污染防护测试

### 7. 组织级只读档案

- [ ] 为 `project profile` 增加组织级只读模式
- [ ] 明确哪些字段允许本地覆盖，哪些字段不可覆盖
- [ ] 让结果中可见 profile 来源与可写状态

### 8. 决策记录治理

- [ ] 为 `decision record` 增加 `reviewer` / `owner` 约束
- [ ] 明确未审核决策与已审核决策的可信差异
- [ ] 将这些状态接入 CLI / MCP 主路径输出

### 9. Cross-project Hub 边界

- [ ] 明确跨项目 Hub 的权限边界
- [ ] 明确跨项目 Hub 的来源边界
- [ ] 防止团队共享高价值 memory 时互相污染
- [ ] 为跨项目引用补充可追溯来源展示

### 10. 团队级验收闭环

- [ ] 验证产品可稳定处理 repo 日常变化，尽量不依赖人工全量重建
- [ ] 让管理者可见“是否在用、哪里不准、哪里在坏”
- [ ] 验证团队共享 memory 后不会互相污染

---

## 四、已完成项说明

以下 Context Lifecycle 相关阶段已在 `docs/MEMPALACE_ABSORPTION_EXECUTION_PLAN.md` 中标记为完成：

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

### 11. 两级缓存

- [ ] 实现 `L1 memory + L2 Redis` 两级缓存
- [ ] 明确缓存命中优先级与失效策略
- [ ] 补充命中率与延迟验证

### 12. Provider 级指标与面板

- [ ] 为 provider 增加成功率、失败率、延迟、熔断/冷却指标
- [ ] 在健康检查或工作台中暴露 provider 级状态
- [ ] 补充可观测性验证与文档

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
