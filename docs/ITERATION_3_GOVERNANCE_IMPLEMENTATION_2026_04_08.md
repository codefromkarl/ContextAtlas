# Iteration 3 治理能力实现记录（2026-04-08）

本文档用于记录 `Iteration 3` 的实现结果，覆盖：

- `DecisionRecord.owner` 落地
- shared provenance / governance 状态外显
- `profile:show` 的来源与可写状态输出
- 相关回归测试

---

## 一、实现结论

`Iteration 3` 已完成。

这一轮没有重新发明治理模型，而是把 `Iteration 2` 中定下来的边界真正接到了现有主路径上。

---

## 二、落地内容

### 1. Decision Owner

已完成：

- `DecisionRecord` 增加 `owner`
- `DecisionStore` 持久化与读取 `owner`
- `record_decision` MCP 写入支持 `owner`
- `decision:record` CLI 支持 `--owner`
- `decision:list` CLI 支持 `--owner` 过滤

对应位置：

- [types.ts](/home/yuanzhi/Develop/tools/ContextAtlas/src/memory/types.ts#L88)
- [DecisionStore.ts](/home/yuanzhi/Develop/tools/ContextAtlas/src/memory/DecisionStore.ts#L15)
- [projectMemory.ts](/home/yuanzhi/Develop/tools/ContextAtlas/src/mcp/tools/projectMemory.ts#L69)
- [memoryKnowledge.ts](/home/yuanzhi/Develop/tools/ContextAtlas/src/cli/commands/memoryKnowledge.ts#L315)

### 2. Governance 状态外显

已完成：

- 检索结果卡片中的决策记录显示 `Owner`、`Reviewer`、`治理状态`
- 检索结果卡片中的 feature memory 显示 `类型` 与 `来源项目`
- `prepare_handoff` 中的 decision / feature context block 同步包含治理字段
- 下一步动作中的 `decision:record` 示例命令增加 `--owner`

对应位置：

- [codebaseRetrieval.ts](/home/yuanzhi/Develop/tools/ContextAtlas/src/mcp/tools/codebaseRetrieval.ts#L1339)
- [prepareHandoff.ts](/home/yuanzhi/Develop/tools/ContextAtlas/src/mcp/tools/prepareHandoff.ts#L58)

### 3. Profile 来源与可写状态

已完成：

- `profile:show` 支持 `--repo`
- `profile:show --json` 输出 `source` 与 `writableState`
- 文本输出新增 `来源` 与 `可写状态`

对应位置：

- [profile.ts](/home/yuanzhi/Develop/tools/ContextAtlas/src/cli/commands/profile.ts#L98)

### 4. Shared / Cross-project 来源边界

已完成：

- shared feature memory 在结果卡片和 handoff block 中明确显示 `memoryType` 与 `sourceProjectId`
- 共享条目不再只以“普通 feature memory”形态展示

这使 shared / local 的来源边界从“隐式字段”变成了主路径可见信号。

---

## 三、验证

本轮新增或扩展的验证覆盖：

- `tests/memory-substores.test.ts`
  - `DecisionStore can save, read, and list decisions with reviewer and owner metadata`
- `tests/mcp-memory-tools.test.ts`
  - `record_decision persists owner metadata`
  - `decision:list supports reviewer and owner filter with json output`
- `tests/codebase-retrieval.test.ts`
  - 默认结果卡片外显 shared provenance 与 decision governance
- `tests/profile-governance.test.ts`
  - `profile:show CLI exposes governance source and writable status`

执行结果：

```bash
node --import tsx --test \
  tests/memory-substores.test.ts \
  tests/mcp-memory-tools.test.ts \
  tests/codebase-retrieval.test.ts \
  tests/profile-governance.test.ts
```

结果：

- `36 passed`
- `0 failed`

---

## 四、对清单状态的影响

本轮可以正式关闭这些实现项：

- shared / personal memory 分层
- organization-readonly project profile
- decision reviewer / owner 约束
- Cross-project Hub 的权限边界与来源边界
- CLI / MCP 来源与治理状态外显

仍未关闭的，是团队级验收项：

- 日常 repo 变化稳定性
- 管理者视角的可见性
- 团队共享 memory 的污染控制验收

---

## 五、结论

`Iteration 3` 已完成，下一阶段应转入团队级验收闭环，而不是继续补同类治理字段。
