# Iteration 1 验收报告（2026-04-08）

本文档用于记录 `Iteration 1` 的验收证据，覆盖：

- 首次接入闭环
- 结果卡片结构
- 冷启动降级体验
- 产品身份统一

---

## 一、验收范围

本次验收对应：

- `docs/ROADMAP_CHECKLIST.md` 中 `Phase A / P0 验收标准`
- `docs/NEXT_TASKS_EXECUTION_CHECKLIST.md` 中 `P0`
- `docs/ITERATION_PLAN_2026_04_08.md` 中 `Iteration 1`

---

## 二、验证命令

本轮执行的验证命令：

```bash
pnpm test -- --test-name-pattern "buildStartGuide|handleCodebaseRetrieval"
```

实际结果：

- 命令成功退出
- Node test 实际运行了整套测试集
- `249 passed`
- `0 failed`

说明：

- 虽然命令名义上只想聚焦 `buildStartGuide` 与 `handleCodebaseRetrieval`
- 但实际运行结果比预期更强，直接覆盖了整套测试
- 因此本轮可把该结果视为强于局部 smoke 的新鲜验证证据

---

## 三、验收结论

### 1. 首次接入闭环

判定：通过。

依据：

- `docs/FIRST_USE.md` 已将默认路径压缩为：
  - `Connect Repo`
  - `Check Index Status`
  - `Ask`
  - `Review Result`
  - `Give Feedback / Save Memory`
- `src/workflow/start.ts` 直接输出默认闭环、当前模式和下一步动作。
- `tests/workflow-start.test.ts` 覆盖了：
  - 已索引场景
  - 未索引首次使用场景
  - 正在索引场景
  - 交互式无参数入口场景

补充说明：

- “10 分钟”这一项这里按工程验收口径关闭。
- 证据来自默认路径长度、直接命令提示、首次使用文档和自动化测试。
- 这不等同于正式的外部可用性研究，但对当前仓库阶段已经足够作为工程验收依据。

### 2. 结果卡片结构固定

判定：通过。

依据：

- `src/mcp/tools/codebaseRetrieval.ts` 的 text 响应明确固定了以下区域：
  - 代码命中
  - 相关模块记忆
  - 相关决策记录
  - 相关长期记忆
  - 近期反馈信号
  - 跨项目参考
  - 来源层级与可信规则
  - 下一步动作
  - 为什么命中这些结果
- `tests/codebase-retrieval.test.ts` 已显式断言这些结构存在。
- 同文件还覆盖了 `response_format=json` 与 `response_mode=overview` 两种主路径变体。

### 3. 冷启动降级体验

判定：通过。

依据：

- `src/workflow/start.ts` 在未建索引和索引进行中两种状态下都明确提示：
  - 当前仅提供部分词法结果
  - 完整模式将在索引完成后自动可用
- `tests/workflow-start.test.ts` 对这些提示做了断言。
- `tests/codebase-retrieval.test.ts` 包含：
  - `handleCodebaseRetrieval returns lexical fallback when project is not indexed`
  - `handleCodebaseRetrieval enqueues indexing and still returns lexical fallback`

这说明系统在冷启动阶段不是“不可用”，而是“降级可用”。

### 4. 产品身份统一

判定：通过。

依据：

- `package.json`
  - npm 包名：`@codefromkarl/context-atlas`
  - CLI 主命令：`contextatlas`
  - 兼容短别名：`cw`
- `README.md`、`README.EN.md`、`docs/FIRST_USE.md`、`docs/CLI.md`、`docs/DEPLOYMENT.md` 均已统一使用 `contextatlas` 作为主命令名。
- `.github/workflows/release.yml` 中的安装说明、发布包名和运行示例也已统一为：
  - `npm install -g @codefromkarl/context-atlas`
  - `contextatlas start /path/to/repo`
  - `contextatlas mcp`
- 仓库名、repository、homepage 也与 `ContextAtlas` 对齐。
- 仓库内检索未发现 `CodeWeaver`、`ContextWeaver` 等旧品牌残留。

说明：

- `cw` 仍然保留为兼容短别名。
- 这不构成身份冲突，因为文档主路径已统一使用 `contextatlas`。

---

## 四、对应状态更新建议

建议将下面这些状态正式关闭：

1. `docs/ROADMAP_CHECKLIST.md`
   - `评估是否继续收大模块`
   - `P0 验收标准` 下 4 个未勾选项

2. `docs/NEXT_TASKS_EXECUTION_CHECKLIST.md`
   - `P0` 全部条目

3. `docs/ITERATION_PLAN_2026_04_08.md`
   - `Iteration 1` 的工作项、交付物和退出标准

---

## 五、结论

`Iteration 1` 可以按“已完成”处理。

本轮更适合进入下一阶段，也就是：

- 团队记忆分层
- 组织级只读 profile
- decision reviewer / owner 治理
- Cross-project Hub 权限与来源边界
