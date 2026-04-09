# Team Update Message (2026-04-09)

可直接复制给团队的简版通知：

```text
ContextAtlas 这轮关于 index:update / 长期记忆治理的收口已经完成。

本次主要结果：
1. index:plan / index:update 现在会显式给出 churn / cost 策略信号，并在高 churn 或高增量成本时升级为 full rebuild。
2. 长期记忆已从 project-meta JSON blob 迁到独立 SQLite 表 + FTS5，legacy blob 仍可读，写入时会自动迁移。
3. MemoryHubDatabase 默认路径改成运行时动态解析，并自动创建父目录，修复了 HOME / CONTEXTATLAS_BASE_DIR 场景下的路径问题。
4. INDEX_UPDATE_* 阈值已经外置成环境变量，并同步到 init 模板、README、CLI、FIRST_USE、DEPLOYMENT。

当前验证结果：
- acceptance probe = 0
- pnpm build 通过
- pnpm test = 268/268 通过

相关文档：
- 更新总结：docs/changelog/2026-04-09.md
- 验收报告：docs/archive/iterations/2026-04-09/iteration-6-index-and-memory-acceptance-report.md
- 交接摘要：docs/archive/deliveries/2026-04-09-index-and-memory/handoff.md
- PR 摘要：docs/archive/deliveries/2026-04-09-index-and-memory/pr-summary.md

相关 checkpoint：
- chk_dd4e63fc1634

相关 decision：
- 2026-04-09-index-update-and-long-term-storage
```
