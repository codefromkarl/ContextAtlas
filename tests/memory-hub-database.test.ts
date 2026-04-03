import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { deriveStableProjectId } from '../src/db/index.ts';
import { MemoryHubDatabase } from '../src/memory/MemoryHubDatabase.ts';

function withTempDb(run: (dbPath: string) => void): void {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cw-memory-hub-db-'));
  const dbPath = path.join(tempDir, 'memory-hub.db');

  try {
    run(dbPath);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

test('ensureProject reuses existing project for the same normalized path', () => {
  withTempDb((dbPath) => {
    const db = new MemoryHubDatabase(dbPath);

    try {
      const first = db.ensureProject({
        path: '/tmp/contextatlas-project',
        name: 'ContextAtlas',
      });

      const second = db.ensureProject({
        path: '/tmp/contextatlas-project/',
        name: 'ContextAtlas Renamed',
      });

      const projects = db.listProjects();

      assert.equal(projects.length, 1);
      assert.equal(second.id, first.id);
      assert.equal(second.path, first.path);
      assert.equal(second.name, 'ContextAtlas Renamed');
    } finally {
      db.close();
    }
  });
});

test('repairProjectIdentities migrates legacy project ids to canonical path-derived ids', () => {
  withTempDb((dbPath) => {
    const setup = new MemoryHubDatabase(dbPath);
    setup.close();

    const legacyPath = '/tmp/contextatlas-legacy';
    const canonicalId = deriveStableProjectId(legacyPath);

    const rawDb = new Database(dbPath);
    rawDb.exec(`
      INSERT INTO projects (id, name, path, created_at)
      VALUES ('legacy-project', 'Legacy Project', '${legacyPath}', datetime('now'));
      INSERT INTO feature_memories (
        project_id, name, responsibility, location_dir, location_files, api_exports,
        api_endpoints, dependencies, data_flow, key_patterns, memory_type, updated_at
      ) VALUES (
        'legacy-project', 'SearchService', 'legacy memory', 'src/search', '[]', '[]',
        '[]', '{}', '', '[]', 'local', datetime('now')
      );
      INSERT INTO project_memory_meta (project_id, meta_key, meta_value, updated_at)
      VALUES ('legacy-project', 'catalog', '{"version":1,"modules":{},"scopes":{},"globalMemoryFiles":[]}', datetime('now'));
      INSERT INTO decision_records (project_id, decision_id, title, context, decision, rationale, status)
      VALUES ('legacy-project', 'adr-1', 'Legacy ADR', '{}', 'keep', 'because', 'accepted');
    `);
    rawDb.close();

    const db = new MemoryHubDatabase(dbPath);
    try {
      const report = db.repairProjectIdentities();

      assert.equal(report.repairedProjects, 1);

      const project = db.getProject(canonicalId);
      assert.ok(project);
      assert.equal(project?.path, legacyPath);

      const memory = db.getMemory(canonicalId, 'SearchService');
      assert.ok(memory);

      const meta = db.getProjectMeta(canonicalId, 'catalog');
      assert.ok(meta);

      const decision = db.getDecision(canonicalId, 'adr-1');
      assert.ok(decision);

      assert.equal(db.getProject('legacy-project'), undefined);
    } finally {
      db.close();
    }
  });
});

test('analyzeProjectIdentityRepairs reports legacy project migrations without mutating data', () => {
  withTempDb((dbPath) => {
    const setup = new MemoryHubDatabase(dbPath);
    setup.close();

    const legacyPath = '/tmp/contextatlas-dry-run';
    const canonicalId = deriveStableProjectId(legacyPath);

    const rawDb = new Database(dbPath);
    rawDb.exec(`
      INSERT INTO projects (id, name, path, created_at)
      VALUES ('legacy-project', 'Legacy Project', '${legacyPath}', datetime('now'));
      INSERT INTO feature_memories (
        project_id, name, responsibility, location_dir, location_files, api_exports,
        api_endpoints, dependencies, data_flow, key_patterns, memory_type, updated_at
      ) VALUES (
        'legacy-project', 'SearchService', 'legacy memory', 'src/search', '[]', '[]',
        '[]', '{}', '', '[]', 'local', datetime('now')
      );
    `);
    rawDb.close();

    const db = new MemoryHubDatabase(dbPath);
    try {
      const analysis = db.analyzeProjectIdentityRepairs();

      assert.equal(analysis.repairedProjects, 1);
      assert.equal(analysis.entries.length, 1);
      assert.equal(analysis.entries[0]?.legacyProjectId, 'legacy-project');
      assert.equal(analysis.entries[0]?.canonicalProjectId, canonicalId);
      assert.equal(analysis.entries[0]?.featureMemoryCount, 1);

      assert.ok(db.getProject('legacy-project'));
      assert.equal(db.getProject(canonicalId), undefined);
      assert.ok(db.getMemory('legacy-project', 'SearchService'));
    } finally {
      db.close();
    }
  });
});

test('saveMemory can overwrite an existing module without foreign key failure', () => {
  withTempDb((dbPath) => {
    const db = new MemoryHubDatabase(dbPath);

    try {
      const project = db.ensureProject({
        path: '/tmp/contextatlas-overwrite',
        name: 'Overwrite Project',
      });

      const firstId = db.saveMemory({
        project_id: project.id,
        name: 'legacy-project-memory-migration-map',
        responsibility: 'initial responsibility',
        location_dir: 'src/memory',
        location_files: ['map.ts'],
        dependencies: { imports: ['A'], external: [] },
      });

      const secondId = db.saveMemory({
        project_id: project.id,
        name: 'legacy-project-memory-migration-map',
        responsibility: 'updated responsibility',
        location_dir: 'src/memory',
        location_files: ['map.ts'],
        dependencies: { imports: [], external: [] },
      });

      const memory = db.getMemory(project.id, 'legacy-project-memory-migration-map');

      assert.ok(memory);
      assert.equal(memory?.responsibility, 'updated responsibility');
      assert.equal(secondId, firstId);
    } finally {
      db.close();
    }
  });
});
