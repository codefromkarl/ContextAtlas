# ContextAtlas 迭代执行计划（2026-04-08）

本文档将当前后续任务压缩成按迭代推进的执行计划，目标是让仓库从“有路线图和清单”进入“可直接排期执行”的状态。

适用范围：

- `docs/NEXT_TASKS_EXECUTION_CHECKLIST.md`
- `docs/ROADMAP_CHECKLIST.md`
- `docs/UPDATE_2026_04_08.md`

说明：

- `docs/MEMPALACE_ABSORPTION_EXECUTION_PLAN.md` 当前已完成，不纳入本轮主计划。
- 本计划优先处理验收闭环和团队治理边界。
- `Embedding Gateway` 增强项放在后置迭代，避免打断主路径收口。

---

## 一、总目标

本轮迭代结束时，至少应达到下面结果：

1. `Phase A` 中已经实现但未正式关闭的验收项全部完成。
2. 团队级记忆边界开始清晰，不再只有单机使用假设。
3. 产品能更明确回答“谁能写、谁能读、什么可信、污染如何避免”。
4. Embedding Gateway 的后续增强具备独立排期，不与主路径收口互相阻塞。

---

## 二、迭代划分

建议拆成 4 个连续迭代，每个迭代聚焦一个明确结果。

### Iteration 1：验收收口周

目标：把“已经基本完成但未正式关闭”的事项做成有证据的完成状态。

工作项：

- [x] 完成 `src/mcp/tools/codebaseRetrieval.ts` 与 `src/search/SearchService.ts` 的收口评估
- [x] 按 `docs/FIRST_USE.md` 跑一次默认闭环
- [x] 验证 10 分钟首次接入目标
- [x] 验证结果卡片结构在 CLI / MCP 主路径上一致
- [x] 验证冷启动降级路径稳定可用
- [x] 核对产品身份文案是否完全统一
- [x] 更新 `docs/ROADMAP_CHECKLIST.md` 中对应验收状态

交付物：

- [x] 一份模块收口评估结论
- [x] 一组验收记录或 smoke 证据
- [x] 更新后的路线图勾选状态

交付记录：

- [模块收口评估（2026-04-08）](./ITERATION_1_MODULE_CLOSURE_EVALUATION_2026_04_08.md)
- [Iteration 1 验收报告（2026-04-08）](./ITERATION_1_ACCEPTANCE_REPORT_2026_04_08.md)

退出标准：

- [x] `Phase A / P0 验收标准` 的未勾选项全部关闭，或有明确阻塞说明
- [x] 当前主路径不存在“功能已做但文档仍显示未完成”的状态

### Iteration 2：记忆边界设计周

目标：先把团队治理边界设计清楚，再进入实现。

工作项：

- [x] 设计 `shared memory` 与 `personal memory` 分层模型
- [x] 设计组织级只读 `project profile` 模式
- [x] 定义读取优先级、写入权限、冲突处理和来源展示规则
- [x] 确定哪些状态需要进入 CLI / MCP 主路径输出
- [x] 评估对存储层、MCP 工具层、CLI 层的影响

交付物：

- [x] 一份边界设计文档
- [x] 一份影响面清单
- [x] 一组实现顺序建议

交付记录：

- [Iteration 2 记忆治理边界设计（2026-04-08）](./ITERATION_2_MEMORY_GOVERNANCE_DESIGN_2026_04_08.md)

退出标准：

- [x] 团队记忆分层与只读档案方案定稿
- [x] 没有关键权限边界仍处于口头约定状态

### Iteration 3：治理能力实现周

目标：把 Iteration 2 定下来的边界真正接入产品主路径。

工作项：

- [x] 实现 `shared memory` 与 `personal memory` 分层
- [x] 实现组织级只读 `project profile`
- [x] 为 `decision record` 增加 `reviewer` / `owner` 约束
- [x] 为 Cross-project Hub 增加权限边界和来源边界
- [x] 在 CLI / MCP 输出中补来源、可信度或可写状态信息
- [x] 补充污染防护、权限边界和来源展示测试

交付物：

- [x] 可运行实现
- [x] 回归测试
- [x] 更新后的文档和命令示例

交付记录：

- [Iteration 3 治理能力实现记录（2026-04-08）](./ITERATION_3_GOVERNANCE_IMPLEMENTATION_2026_04_08.md)

退出标准：

- [x] 团队共享 memory 不再是“默认全可见全可写”的隐含模型
- [x] 决策记录、profile、跨项目引用都能看出来源和治理状态

### Iteration 4：稳定性与 Gateway 后置增强周

目标：在不打断主路径的前提下，补稳定性验证和 Gateway 观测增强。

工作项：

- [x] 验证产品对 repo 日常变化的处理稳定性
- [x] 补管理者视角的可见性，回答“是否在用、哪里不准、哪里在坏”
- [ ] 实现 `L1 memory + L2 Redis` 两级缓存
- [ ] 增加 provider 级成功率、失败率、延迟和冷却指标
- [ ] 在健康检查或工作台中暴露 provider 级状态
- [ ] 补性能、命中率和可观测性验证

交付记录：

- [Iteration 4 团队级验收报告（2026-04-08）](./ITERATION_4_TEAM_ACCEPTANCE_REPORT_2026_04_08.md)

交付物：

- [ ] 稳定性验证记录
- [ ] Gateway 两级缓存实现
- [ ] Provider 级指标输出

退出标准：

- [ ] 日常 repo 变化不再频繁依赖人工全量重建
- [ ] Gateway 后续增强具备基本观测和验证闭环

---

## 三、依赖关系

执行依赖建议如下：

1. Iteration 1 必须先做，因为它负责关闭现有“已做未验”的不确定状态。
2. Iteration 2 必须先于 Iteration 3，因为治理能力实现前需要先定边界。
3. Iteration 4 可以部分并行，但不应抢占 Iteration 1-3 的主路径优先级。

---

## 四、并行建议

如果需要并行推进，建议只做这两类并行：

- 主线程：Iteration 1 或 Iteration 2 的主路径收口
- 支线线程：Gateway 方案设计、指标口径设计、缓存策略验证

不建议并行的组合：

- 不要在 Iteration 2 边界未定前直接做大规模治理实现
- 不要在主路径验收未关闭前，把大部分精力转去 Gateway 增强

---

## 五、每轮迭代的固定动作

每轮开始前：

- [ ] 确认本轮目标、边界和不做项
- [ ] 确认需要更新的文档与测试面

每轮结束前：

- [ ] 运行对应验证
- [ ] 更新执行清单状态
- [ ] 更新路线图或相关文档状态
- [ ] 记录未完成原因和下一轮承接点

---

## 六、推荐的最近一步

如果现在立刻开始执行，建议先做：

1. 进入 Iteration 1。
2. 先完成大模块收口评估。
3. 再跑一次首次接入、结果卡片、冷启动和产品身份统一验收。
4. 最后回写 `docs/ROADMAP_CHECKLIST.md` 与 `docs/NEXT_TASKS_EXECUTION_CHECKLIST.md` 的状态。
