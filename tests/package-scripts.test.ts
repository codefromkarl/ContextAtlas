import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('package.json exposes a delivery verification script', () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
  ) as {
    scripts?: Record<string, string>;
  };

  const script = pkg.scripts?.['verify:delivery'];
  assert.ok(script);
  assert.match(script, /remaining-acceptance-failures/);
  assert.match(script, /pnpm build/);
  assert.match(script, /pnpm test/);
});

test('package.json exposes a fast delivery artifact verification script', () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
  ) as {
    scripts?: Record<string, string>;
  };

  const script = pkg.scripts?.['verify:delivery:artifacts'];
  assert.ok(script);
  assert.match(script, /delivery-manifest\.test/);
  assert.match(script, /delivery-readme-links\.test/);
  assert.match(script, /package-scripts\.test/);
});

test('package.json exposes a delivery manifest print script', () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
  ) as {
    scripts?: Record<string, string>;
  };

  const script = pkg.scripts?.['delivery:manifest'];
  assert.ok(script);
  assert.match(script, /DELIVERY_MANIFEST_2026_04_09_INDEX_AND_MEMORY\.json/);
});

test('package.json exposes a delivery bundle print script', () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
  ) as {
    scripts?: Record<string, string>;
  };

  const script = pkg.scripts?.['delivery:bundle'];
  assert.ok(script);
  assert.match(script, /DELIVERY_BUNDLE_2026_04_09_INDEX_AND_MEMORY\.md/);
});

test('package.json exposes delivery scripts for PR body and team update message', () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
  ) as {
    scripts?: Record<string, string>;
  };

  const prScript = pkg.scripts?.['delivery:pr'];
  const teamScript = pkg.scripts?.['delivery:team-update'];

  assert.ok(prScript);
  assert.ok(teamScript);
  assert.match(prScript, /PR_BODY_2026_04_09_INDEX_AND_MEMORY\.md/);
  assert.match(teamScript, /TEAM_UPDATE_MESSAGE_2026_04_09_INDEX_AND_MEMORY\.md/);
});

test('package.json exposes a delivery runbook script', () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
  ) as {
    scripts?: Record<string, string>;
  };

  const script = pkg.scripts?.['delivery:runbook'];
  assert.ok(script);
  assert.match(script, /DELIVERY_RUNBOOK_2026_04_09_INDEX_AND_MEMORY\.md/);
});

test('package.json exposes delivery scripts for handoff and merge checklist', () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
  ) as {
    scripts?: Record<string, string>;
  };

  const handoffScript = pkg.scripts?.['delivery:handoff'];
  const checklistScript = pkg.scripts?.['delivery:checklist'];

  assert.ok(handoffScript);
  assert.ok(checklistScript);
  assert.match(handoffScript, /HANDOFF_2026_04_09_INDEX_AND_MEMORY\.md/);
  assert.match(checklistScript, /MERGE_CHECKLIST_2026_04_09_INDEX_AND_MEMORY\.md/);
});

test('package.json exposes delivery scripts for commit message and release note', () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
  ) as {
    scripts?: Record<string, string>;
  };

  const commitScript = pkg.scripts?.['delivery:commit-message'];
  const releaseScript = pkg.scripts?.['delivery:release-note'];

  assert.ok(commitScript);
  assert.ok(releaseScript);
  assert.match(commitScript, /COMMIT_MESSAGE_2026_04_09_INDEX_AND_MEMORY\.md/);
  assert.match(releaseScript, /RELEASE_NOTE_2026_04_09_INDEX_AND_MEMORY\.md/);
});

test('package.json exposes a delivery all-in-one script', () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
  ) as {
    scripts?: Record<string, string>;
  };

  const script = pkg.scripts?.['delivery:all'];
  assert.ok(script);
  assert.match(script, /pnpm verify:delivery:artifacts/);
  assert.match(script, /pnpm delivery:manifest/);
  assert.match(script, /pnpm delivery:bundle/);
  assert.match(script, /pnpm delivery:pr/);
  assert.match(script, /pnpm delivery:team-update/);
  assert.match(script, /pnpm delivery:runbook/);
});

test('package.json exposes a delivery full pipeline script', () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
  ) as {
    scripts?: Record<string, string>;
  };

  const script = pkg.scripts?.['delivery:full'];
  assert.ok(script);
  assert.match(script, /pnpm verify:delivery/);
  assert.match(script, /pnpm delivery:all/);
});
