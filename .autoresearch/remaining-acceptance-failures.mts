import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { scan } from '../src/scanner/index.ts';
import { getEmbeddingConfig } from '../src/config.ts';
import {
  generateProjectId,
  initDb,
  setStoredEmbeddingDimensions,
} from '../src/db/index.ts';
import { resolveIndexPaths } from '../src/storage/layout.ts';
import {
  analyzeIndexUpdatePlan,
  formatIndexUpdatePlanReport,
} from '../src/indexing/updateStrategy.ts';
import { MemoryHubDatabase } from '../src/memory/MemoryHubDatabase.ts';
import { MemoryStore } from '../src/memory/MemoryStore.ts';

const tempDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'cw-autoresearch-acceptance-'),
);
const previousBaseDir = process.env.CONTEXTATLAS_BASE_DIR;
let failures = 0;

try {
  process.env.CONTEXTATLAS_BASE_DIR = tempDir;

  const repoRoot = path.join(tempDir, 'repo');
  fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  for (let i = 0; i < 10; i += 1) {
    fs.writeFileSync(
      path.join(repoRoot, 'src', `file-${i}.ts`),
      `export const value${i} = ${i};\n`,
    );
  }

  await scan(repoRoot, { vectorIndex: false });
  const projectId = generateProjectId(repoRoot);
  const db = initDb(projectId);
  setStoredEmbeddingDimensions(db, getEmbeddingConfig().dimensions);
  db.close();

  const { vectorPath } = resolveIndexPaths(projectId, { baseDir: tempDir });
  fs.mkdirSync(vectorPath, { recursive: true });
  fs.writeFileSync(path.join(vectorPath, '.keep'), 'ok');

  for (let i = 0; i < 8; i += 1) {
    fs.writeFileSync(
      path.join(repoRoot, 'src', `file-${i}.ts`),
      `export const value${i} = ${i + 100};\n`,
    );
  }

  const plan = await analyzeIndexUpdatePlan(repoRoot);
  const report = formatIndexUpdatePlanReport(plan);
  if (plan.mode !== 'full') {
    failures += 1;
  }
  if (!/churn|cost|estimate/i.test(report)) {
    failures += 1;
  }

  const memoryRoot = path.join(tempDir, 'memory-project');
  const dbPath = path.join(tempDir, 'memory-hub.db');
  fs.mkdirSync(memoryRoot, { recursive: true });
  MemoryStore.setSharedHubForTests(new MemoryHubDatabase(dbPath));
  const store = new MemoryStore(memoryRoot);
  await store.appendLongTermMemoryItem({
    type: 'feedback',
    title: '提交前先跑 lint',
    summary: '提交代码前必须运行 lint',
    scope: 'project',
    source: 'user-explicit',
    confidence: 1,
    tags: ['lint'],
  });

  const sqlite = new Database(dbPath, { readonly: true });
  const tables = new Set(
    sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
      .all()
      .map((row: { name: string }) => row.name),
  );
  if (!tables.has('long_term_memories') || !tables.has('long_term_memories_fts')) {
    failures += 1;
  }

  const rowCount = tables.has('long_term_memories')
    ? (
        sqlite
          .prepare('SELECT COUNT(*) AS count FROM long_term_memories')
          .get() as { count: number }
      ).count
    : 0;
  const blobCount = (
    sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM project_memory_meta WHERE meta_key = 'global:feedback'",
      )
      .get() as { count: number }
  ).count;
  if (rowCount !== 1 || blobCount !== 0) {
    failures += 1;
  }

  sqlite.close();
  MemoryStore.resetSharedHubForTests();
  console.log(String(failures));
} finally {
  MemoryStore.resetSharedHubForTests();
  if (previousBaseDir === undefined) {
    delete process.env.CONTEXTATLAS_BASE_DIR;
  } else {
    process.env.CONTEXTATLAS_BASE_DIR = previousBaseDir;
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
}
