# ContextAtlas Domain Vocabulary

## Core Pipeline

- **Recall** — 混合召回：向量 + 词法 + skeleton + graph 四路并发召回原始候选
- **Rerank** — 精排：对召回候选做 cross-encoder 重排
- **Expand** — 上下文扩展：从 seed chunks 补充邻居、面包屑、跨文件引用
- **Pack** — 上下文打包：合并 chunks → 按文件聚合段落 → Token 预算裁剪

## Memory

- **FeatureMemory** — 模块记忆：记录模块职责、API、数据流
- **DecisionRecord** — 决策记录：记录架构决策
- **LongTermMemory** — 长期记忆：无法从代码推导的事实（用户偏好、纠正、项目状态）
- **MemoryCatalog** — 路由索引：轻量索引，用于按需加载模块记忆
- **MemoryRouter** — 渐进式记忆路由器：catalog → global → feature 三层加载
- **MemoryStore** — 项目记忆 facade：协调 feature/project-meta/decision/long-term 四类子存储
- **MemorySession** — 已完成初始化的记忆会话（候选概念，待实现）

## Retrieval

- **ContextPack** — 检索输出包：seeds + expanded + files + debug info
- **ResultCard** — 检索结果卡片：排名 + 上下文块 + 记忆匹配 + 格式化
- **QueryIntent** — 查询意图：balanced / architecture / symbol_lookup
- **LexicalStrategy** — 词法策略：chunks_fts / files_fts / none

## Assembly

- **AssemblyProfile** — 装配配置：overview / debug / implementation / verification / handoff
- **ContextBlock** — 上下文块：类型化、优先级、来源追踪的结构化上下文单元
- **WakeupLayers** — 唤醒层：分层展示上下文块，从关键到辅助
- **Checkpoint** — 任务检查点：保存/恢复 Agent 工作状态

## Infrastructure

- **MemoryStoreProvider** — 记忆存储提供者：统一创建/缓存 MemoryStore 实例（候选概念）
- **IntentPostProcessor** — 意图后处理器：按 QueryIntent 应用不同的后处理策略（候选概念）
