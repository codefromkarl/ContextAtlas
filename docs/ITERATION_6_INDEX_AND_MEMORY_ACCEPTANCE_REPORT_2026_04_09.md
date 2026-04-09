# Iteration 6 Acceptance Report (2026-04-09)

## Goal

Validate the 2026-04-09 workstream that:

- adds churn / cost-aware escalation to `index:plan` / `index:update`
- migrates long-term memory into dedicated SQLite tables + FTS5
- hardens runtime path resolution for the memory hub
- externalizes index escalation thresholds into environment config

## Scope

- `src/config.ts`
- `src/indexing/updateStrategy.ts`
- `src/memory/MemoryHubDatabase.ts`
- `src/memory/LongTermMemoryService.ts`
- `src/mcp/tools/longTermMemory.ts`
- `src/monitoring/indexBenchmark.ts`
- `src/cli/commands/bootstrap.ts`
- `README.md`
- `README.EN.md`
- `docs/CLI.md`
- `docs/FIRST_USE.md`
- `docs/DEPLOYMENT.md`
- `docs/UPDATE_2026_04_09.md`

## Acceptance Checks

### 1. Goal-level acceptance probe

Command:

```bash
node --import tsx ./.autoresearch/remaining-acceptance-failures.mts
```

Expected:

- output is `0`

Observed:

- `0`

### 2. Build verification

Command:

```bash
pnpm build
```

Expected:

- build succeeds

Observed:

- passed

### 3. Full regression suite

Command:

```bash
pnpm test
```

Expected:

- full repository test suite stays green

Observed:

- `268/268` passed

## Notable Verified Behaviors

- `index:plan --json` now exposes `strategySignals`
- high churn / high estimated incremental cost can escalate to `full`
- `INDEX_UPDATE_*` env vars can tune escalation behavior without source edits
- long-term memory now persists into `long_term_memories` + `long_term_memories_fts`
- legacy `global:<type>` blobs are still readable and are migrated on write
- memory hub default DB path is resolved at construction time and parent directories are created automatically

## Key Regression Locks Added

- high churn escalation test
- configurable threshold behavior test
- legacy long-term memory migration + FTS test
- memory health no-double-count migration test
- memory hub default-path runtime resolution test

## Delivery State

- code changes complete
- tests complete
- docs synced
- decision recorded: `2026-04-09-index-update-and-long-term-storage`
- latest verification checkpoint: `chk_dd4e63fc1634`
