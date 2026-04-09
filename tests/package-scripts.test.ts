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
  assert.match(script, /pnpm test:dist/);
});

test('package.json build scripts compile the scanner bundle required by dist smoke tests', () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
  ) as {
    scripts?: Record<string, string>;
  };

  const buildScript = pkg.scripts?.build;
  const buildReleaseScript = pkg.scripts?.['build:release'];
  assert.ok(buildScript);
  assert.ok(buildReleaseScript);
  assert.match(buildScript, /src\/scanner\/index\.ts/);
  assert.match(buildReleaseScript, /src\/scanner\/index\.ts/);
});

test('package.json splits source and dist test entrypoints explicitly', () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
  ) as {
    scripts?: Record<string, string>;
  };

  const testScript = pkg.scripts?.test;
  const distScript = pkg.scripts?.['test:dist'];
  assert.ok(testScript);
  assert.ok(distScript);
  assert.match(testScript, /scripts\/run-tests\.mjs source/);
  assert.match(distScript, /scripts\/run-tests\.mjs dist/);
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
  assert.match(script, /archive\/deliveries\/2026-04-09-index-and-memory\/delivery-manifest\.json/);
});

test('package.json exposes a delivery bundle print script', () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
  ) as {
    scripts?: Record<string, string>;
  };

  const script = pkg.scripts?.['delivery:bundle'];
  assert.ok(script);
  assert.match(script, /archive\/deliveries\/2026-04-09-index-and-memory\/delivery-bundle\.md/);
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
  assert.match(prScript, /archive\/deliveries\/2026-04-09-index-and-memory\/pr-body\.md/);
  assert.match(teamScript, /archive\/deliveries\/2026-04-09-index-and-memory\/team-update-message\.md/);
});

test('package.json exposes a delivery runbook script', () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
  ) as {
    scripts?: Record<string, string>;
  };

  const script = pkg.scripts?.['delivery:runbook'];
  assert.ok(script);
  assert.match(script, /archive\/deliveries\/2026-04-09-index-and-memory\/delivery-runbook\.md/);
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
  assert.match(handoffScript, /archive\/deliveries\/2026-04-09-index-and-memory\/handoff\.md/);
  assert.match(checklistScript, /archive\/deliveries\/2026-04-09-index-and-memory\/merge-checklist\.md/);
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
  assert.match(commitScript, /archive\/deliveries\/2026-04-09-index-and-memory\/commit-message\.md/);
  assert.match(releaseScript, /archive\/deliveries\/2026-04-09-index-and-memory\/release-note\.md/);
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
