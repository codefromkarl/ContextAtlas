# Mempalace 吸收路线图（执行版）

本文档用于把「分层唤醒、时态事实、原始证据层、agent diary、写入去重/冲突提示」落成可执行阶段，并作为执行过程中的待办面板。

## 执行原则

- 直接复用现有 `assemble_context` / `codebase-retrieval` / `prepare_handoff` / `long-term memory` 主路径，不重写存储层。
- 每完成一个阶段：
  - 更新本文档状态
  - 运行对应验证
  - 创建一个 git commit
- 阶段边界按当前代码耦合关系划分，优先保证每个 commit 都是完整、可验证、可回滚的增量。

## 阶段总览

### Phase 0 - 路线图导入

- [x] 新增执行文档
- [x] 固化阶段边界、验收口径与提交约束

### Phase 1 - 分层唤醒协议

- [x] 将 `wakeupLayers` 从输出摘要升级为正式唤醒协议
- [x] 为 `assemble_context` 增加可控层级输入
- [x] 将 L0 明确为项目硬约束 + 路由决策，而不只是 intent/routing 文案
- [x] 补充协议级测试与文档

### Phase 2 - 知识模型扩展

- [ ] 将 `temporal-fact` / `journal` / `evidence` 作为正式长期记忆类型纳入 CLI/MCP 主入口
- [ ] 提供 `invalidate` / `factKey` / `validFrom` / `validUntil` 等时态事实治理能力
- [ ] 注册并暴露 `record_agent_diary` / `read_agent_diary` / `find_agent_diary`
- [ ] 补充存储层与工具层测试

### Phase 3 - 证据回链与时态主路径

- [ ] 让 retrieval 主路径把 `evidence` 与 `temporal-fact` 作为显式上下文块处理
- [ ] 让 checkpoint / handoff 能解析并携带 `supportingRefs`
- [ ] 为 feature memory / decision record 的 `evidenceRefs` 建立自动回链解析
- [ ] 补充 retrieval / handoff / persistence 测试

### Phase 4 - Agent Diary 生命周期接入

- [ ] 让 `assemble_context` 可选吸收最近 diary
- [ ] 让 `prepare_handoff` 补带最近 diary 摘要
- [ ] 让 diary 进入上下文生命周期，而不只是旁路工具
- [ ] 补充上下文装配与 handoff 测试

### Phase 5 - 写入治理与冲突提示

- [ ] 为 feature memory / decision 维持重复提示
- [ ] 为长期记忆新增写入前诊断与冲突提示
- [ ] 对 `temporal-fact` 做 `factKey` 冲突诊断
- [ ] 对 `evidence` / `journal` / `feedback` 做重复提示
- [ ] 补充写入治理测试

### Phase 6 - 文档、验证与收尾

- [ ] 更新 MCP 文档与执行文档
- [ ] 运行阶段性回归测试
- [ ] 确认所有阶段均已提交

## 提交记录

- Phase 0: done
- Phase 1: done
- Phase 2: pending
- Phase 3: pending
- Phase 4: pending
- Phase 5: pending
- Phase 6: pending
