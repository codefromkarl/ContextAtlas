/**
 * AutoRecord MCP Tools
 *
 * 提供自动记忆记录能力，支持会话结束时自动提取和记录记忆
 */

import path from 'node:path';
import { z } from 'zod';
import { MemoryAutoRecorder } from '../../memory/MemoryAutoRecorder.js';
import { MemoryHubDatabase } from '../../memory/MemoryHubDatabase.js';
import { MemoryStore } from '../../memory/MemoryStore.js';
import { logger } from '../../utils/logger.js';

// ===========================================
// Schema 定义
// ===========================================

export const sessionEndSchema = z.object({
  summary: z.string().describe('Session summary or conversation transcript'),
  project: z
    .string()
    .optional()
    .describe('Deprecated project label; project identity is now derived from path'),
  autoRecord: z
    .boolean()
    .optional()
    .default(false)
    .describe('Whether to auto-record without confirmation'),
});

export const suggestMemorySchema = z.object({
  project: z
    .string()
    .optional()
    .describe('Deprecated project label; project identity is now derived from path'),
  moduleName: z.string().describe('Module name'),
  files: z.array(z.string()).optional().describe('Related file paths'),
});

// ===========================================
// 类型定义
// ===========================================

export type SessionEndInput = z.infer<typeof sessionEndSchema>;
export type SuggestMemoryInput = z.infer<typeof suggestMemorySchema>;

// ===========================================
// 工具处理函数
// ===========================================

/**
 * 处理会话结束，自动提取并建议记录记忆
 */
export async function handleSessionEnd(
  args: SessionEndInput,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const { summary, project, autoRecord } = args;

  logger.info({ project, autoRecord, summaryLength: summary.length }, 'MCP session_end 调用开始');

  const projectRoot = resolveProjectRoot(project);
  const recorder = new MemoryAutoRecorder(projectRoot);
  const triggerResult = await recorder.onTrigger({
    type: 'session-end',
    context: { conversationSummary: summary, projectRoot },
  });

  const suggestedMemory = triggerResult.suggestedMemory;
  const suggestedLongTermMemories = triggerResult.suggestedLongTermMemories || [];

  if (
    !triggerResult.shouldSuggest ||
    (!suggestedMemory && suggestedLongTermMemories.length === 0)
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
  if (autoRecord || triggerResult.shouldAutoRecord) {
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
      });

      savedBlocks.push(
        `### 模块记忆\n- **模块名**: ${suggestedMemory.name}\n- **职责**: ${suggestedMemory.responsibility || '待补充'}\n- **目录**: ${suggestedMemory.dir}\n- **文件**: ${suggestedMemory.files.join(', ')}\n- **导出**: ${suggestedMemory.exports?.join(', ') || 'N/A'}\n- **Saved to**: ${filePath}`,
      );
    }

    if (suggestedLongTermMemories.length > 0) {
      const persisted = [];
      for (const memory of suggestedLongTermMemories) {
        persisted.push(await store.appendLongTermMemoryItem(memory));
      }

      savedBlocks.push(
        `### 长期记忆\n${persisted.map((memory) => `- **${memory.type}**: ${memory.title}`).join('\n')}`,
      );
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
      `## 检测到新模块，建议记录记忆\n\n**模块名**: ${suggestedMemory.name}\n\n**职责**: ${suggestedMemory.responsibility || '待补充'}\n\n**目录**: ${suggestedMemory.dir}\n\n**文件**: ${suggestedMemory.files.join(', ')}\n\n**导出**: ${suggestedMemory.exports?.join(', ') || 'N/A'}\n\n**置信度**: ${(suggestedMemory.confidence * 100).toFixed(0)}%\n\n---\n\n**调用 record_memory 确认记录**:\n\`\`\`json\n{\n  "name": "${suggestedMemory.name}",\n  "responsibility": "${suggestedMemory.responsibility || '待补充'}",\n  "dir": "${suggestedMemory.dir}",\n  "files": ${JSON.stringify(suggestedMemory.files)},\n  "exports": ${JSON.stringify(suggestedMemory.exports || [])}\n}\n\`\`\``,
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

  return {
    content: [
      {
        type: 'text',
        text: `${suggestionBlocks.join('\n\n---\n\n')}\n\n或 **调用 session_end with autoRecord=true 自动记录**`,
      },
    ],
  };
}

/**
 * 根据文件名建议记忆
 */
export async function handleSuggestMemory(
  args: SuggestMemoryInput,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
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
        text: `## 建议记录模块\n\n**模块名**: ${moduleName}\n\n**目录**: ${info?.dir || 'src/'}\n\n**文件**: ${files?.join(', ') || '待指定'}\n\n**导出**: ${info?.exports?.join(', ') || '待分析'}\n\n---\n\n**调用 record_memory 确认记录**`,
      },
    ],
  };
}

function resolveProjectRoot(projectId?: string): string {
  const fallback = process.cwd();
  if (!projectId) {
    return fallback;
  }

  if (path.isAbsolute(projectId)) {
    return path.resolve(projectId);
  }

  const db = new MemoryHubDatabase();
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
