/**
 * AutoRecord Application Layer
 *
 * CLI 和 MCP adapter 统一通过此入口调用自动记忆记录业务逻辑。
 */

import path from 'node:path';
import { MemoryAutoRecorder } from '../../memory/MemoryAutoRecorder.js';
import { MemoryHubDatabase } from '../../memory/MemoryHubDatabase.js';
import { MemoryStore } from '../../memory/MemoryStore.js';
import type { LongTermMemoryItem, ResolvedLongTermMemoryItem, TaskCheckpoint } from '../../memory/types.js';
import { logger } from '../../utils/logger.js';
import type { MemoryToolResponse } from './memoryTypes.js';

// ===========================================
// Input 类型
// ===========================================

export interface SessionEndInput {
  summary: string;
  project?: string;
  autoRecord?: boolean;
}

export interface SuggestMemoryInput {
  project?: string;
  moduleName: string;
  files?: string[];
}

// ===========================================
// Helpers
// ===========================================

function resolveProjectRoot(projectId?: string): string {
  const fallback = process.cwd();
  if (!projectId) {
    return fallback;
  }

  if (path.isAbsolute(projectId)) {
    return path.resolve(projectId);
  }

  const db = MemoryHubDatabase.getDefault();
  try {
    const project = db.getProject(projectId);
    if (!project?.path) {
      return fallback;
    }
    return path.resolve(project.path);
  } finally {
    db.close();
  }
}

function formatCheckpointSavedBlock(checkpoint: TaskCheckpoint, savedTo: string): string {
  return [
    '### 任务检查点',
    `- **标题**: ${checkpoint.title}`,
    `- **阶段**: ${checkpoint.phase}`,
    `- **目标**: ${checkpoint.goal}`,
    `- **Summary**: ${checkpoint.summary}`,
    `- **Saved to**: ${savedTo}`,
  ].join('\n');
}

function formatCheckpointSuggestionBlock(checkpoint: TaskCheckpoint): string {
  return [
    '## 检测到会话检查点',
    `**标题**: ${checkpoint.title}`,
    `**阶段**: ${checkpoint.phase}`,
    `**目标**: ${checkpoint.goal}`,
    '',
    '建议启用 `autoRecord=true` 以自动保存正式 checkpoint。',
  ].join('\n');
}

async function persistGovernedLongTermMemory(
  store: MemoryStore,
  memory: LongTermMemoryItem,
): Promise<{ memory: LongTermMemoryItem; action: 'created' | 'merged' | 'updated' }> {
  if (memory.type !== 'project-state' && memory.type !== 'reference') {
    return store.appendLongTermMemoryItem(memory);
  }

  const existing = await store.listLongTermMemories({
    types: [memory.type],
    scope: memory.scope,
    includeExpired: true,
  });
  const activePeer = existing.find((item) => shouldSupersede(item, memory));

  if (!activePeer) {
    return store.appendLongTermMemoryItem(memory);
  }

  await store.appendLongTermMemoryItem({
    ...activePeer,
    validUntil: new Date().toISOString().slice(0, 10),
    provenance: [...new Set([...(activePeer.provenance || []), `superseded-by:${memory.id}`])],
  });

  return store.appendLongTermMemoryItem({
    ...memory,
    provenance: [...new Set([...(memory.provenance || []), `supersedes:${activePeer.id}`])],
  });
}

function shouldSupersede(
  existing: ResolvedLongTermMemoryItem,
  next: LongTermMemoryItem,
): boolean {
  if (existing.status === 'expired' || existing.status === 'superseded') {
    return false;
  }

  return existing.type === next.type
    && existing.scope === next.scope
    && existing.title === next.title
    && existing.summary !== next.summary;
}

// ===========================================
// Handlers
// ===========================================

export async function executeSessionEnd(
  args: SessionEndInput,
): Promise<MemoryToolResponse> {
  const { summary, project, autoRecord } = args;

  logger.info({ project, autoRecord, summaryLength: summary.length }, 'MCP session_end 调用开始');

  const projectRoot = resolveProjectRoot(project);
  const recorder = new MemoryAutoRecorder(projectRoot, { autoRecord: Boolean(autoRecord) });
  const triggerResult = await recorder.onTrigger({
    type: 'session-end',
    context: { conversationSummary: summary, projectRoot },
  });

  const suggestedMemory = triggerResult.suggestedMemory;
  const suggestedLongTermMemories = triggerResult.suggestedLongTermMemories || [];
  const suggestedCheckpoint = triggerResult.suggestedCheckpoint;
  const shouldAutoRecord = Boolean(autoRecord || triggerResult.shouldAutoRecord);

  if (
    !triggerResult.shouldSuggest &&
    !shouldAutoRecord &&
    !suggestedCheckpoint
  ) {
    return {
      content: [
        {
          type: 'text',
          text: '会话分析完成，未检测到需要记录的新模块或长期记忆。',
        },
      ],
    };
  }

  // 如果启用自动记录，直接保存
  if (shouldAutoRecord) {
    const store = new MemoryStore(projectRoot);
    const savedBlocks: string[] = [];

    if (suggestedMemory) {
      const filePath = await store.saveFeature({
        name: suggestedMemory.name,
        responsibility: suggestedMemory.responsibility || '待补充',
        location: {
          dir: suggestedMemory.dir,
          files: suggestedMemory.files,
        },
        api: {
          exports: suggestedMemory.exports || [],
          endpoints: [],
        },
        dependencies: {
          imports: suggestedMemory.imports || [],
          external: [],
        },
        dataFlow: suggestedMemory.dataFlow || '',
        keyPatterns: [],
        lastUpdated: new Date().toISOString(),
        confirmationStatus: 'agent-inferred',
      });

      savedBlocks.push(
        `### 模块记忆\n- **模块名**: ${suggestedMemory.name}\n- **职责**: ${suggestedMemory.responsibility || '待补充'}\n- **确认状态**: agent-inferred\n- **目录**: ${suggestedMemory.dir}\n- **文件**: ${suggestedMemory.files.join(', ')}\n- **导出**: ${suggestedMemory.exports?.join(', ') || 'N/A'}\n- **Saved to**: ${filePath}`,
      );
    }

    if (suggestedLongTermMemories.length > 0) {
      const persisted = [];
      for (const memory of suggestedLongTermMemories) {
        persisted.push(await persistGovernedLongTermMemory(store, memory));
      }

      savedBlocks.push(
        `### 长期记忆\n${persisted.map(({ memory, action }) => `- **${memory.type}**: ${memory.title} (${action})`).join('\n')}`,
      );
    }

    if (suggestedCheckpoint) {
      const savedTo = await store.saveCheckpoint(suggestedCheckpoint);
      savedBlocks.push(formatCheckpointSavedBlock(suggestedCheckpoint, savedTo));
    }

    return {
      content: [
        {
          type: 'text',
          text: `## 会话记忆已自动保存\n\n${savedBlocks.join('\n\n')}`,
        },
      ],
    };
  }

  // 否则返回建议，等待用户确认
  const suggestionBlocks: string[] = [];

  if (suggestedMemory) {
    suggestionBlocks.push(
      `## 检测到新模块，建议记录记忆\n\n**模块名**: ${suggestedMemory.name}\n\n**职责**: ${suggestedMemory.responsibility || '待补充'}\n\n**建议状态**: suggested\n\n**目录**: ${suggestedMemory.dir}\n\n**文件**: ${suggestedMemory.files.join(', ')}\n\n**导出**: ${suggestedMemory.exports?.join(', ') || 'N/A'}\n\n**置信度**: ${(suggestedMemory.confidence * 100).toFixed(0)}%\n\n---\n\n**调用 record_memory 确认记录**:\n\`\`\`json\n{\n  "name": "${suggestedMemory.name}",\n  "responsibility": "${suggestedMemory.responsibility || '待补充'}",\n  "dir": "${suggestedMemory.dir}",\n  "files": ${JSON.stringify(suggestedMemory.files)},\n  "exports": ${JSON.stringify(suggestedMemory.exports || [])},\n  "confirmationStatus": "human-confirmed"\n}\n\`\`\``,
    );
  }

  if (suggestedLongTermMemories.length > 0) {
    suggestionBlocks.push(
      `## 检测到长期记忆候选\n\n${suggestedLongTermMemories
        .map(
          (memory) =>
            `- **${memory.type}**: ${memory.title} | ${memory.summary} | 置信度 ${(memory.confidence * 100).toFixed(0)}%`,
        )
        .join('\n')}`,
    );
  }

  if (suggestedCheckpoint) {
    suggestionBlocks.push(formatCheckpointSuggestionBlock(suggestedCheckpoint));
  }

  return {
    content: [
      {
        type: 'text',
        text: `${suggestionBlocks.join('\n\n---\n\n')}\n\n或 **调用 session_end with autoRecord=true 自动记录**`,
      },
    ],
  };
}

export async function executeSuggestMemory(
  args: SuggestMemoryInput,
): Promise<MemoryToolResponse> {
  const { project, moduleName, files } = args;

  logger.info({ project, moduleName, files }, 'MCP suggest_memory 调用开始');

  const projectRoot = resolveProjectRoot(project);
  const recorder = new MemoryAutoRecorder(projectRoot);
  await recorder.onTrigger({
    type: 'explicit-request',
    context: {
      moduleName,
      filePaths: files,
      projectRoot,
    },
  });

  // 直接从文件提取信息
  const info = files && files.length > 0 ? await recorder.extractMemoryFromFiles(files) : null;

  return {
    content: [
      {
        type: 'text',
        text: `## 建议记录模块\n\n**模块名**: ${moduleName}\n\n**建议状态**: suggested\n\n**目录**: ${info?.dir || 'src/'}\n\n**文件**: ${files?.join(', ') || '待指定'}\n\n**导出**: ${info?.exports?.join(', ') || '待分析'}\n\n---\n\n**调用 record_memory 确认记录**`,
      },
    ],
  };
}
