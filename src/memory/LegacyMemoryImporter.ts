/**
 * LegacyMemoryImporter - 旧 .project-memory 文件导入器
 *
 * 仅在 SQLite 中不存在项目记忆时触发一次性导入。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';
import { MemoryHubDatabase } from './MemoryHubDatabase.js';
import type { DecisionRecord, FeatureMemory, GlobalMemory, GlobalMemoryType } from './types.js';

const LEGACY_GLOBAL_FILES: GlobalMemoryType[] = ['profile', 'conventions', 'cross-cutting'];

export interface LegacyImportParams {
  projectRoot: string;
  projectId: string;
  hub: MemoryHubDatabase;
  catalogMetaKey: string;
  globalMetaPrefix: string;
}

export interface LegacyImportResult {
  importedFeatures: number;
  importedDecisions: number;
  importedGlobals: number;
  importedCatalog: boolean;
}

export async function importLegacyProjectMemoryIfNeeded(
  params: LegacyImportParams,
): Promise<LegacyImportResult> {
  const { projectRoot, projectId, hub, catalogMetaKey, globalMetaPrefix } = params;

  const existingMemories = hub.listMemories(projectId).length;
  const existingCatalog = hub.getProjectMeta(projectId, catalogMetaKey);
  const existingGlobals = hub.listProjectMeta(projectId, globalMetaPrefix).length;

  if (existingMemories > 0 || existingCatalog || existingGlobals > 0) {
    return {
      importedFeatures: 0,
      importedDecisions: 0,
      importedGlobals: 0,
      importedCatalog: false,
    };
  }

  const memoryDir = path.join(projectRoot, '.project-memory');
  const featuresDir = path.join(memoryDir, 'features');
  const decisionsDir = path.join(memoryDir, 'decisions');
  const globalDir = path.join(memoryDir, 'global');

  let importedFeatures = 0;
  let importedDecisions = 0;
  let importedGlobals = 0;
  let importedCatalog = false;

  // 1) 导入 feature 记忆
  try {
    const featureFiles = await fs.readdir(featuresDir);
    for (const file of featureFiles) {
      if (!file.endsWith('.json')) continue;

      try {
        const raw = await fs.readFile(path.join(featuresDir, file), 'utf-8');
        const memory = JSON.parse(raw) as FeatureMemory;
        hub.saveMemory({
          project_id: projectId,
          name: memory.name,
          responsibility: memory.responsibility,
          location_dir: memory.location.dir,
          location_files: memory.location.files,
          api_exports: memory.api.exports,
          api_endpoints: memory.api.endpoints || [],
          dependencies: memory.dependencies,
          data_flow: memory.dataFlow,
          key_patterns: memory.keyPatterns,
          memory_type: memory.memoryType || 'local',
        });
        importedFeatures += 1;
      } catch {
        // 跳过损坏文件
      }
    }
  } catch {
    // 旧目录不存在
  }

  // 2) 导入 catalog
  try {
    const rawCatalog = await fs.readFile(path.join(memoryDir, 'catalog.json'), 'utf-8');
    hub.setProjectMeta(projectId, catalogMetaKey, rawCatalog);
    importedCatalog = true;
  } catch {
    // 无旧 catalog
  }

  // 3) 导入 global/*.json
  try {
    const globalFiles = await fs.readdir(globalDir);
    for (const file of globalFiles) {
      if (!file.endsWith('.json')) continue;

      const type = path.basename(file, '.json');
      const raw = await fs.readFile(path.join(globalDir, file), 'utf-8');
      hub.setProjectMeta(projectId, `${globalMetaPrefix}${type}`, raw);
      importedGlobals += 1;
    }
  } catch {
    // 无旧 global
  }

  // 4) 导入旧根目录的 profile/conventions/cross-cutting
  for (const type of LEGACY_GLOBAL_FILES) {
    const metaKey = `${globalMetaPrefix}${type}`;
    if (hub.getProjectMeta(projectId, metaKey)) {
      continue;
    }

    try {
      const raw = await fs.readFile(path.join(memoryDir, `${type}.json`), 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const wrapped: GlobalMemory = {
        type,
        data: parsed,
        lastUpdated: new Date().toISOString(),
      };
      hub.setProjectMeta(projectId, metaKey, JSON.stringify(wrapped));
      importedGlobals += 1;
    } catch {
      // 忽略不存在文件
    }
  }

  // 5) 导入 decisions
  try {
    const decisionFiles = await fs.readdir(decisionsDir);
    for (const file of decisionFiles) {
      if (!file.endsWith('.json')) continue;

      try {
        const raw = await fs.readFile(path.join(decisionsDir, file), 'utf-8');
        const decision = JSON.parse(raw) as DecisionRecord;
        const contextPayload = JSON.stringify({
          context: decision.context,
          alternatives: decision.alternatives,
          consequences: decision.consequences,
          date: decision.date,
        });

        hub.saveDecision({
          project_id: projectId,
          decision_id: decision.id,
          title: decision.title,
          context: contextPayload,
          decision: decision.decision,
          rationale: decision.rationale,
          status: decision.status,
        });
        importedDecisions += 1;
      } catch {
        // 跳过损坏文件
      }
    }
  } catch {
    // 无旧 decision 目录
  }

  if (importedFeatures > 0 || importedDecisions > 0 || importedGlobals > 0 || importedCatalog) {
    logger.info(
      {
        projectId,
        importedFeatures,
        importedDecisions,
        importedGlobals,
        importedCatalog,
      },
      '已从旧 .project-memory 导入到 SQLite',
    );
  }

  return {
    importedFeatures,
    importedDecisions,
    importedGlobals,
    importedCatalog,
  };
}
