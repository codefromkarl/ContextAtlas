## Summary

- add configurable churn / cost-based escalation for `index:plan` and `index:update`
- migrate long-term memory persistence from project-meta JSON blobs into dedicated SQLite tables + FTS5
- harden default memory-hub path resolution and parent-directory creation
- sync templates, docs, acceptance, handoff, and delivery artifacts

## Main Changes

### Index planning

- expose `strategySignals` in index planning output
- support escalation via:
  - `INDEX_UPDATE_CHURN_THRESHOLD`
  - `INDEX_UPDATE_COST_RATIO_THRESHOLD`
  - `INDEX_UPDATE_MIN_FILES`
  - `INDEX_UPDATE_MIN_CHANGED_FILES`

### Long-term memory

- add `long_term_memories`
- add `long_term_memories_fts`
- preserve legacy blob reads
- migrate legacy long-term memory on write

### Runtime hardening

- resolve default memory hub DB path at construction time
- auto-create parent directories for the default DB path

## Verification

```bash
node --import tsx ./.autoresearch/remaining-acceptance-failures.mts
pnpm build
pnpm test
```

Observed:

- acceptance probe: `0`
- build: passed
- tests: `268/268` passed

## Related Docs

- `docs/UPDATE_2026_04_09.md`
- `docs/ITERATION_6_INDEX_AND_MEMORY_ACCEPTANCE_REPORT_2026_04_09.md`
- `docs/HANDOFF_2026_04_09_INDEX_AND_MEMORY.md`
- `docs/DELIVERY_BUNDLE_2026_04_09_INDEX_AND_MEMORY.md`
