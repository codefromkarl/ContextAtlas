# PR Summary (2026-04-09)

## Background

This change set closes a focused reliability and governance workstream across indexing and memory:

- make `index:plan` / `index:update` explainable when they escalate from incremental work to full rebuilds
- move long-term memory out of opaque project-meta JSON blobs into dedicated SQLite tables with FTS5
- harden runtime path resolution for the memory hub
- expose the new tuning knobs through config, templates, and docs

## Main Changes

### 1. Index update planning

- added `strategySignals` to `analyzeIndexUpdatePlan()`
- full rebuild escalation can now be triggered by:
  - churn ratio
  - estimated incremental/full cost ratio
  - minimum repo / change-size gates
- the thresholds are configurable through:
  - `INDEX_UPDATE_CHURN_THRESHOLD`
  - `INDEX_UPDATE_COST_RATIO_THRESHOLD`
  - `INDEX_UPDATE_MIN_FILES`
  - `INDEX_UPDATE_MIN_CHANGED_FILES`

### 2. Long-term memory storage

- migrated long-term memory persistence into:
  - `long_term_memories`
  - `long_term_memories_fts`
- kept legacy blob read compatibility
- write operations now migrate legacy items into the new tables

### 3. Runtime hardening

- `MemoryHubDatabase` now resolves its default DB path at construction time
- parent directories are created automatically
- this removes a class of `HOME` / `CONTEXTATLAS_BASE_DIR` path failures

### 4. Delivery surface

- updated init template and env docs
- synced README / README.EN / CLI / FIRST_USE / DEPLOYMENT docs
- added:
  - update summary
  - acceptance report
  - handoff summary
  - architecture decision record

## Verification

Commands verified during the run:

```bash
node --import tsx ./.autoresearch/remaining-acceptance-failures.mts
pnpm build
pnpm test
```

Observed result:

- acceptance probe: `0`
- build: passed
- tests: `268/268` passed

## Follow-up

If we continue this line of work later, the most natural next steps are:

1. surface `strategySignals` inside ops / health summaries
2. show effective `INDEX_UPDATE_*` values in CLI diagnostics
3. continue expanding long-term-memory governance metrics for team dashboards
