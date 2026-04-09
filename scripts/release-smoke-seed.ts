import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MemoryHubDatabase } from '../src/memory/MemoryHubDatabase.ts';
import { MemoryStore } from '../src/memory/MemoryStore.ts';

const fixtureRepoPath = process.argv[2];
const baseDir = process.env.CONTEXTATLAS_BASE_DIR;

if (!fixtureRepoPath) {
  throw new Error('Missing fixture repo path');
}

if (!baseDir) {
  throw new Error('Missing CONTEXTATLAS_BASE_DIR');
}

mkdirSync(path.join(fixtureRepoPath, 'src', 'smoke'), { recursive: true });
writeFileSync(
  path.join(fixtureRepoPath, 'src', 'smoke', 'auth.ts'),
  [
    'export async function smokeLogin() {',
    "  return 'ok';",
    '}',
    '',
    'export async function smokeIssueToken() {',
    "  return 'token';",
    '}',
  ].join('\n'),
);

MemoryStore.setSharedHubForTests(new MemoryHubDatabase(path.join(baseDir, 'memory-hub.db')));

try {
  const store = new MemoryStore(fixtureRepoPath);
  await store.saveFeature({
    name: 'SmokeAuth',
    responsibility: 'release smoke auth fixture',
    location: {
      dir: 'src/smoke',
      files: ['auth.ts'],
    },
    api: {
      exports: ['smokeLogin', 'smokeIssueToken'],
      endpoints: [],
    },
    dependencies: {
      imports: [],
      external: [],
    },
    dataFlow: 'release smoke fixture data flow',
    keyPatterns: ['smokeauth', 'smokelogin'],
    lastUpdated: new Date('2026-04-09T10:00:00.000Z').toISOString(),
    confirmationStatus: 'human-confirmed',
  });
  await store.saveFeature({
    name: 'SmokeOrphan',
    responsibility: 'release smoke orphan fixture',
    location: {
      dir: 'src/smoke',
      files: ['missing.ts'],
    },
    api: {
      exports: ['SmokeOrphan'],
      endpoints: [],
    },
    dependencies: {
      imports: [],
      external: [],
    },
    dataFlow: 'release smoke orphan data flow',
    keyPatterns: ['smokeorphan'],
    lastUpdated: new Date('2026-04-09T10:00:00.000Z').toISOString(),
    confirmationStatus: 'human-confirmed',
  });
  await store.saveCatalog({
    version: 1,
    globalMemoryFiles: [],
    modules: {},
    scopes: {},
  });
  await store.appendLongTermMemoryItem({
    type: 'feedback',
    title: 'Stale governance memory',
    summary: 'legacy coordination guidance for smoke',
    scope: 'project',
    source: 'user-explicit',
    confidence: 1,
    lastVerifiedAt: '2020-01-01',
    tags: ['smoke', 'stale'],
    links: [],
    provenance: [],
    durability: 'stable',
  });
} finally {
  MemoryStore.resetSharedHubForTests();
}

process.stdout.write('release-smoke-seeded\n');
