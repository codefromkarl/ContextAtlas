<h1 align="center">ContextAtlas</h1>

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
  <a href="./docs/README.md">Docs Index</a> ·
  <a href="./docs/guides/first-use.md">First Use</a> ·
  <a href="./docs/changelog/2026-04-09.md">2026-04-09 Update</a> ·
  <a href="./docs/archive/deliveries/2026-04-09-index-and-memory/delivery-bundle.md">2026-04-09 Delivery</a> ·
  <a href="./docs/guides/deployment.md">Deployment</a> ·
  <a href="./docs/reference/cli.md">CLI</a> ·
  <a href="./docs/reference/mcp.md">MCP</a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/codefromkarl/ContextAtlas/main/docs/architecture/contextatlas-architecture.png" alt="ContextAtlas architecture" width="900" />
</p>

## Updates

- `2026-04-06`: tightened the default user path, memory governance, and operational visibility to make first use, feedback loops, and health checks clearer.
- `2026-04-07`: improved the indexing pipeline with lighter planning, snapshot copy reduction, queue observability, fallback hardening, and repeatable benchmarks.
- `2026-04-08`: added the embedding gateway, local caching and multi-upstream routing, plus Hugging Face integration and MCP context lifecycle tools.
- `2026-04-09`: added churn / cost-aware index planning, moved long-term memory into dedicated tables + FTS5, and finished default-path hardening, threshold configuration, and doc sync.

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

For a fuller architecture explanation, see [ContextAtlas engineering positioning](./docs/architecture/harness-engineering.md).

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

Product identity mapping:

- Repository: `ContextAtlas`
- npm package: `@codefromkarl/context-atlas`
- CLI command: `contextatlas`

Available commands:

- `contextatlas`
- `cw` (short alias)

The docs use `contextatlas` as the primary command name. `cw` remains as a compatibility alias.

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

Index update planning also supports these optional knobs:

```bash
INDEX_UPDATE_CHURN_THRESHOLD=0.35
INDEX_UPDATE_COST_RATIO_THRESHOLD=0.65
INDEX_UPDATE_MIN_FILES=8
INDEX_UPDATE_MIN_CHANGED_FILES=5
```

- `INDEX_UPDATE_CHURN_THRESHOLD`: when the changed-file ratio crosses this value, `index:plan` / `index:update` will favor `full`
- `INDEX_UPDATE_COST_RATIO_THRESHOLD`: triggers `full` when the estimated incremental cost is close to a full rebuild
- `INDEX_UPDATE_MIN_FILES` / `INDEX_UPDATE_MIN_CHANGED_FILES`: require both repo size and change size to clear a minimum bar before escalation is allowed

> `init` writes an editable example `.env`, including default SiliconFlow endpoints and recommended model settings.

## Quick start

If you are onboarding for the first time, start with the [First use guide](./docs/guides/first-use.md).

### 1) Confirm the default entry flow

```bash
contextatlas start /path/to/repo
```

### 2) Initialize and fill in API settings

```bash
contextatlas init
# edit ~/.contextatlas/.env
```

### 3) Index a repository

```bash
contextatlas index /path/to/repo
```

### 4) Run local retrieval

```bash
contextatlas search \
  --repo-path /path/to/repo \
  --information-request "How is the authentication flow implemented?"
```

### 5) Start the daemon (recommended)

```bash
contextatlas daemon start
```

### 6) Expose it as an MCP server

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
contextatlas search --repo-path /path/to/repo --information-request "Where is the payment retry policy implemented?"

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
3. use `contextatlas search` or MCP tools to retrieve code and memory
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
contextatlas start /path/to/repo
contextatlas index /path/to/repo
contextatlas index --force
contextatlas index:plan /path/to/repo --json
contextatlas index:diagnose --json
contextatlas daemon start
contextatlas search --repo-path /path/to/repo --information-request "Where is the database connection logic?"
```

### Project memory and long-term memory

```bash
contextatlas memory:find "auth"
contextatlas memory:record "Auth Module" --desc "User authentication module" --dir "src/auth"
contextatlas memory:record-long-term --type reference --title "Grafana Dashboard" --summary "Dashboard URL https://grafana.example.com/d/abc123"
contextatlas memory:list
contextatlas memory:prune-long-term --include-stale
contextatlas decision:list
contextatlas profile:show
```

`contextatlas start` now gives the default loop directly: `Connect Repo → Check Index Status → Ask → Review Result → Give Feedback / Save Memory`. Retrieval result cards also surface source hierarchy, freshness/conflict/confidence signals, and concrete follow-up commands.

Index health checks now also show the latest successful indexing time and the latest execution mode for each project, so it is clearer whether a repository is staying healthy through incremental updates or falling back to rebuild-heavy recovery.

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
contextatlas ops:summary
contextatlas ops:metrics --days 7 --stale-days 30
contextatlas health:check
contextatlas index:plan /path/to/repo
contextatlas index:diagnose
contextatlas alert:eval
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

In the current implementation, `SearchService` is mostly an orchestration facade instead of a single all-in-one engine:

- `HybridRecallEngine` handles vector + lexical recall, FTS fallback, and RRF fusion
- `RerankPolicy` owns rerank pool selection and Smart TopK cutoff
- `SnippetExtractor` builds rerank text and hit-centered snippets
- `GraphExpander` and `ContextPacker` still own expansion and packing

### Indexing path

```text
File changes
  → scanner/ detects changes
  → chunking/ semantic chunking
  → indexer/ embedding + vector store write
  → storage/ atomic snapshot switch
  → indexing/ queue state update
```

### Memory path

```text
Feature / Decision / Profile / Long-term write
  → MemoryStore facade
  → bootstrap project initialization and compatibility import
  → focused sub-stores persist and sync data
  → Memory Hub / Router / retrieval tools read it back
```

The current `memory/` boundaries are:

- `MemoryStore` stays as the stable facade for CLI, MCP, and monitoring
- `MemoryStoreBootstrap` handles read-only/writable initialization, project registration, and compatibility import
- `ProjectMetaStore` owns checkpoints, catalog, profile, and global memory
- `FeatureMemoryRepository` and `FeatureMemoryCatalogCoordinator` own feature memory persistence and catalog sync
- `DecisionStore` owns decision-record mapping and persistence
- `LongTermMemoryService` owns append/find/status/prune logic for long-term memory

## Project structure

```text
src/
├── api/                  # Embedding / Rerank / Unicode handling
├── chunking/             # Tree-sitter semantic chunking
├── db/                   # SQLite + FTS + file metadata
├── indexer/              # Vector indexing orchestration
├── indexing/             # Index queue and daemon
├── mcp/                  # MCP server and tool definitions
├── memory/               # MemoryStore facade + bootstrap + sub-stores + cross-project hub
├── monitoring/           # Retrieval monitoring / health / alerts
├── scanner/              # File discovery and incremental scanning
├── search/               # SearchService facade + recall / rerank / snippet / expand / pack submodules
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
| [Docs index](./docs/README.md) | Unified entry for stable docs, plans, changelog, and archived delivery material |
| [First use guide](./docs/guides/first-use.md) | Fast onboarding path for the default `contextatlas` loop |
| [2026-04-06 update summary](./docs/changelog/2026-04-06.md) | Summary of the new main path, memory governance, operations, release gate, and team metrics |
| [2026-04-07 update summary](./docs/changelog/2026-04-07.md) | Summary of the seven indexing phases covering lightweight planning, snapshot copy reduction, health repair, observability, fallback hardening, storage trimming, and benchmarks |
| [Deployment guide](./docs/guides/deployment.md) | Installation, deployment patterns, MCP integration, operations |
| [CLI reference](./docs/reference/cli.md) | CLI commands, categories, and examples |
| [MCP reference](./docs/reference/mcp.md) | MCP tools, parameters, and calling patterns |
| [Project memory guide](./docs/project/project-memory.md) | Feature Memory, Decision Record, and Catalog routing |
| [Repository positioning](./docs/architecture/repository-positioning.md) | Repository role, design thinking, and system boundaries |
| [Engineering positioning](./docs/architecture/harness-engineering.md) | Where ContextAtlas fits in harness engineering |
| [Product roadmap](./docs/product/roadmap.md) | Future versions and product direction |

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
