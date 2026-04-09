# Merge Checklist (2026-04-09)

## Before Merge

- confirm acceptance probe still prints `0`
- confirm `pnpm build` passes
- confirm `pnpm test` passes
- skim the latest delivery docs:
  - `docs/archive/deliveries/2026-04-09-index-and-memory/pr-summary.md`
  - `docs/archive/deliveries/2026-04-09-index-and-memory/release-note.md`
  - `docs/archive/deliveries/2026-04-09-index-and-memory/handoff.md`

## Key References

- checkpoint: `chk_dd4e63fc1634`
- decision: `2026-04-09-index-update-and-long-term-storage`
- delivery index: `docs/archive/deliveries/2026-04-09-index-and-memory/delivery-bundle.md`

## Suggested Verification Commands

```bash
pnpm verify:delivery:artifacts
node --import tsx ./.autoresearch/remaining-acceptance-failures.mts
pnpm build
pnpm test
```

## Suggested Commit Subject

```text
feat: add configurable index escalation and migrate long-term memory storage
```

## Suggested PR Focus

1. index update planning now exposes configurable churn / cost escalation signals
2. long-term memory now lives in dedicated SQLite tables with FTS5 and legacy write-time migration
3. delivery surface is fully synced across templates, docs, checkpoint, handoff, and release artifacts
