# Iteration 2 记忆治理边界设计（2026-04-08）

本文档用于完成 `Iteration 2` 的设计任务，覆盖：

- `shared memory` 与 `personal memory` 分层
- 组织级只读 `project profile`
- `decision record` 的 `reviewer / owner` 治理
- Cross-project Hub 的权限边界与来源边界

本轮目标是把治理边界定稿，不在这一轮直接推进大规模实现改造。

---

## 一、设计结论

本轮设计结论如下：

1. 当前仓库已经具备一部分治理底座，不应从零重做。
2. `profile governance + shared hub policy + reviewer/owner metadata` 已经落地，但仍属于“能力已存在、团队边界未完全产品化”的状态。
3. `Iteration 3` 的重点不再是发明新模型，而是把现有模型补成统一的读写权限、可信状态和来源展示规则。

---

## 二、当前实现现状

### 1. 已有能力

当前代码中已经存在以下治理能力：

- `ProjectProfile.governance`
  - `profileMode: editable | organization-readonly`
  - `sharedMemory: disabled | readonly | editable`
  - `personalMemory: project | global-user`
- `MemoryStore.saveProfile()` 已对 `organization-readonly` 做覆盖保护，默认不允许无 `force` 覆盖。
- `handleRecordLongTermMemory()` 在未显式提供 `scope` 时，会继承 `profile.governance.personalMemory`。
- `SharedMemoryHub.contribute()` 会检查项目 `sharedMemory` 策略，只有 `editable` 允许贡献共享记忆。
- `SharedMemoryHub.syncToProject()` 会在目标项目 `sharedMemory=disabled` 时拒绝同步。
- `DecisionRecord` 已有 `owner` 与 `reviewer` 字段，CLI / MCP / SQLite 持久化 / list filter 都已接通。
- retrieval / handoff 主路径已经能展示：
  - feature memory 的 `memoryType`、`sourceProjectId`
  - decision 的 `owner`、`reviewer`、`reviewed / owner-owned / unowned`

对应代码与测试依据：

- [types.ts](/home/yuanzhi/Develop/tools/ContextAtlas/src/memory/types.ts#L88)
- [MemoryStore.ts](/home/yuanzhi/Develop/tools/ContextAtlas/src/memory/MemoryStore.ts#L318)
- [SharedMemoryHub.ts](/home/yuanzhi/Develop/tools/ContextAtlas/src/memory/SharedMemoryHub.ts#L60)
- [profile.ts](/home/yuanzhi/Develop/tools/ContextAtlas/src/cli/commands/profile.ts#L18)
- [memoryKnowledge.ts](/home/yuanzhi/Develop/tools/ContextAtlas/src/cli/commands/memoryKnowledge.ts#L315)
- [codebaseRetrieval.ts](/home/yuanzhi/Develop/tools/ContextAtlas/src/mcp/tools/codebaseRetrieval.ts#L1495)
- [prepareHandoff.ts](/home/yuanzhi/Develop/tools/ContextAtlas/src/mcp/tools/prepareHandoff.ts#L133)
- [profile-governance.test.ts](/home/yuanzhi/Develop/tools/ContextAtlas/tests/profile-governance.test.ts#L32)
- [mcp-memory-tools.test.ts](/home/yuanzhi/Develop/tools/ContextAtlas/tests/mcp-memory-tools.test.ts#L359)

### 2. 仍然缺失的边界

当前仍未正式收口的点主要有：

- `shared memory` 与 `personal memory` 的对象边界还不够明确，尤其是“哪些类型允许 personal，哪些允许 shared”没有统一规则。
- profile 的治理状态目前主要在 `profile:show` 暴露，尚未成为 retrieval / assemble / handoff 的稳定背景信息。
- CLI / MCP 主路径虽然已有部分治理字段，但还没有统一外显“可写性、共享来源、作用域层级、消费边界”。
- Cross-project Hub 目前有贡献、同步和搜索能力，但“谁可以贡献、谁可以消费、消费后如何保留 provenance、消费结果如何在检索主路径稳定展示”仍偏隐式。
- `shared memory` 的“共享基底 + 本地 override”规则尚未正式产品化。

---

## 三、分层设计

### 1. shared memory

`shared memory` 定义为：

- 可跨项目复用
- 默认服务于团队或组织
- 允许被多个仓库消费
- 必须可追溯来源项目或共享库入口

本轮建议将以下对象纳入 `shared memory` 域：

- Shared Hub 中的 `FeatureMemory`
- 组织级只读 `ProjectProfile`
- 被团队明确标记为共享的规则型长期记忆

约束：

- shared 不等于全局可写。
- shared 默认应是“少量高价值、可复用、需治理”的对象。
- shared 数据必须带来源说明，不能伪装成本地原生记忆。

### 2. personal memory

`personal memory` 定义为：

- 默认只服务单个 agent / 用户
- 用于保存偏好、临时工作习惯、个人 runbook、个人 diary
- 不自动进入团队共享路径

本轮建议将以下对象纳入 `personal memory` 域：

- `scope=global-user` 的长期记忆
- `journal`
- 个人参考链接、个人工作习惯、个人验证偏好

约束：

- personal memory 不承载团队事实真相。
- personal memory 可以辅助工作，但不能在主路径上压过代码和 shared governance。
- personal memory 若要共享，必须显式迁移，不允许“读取时自动上浮成 shared”。

### 3. project memory

`project memory` 仍然是主工作区：

- 默认绑定当前仓库
- 可容纳 feature memory、decision、project-scoped long-term memory
- 与当前代码、当前目录和当前索引生命周期强绑定

因此，整体模型定为三层：

1. `project memory`
2. `shared memory`
3. `personal memory`

其中：

- `project` 是默认工作层
- `shared` 是治理后可复用层
- `personal` 是个人辅助层

---

## 四、读取优先级与冲突规则

建议统一为以下主路径优先级：

1. 当前代码证据
2. 当前项目的已确认 feature memory / reviewed decision
3. 当前项目的普通 profile / long-term memory
4. shared memory
5. personal memory

解释：

- `code` 仍然是最高优先级。
- `shared memory` 不能压过当前项目已确认事实，只能作为补充、参考或模板。
- `personal memory` 只能作为最低优先级的个人辅助层。

冲突处理规则：

- 代码与任何 memory 冲突时，以代码为准。
- 当前项目已确认记忆与 shared memory 冲突时，以当前项目为准。
- shared memory 与 personal memory 冲突时，以 shared 为准。
- personal memory 不应进入高可信 block，只能以辅助提示展示。

---

## 五、写入权限设计

### 1. Project Profile

`ProjectProfile` 的治理规则定为：

- `editable`
  - 当前项目可直接更新
- `organization-readonly`
  - 默认只读
  - 仅显式 `force` 才允许覆盖
  - 覆盖行为应视为管理员级动作

当前代码已具备核心保护，后续实现重点是把该状态稳定外显到 CLI / MCP 输出。

### 2. Shared Memory

`sharedMemory` 策略解释定为：

- `disabled`
  - 不允许从 shared hub 同步
  - 不允许贡献到 shared hub
- `readonly`
  - 允许消费 shared
  - 不允许贡献 shared
- `editable`
  - 允许消费 shared
  - 允许贡献 shared

实现建议：

- `contribute` 检查 source 项目策略
- `sync` 检查 target 项目策略
- 主路径结果中要显式标注“本条目来自 shared source”

### 3. Personal Memory

`personalMemory` 规则解释定为：

- `project`
  - 默认落到当前项目作用域
- `global-user`
  - 默认落到用户级作用域

这一项当前已经影响长期记忆默认落库逻辑，后续需补到 CLI / MCP 可见输出。

---

## 六、Decision Reviewer / Owner 设计

### 1. 当前判断

`owner` 与 `reviewer` 当前都已经存在，底层持久化和 CLI/MCP 写入也已接通。

因此，这一部分不再是“字段设计缺失”，而是“治理语义定稿和主路径展示收口”问题。

### 2. 定稿方案

- `owner`
  - 负责维护该决策的人
  - 解决“这条决策归谁负责”的问题
- `reviewer`
  - 审核或批准该决策的人
  - 解决“这条决策是否经过独立审查”的问题

可信状态解释：

- 无 `owner`
  - 视为临时决策或历史导入记录
- 有 `owner`、无 `reviewer`
  - 视为 owner-owned，属于已归属但未审核
- 有 `owner`、有 `reviewer`
  - 视为 reviewed，可在团队主路径中给更高可信度

### 3. Iteration 3 的最小实现

最小改造建议：

- 将 `owner / reviewer / governanceState` 解释稳定写入主路径文档
- 保证 `decision:list`、retrieval、handoff、assemble 对治理状态解释一致
- 明确哪些决策可以被视为 reviewed，哪些只能视为 owner-owned
- 为后续团队视图补 reviewer/owner 维度聚合预留一致口径

---

## 七、Cross-project Hub 边界

### 1. 来源边界

Cross-project Hub 的来源边界必须外显：

- 来源项目
- 共享类别
- 引用路径或 shared ref
- 本地同步别名

当前 `SharedMemoryHub` 已经保留 `sourceProject`、`sourceProjectId`、shared ref，但主路径展示还不稳定。

### 2. 权限边界

Hub 的权限边界建议定为：

- 贡献权限由 source project 的 `sharedMemory` 策略控制
- 消费权限由 target project 的 `sharedMemory` 策略控制
- 共享条目一旦同步到项目，本地副本应保留 shared provenance，不应伪装为纯 local

### 3. 防污染规则

shared memory 同步后应保留这些元信息：

- `memoryType=shared`
- `sourceProjectId`
- `sharedReferences`

当本地对 shared memory 做覆盖时：

- 允许局部 override
- 但必须保留原 shared reference
- 检索展示时应明确“shared base + local override”

补充说明：

- 当前 `hub:search` / `hub:fts` / `hub:deps` 偏向数据层查询入口，还没有把 governance/provenance 当作一等输出字段。
- Iteration 3 的目标不应只是“能搜到 shared memory”，而应是“能看清 shared memory 从哪里来、当前项目能不能改、它是否只是共享基底”。

---

## 八、CLI / MCP 主路径外显要求

Iteration 3 需要把以下治理信息稳定外显到主路径：

### 1. profile

- `profileMode`
- `sharedMemory`
- `personalMemory`
- 这些治理信息来自哪个 profile 来源

### 2. decision

- `owner`
- `reviewer`
- `reviewed / owner-owned / unowned` 状态

### 3. feature/shared memory

- `memoryType`
- `sourceProjectId` 或 shared source
- 是否可写 / 是否来自共享
- 是否存在 local override

### 4. long-term memory

- `scope`
- 是否 personal
- 是否 project-scoped

---

## 九、影响面清单

Iteration 3 实现时，优先影响以下位置：

- 类型与存储
  - [types.ts](/home/yuanzhi/Develop/tools/ContextAtlas/src/memory/types.ts#L1)
  - [DecisionStore.ts](/home/yuanzhi/Develop/tools/ContextAtlas/src/memory/DecisionStore.ts#L1)
  - [MemoryStore.ts](/home/yuanzhi/Develop/tools/ContextAtlas/src/memory/MemoryStore.ts#L1)
- CLI
  - [profile.ts](/home/yuanzhi/Develop/tools/ContextAtlas/src/cli/commands/profile.ts#L1)
  - [memoryKnowledge.ts](/home/yuanzhi/Develop/tools/ContextAtlas/src/cli/commands/memoryKnowledge.ts#L1)
  - [hubShared.ts](/home/yuanzhi/Develop/tools/ContextAtlas/src/cli/commands/hubShared.ts#L1)
- MCP
  - [projectMemory.ts](/home/yuanzhi/Develop/tools/ContextAtlas/src/mcp/tools/projectMemory.ts#L1)
  - [longTermMemory.ts](/home/yuanzhi/Develop/tools/ContextAtlas/src/mcp/tools/longTermMemory.ts#L1)
- 主路径展示
  - [codebaseRetrieval.ts](/home/yuanzhi/Develop/tools/ContextAtlas/src/mcp/tools/codebaseRetrieval.ts#L1)
  - [assembleContext.ts](/home/yuanzhi/Develop/tools/ContextAtlas/src/mcp/tools/assembleContext.ts#L1)

---

## 十、实现顺序建议

建议按下面顺序进入 `Iteration 3`：

1. 统一 profile/shared/personal 的展示口径
2. 在 retrieval / assemble / handoff 中稳定外显 governance 状态
3. 补 shared provenance 与 local override 展示
4. 补个人 / 项目作用域展示与测试
5. 再补团队视角的 owner / reviewer 聚合或过滤增强

原因：

- `owner` 已经存在，当前瓶颈已经从“字段缺失”变成“语义和展示不统一”。
- 主路径展示要建立在统一口径后，否则会重复改两遍。
- shared provenance 一旦进入展示层，shared/personal/project 三层关系会更清晰。

---

## 十一、退出标准

`Iteration 2` 设计可视为完成，当且仅当：

- shared / personal / project 三层边界有明确书面定义
- profile readonly / shared policy / personal scope 的权限语义已定稿
- decision 的 `owner / reviewer` 分工已定稿
- Cross-project Hub 的来源与权限边界已定稿
- Iteration 3 的实现顺序已明确

本文件满足上述条件，因此 `Iteration 2` 可以进入实现准备阶段。
