import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = path.join(
  REPO_ROOT,
  'docs',
  'archive',
  'deliveries',
  '2026-04-09-index-and-memory',
  'delivery-manifest.json',
);
const DELIVERY_BUNDLE_PATH = path.join(
  REPO_ROOT,
  'docs',
  'archive',
  'deliveries',
  '2026-04-09-index-and-memory',
  'delivery-bundle.md',
);

test('delivery manifest stays aligned with delivery bundle and referenced docs exist', () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as {
    checkpoint: { id: string };
    artifacts: Record<string, string>;
    run_artifacts: Record<string, string>;
  };
  const deliveryBundle = fs.readFileSync(DELIVERY_BUNDLE_PATH, 'utf8');

  assert.match(deliveryBundle, new RegExp(manifest.checkpoint.id));

  for (const relPath of Object.values(manifest.artifacts)) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, relPath)), `missing artifact: ${relPath}`);
  }

  for (const relPath of Object.values(manifest.run_artifacts)) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, relPath)), `missing run artifact: ${relPath}`);
  }
});

test('delivery manifest includes the latest delivery-facing artifacts', () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as {
    artifacts: Record<string, string>;
  };

  assert.equal(
    manifest.artifacts.delivery_commands,
    'docs/archive/deliveries/2026-04-09-index-and-memory/delivery-commands.md',
  );
  assert.equal(
    manifest.artifacts.changeset_map,
    'docs/archive/deliveries/2026-04-09-index-and-memory/changeset-map.md',
  );
  assert.equal(
    manifest.artifacts.delivery_runbook,
    'docs/archive/deliveries/2026-04-09-index-and-memory/delivery-runbook.md',
  );
});

test('delivery manifest exposes machine-readable verification commands', () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as {
    commands?: Record<string, string>;
  };
  const pkg = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
  ) as {
    scripts?: Record<string, string>;
  };

  assert.equal(manifest.commands?.delivery_bundle, 'pnpm delivery:bundle');
  assert.equal(manifest.commands?.delivery_all, 'pnpm delivery:all');
  assert.equal(manifest.commands?.delivery_full, 'pnpm delivery:full');
  assert.equal(manifest.commands?.delivery_commit_message, 'pnpm delivery:commit-message');
  assert.equal(manifest.commands?.delivery_handoff, 'pnpm delivery:handoff');
  assert.equal(manifest.commands?.delivery_checklist, 'pnpm delivery:checklist');
  assert.equal(manifest.commands?.delivery_pr, 'pnpm delivery:pr');
  assert.equal(manifest.commands?.delivery_release_note, 'pnpm delivery:release-note');
  assert.equal(manifest.commands?.delivery_runbook, 'pnpm delivery:runbook');
  assert.equal(manifest.commands?.delivery_team_update, 'pnpm delivery:team-update');
  assert.equal(manifest.commands?.verify_delivery_artifacts, 'pnpm verify:delivery:artifacts');
  assert.equal(manifest.commands?.verify_delivery, 'pnpm verify:delivery');
  assert.equal(manifest.commands?.delivery_manifest, 'pnpm delivery:manifest');
  assert.ok(pkg.scripts?.['delivery:all']);
  assert.ok(pkg.scripts?.['delivery:full']);
  assert.ok(pkg.scripts?.['delivery:bundle']);
  assert.ok(pkg.scripts?.['delivery:commit-message']);
  assert.ok(pkg.scripts?.['delivery:handoff']);
  assert.ok(pkg.scripts?.['delivery:checklist']);
  assert.ok(pkg.scripts?.['delivery:pr']);
  assert.ok(pkg.scripts?.['delivery:release-note']);
  assert.ok(pkg.scripts?.['delivery:runbook']);
  assert.ok(pkg.scripts?.['delivery:team-update']);
  assert.ok(pkg.scripts?.['verify:delivery:artifacts']);
  assert.ok(pkg.scripts?.['verify:delivery']);
  assert.ok(pkg.scripts?.['delivery:manifest']);
});

test('delivery docs reference the latest checkpoint id from the manifest', () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as {
    checkpoint: { id: string };
  };
  const expectedCheckpoint = manifest.checkpoint.id;
  const docsToCheck = [
    'docs/archive/deliveries/2026-04-09-index-and-memory/handoff.md',
    'docs/archive/deliveries/2026-04-09-index-and-memory/delivery-bundle.md',
    'docs/archive/deliveries/2026-04-09-index-and-memory/merge-checklist.md',
    'docs/archive/deliveries/2026-04-09-index-and-memory/team-update-message.md',
    'docs/archive/iterations/2026-04-09/iteration-6-index-and-memory-acceptance-report.md',
  ];

  for (const relPath of docsToCheck) {
    const content = fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
    assert.match(content, new RegExp(expectedCheckpoint), `checkpoint not synced in ${relPath}`);
  }
});

test('delivery docs do not retain stale checkpoint ids or outdated test counts', () => {
  const docsToCheck = [
    'docs/archive/deliveries/2026-04-09-index-and-memory/handoff.md',
    'docs/archive/deliveries/2026-04-09-index-and-memory/delivery-bundle.md',
    'docs/archive/deliveries/2026-04-09-index-and-memory/merge-checklist.md',
    'docs/archive/deliveries/2026-04-09-index-and-memory/team-update-message.md',
    'docs/archive/iterations/2026-04-09/iteration-6-index-and-memory-acceptance-report.md',
    'docs/changelog/2026-04-09.md',
    'docs/archive/deliveries/2026-04-09-index-and-memory/pr-summary.md',
    'docs/archive/deliveries/2026-04-09-index-and-memory/pr-body.md',
    'docs/archive/deliveries/2026-04-09-index-and-memory/release-note.md',
    'docs/archive/deliveries/2026-04-09-index-and-memory/delivery-manifest.json',
  ];

  const forbiddenPatterns = [
    /chk_199893fa4484/,
    /chk_12f18c59d3e2/,
    /262\/262/,
    /263\/263/,
  ];

  for (const relPath of docsToCheck) {
    const content = fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
    for (const pattern of forbiddenPatterns) {
      assert.doesNotMatch(content, pattern, `stale reference remained in ${relPath}`);
    }
  }
});
