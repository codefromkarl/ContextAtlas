# ContextAtlas

<p align="center">
  <strong>Stable, reusable, and observable code context infrastructure for AI agents</strong>
</p>

<p align="center">
  <em>Hybrid Retrieval · Project Memory · MCP Server · Retrieval Observability</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node >=20" />
  <img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript 5.x" />
  <img src="https://img.shields.io/badge/MCP-Server-6C47FF?style=flat-square" alt="MCP Server" />
  <img src="https://img.shields.io/github/license/codefromkarl/ContextAtlas?style=flat-square" alt="License" />
  <img src="https://img.shields.io/github/stars/codefromkarl/ContextAtlas?style=flat-square" alt="GitHub stars" />
</p>

<p align="center">
  <a href="./README.md">简体中文</a> ·
  <a href="./docs/DEPLOYMENT.md">Deployment</a> ·
  <a href="./docs/CLI.md">CLI</a> ·
  <a href="./docs/MCP.md">MCP</a>
</p>

<p align="center">
  <img src="./docs/architecture.png" alt="ContextAtlas architecture" width="900" />
</p>

## Contents

- [Why ContextAtlas](#why-contextatlas)
- [Where it fits](#where-it-fits)
- [Core capabilities](#core-capabilities)
- [Quick highlights](#quick-highlights)
- [Positioning](#positioning)
- [Tech stack](#tech-stack)
- [Installation](#installation)
- [Configuration](#configuration)
- [Quick start](#quick-start)
- [Integration modes](#integration-modes)
- [Usage flow](#usage-flow)
- [Common commands](#common-commands)
- [Architecture overview](#architecture-overview)
- [Project structure](#project-structure)
- [Notes](#notes)
- [Current limitations](#current-limitations)
- [Documentation map](#documentation-map)
- [Contributing](#contributing)
- [Development](#development)
- [Friendly links](#friendly-links)
- [License](#license)

ContextAtlas is not just a code search tool. It addresses a more practical engineering problem:

- can an agent find the right code faster in a large repository?
- can repository understanding be persisted instead of rediscovered every session?
- can retrieval, indexing, and memory quality be observed and improved over time?

If you are building Claude Code workflows, MCP clients, or custom agent systems, ContextAtlas provides a **context infrastructure layer**: retrieval, memory, context packing, and observability.

## Why ContextAtlas

In real projects, agent failures are often not caused by a weak model. They come from weak context systems:

- the relevant code is not found
- the returned code is too fragmented and lacks surrounding context
- the same module has to be re-understood again and again
- indexes become stale, retrieval quality degrades, and token budgets get exhausted without clear signals

ContextAtlas turns this into a composable set of capabilities:

- **Find**: hybrid retrieval narrows down the relevant implementation
- **Expand**: graph expansion and token packing turn hits into usable local context
- **Store**: project memory, long-term memory, and a cross-project hub preserve knowledge
- **Observe**: health checks, telemetry, usage analysis, and alerts make the system diagnosable

## Where it fits

- As a repository retrieval backend for coding agents
- As an MCP server for external clients that need code retrieval and memory tools
- As a local CLI / skill backend for scripts, CI, and workflow automation
- As a cross-project knowledge layer for reusable module knowledge and decision history

## Core capabilities

| Capability | Description |
|------|------|
| **Hybrid Retrieval** | Vector recall + FTS lexical recall + RRF fusion + rerank |
| **Context Expansion** | Local context expansion based on neighbors, breadcrumbs, and imports |
| **Token-aware Packing** | Keeps the highest-value context inside a limited token budget |
| **Project Memory** | Feature Memory, Decision Record, and Project Profile |
| **Long-term Memory** | Rules, preferences, and external references that cannot be derived reliably from code |
| **Cross-project Hub** | Reuse module memories, dependency chains, and relations across repositories |
| **Async Indexing** | SQLite queue + daemon consumer + atomic snapshot switch |
| **Observability** | Retrieval monitor, usage report, index health, memory health, and alert evaluation |

## Quick highlights

### 1. It does more than search code

ContextAtlas does not aim to return “the most similar snippet.” It assembles a usable context pack through:

- vector recall
- FTS recall
- RRF fusion
- rerank
- graph expansion
- token-aware packing

### 2. Repository understanding can be persisted

In addition to retrieval, ContextAtlas supports:

- Feature Memory: module responsibilities, files, dependencies, and data flow
- Decision Record: architecture decisions and rationale
- Project Profile: tech stack, structure, and conventions
- Long-term Memory: preferences, rules, and external references

### 3. The retrieval system itself is observable

You can inspect more than just search results:

- whether the index is healthy
- whether retrieval quality is degrading
- whether long-term memories are stale or expired
- whether usage patterns suggest a rebuild or incremental indexing

### 4. It works both as CLI and MCP Server

The same capabilities can be used:

- directly from local shell commands, scripts, and skills
- through MCP tools in Claude Desktop or other MCP clients

## Positioning

**ContextAtlas is a context infrastructure layer for AI agents.**

It answers this question:

> When an upstream agent starts working, how can it reliably get high-value, low-noise, reusable code context and repository knowledge?

It does **not** handle:

- agent reasoning itself
- workflow orchestration / planning
- full verification harness responsibilities
- browser, terminal, or business API actions

In short, ContextAtlas decides **what context to provide**, not **how the task should be executed**.

For a fuller architecture explanation, see [ContextAtlas engineering positioning](./docs/ContextAtlas-Harness-Engineering.md).

## Tech stack

- **TypeScript / Node.js 20+**
- **Tree-sitter** for semantic chunking
- **SQLite + FTS5** for metadata, retrieval, queues, and memory hub storage
- **LanceDB** for vector storage
- **Model Context Protocol SDK** for MCP integration

## Installation

```bash
npm install -g @codefromkarl/context-atlas
```

Available commands:

- `contextatlas`
- `cw` (short alias)

## Configuration

Initialize the config directory and example environment file first:

```bash
contextatlas init
```

Default config file location:

```bash
~/.contextatlas/.env
```

Minimum required configuration:

```bash
EMBEDDINGS_API_KEY=
EMBEDDINGS_BASE_URL=
EMBEDDINGS_MODEL=

RERANK_API_KEY=
RERANK_BASE_URL=
RERANK_MODEL=
```

> `init` writes an editable example `.env`, including default SiliconFlow endpoints and recommended model settings.

## Quick start

### 1) Initialize and fill in API settings

```bash
contextatlas init
# edit ~/.contextatlas/.env
```

### 2) Index a repository

```bash
contextatlas index /path/to/repo
```

### 3) Run local retrieval

```bash
cw search \
  --repo-path /path/to/repo \
  --information-request "How is the authentication flow implemented?"
```

### 4) Start the daemon (recommended)

```bash
contextatlas daemon start
```

### 5) Expose it as an MCP server

```bash
contextatlas mcp
```

## Integration modes

### 1. As a local CLI / skill backend

Useful for:

- custom agent skills
- shell workflows and CI scripts
- local debugging and retrieval analysis

Example:

```bash
# retrieval
cw search --repo-path /path/to/repo --information-request "Where is the payment retry policy implemented?"

# project memory
contextatlas memory:find "search"
contextatlas decision:list

# health
contextatlas health:full
```

### 2. As an MCP server

Useful for:

- desktop clients that support MCP
- agent systems that need standard tool-based access to ContextAtlas capabilities

Claude Desktop configuration example:

```json
{
  "mcpServers": {
    "contextatlas": {
      "command": "contextatlas",
      "args": ["mcp"]
    }
  }
}
```

ContextAtlas MCP tools cover:

- code retrieval
- project memory
- long-term memory
- cross-project hub operations
- auto-recording and memory suggestion flows

## Usage flow

```text
1. init
   ↓
2. index
   ↓
3. search / MCP retrieval
   ↓
4. understand code and dependencies
   ↓
5. record project memory / long-term memory (optional)
   ↓
6. continuously observe health / monitor / usage signals
```

A typical workflow looks like this:

1. run `contextatlas init`
2. run `contextatlas index /path/to/repo`
3. use `cw search` or MCP tools to retrieve code and memory
4. record stable module knowledge, decisions, or long-term memory after the task
5. periodically run `health:full`, `monitor:retrieval`, `usage:index-report`, and `memory:health`

### Recommended CLAUDE.md startup rules

If you use ContextAtlas inside Claude Code or other session-based agent workflows, add a rule like this to `CLAUDE.md`:

```md
At the beginning of every conversation:
1. Query project memory first (for example via `project-memory-hub` / `memory-load` / `find_memory`)
2. Immediately run repository indexing (`contextatlas index /path/to/repo`)
3. Only then start retrieval, analysis, and implementation
```

Why this helps:

- it loads existing project knowledge before broad exploration
- it reduces the chance of working against stale retrieval data after repository changes
- it makes later planning and implementation depend on fresher context

## Common commands

### Retrieval and indexing

```bash
contextatlas index /path/to/repo
contextatlas index --force
contextatlas daemon start
cw search --repo-path /path/to/repo --information-request "Where is the database connection logic?"
```

### Project memory and long-term memory

```bash
contextatlas memory:find "auth"
contextatlas memory:record "Auth Module" --desc "User authentication module" --dir "src/auth"
contextatlas memory:list
contextatlas memory:prune-long-term --include-stale
contextatlas decision:list
contextatlas profile:show
```

### Cross-project hub

```bash
contextatlas hub:list-projects
contextatlas hub:search --category search
contextatlas hub:deps <projectId> <moduleName>
```

### Observability and operations

```bash
contextatlas monitor:retrieval --days 7
contextatlas usage:index-report --days 7
contextatlas health:check
contextatlas memory:health
contextatlas health:full
contextatlas alert:eval
contextatlas usage:purge --days 90 --apply
```

## Architecture overview

### Retrieval path

```text
User question
  → vector recall
  → FTS lexical recall
  → RRF fusion
  → rerank
  → graph expansion
  → token-aware packing
  → structured context output
```

### Indexing path

```text
File changes
  → scanner/ detects changes
  → chunking/ semantic chunking
  → indexer/ embedding + vector store write
  → storage/ atomic snapshot switch
  → indexing/ queue state update
```

## Project structure

```text
src/
├── api/                  # Embedding / Rerank / Unicode handling
├── chunking/             # Tree-sitter semantic chunking
├── db/                   # SQLite + FTS + file metadata
├── indexer/              # Vector indexing orchestration
├── indexing/             # Index queue and daemon
├── mcp/                  # MCP server and tool definitions
├── memory/               # Project memory / long-term memory / cross-project hub
├── monitoring/           # Retrieval monitoring / health / alerts
├── scanner/              # File discovery and incremental scanning
├── search/               # SearchService / GraphExpander / ContextPacker
├── storage/              # Snapshot layout and atomic switching
├── usage/                # Usage tracking and optimization analysis
└── vectorStore/          # LanceDB vector storage
```

## Notes

- **The first full index may take time**: index once, then keep incremental updates warm with the daemon
- **Do not store code-derivable facts in long-term memory**: use it for rules, preferences, external references, and non-code state
- **MCP and CLI are complementary**: MCP is better for tool integration, CLI is better for scripts, skills, and manual debugging
- **Make health checks routine**: when results get worse, check index, memory, and retrieval metrics before blaming the model

## Current limitations

- no multi-tenant or permission isolation yet
- memory write quality still depends on upstream workflow discipline
- no conflict detection in the cross-project hub yet
- automatic incremental indexing still relies on the daemon or external scheduling
- no unified confidence score interface for retrieval results yet

## Documentation map

| Document | Purpose |
|------|------|
| [Deployment guide](./docs/DEPLOYMENT.md) | Installation, deployment patterns, MCP integration, operations |
| [CLI reference](./docs/CLI.md) | CLI commands, categories, and examples |
| [MCP reference](./docs/MCP.md) | MCP tools, parameters, and calling patterns |
| [Project memory guide](./PROJECT_MEMORY.md) | Feature Memory, Decision Record, and Catalog routing |
| [Repository positioning](./docs/REPOSITORY_POSITIONING.md) | Repository role, design thinking, and system boundaries |
| [Engineering positioning](./docs/ContextAtlas-Harness-Engineering.md) | Where ContextAtlas fits in harness engineering |
| [Product roadmap](./PRODUCT_EVOLUTION_ROADMAP.md) | Future versions and product direction |

## Contributing

Ways to improve ContextAtlas:

- open issues for bugs or documentation gaps
- submit PRs for retrieval, memory, monitoring, or documentation improvements
- contribute real-world usage patterns, deployment notes, and benchmark data
- improve README, CLI docs, and MCP examples

Before submitting code, it helps to:

1. run `pnpm build` and make sure the repo still builds
2. keep command examples, README, and docs aligned with the implementation
3. update functionality, documentation, and operational notes together when possible

## Development

```bash
pnpm build
pnpm build:release
pnpm dev
node dist/index.js
```

## Friendly links

https://linux.do/

## License

MIT
