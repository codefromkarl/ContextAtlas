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

### 3. 配置 API 密钥

编辑 `~/.contextatlas/.env` 或在 MCP 客户端配置中通过 `env` 字段传递。

### 4. 重启 MCP 客户端

确认工具列表中出现 ContextAtlas 的工具。

### 5. 在对话中使用

直接在 MCP 客户端中使用 `find_memory`、`codebase-retrieval` 等工具。

## 更多参考

- [CLI 命令参考](../reference/cli.md)
- [MCP 工具参考](../reference/mcp.md)
- [部署手册](./deployment.md)
