/**
 * MemoryHubDatabase - 跨项目记忆数据库
 *
 * 使用 SQLite 集中管理多项目记忆，支持跨项目引用和查询
 *
 * Schema:
 * - projects: 项目注册表
 * - feature_memories: 功能记忆
 * - memory_relations: 记忆关系（跨项目引用）
 * - decision_records: 决策记录
 * - shared_index: 共享索引（加速查询）
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { deriveStableProjectId, normalizeProjectPath } from '../db/index.js';
import { resolveBaseDir } from '../runtimePaths.js';
import { logger } from '../utils/logger.js';
import type { LongTermMemoryScope, LongTermMemoryType } from './types.js';

function resolveDefaultHubPath(): string {
  return path.join(resolveBaseDir(), 'memory-hub.db');
}

export interface ProjectInfo {
  id: string;
  name: string;
  path: string;
  created_at?: string;
  createdAt?: string;
}

export interface FeatureMemoryRow {
  id: number;
  project_id: string;
  name: string;
  responsibility: string;
  location_dir: string;
  location_files: string; // JSON
  api_exports: string; // JSON
  api_endpoints: string; // JSON
  dependencies: string; // JSON
  data_flow: string;
  key_patterns: string; // JSON
  evidence_refs?: string; // JSON
  memory_type: 'local' | 'shared' | 'pattern' | 'framework';
  confirmation_status?: 'suggested' | 'agent-inferred' | 'human-confirmed';
  review_status?: 'verified' | 'needs-review';
  review_reason?: string;
  review_marked_at?: string;
  created_at: string;
  updated_at: string;
}

export interface MemoryRelationRow {
  id: number;
  from_memory_id: number;
  to_memory_id: number;
  relation_type: 'depends_on' | 'extends' | 'references' | 'implements';
  created_at: string;
}

export interface SharedIndexRow {
  memory_id: number;
  search_key: string;
  category: string;
  tags: string;
}

export interface ProjectMetaRow {
  project_id: string;
  meta_key: string;
  meta_value: string;
  updated_at: string;
}

export interface LongTermMemoryRow {
  rowid: number;
  id: string;
  project_id: string;
  type: LongTermMemoryType;
  scope: LongTermMemoryScope;
  title: string;
  summary: string;
  why: string | null;
  how_to_apply: string | null;
  tags: string;
  tags_text: string;
  source: 'user-explicit' | 'agent-inferred' | 'tool-result';
  confidence: number;
  links: string;
  fact_key: string | null;
  invalidates: string;
  invalidated_by: string | null;
  durability: 'stable' | 'ephemeral';
  provenance: string;
  valid_from: string | null;
  valid_until: string | null;
  last_verified_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectRepairReport {
  scannedProjects: number;
  repairedProjects: number;
  removedProjects: number;
  canonicalProjects: number;
}

export interface ProjectRepairEntry {
  legacyProjectId: string;
  canonicalProjectId: string;
  path: string;
  featureMemoryCount: number;
  metaCount: number;
  decisionCount: number;
  action: 'already-canonical' | 'migrate-to-canonical';
}

export interface ProjectRepairAnalysis extends ProjectRepairReport {
  entries: ProjectRepairEntry[];
}

const REPAIR_PLACEHOLDER_PREFIX = '__cw_repair__';

export class MemoryHubDatabase {
  private db: Database.Database;

  constructor(dbPath?: string) {
    this.dbPath = dbPath || resolveDefaultHubPath();
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initializeSchema();
  }

  private dbPath: string;

  /**
   * 初始化数据库 schema
   */
  private initializeSchema(): void {
    this.db.exec(`
      -- 项目注册表
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- 功能记忆表
      CREATE TABLE IF NOT EXISTS feature_memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        responsibility TEXT NOT NULL,
        location_dir TEXT NOT NULL,
        location_files TEXT DEFAULT '[]',
        api_exports TEXT DEFAULT '[]',
        api_endpoints TEXT DEFAULT '[]',
        dependencies TEXT DEFAULT '{}',
        data_flow TEXT DEFAULT '',
        key_patterns TEXT DEFAULT '[]',
        evidence_refs TEXT DEFAULT '[]',
        memory_type TEXT DEFAULT 'local' CHECK(memory_type IN ('local', 'shared', 'pattern', 'framework')),
        confirmation_status TEXT DEFAULT 'human-confirmed' CHECK(confirmation_status IN ('suggested', 'agent-inferred', 'human-confirmed')),
        review_status TEXT DEFAULT 'verified' CHECK(review_status IN ('verified', 'needs-review')),
        review_reason TEXT,
        review_marked_at TEXT,
        snapshot_id TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (project_id) REFERENCES projects(id),
        UNIQUE(project_id, name)
      );

      -- 记忆关系表（跨项目引用核心）
      CREATE TABLE IF NOT EXISTS memory_relations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_memory_id INTEGER NOT NULL,
        to_memory_id INTEGER NOT NULL,
        relation_type TEXT NOT NULL CHECK(relation_type IN ('depends_on', 'extends', 'references', 'implements')),
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (from_memory_id) REFERENCES feature_memories(id),
        FOREIGN KEY (to_memory_id) REFERENCES feature_memories(id)
      );

      -- 决策记录表
      CREATE TABLE IF NOT EXISTS decision_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        decision_id TEXT NOT NULL,
        title TEXT NOT NULL,
        context TEXT,
        decision TEXT NOT NULL,
        rationale TEXT,
        status TEXT DEFAULT 'accepted',
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (project_id) REFERENCES projects(id),
        UNIQUE(project_id, decision_id)
      );

      -- 共享索引表（加速查询）
      CREATE TABLE IF NOT EXISTS shared_index (
        memory_id INTEGER NOT NULL,
        search_key TEXT NOT NULL,
        category TEXT,
        tags TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (memory_id) REFERENCES feature_memories(id)
      );

      -- 项目级记忆元数据（catalog/global/profile 等）
      CREATE TABLE IF NOT EXISTS project_memory_meta (
        project_id TEXT NOT NULL,
        meta_key TEXT NOT NULL,
        meta_value TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (project_id, meta_key),
        FOREIGN KEY (project_id) REFERENCES projects(id)
      );

      -- 长期记忆表
      CREATE TABLE IF NOT EXISTS long_term_memories (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('user', 'feedback', 'project-state', 'reference', 'journal', 'evidence', 'temporal-fact')),
        scope TEXT NOT NULL CHECK(scope IN ('project', 'global-user')),
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        why TEXT,
        how_to_apply TEXT,
        tags TEXT DEFAULT '[]',
        tags_text TEXT DEFAULT '',
        source TEXT NOT NULL CHECK(source IN ('user-explicit', 'agent-inferred', 'tool-result')),
        confidence REAL DEFAULT 0.5,
        links TEXT DEFAULT '[]',
        fact_key TEXT,
        invalidates TEXT DEFAULT '[]',
        invalidated_by TEXT,
        durability TEXT DEFAULT 'stable' CHECK(durability IN ('stable', 'ephemeral')),
        provenance TEXT DEFAULT '[]',
        valid_from TEXT,
        valid_until TEXT,
        last_verified_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id),
        UNIQUE(project_id, id)
      );

      -- 索引优化
      CREATE INDEX IF NOT EXISTS idx_memories_project ON feature_memories(project_id);
      CREATE INDEX IF NOT EXISTS idx_memories_name ON feature_memories(name);
      CREATE INDEX IF NOT EXISTS idx_memories_type ON feature_memories(memory_type);
      CREATE INDEX IF NOT EXISTS idx_relations_from ON memory_relations(from_memory_id);
      CREATE INDEX IF NOT EXISTS idx_relations_to ON memory_relations(to_memory_id);
      CREATE INDEX IF NOT EXISTS idx_shared_index_key ON shared_index(search_key);
      CREATE INDEX IF NOT EXISTS idx_shared_index_category ON shared_index(category);
      CREATE INDEX IF NOT EXISTS idx_project_meta_project ON project_memory_meta(project_id);
      CREATE INDEX IF NOT EXISTS idx_project_meta_key ON project_memory_meta(meta_key);
      CREATE INDEX IF NOT EXISTS idx_long_term_project ON long_term_memories(project_id);
      CREATE INDEX IF NOT EXISTS idx_long_term_type_scope ON long_term_memories(project_id, type, scope);
      CREATE INDEX IF NOT EXISTS idx_long_term_updated ON long_term_memories(project_id, updated_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_long_term_fact_key
        ON long_term_memories(project_id, type, scope, fact_key)
        WHERE fact_key IS NOT NULL;

      -- FTS 全文搜索
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        name,
        responsibility,
        data_flow,
        content='feature_memories',
        content_rowid='id'
      );

      -- FTS 触发器同步
      CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON feature_memories BEGIN
        INSERT INTO memories_fts(rowid, name, responsibility, data_flow)
        VALUES (new.id, new.name, new.responsibility, new.data_flow);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON feature_memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, name, responsibility, data_flow)
        VALUES ('delete', old.id, old.name, old.responsibility, old.data_flow);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE ON feature_memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, name, responsibility, data_flow)
        VALUES ('delete', old.id, old.name, old.responsibility, old.data_flow);
        INSERT INTO memories_fts(rowid, name, responsibility, data_flow)
        VALUES (new.id, new.name, new.responsibility, new.data_flow);
      END;

      CREATE VIRTUAL TABLE IF NOT EXISTS long_term_memories_fts USING fts5(
        title,
        summary,
        why,
        how_to_apply,
        tags_text,
        content='long_term_memories',
        content_rowid='rowid'
      );

      CREATE TRIGGER IF NOT EXISTS long_term_memories_fts_ai AFTER INSERT ON long_term_memories BEGIN
        INSERT INTO long_term_memories_fts(rowid, title, summary, why, how_to_apply, tags_text)
        VALUES (new.rowid, new.title, new.summary, new.why, new.how_to_apply, new.tags_text);
      END;

      CREATE TRIGGER IF NOT EXISTS long_term_memories_fts_ad AFTER DELETE ON long_term_memories BEGIN
        INSERT INTO long_term_memories_fts(
          long_term_memories_fts,
          rowid,
          title,
          summary,
          why,
          how_to_apply,
          tags_text
        )
        VALUES ('delete', old.rowid, old.title, old.summary, old.why, old.how_to_apply, old.tags_text);
      END;

      CREATE TRIGGER IF NOT EXISTS long_term_memories_fts_au AFTER UPDATE ON long_term_memories BEGIN
        INSERT INTO long_term_memories_fts(
          long_term_memories_fts,
          rowid,
          title,
          summary,
          why,
          how_to_apply,
          tags_text
        )
        VALUES ('delete', old.rowid, old.title, old.summary, old.why, old.how_to_apply, old.tags_text);
        INSERT INTO long_term_memories_fts(rowid, title, summary, why, how_to_apply, tags_text)
        VALUES (new.rowid, new.title, new.summary, new.why, new.how_to_apply, new.tags_text);
      END;
    `);

    // 迁移：补齐新列（老库兼容）
    try {
      this.db.exec(`ALTER TABLE feature_memories ADD COLUMN api_endpoints TEXT DEFAULT '[]'`);
    } catch {
      // column exists
    }
    try {
      this.db.exec(`ALTER TABLE feature_memories ADD COLUMN key_patterns TEXT DEFAULT '[]'`);
    } catch {
      // column exists
    }
    try {
      this.db.exec(`ALTER TABLE feature_memories ADD COLUMN evidence_refs TEXT DEFAULT '[]'`);
    } catch {
      // column exists
    }
    try {
      this.db.exec(
        "ALTER TABLE feature_memories ADD COLUMN confirmation_status TEXT DEFAULT 'human-confirmed' CHECK(confirmation_status IN ('suggested', 'agent-inferred', 'human-confirmed'))",
      );
    } catch {
      // column exists
    }
    try {
      this.db.exec(
        "ALTER TABLE feature_memories ADD COLUMN review_status TEXT DEFAULT 'verified' CHECK(review_status IN ('verified', 'needs-review'))",
      );
    } catch {
      // column exists
    }
    try {
      this.db.exec('ALTER TABLE feature_memories ADD COLUMN review_reason TEXT');
    } catch {
      // column exists
    }
    try {
      this.db.exec('ALTER TABLE feature_memories ADD COLUMN review_marked_at TEXT');
    } catch {
      // column exists
    }
    try {
      this.db.exec("ALTER TABLE long_term_memories ADD COLUMN tags_text TEXT DEFAULT ''");
    } catch {
      // column exists
    }

    logger.info('Memory Hub 数据库初始化完成');
  }

  // ===========================================
  // Projects 管理
  // ===========================================

  normalizeProjectPath(projectPath: string): string {
    return normalizeProjectPath(projectPath);
  }

  getProjectByPath(projectPath: string): ProjectInfo | null {
    const normalizedPath = this.normalizeProjectPath(projectPath);
    const stmt = this.db.prepare('SELECT * FROM projects WHERE path = ?');
    return stmt.get(normalizedPath) as ProjectInfo | null;
  }

  ensureProject(project: { path: string; name?: string }): ProjectInfo {
    const normalizedPath = this.normalizeProjectPath(project.path);
    const existing = this.getProjectByPath(normalizedPath);

    if (existing) {
      if (project.name && project.name !== existing.name) {
        this.db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(project.name, existing.id);
        return {
          ...existing,
          name: project.name,
        };
      }

      return existing;
    }

    const name =
      project.name || path.basename(normalizedPath) || deriveStableProjectId(normalizedPath);
    const id = deriveStableProjectId(normalizedPath);

    this.db
      .prepare(`
        INSERT INTO projects (id, name, path, created_at)
        VALUES (?, ?, ?, datetime('now'))
      `)
      .run(id, name, normalizedPath);

    logger.info({ projectId: id, path: normalizedPath }, '项目已按路径确保存在');
    return this.getProject(id) as ProjectInfo;
  }

  registerProject(project: { id: string; name: string; path: string }): void {
    this.ensureProject({
      path: project.path,
      name: project.name,
    });
  }

  getProject(projectId: string): ProjectInfo | null {
    const stmt = this.db.prepare('SELECT * FROM projects WHERE id = ?');
    return stmt.get(projectId) as ProjectInfo | null;
  }

  listProjects(): ProjectInfo[] {
    const stmt = this.db.prepare('SELECT * FROM projects ORDER BY created_at DESC');
    return stmt.all() as ProjectInfo[];
  }

  analyzeProjectIdentityRepairs(): ProjectRepairAnalysis {
    const projects = this.listProjects();
    const entries: ProjectRepairEntry[] = [];
    const countFeatureMemories = this.db.prepare(
      'SELECT COUNT(*) as count FROM feature_memories WHERE project_id = ?',
    );
    const countMeta = this.db.prepare(
      'SELECT COUNT(*) as count FROM project_memory_meta WHERE project_id = ?',
    );
    const countDecisions = this.db.prepare(
      'SELECT COUNT(*) as count FROM decision_records WHERE project_id = ?',
    );

    let repairedProjects = 0;
    let canonicalProjects = 0;

    for (const project of projects) {
      const normalizedPath = this.normalizeProjectPath(project.path);
      const canonicalId = deriveStableProjectId(normalizedPath);
      const isCanonical = project.id === canonicalId;

      if (isCanonical) {
        canonicalProjects += 1;
      } else {
        repairedProjects += 1;
      }

      const featureMemoryCount = (countFeatureMemories.get(project.id) as { count: number }).count;
      const metaCount = (countMeta.get(project.id) as { count: number }).count;
      const decisionCount = (countDecisions.get(project.id) as { count: number }).count;

      entries.push({
        legacyProjectId: project.id,
        canonicalProjectId: canonicalId,
        path: normalizedPath,
        featureMemoryCount,
        metaCount,
        decisionCount,
        action: isCanonical ? 'already-canonical' : 'migrate-to-canonical',
      });
    }

    return {
      scannedProjects: projects.length,
      repairedProjects,
      removedProjects: repairedProjects,
      canonicalProjects,
      entries,
    };
  }

  repairProjectIdentities(): ProjectRepairReport {
    const analysis = this.analyzeProjectIdentityRepairs();
    const projects = this.listProjects();
    const report: ProjectRepairReport = {
      scannedProjects: analysis.scannedProjects,
      repairedProjects: 0,
      removedProjects: 0,
      canonicalProjects: analysis.canonicalProjects,
    };

    const selectFeature = this.db.prepare(
      'SELECT * FROM feature_memories WHERE project_id = ? AND name = ?',
    );
    const deleteFeature = this.db.prepare(
      'DELETE FROM feature_memories WHERE project_id = ? AND name = ?',
    );
    const moveFeature = this.db.prepare(
      'UPDATE feature_memories SET project_id = ? WHERE project_id = ? AND name = ?',
    );

    const selectMeta = this.db.prepare(
      'SELECT * FROM project_memory_meta WHERE project_id = ? AND meta_key = ?',
    );
    const deleteMeta = this.db.prepare(
      'DELETE FROM project_memory_meta WHERE project_id = ? AND meta_key = ?',
    );
    const moveMeta = this.db.prepare(
      'UPDATE project_memory_meta SET project_id = ? WHERE project_id = ? AND meta_key = ?',
    );

    const selectDecision = this.db.prepare(
      'SELECT * FROM decision_records WHERE project_id = ? AND decision_id = ?',
    );
    const deleteDecision = this.db.prepare(
      'DELETE FROM decision_records WHERE project_id = ? AND decision_id = ?',
    );
    const moveDecision = this.db.prepare(
      'UPDATE decision_records SET project_id = ? WHERE project_id = ? AND decision_id = ?',
    );

    const transaction = this.db.transaction(() => {
      for (const project of projects) {
        const normalizedPath = this.normalizeProjectPath(project.path);
        const canonicalId = deriveStableProjectId(normalizedPath);

        if (project.id === canonicalId) {
          continue;
        }

        let canonicalProject = this.getProject(canonicalId);
        if (!canonicalProject) {
          const placeholderPath = `${REPAIR_PLACEHOLDER_PREFIX}:${canonicalId}:${normalizedPath}`;
          this.db
            .prepare(
              "INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, COALESCE(?, datetime('now')))",
            )
            .run(
              canonicalId,
              project.name,
              placeholderPath,
              project.created_at ?? project.createdAt ?? null,
            );
          canonicalProject = this.getProject(canonicalId);
        }

        const legacyFeatures = this.db
          .prepare(
            'SELECT name, updated_at FROM feature_memories WHERE project_id = ? ORDER BY updated_at DESC',
          )
          .all(project.id) as Array<{ name: string; updated_at: string }>;
        for (const feature of legacyFeatures) {
          const existing = selectFeature.get(canonicalId, feature.name) as
            | { updated_at?: string }
            | undefined;
          if (existing) {
            if ((existing.updated_at || '') < feature.updated_at) {
              deleteFeature.run(canonicalId, feature.name);
              moveFeature.run(canonicalId, project.id, feature.name);
            } else {
              deleteFeature.run(project.id, feature.name);
            }
          } else {
            moveFeature.run(canonicalId, project.id, feature.name);
          }
        }

        const legacyMeta = this.db
          .prepare(
            'SELECT meta_key, updated_at FROM project_memory_meta WHERE project_id = ? ORDER BY updated_at DESC',
          )
          .all(project.id) as Array<{ meta_key: string; updated_at: string }>;
        for (const meta of legacyMeta) {
          const existing = selectMeta.get(canonicalId, meta.meta_key) as
            | { updated_at?: string }
            | undefined;
          if (existing) {
            if ((existing.updated_at || '') < meta.updated_at) {
              deleteMeta.run(canonicalId, meta.meta_key);
              moveMeta.run(canonicalId, project.id, meta.meta_key);
            } else {
              deleteMeta.run(project.id, meta.meta_key);
            }
          } else {
            moveMeta.run(canonicalId, project.id, meta.meta_key);
          }
        }

        const legacyDecisions = this.db
          .prepare(
            'SELECT decision_id, created_at FROM decision_records WHERE project_id = ? ORDER BY created_at DESC',
          )
          .all(project.id) as Array<{ decision_id: string; created_at: string }>;
        for (const decision of legacyDecisions) {
          const existing = selectDecision.get(canonicalId, decision.decision_id) as
            | { created_at?: string }
            | undefined;
          if (existing) {
            if ((existing.created_at || '') < decision.created_at) {
              deleteDecision.run(canonicalId, decision.decision_id);
              moveDecision.run(canonicalId, project.id, decision.decision_id);
            } else {
              deleteDecision.run(project.id, decision.decision_id);
            }
          } else {
            moveDecision.run(canonicalId, project.id, decision.decision_id);
          }
        }

        this.db.prepare('DELETE FROM projects WHERE id = ?').run(project.id);
        this.db
          .prepare('UPDATE projects SET path = ?, name = ? WHERE id = ?')
          .run(normalizedPath, project.name, canonicalId);
        report.repairedProjects += 1;
        report.removedProjects += 1;
      }
    });

    transaction();
    return report;
  }

  // ===========================================
  // Project Meta 管理
  // ===========================================

  setProjectMeta(projectId: string, key: string, value: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO project_memory_meta (project_id, meta_key, meta_value, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(project_id, meta_key) DO UPDATE SET
        meta_value = excluded.meta_value,
        updated_at = datetime('now')
    `);
    stmt.run(projectId, key, value);
  }

  getProjectMeta(projectId: string, key: string): string | null {
    const stmt = this.db.prepare(`
      SELECT meta_value
      FROM project_memory_meta
      WHERE project_id = ? AND meta_key = ?
    `);
    const row = stmt.get(projectId, key) as { meta_value: string } | undefined;
    return row?.meta_value ?? null;
  }

  deleteProjectMeta(projectId: string, key: string): boolean {
    const stmt = this.db.prepare(`
      DELETE FROM project_memory_meta
      WHERE project_id = ? AND meta_key = ?
    `);
    const result = stmt.run(projectId, key);
    return result.changes > 0;
  }

  listProjectMeta(projectId: string, keyPrefix?: string): ProjectMetaRow[] {
    if (keyPrefix) {
      const stmt = this.db.prepare(`
        SELECT project_id, meta_key, meta_value, updated_at
        FROM project_memory_meta
        WHERE project_id = ? AND meta_key LIKE ?
        ORDER BY meta_key ASC
      `);
      return stmt.all(projectId, `${keyPrefix}%`) as ProjectMetaRow[];
    }

    const stmt = this.db.prepare(`
      SELECT project_id, meta_key, meta_value, updated_at
      FROM project_memory_meta
      WHERE project_id = ?
      ORDER BY meta_key ASC
    `);
    return stmt.all(projectId) as ProjectMetaRow[];
  }

  saveLongTermMemory(memory: {
    id: string;
    project_id: string;
    type: LongTermMemoryType;
    scope: LongTermMemoryScope;
    title: string;
    summary: string;
    why?: string;
    how_to_apply?: string;
    tags?: string[];
    source: 'user-explicit' | 'agent-inferred' | 'tool-result';
    confidence: number;
    links?: string[];
    fact_key?: string;
    invalidates?: string[];
    invalidated_by?: string;
    durability?: 'stable' | 'ephemeral';
    provenance?: string[];
    valid_from?: string;
    valid_until?: string;
    last_verified_at?: string;
    created_at: string;
    updated_at: string;
  }): void {
    const normalized = {
      ...memory,
      why: memory.why ?? null,
      how_to_apply: memory.how_to_apply ?? null,
      tags: JSON.stringify(memory.tags ?? []),
      tags_text: (memory.tags ?? []).join(' '),
      links: JSON.stringify(memory.links ?? []),
      fact_key: memory.fact_key ?? null,
      invalidates: JSON.stringify(memory.invalidates ?? []),
      invalidated_by: memory.invalidated_by ?? null,
      durability: memory.durability ?? 'stable',
      provenance: JSON.stringify(memory.provenance ?? []),
      valid_from: memory.valid_from ?? null,
      valid_until: memory.valid_until ?? null,
      last_verified_at: memory.last_verified_at ?? null,
    };

    this.db.prepare(`
      INSERT INTO long_term_memories (
        id,
        project_id,
        type,
        scope,
        title,
        summary,
        why,
        how_to_apply,
        tags,
        tags_text,
        source,
        confidence,
        links,
        fact_key,
        invalidates,
        invalidated_by,
        durability,
        provenance,
        valid_from,
        valid_until,
        last_verified_at,
        created_at,
        updated_at
      ) VALUES (
        @id,
        @project_id,
        @type,
        @scope,
        @title,
        @summary,
        @why,
        @how_to_apply,
        @tags,
        @tags_text,
        @source,
        @confidence,
        @links,
        @fact_key,
        @invalidates,
        @invalidated_by,
        @durability,
        @provenance,
        @valid_from,
        @valid_until,
        @last_verified_at,
        @created_at,
        @updated_at
      )
      ON CONFLICT(project_id, id) DO UPDATE SET
        type = excluded.type,
        scope = excluded.scope,
        title = excluded.title,
        summary = excluded.summary,
        why = excluded.why,
        how_to_apply = excluded.how_to_apply,
        tags = excluded.tags,
        tags_text = excluded.tags_text,
        source = excluded.source,
        confidence = excluded.confidence,
        links = excluded.links,
        fact_key = excluded.fact_key,
        invalidates = excluded.invalidates,
        invalidated_by = excluded.invalidated_by,
        durability = excluded.durability,
        provenance = excluded.provenance,
        valid_from = excluded.valid_from,
        valid_until = excluded.valid_until,
        last_verified_at = excluded.last_verified_at,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `).run(normalized);
  }

  listLongTermMemories(projectId: string, options?: {
    types?: LongTermMemoryType[];
    scope?: LongTermMemoryScope;
  }): LongTermMemoryRow[] {
    let sql = `
      SELECT *
      FROM long_term_memories
      WHERE project_id = ?
    `;
    const params: Array<string> = [projectId];

    if (options?.scope) {
      sql += ' AND scope = ?';
      params.push(options.scope);
    }

    if (options?.types?.length) {
      sql += ` AND type IN (${options.types.map(() => '?').join(', ')})`;
      params.push(...options.types);
    }

    sql += ' ORDER BY updated_at DESC';

    return this.db.prepare(sql).all(...params) as LongTermMemoryRow[];
  }

  searchLongTermMemories(
    projectId: string,
    queryText: string,
    options?: {
      types?: LongTermMemoryType[];
      scope?: LongTermMemoryScope;
      limit?: number;
    },
  ): Array<LongTermMemoryRow & { fts_rank: number }> {
    let sql = `
      SELECT ltm.*, bm25(long_term_memories_fts) AS fts_rank
      FROM long_term_memories_fts
      JOIN long_term_memories ltm ON long_term_memories_fts.rowid = ltm.rowid
      WHERE long_term_memories_fts MATCH ?
        AND ltm.project_id = ?
    `;
    const params: Array<string | number> = [queryText.trim(), projectId];

    if (options?.scope) {
      sql += ' AND ltm.scope = ?';
      params.push(options.scope);
    }

    if (options?.types?.length) {
      sql += ` AND ltm.type IN (${options.types.map(() => '?').join(', ')})`;
      params.push(...options.types);
    }

    sql += ' ORDER BY fts_rank ASC, ltm.updated_at DESC';
    if (options?.limit) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }

    return this.db.prepare(sql).all(...params) as Array<LongTermMemoryRow & { fts_rank: number }>;
  }

  deleteLongTermMemory(projectId: string, id: string): boolean {
    const result = this.db
      .prepare('DELETE FROM long_term_memories WHERE project_id = ? AND id = ?')
      .run(projectId, id);
    return result.changes > 0;
  }

  // ===========================================
  // Feature Memories 管理
  // ===========================================

  saveMemory(memory: {
    project_id: string;
    name: string;
    responsibility: string;
    location_dir: string;
    location_files?: string[];
    api_exports?: string[];
    api_endpoints?: Array<{
      method: string;
      path: string;
      handler: string;
      description?: string;
    }>;
    dependencies?: { imports?: string[]; external?: string[] };
    data_flow?: string;
    key_patterns?: string[];
    evidence_refs?: string[];
    memory_type?: 'local' | 'shared' | 'pattern' | 'framework';
    confirmation_status?: 'suggested' | 'agent-inferred' | 'human-confirmed';
    review_status?: 'verified' | 'needs-review';
    review_reason?: string;
    review_marked_at?: string;
    snapshot_id?: string;
    updated_at?: string;
  }): number {
    const insert = this.db.prepare(`
      INSERT INTO feature_memories (
        project_id, name, responsibility, location_dir,
        location_files, api_exports, api_endpoints, dependencies, data_flow, key_patterns,
        evidence_refs, memory_type, confirmation_status, review_status, review_reason, review_marked_at, snapshot_id, updated_at
      ) VALUES (
        @project_id, @name, @responsibility, @location_dir,
        @location_files, @api_exports, @api_endpoints, @dependencies, @data_flow, @key_patterns,
        @evidence_refs, @memory_type, @confirmation_status, @review_status, @review_reason, @review_marked_at, @snapshot_id, COALESCE(@updated_at, datetime('now'))
      )
      ON CONFLICT(project_id, name) DO UPDATE SET
        responsibility = @responsibility,
        location_dir = @location_dir,
        location_files = @location_files,
        api_exports = @api_exports,
        api_endpoints = @api_endpoints,
        dependencies = @dependencies,
        data_flow = @data_flow,
        key_patterns = @key_patterns,
        evidence_refs = @evidence_refs,
        memory_type = @memory_type,
        confirmation_status = @confirmation_status,
        review_status = @review_status,
        review_reason = @review_reason,
        review_marked_at = @review_marked_at,
        snapshot_id = @snapshot_id,
        updated_at = COALESCE(@updated_at, datetime('now'))
    `);

    insert.run({
      project_id: memory.project_id,
      name: memory.name,
      responsibility: memory.responsibility,
      location_dir: memory.location_dir,
      location_files: JSON.stringify(memory.location_files || []),
      api_exports: JSON.stringify(memory.api_exports || []),
      api_endpoints: JSON.stringify(memory.api_endpoints || []),
      dependencies: JSON.stringify(memory.dependencies || {}),
      data_flow: memory.data_flow || '',
      key_patterns: JSON.stringify(memory.key_patterns || []),
      evidence_refs: JSON.stringify(memory.evidence_refs || []),
      memory_type: memory.memory_type || 'local',
      confirmation_status: memory.confirmation_status || 'human-confirmed',
      review_status: memory.review_status || 'verified',
      review_reason: memory.review_reason || null,
      review_marked_at: memory.review_marked_at || null,
      snapshot_id: memory.snapshot_id,
      updated_at: memory.updated_at,
    });

    const persistedMemory = this.getMemory(memory.project_id, memory.name);
    const memoryId = persistedMemory?.id || 0;

    // 更新共享索引
    this.updateSharedIndex(memory, memoryId);

    return memoryId;
  }

  getMemory(projectId: string, name: string): FeatureMemoryRow | null {
    const stmt = this.db.prepare(
      'SELECT * FROM feature_memories WHERE project_id = ? AND name = ?',
    );
    return stmt.get(projectId, name) as FeatureMemoryRow | null;
  }

  getMemoryById(id: number): FeatureMemoryRow | null {
    const stmt = this.db.prepare('SELECT * FROM feature_memories WHERE id = ?');
    return stmt.get(id) as FeatureMemoryRow | null;
  }

  listMemories(projectId?: string): FeatureMemoryRow[] {
    let sql = 'SELECT * FROM feature_memories';
    const params: (string | undefined)[] = [];

    if (projectId) {
      sql += ' WHERE project_id = ?';
      params.push(projectId);
    }

    sql += ' ORDER BY updated_at DESC';

    const stmt = this.db.prepare(sql);
    return stmt.all(...params.filter(Boolean)) as FeatureMemoryRow[];
  }

  deleteMemory(projectId: string, name: string): boolean {
    const existing = this.getMemory(projectId, name);
    if (!existing) {
      return false;
    }

    const deleteSharedIndexStmt = this.db.prepare('DELETE FROM shared_index WHERE memory_id = ?');
    deleteSharedIndexStmt.run(existing.id);

    const stmt = this.db.prepare('DELETE FROM feature_memories WHERE project_id = ? AND name = ?');
    const result = stmt.run(projectId, name);
    return result.changes > 0;
  }

  updateMemoryReviewStatus(
    projectId: string,
    name: string,
    review: {
      review_status: 'verified' | 'needs-review';
      review_reason?: string | null;
      review_marked_at?: string | null;
    },
  ): boolean {
    const stmt = this.db.prepare(`
      UPDATE feature_memories
      SET review_status = ?,
          review_reason = ?,
          review_marked_at = ?
      WHERE project_id = ? AND name = ?
    `);
    const result = stmt.run(
      review.review_status,
      review.review_reason ?? null,
      review.review_marked_at ?? null,
      projectId,
      name,
    );
    return result.changes > 0;
  }

  // ===========================================
  // Shared Index 管理
  // ===========================================

  private updateSharedIndex(
    memory: { name: string; responsibility: string; memory_type?: string },
    memoryId: number,
  ): void {
    // 删除旧索引
    const deleteStmt = this.db.prepare('DELETE FROM shared_index WHERE memory_id = ?');
    deleteStmt.run(memoryId);

    // 提取搜索关键词
    const keys = this.extractSearchKeys(memory);

    // 插入新索引
    const insert = this.db.prepare(`
      INSERT INTO shared_index (memory_id, search_key, category, tags)
      VALUES (?, ?, ?, ?)
    `);

    for (const key of keys) {
      insert.run(memoryId, key.key, key.category, key.tags);
    }
  }

  private extractSearchKeys(memory: {
    name: string;
    responsibility: string;
    memory_type?: string;
  }): Array<{ key: string; category: string; tags: string }> {
    const keys: Array<{ key: string; category: string; tags: string }> = [];

    // 模块名作为主要搜索键
    keys.push({
      key: memory.name.toLowerCase(),
      category: this.inferCategory(memory.name, memory.responsibility),
      tags: memory.name,
    });

    // 职责描述分词
    const words = memory.responsibility
      .toLowerCase()
      .split(/[\s,，.。]+/)
      .filter((w) => w.length > 1);

    for (const word of words.slice(0, 10)) {
      // 限制关键词数量
      keys.push({
        key: word,
        category: this.inferCategory(memory.name, memory.responsibility),
        tags: '',
      });
    }

    return keys;
  }

  private inferCategory(name: string, responsibility: string): string {
    const nameLower = name.toLowerCase();
    const respLower = responsibility.toLowerCase();

    if (nameLower.includes('auth') || respLower.includes('认证') || respLower.includes('jwt'))
      return 'auth';
    if (nameLower.includes('db') || nameLower.includes('database') || respLower.includes('数据库'))
      return 'database';
    if (nameLower.includes('api') || respLower.includes('endpoint')) return 'api';
    if (nameLower.includes('search') || respLower.includes('检索') || respLower.includes('搜索'))
      return 'search';
    if (nameLower.includes('cache') || respLower.includes('缓存')) return 'cache';

    return 'general';
  }

  // ===========================================
  // 跨项目查询（核心功能）
  // ===========================================

  /**
   * 跨项目搜索记忆
   */
  searchMemories(query: {
    queryText?: string;
    category?: string;
    moduleName?: string;
    dependencies?: string[];
    memory_type?: string;
    limit?: number;
  }): Array<FeatureMemoryRow & { project_name: string; project_path: string }> {
    const useFts = typeof query.queryText === 'string' && query.queryText.trim().length > 0;

    let sql = `
      SELECT fm.*, p.name AS project_name, p.path AS project_path
      ${useFts ? ', bm25(memories_fts) AS fts_rank' : ''}
      FROM feature_memories fm
      ${useFts ? 'JOIN memories_fts ON memories_fts.rowid = fm.id' : ''}
      JOIN projects p ON fm.project_id = p.id
      WHERE 1=1
    `;
    const params: Array<string | number> = [];

    if (useFts) {
      sql += ' AND memories_fts MATCH ?';
      params.push(query.queryText!.trim());
    }

    if (query.category) {
      sql += ` AND EXISTS (
        SELECT 1 FROM shared_index si
        WHERE si.memory_id = fm.id AND si.category = ?
      )`;
      params.push(query.category);
    }

    if (query.moduleName) {
      sql += ' AND fm.name LIKE ?';
      params.push(`%${query.moduleName}%`);
    }

    if (query.dependencies) {
      sql += ' AND fm.dependencies LIKE ?';
      params.push(`%${query.dependencies[0]}%`);
    }

    if (query.memory_type) {
      sql += ' AND fm.memory_type = ?';
      params.push(query.memory_type);
    }

    if (useFts) {
      sql += ' ORDER BY fts_rank ASC, fm.updated_at DESC';
    } else {
      sql += ' ORDER BY fm.updated_at DESC';
    }

    if (query.limit) {
      sql += ' LIMIT ?';
      params.push(query.limit);
    }

    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as Array<
      FeatureMemoryRow & { project_name: string; project_path: string }
    >;
  }

  /**
   * FTS 全文搜索
   */
  searchMemoriesFTS(
    queryText: string,
    limit: number = 20,
  ): Array<{
    id: number;
    project_id: string;
    name: string;
    responsibility: string;
    project_name: string;
    snippet: string;
  }> {
    const stmt = this.db.prepare(`
      SELECT
        fm.id,
        fm.project_id,
        fm.name,
        fm.responsibility,
        p.name AS project_name,
        snippet(memories_fts, 0, '<b>', '</b>', '...', 10) AS name_snippet,
        snippet(memories_fts, 1, '<b>', '</b>', '...', 20) AS responsibility_snippet
      FROM memories_fts
      JOIN feature_memories fm ON memories_fts.rowid = fm.id
      JOIN projects p ON fm.project_id = p.id
      WHERE memories_fts MATCH ?
      LIMIT ?
    `);

    return stmt.all(queryText, limit) as Array<{
      id: number;
      project_id: string;
      name: string;
      responsibility: string;
      project_name: string;
      snippet: string;
    }>;
  }

  /**
   * 单项目 FTS 全文搜索
   */
  searchProjectMemoriesFTS(
    projectId: string,
    queryText: string,
    limit: number = 20,
  ): FeatureMemoryRow[] {
    const stmt = this.db.prepare(`
      SELECT fm.*
      FROM memories_fts
      JOIN feature_memories fm ON memories_fts.rowid = fm.id
      WHERE memories_fts MATCH ? AND fm.project_id = ?
      LIMIT ?
    `);

    return stmt.all(queryText, projectId, limit) as FeatureMemoryRow[];
  }

  // ===========================================
  // Memory Relations 管理（跨项目引用）
  // ===========================================

  createRelation(
    fromMemoryId: number,
    toMemoryId: number,
    type: MemoryRelationRow['relation_type'],
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO memory_relations (from_memory_id, to_memory_id, relation_type)
      VALUES (?, ?, ?)
    `);
    stmt.run(fromMemoryId, toMemoryId, type);
    logger.info({ fromMemoryId, toMemoryId, type }, '记忆关系已创建');
  }

  /**
   * 获取某记忆的所有依赖（递归）
   */
  getDependencies(memoryId: number): FeatureMemoryRow[] {
    const stmt = this.db.prepare(`
      WITH RECURSIVE deps AS (
        SELECT fm.*
        FROM feature_memories fm
        WHERE fm.id = ?

        UNION ALL

        SELECT ref_fm.*
        FROM deps d
        JOIN memory_relations mr ON d.id = mr.from_memory_id
        JOIN feature_memories ref_fm ON mr.to_memory_id = ref_fm.id
      )
      SELECT * FROM deps
    `);
    return stmt.all(memoryId) as FeatureMemoryRow[];
  }

  /**
   * 获取引用某记忆的所有记忆
   */
  getDependents(memoryId: number): FeatureMemoryRow[] {
    const stmt = this.db.prepare(`
      SELECT fm.*
      FROM memory_relations mr
      JOIN feature_memories fm ON mr.from_memory_id = fm.id
      WHERE mr.to_memory_id = ?
    `);
    return stmt.all(memoryId) as FeatureMemoryRow[];
  }

  // ===========================================
  // Decision Records 管理
  // ===========================================

  saveDecision(decision: {
    project_id: string;
    decision_id: string;
    title: string;
    context?: string;
    decision: string;
    rationale?: string;
    status?: string;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO decision_records (
        project_id, decision_id, title, context, decision, rationale, status
      ) VALUES (@project_id, @decision_id, @title, @context, @decision, @rationale, @status)
      ON CONFLICT(project_id, decision_id) DO UPDATE SET
        title = @title,
        context = @context,
        decision = @decision,
        rationale = @rationale,
        status = @status
    `);
    stmt.run(decision);
  }

  getDecision(projectId: string, decisionId: string): any | null {
    const stmt = this.db.prepare(
      'SELECT * FROM decision_records WHERE project_id = ? AND decision_id = ?',
    );
    return stmt.get(projectId, decisionId);
  }

  listDecisions(projectId?: string): any[] {
    let sql = 'SELECT * FROM decision_records';
    const params: string[] = [];

    if (projectId) {
      sql += ' WHERE project_id = ?';
      params.push(projectId);
    }

    sql += ' ORDER BY created_at DESC';

    const stmt = this.db.prepare(sql);
    return stmt.all(...params);
  }

  // ===========================================
  // 统计信息
  // ===========================================

  getStats(): {
    totalProjects: number;
    totalMemories: number;
    totalRelations: number;
    totalDecisions: number;
    byCategory: Record<string, number>;
  } {
    const totalProjectsRow = this.db.prepare('SELECT COUNT(*) as count FROM projects').get() as {
      count: number;
    };
    const totalProjects = totalProjectsRow.count;

    const totalMemoriesRow = this.db
      .prepare('SELECT COUNT(*) as count FROM feature_memories')
      .get() as { count: number };
    const totalMemories = totalMemoriesRow.count;

    const totalRelationsRow = this.db
      .prepare('SELECT COUNT(*) as count FROM memory_relations')
      .get() as { count: number };
    const totalRelations = totalRelationsRow.count;

    const totalDecisionsRow = this.db
      .prepare('SELECT COUNT(*) as count FROM decision_records')
      .get() as { count: number };
    const totalDecisions = totalDecisionsRow.count;

    const byCategoryRows = this.db
      .prepare(`
      SELECT category, COUNT(*) as count
      FROM shared_index
      GROUP BY category
    `)
      .all() as Array<{ category: string; count: number }>;

    const byCategory: Record<string, number> = {};
    for (const row of byCategoryRows) {
      byCategory[row.category] = row.count;
    }

    return {
      totalProjects,
      totalMemories,
      totalRelations,
      totalDecisions,
      byCategory,
    };
  }

  close(): void {
    this.db.close();
  }
}
