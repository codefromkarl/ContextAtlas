# Delivery Commands (2026-04-09)

## One-command full delivery

```bash
pnpm delivery:full
```

## Verify

```bash
pnpm verify:delivery:artifacts
node --import tsx ./.autoresearch/remaining-acceptance-failures.mts
pnpm build
pnpm test
```

If you want the full verification plus delivery-output flow in one step, use:

```bash
pnpm delivery:full
```

## Review Docs

```bash
pnpm delivery:bundle
pnpm delivery:manifest
sed -n '1,200p' docs/DELIVERY_BUNDLE_2026_04_09_INDEX_AND_MEMORY.md
sed -n '1,200p' docs/PR_BODY_2026_04_09_INDEX_AND_MEMORY.md
sed -n '1,200p' docs/COMMIT_MESSAGE_2026_04_09_INDEX_AND_MEMORY.md
```

## Suggested Commit Flow

```bash
git status --short
git add README.md README.EN.md docs src tests .autoresearch
git commit -F - <<'EOF'
feat: add configurable index escalation and migrate long-term memory storage

- add churn / cost-aware strategy signals to index:plan and index:update
- make full-rebuild escalation configurable through INDEX_UPDATE_* env vars
- move long-term memory into dedicated SQLite tables with FTS5
- preserve legacy blob reads and migrate legacy items on write
- harden default memory-hub path resolution and auto-create parent dirs
- sync templates, docs, acceptance, handoff, and release artifacts
EOF
```

## Suggested Follow-up Inspection

```bash
git show --stat --summary HEAD
```
