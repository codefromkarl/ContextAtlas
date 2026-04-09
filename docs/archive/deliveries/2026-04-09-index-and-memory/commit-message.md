# Commit Message Draft (2026-04-09)

## Suggested Subject

```text
feat: add configurable index escalation and migrate long-term memory storage
```

## Suggested Body

```text
- add churn / cost-aware strategy signals to index:plan and index:update
- make full-rebuild escalation configurable through INDEX_UPDATE_* env vars
- move long-term memory into dedicated SQLite tables with FTS5
- preserve legacy blob reads and migrate legacy items on write
- harden default memory-hub path resolution and auto-create parent dirs
- sync templates, docs, acceptance, handoff, and release artifacts
```
