# 首次使用

面向第一次接入 ContextAtlas 的用户，目标是在几分钟内选择接入模式并跑通闭环。

## 第一步：选择接入模式

ContextAtlas 提供两种互斥接入模式：

- **cli-skill**：通过终端命令行和 agent skill 集成，适合本地开发和脚本自动化
- **mcp**：通过 MCP 协议接入 Claude Desktop、Cursor 等 MCP 客户端

两种模式的 setup 互斥——选择一种后，`setup:local` 只会写入对应模式的配置文件。

## cli-skill 路径

### 1. 安装

```bash
npm install -g @codefromkarl/context-atlas
```

### 2. 初始化配置

```bash
contextatlas init
contextatlas setup:local --mode cli-skill
contextatlas health:full
```

写入文件：`~/.contextatlas/.env`、prompt docs（CLAUDE.md、AGENTS.md、GEMINI.md）、Codex CLI skill

不写入：MCP 配置文件

### 3. 配置 API 密钥

编辑 `~/.contextatlas/.env` 填入 Embedding 和 Rerank 的 API 密钥。

### 4. 索引代码库

```bash
contextatlas index /path/to/your/project
```

### 5. 搜索

```bash
contextatlas search --repo-path /path/to/project --information-request "你的问题"
```

`health:full` 是 setup 后的推荐自检入口，会汇总索引、记忆、图谱、契约和 MCP 进程状态。

## mcp 路径

### 1. 安装

```bash
npm install -g @codefromkarl/context-atlas
```

### 2. 初始化配置

```bash
contextatlas init
contextatlas setup:local --mode mcp
```

写入文件：`~/.contextatlas/.env`、MCP 客户端配置（Claude Desktop、Cursor、Gemini、Codex）、prompt docs、Codex MCP skill

如果只需要只读能力，可使用：

```bash
contextatlas setup:local --mode mcp --toolset retrieval-only
```

该模式仅暴露只读检索、图谱、契约和记忆读取工具，降低 MCP 客户端的工具选择负担。

如果是从旧版升级，先用 CLI 完成迁移检查：`contextatlas health:graph` 检查旧 graph schema，`contextatlas health:full` 汇总索引、记忆、图谱、契约和 MCP 状态。`retrieval-only` 不包含索引重建、长期记忆写入或 memory hub 修复入口。

### 3. 配置 API 密钥

编辑 `~/.contextatlas/.env` 或在 MCP 客户端配置中通过 `env` 字段传递。

### 4. 重启 MCP 客户端

确认工具列表中出现 ContextAtlas 的工具。

重启后建议运行或触发一次 `contextatlas health:full`，确认本地配置和运行时状态正常。

### 5. 在对话中使用

直接在 MCP 客户端中使用 `find_memory`、`codebase-retrieval` 等工具。

## 更多参考

- [CLI 命令参考](../reference/cli.md)
- [MCP 工具参考](../reference/mcp.md)
- [部署手册](./deployment.md)
