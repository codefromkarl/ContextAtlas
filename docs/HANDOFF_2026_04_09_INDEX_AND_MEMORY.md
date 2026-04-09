# Handoff Summary (2026-04-09)

## Current Status

- workstream goal completed
- acceptance probe: `0`
- `pnpm build`: passed
- `pnpm test`: `268/268` passed
- latest verification checkpoint: `chk_dd4e63fc1634`
- related architecture decision: `2026-04-09-index-update-and-long-term-storage`

## What Changed

### 1. Index update planning

- `index:plan` / `index:update` now expose `strategySignals`
- escalation to `full` can be driven by:
  - changed-file churn
  - estimated incremental/full cost ratio
  - minimum repo/change-size gates
- thresholds are now configurable through:
  - `INDEX_UPDATE_CHURN_THRESHOLD`
  - `INDEX_UPDATE_COST_RATIO_THRESHOLD`
  - `INDEX_UPDATE_MIN_FILES`
  - `INDEX_UPDATE_MIN_CHANGED_FILES`

Primary files:

- `src/config.ts`
- `src/indexing/updateStrategy.ts`

### 2. Long-term memory storage

- long-term memory moved from `project_memory_meta` JSON blobs to:
  - `long_term_memories`
  - `long_term_memories_fts`
- legacy blobs are still readable
- write operations migrate legacy items into the new tables

Primary files:

- `src/memory/MemoryHubDatabase.ts`
- `src/memory/LongTermMemoryService.ts`
- `src/mcp/tools/longTermMemory.ts`

### 3. Runtime hardening

- `MemoryHubDatabase` now resolves the default DB path at construction time
- parent directories are created automatically
- this fixes `HOME` / `CONTEXTATLAS_BASE_DIR` path fragility

Primary file:

- `src/memory/MemoryHubDatabase.ts`

## Docs and Templates Updated

- `README.md`
- `README.EN.md`
- `docs/CLI.md`
- `docs/FIRST_USE.md`
- `docs/DEPLOYMENT.md`
- `docs/UPDATE_2026_04_09.md`
- `docs/ITERATION_6_INDEX_AND_MEMORY_ACCEPTANCE_REPORT_2026_04_09.md`

## Tests Worth Reading

- `tests/index-plan.test.ts`
- `tests/memory-substores.test.ts`
- `tests/profile-governance.test.ts`
- `tests/memory-health.test.ts`
- `tests/memory-hub-database.test.ts`
- `tests/cli-registration.test.ts`

## Resume Commands

```bash
pnpm build
pnpm test
node --import tsx ./.autoresearch/remaining-acceptance-failures.mts
```

## If You Continue From Here

1. Use checkpoint `chk_dd4e63fc1634` as the default resume point.
2. Review decision `2026-04-09-index-update-and-long-term-storage` before changing the storage or escalation model.
3. Prefer extending `strategySignals` into ops / health surfaces rather than adding new hidden heuristics.
