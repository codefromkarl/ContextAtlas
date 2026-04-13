# ContextAtlas 接入模式解耦重构计划

本文档用于把当前 `CLI + skills + MCP` 混搭接入，重构为两种可选且互斥的默认应用模式：

- `cli-skill`
- `mcp`

目标不是删除 `MCP`，而是把它从“默认隐式依赖”降级为“可选适配器”，使用户能够明确选择一种接入模式，而不是表面二选一、底层仍混用同一套路径。

## 背景

当前仓库已经具备 `CLI`、`MCP Server` 和面向 skills/workflow 的接入能力，但实现上仍存在明显混搭：

- `contextatlas search` 直接复用 `src/mcp/tools/codebaseRetrieval.ts` 的 handler，而不是调用独立 use case。
- `contextatlas setup:local` 会同时写入 MCP 配置、prompt 文档和 Codex skill。
- 当前生成的 Codex skill `contextatlas-mcp` 本质上仍通过 `mcp__contextatlas__*` 工具调用能力。
- 非 TTY 环境下直接执行 `contextatlas` 会自动切到隐式 MCP stdio 模式。

这会带来几个问题：

- 用户无法真正选择“只走 CLI + skills”。
- CLI 与 MCP 的职责边界不清，后续修改容易产生交叉回归。
- 文档、测试、setup 和运行时逻辑都默认混搭，难以维护。

## 重构目标

### 产品目标

- 用户可显式选择 `cli-skill` 或 `mcp` 两种接入模式。
- 任一模式下都不再默认写入另一种模式的配置或行为钩子。
- 文档、setup、skill、运行时行为与测试均与所选模式一致。

### 架构目标

- `SearchService`、`MemoryStore` 等核心能力保持独立，不依赖 CLI 或 MCP 适配层。
- 新增 application/use case 层，承载查询编排、结果整形、写入策略等通用逻辑。
- CLI adapter 与 MCP adapter 都只负责参数解析、协议转换、输出格式和错误映射。

### 非目标

- 本次不重写检索、记忆、索引核心实现。
- 本次不改变 `SearchService`、`MemoryStore` 的对外语义。
- 本次不新增第三种长期支持模式；`hybrid` 仅允许作为迁移过渡，不作为稳定默认模式。

## 当前混搭点

### 代码层

- ~~`src/cli/commands/search.ts`~~ ✅ 已修复
  - ~~CLI 直接 import `../../mcp/tools/codebaseRetrieval.js`~~ → 现在直接 import `../../application/retrieval/executeRetrieval.js`
- `src/cli/commands/bootstrap.ts`
  - `setup:local` 将 skills、MCP、prompt 文档绑定在同一命令
- ~~`src/setup/local.ts`~~ ✅ 已修复
  - ~~同时写入 `~/.claude/mcp.json`、`~/.codex/config.toml`、prompt 文档和 `contextatlas-mcp` skill~~ → 现在按模式互斥生成
- `src/config.ts`
  - 隐式 stdio 环境自动注入 `mcp` 子命令
- ~~`src/mcp/tools/codebaseRetrieval.ts`~~ ✅ 已修复
  - ~~混合承载参数校验、自动索引决策、检索编排、结果卡片与 MCP 响应包装~~ → 现在仅为 ~105 行 thin adapter（Zod schema + progress + handler）

### 文档层

- `docs/reference/cli.md`
  - 将 `setup:local` 作为一键混合接入路径
- `docs/guides/deployment.md`
  - 将本地接入描述为单一路径，未区分模式
- `docs/reference/mcp.md`
  - 需要与新的显式模式约束对齐

### 测试层

- `tests/local-setup.test.ts`
  - 当前断言 `setup:local` 会生成 `contextatlas-mcp` skill 和 MCP 配置
- `tests/mcp-stdio.test.ts`
  - 当前默认假设无参非 TTY 可走隐式 MCP
- `tests/cli-registration.test.ts`
  - 当前只验证 `setup:local` 的单一入口命令集合

## 目标形态

### 模式 1：`cli-skill`

适用场景：

- 用户只在本地终端和本地 agent 中使用 ContextAtlas
- 希望依靠 shell + JSON 输出 + prompt/skill 约束完成集成
- 不希望暴露或维护 MCP server

约束：

- 只写 `~/.contextatlas/.env`
- 只写 prompt 文档和 `contextatlas-cli` skill
- skill 中只允许 shell 调用 `contextatlas ... --json`
- 不写任何 MCP 客户端配置
- 禁用隐式 MCP stdio 自动切换

### 模式 2：`mcp`

适用场景：

- 需要接入 Claude Desktop、Cursor、Codex MCP、Gemini 等 MCP 客户端
- 需要标准工具协议、工具发现与 progress 回调

约束：

- 写入 MCP 客户端配置
- 可选写入模式说明 prompt，但不写 CLI-oriented skill
- 保留 `contextatlas mcp`
- 仅在该模式下允许隐式 stdio MCP

## 目标分层

重构后应形成以下分层：

```text
core services
  SearchService / MemoryStore / indexing / monitoring

application use cases
  executeCodebaseRetrieval
  executeFindMemory
  executeRecordMemory
  ...

adapters
  CLI commands
  MCP tools

setup / docs / generated assets
  cli-skill mode
  mcp mode
```

约束原则：

- CLI 不再 import `src/mcp/tools/*`
- MCP tools 不再承载核心业务逻辑
- setup 根据 mode 写入互斥文件集合
- 文档与测试按 mode 分离

## 执行阶段

### Phase 0 - 约束冻结

目标：

- 明确两种稳定模式的边界、配置和验收口径
- 停止继续增强当前混搭行为

工作项：

- 在本计划文档中固定模式定义与边界
- 约定 `CONTEXTATLAS_EXPOSURE_MODE=cli-skill|mcp`
- 约定 `setup` 层必须显式选择 mode
- 标记当前隐式混搭行为为兼容路径，不再作为新增功能基线

验收：

- 文档中有清晰的模式矩阵
- 执行者不再以“默认混搭”为实现假设

### Phase 1 - 抽出 application/use case 层 ✅ 已完成

目标：

- 解除 CLI 对 MCP tool handler 的直接依赖
- 让 MCP handler 只保留协议适配职责

已新增文件：

- `src/application/retrieval/retrievalTypes.ts` — 共享类型（ResultCard 接口 + I/O 类型 + 进度阶段）
- `src/application/retrieval/resultCard.ts` — 结果卡片排名 + 格式化 + 上下文块构建
- `src/application/retrieval/coldStartFallback.ts` — 冷启动词法降级包
- `src/application/retrieval/executeRetrieval.ts` — 核心编排（索引检查→搜索→卡片→格式化）
- `src/application/retrieval/codebaseRetrieval.ts` — application 层入口（向后兼容）

已调整文件：

- `src/cli/commands/search.ts` — 去除 MCP 类型依赖，直接消费 `RetrievalOutput`
- `src/mcp/tools/codebaseRetrieval.ts` — 2363 行→~105 行 Zod schema + thin handler
- `src/setup/local.ts` — CLI skill 扩展为 9 步工作流；MCP mode 写入 contextatlas-mcp skill

拆分原则：

- 输入归一化、自动索引策略、SearchService 初始化、结果卡片组装下沉到 application 层
- Zod schema、MCP progress 回调、MCP text/json 响应包装保留在 MCP adapter
- CLI 仅负责命令参数解析与 text/json 输出

验收：

- ✅ `src/cli/commands/search.ts` 不再 import `src/mcp/tools/*`
- ✅ `codebase-retrieval` 与 CLI 搜索共享同一 application use case
- ✅ 现有检索结果语义保持不变（13 个 codebase-retrieval 测试全部通过）

### Phase 2 - setup 模式化

目标：

- 将当前一键混搭 setup 拆成显式模式 setup

建议方案：

- 保留命令名：`contextatlas setup:local --mode <mode>`
- 或拆为：
  - `contextatlas setup:cli`
  - `contextatlas setup:mcp`

推荐优先级：

- 第一阶段先保留 `setup:local`
- 强制要求 `--mode cli-skill|mcp`
- 后续再评估是否拆成两个命令

建议调整文件：

- `src/cli/commands/bootstrap.ts`
- `src/setup/local.ts`
- `tests/local-setup.test.ts`
- `tests/cli-registration.test.ts`

重构要求：

- `applyLocalSetup` 拆为 mode-aware 入口
- 输出文件集合按模式互斥
- `cli-skill` 不生成 MCP 配置
- `mcp` 不生成 CLI skill

验收：

- `--mode cli-skill` 与 `--mode mcp` 的 dry-run 输出明显不同
- 无 mode 时给出错误或迁移提示，而不是继续默认混搭
- setup 测试按模式拆分断言

### Phase 3 - skill 分流 ✅ 已完成

目标：

- 让 skill 成为 `cli-skill` 模式的原生入口，而不是 MCP 的变体

已实现：

- `cli-skill` 模式生成 `contextatlas-cli` skill，覆盖完整 9 步工作流（检索→反馈→记忆→决策→索引）
- `mcp` 模式生成 `contextatlas-mcp` skill，走 MCP tool 调用路径
- `src/setup/local.ts` 中 `applyLocalSetup` 按模式互斥生成对应 skill

验收：

- ✅ CLI skill 覆盖主路径检索、反馈、记忆写入、决策记录
- ✅ skill 文本中不再出现 MCP tool 名称（cli-skill 模式）
- ✅ MCP 模式下生成 contextatlas-mcp skill

### Phase 4 - 运行时模式隔离

目标：

- 让运行时行为与 setup mode 保持一致

建议调整文件：

- `src/config.ts`
- `src/index.ts`
- `tests/mcp-stdio.test.ts`

重构要求：

- 仅在 `mcp` 模式下启用隐式 stdio MCP
- `cli-skill` 模式下无参启动始终走 `start` 或 CLI 帮助
- 所有“自动注入 mcp 子命令”的逻辑都受 exposure mode 控制

验收：

- 非 TTY 环境不再无条件进入 MCP
- `mcp` 模式保留现有 stdio 能力
- `cli-skill` 模式下 shell 自动化仍可稳定使用 JSON 命令输出

### Phase 5 - 文档与参考面分离

目标：

- 让用户第一次阅读文档时就能明确看到两种互斥接入方式

建议调整文档：

- `docs/reference/cli.md`
- `docs/reference/mcp.md`
- `docs/guides/deployment.md`
- `docs/guides/first-use.md`
- `README.md`
- `README_ZH.md`
- `docs/README.md`

文档要求：

- 明确区分 `CLI + skills` 与 `MCP` 两条接入路径
- 明确说明各自写入哪些文件
- 明确说明迁移方式与兼容期
- 禁止再用“一键全配好”描述稳定默认行为

验收：

- 新用户可在 5 分钟内判断自己该选哪种模式
- CLI 文档不再默认要求 MCP
- MCP 文档不再隐含 skill 依赖

### Phase 6 - 兼容层收口与清理

目标：

- 在完成迁移后收口旧混搭入口

建议处理：

- 为旧 `setup:local` 无 mode 用法提供一个版本周期的兼容提示
- 为旧 `contextatlas-mcp` skill 给出废弃说明或按模式重生成
- 评估是否保留 `hybrid` 兼容模式作为隐藏开关

建议不做：

- 长期保留“默认混搭”作为第三稳定模式

验收：

- 代码中不存在新的默认混搭入口
- 兼容逻辑可追踪、可删除、可测试

## 测试计划

### 必改测试

- `tests/local-setup.test.ts`
  - 按 mode 拆分断言
- `tests/cli-registration.test.ts`
  - 验证 setup 命令参数或新增命令
- `tests/mcp-stdio.test.ts`
  - 增加 mode 控制下的行为差异
- `tests/codebase-retrieval.test.ts`
  - 验证 MCP adapter 迁移后结果不变

### 建议新增测试

- `tests/setup-cli-skill.test.ts`
- `tests/setup-mcp.test.ts`
- `tests/cli-search-usecase.test.ts`
- `tests/exposure-mode-config.test.ts`

### 验证命令

```bash
pnpm test
pnpm test:mcp-stdio
pnpm build
```

如果拆出新的 application/use case 层，建议补一组 source-level 单元测试，避免后续 CLI 与 MCP 在结果整形上再次分叉。

## 迁移策略

建议分两次发布：

### Release 1

- 引入 application/use case 层
- `setup:local` 支持显式 `--mode`
- 默认无 mode 时给 warning，但仍可兼容旧行为

### Release 2

- 默认要求 mode
- 移除或隐藏混搭默认行为
- 文档全面切换到双模式表述

这样可以避免一次性打断已有 MCP 用户，同时为 `cli-skill` 模式留出验证窗口。

## 风险

### 风险 1

CLI 与 MCP 从同一 handler 分离后，结果卡片可能出现轻微漂移。

缓解：

- 先抽 use case，再让两个 adapter 共同消费
- 对检索结果文本与 JSON 结构做快照测试

### 风险 2

setup 文件集合拆分后，旧用户本地环境可能遗留多余配置。

缓解：

- 在 setup report 中显式列出“本模式未管理的旧文件”
- 文档中提供清理指引

### 风险 3

禁用隐式 MCP 后，某些现有自动化或客户端启动方式会失效。

缓解：

- 通过 mode 控制而不是全局删除
- 给 `mcp` 模式保留现有行为

## 完成定义

当满足以下条件时，可认为本重构完成：

- CLI 与 MCP 共享 application/use case，而不是互相依赖
- 用户可明确选择 `cli-skill` 或 `mcp`
- setup、skill、prompt、运行时行为与所选模式一致
- 文档与测试不再把混搭路径当作默认方案
- 兼容层被限制在可删除的过渡边界内

## 推荐执行顺序

1. 先做 Phase 1，抽 use case，解除 CLI 对 MCP handler 的依赖。
2. 再做 Phase 2 和 Phase 3，拆 setup 与 skill 生成。
3. 然后做 Phase 4，收口运行时隐式 MCP。
4. 最后做 Phase 5 和 Phase 6，完成文档切换与兼容层清理。

不要先删 MCP，也不要先改文档。先把 adapter 边界理顺，否则文档和 setup 只会反复改。
