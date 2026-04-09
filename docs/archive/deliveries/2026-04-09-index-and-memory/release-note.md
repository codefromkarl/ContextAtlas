# Release Note Draft (2026-04-09)

## Highlights

- Added churn / cost-aware escalation to `index:plan` and `index:update`
- Moved long-term memory storage from project-meta JSON blobs into dedicated SQLite tables with FTS5
- Hardened memory-hub default path resolution and parent-directory creation
- Exposed `INDEX_UPDATE_*` knobs through config, templates, and docs

## Details

### Index planning

`index:plan` and `index:update` now surface `strategySignals`, including changed-file churn, estimated incremental/full cost ratio, and the triggers that explain why the planner recommends `incremental` or `full`.

### Long-term memory

Long-term memory now persists into `long_term_memories` and `long_term_memories_fts`. Legacy `global:<type>` blobs remain readable and are migrated into the new tables on write.

### Runtime reliability

`MemoryHubDatabase` now resolves its default database path at construction time and automatically creates parent directories, reducing failures in dynamic `HOME` / `CONTEXTATLAS_BASE_DIR` environments.

### Configuration

The following environment variables are now available for index escalation tuning:

- `INDEX_UPDATE_CHURN_THRESHOLD`
- `INDEX_UPDATE_COST_RATIO_THRESHOLD`
- `INDEX_UPDATE_MIN_FILES`
- `INDEX_UPDATE_MIN_CHANGED_FILES`

## Validation

- acceptance probe: `0`
- `pnpm build`: passed
- `pnpm test`: `268/268` passed
