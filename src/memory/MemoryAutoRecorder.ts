/**
 * MemoryAutoRecorder - 自动记忆记录器
 *
 * 在特定触发条件下自动记录或建议记录功能记忆与长期记忆
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';
import { MemoryStore } from './MemoryStore.js';
import type { LongTermMemoryItem } from './types.js';

interface AutoRecordTrigger {
  type: 'module-not-found' | 'new-file-created' | 'session-end' | 'explicit-request';
  context: {
    moduleName?: string;
    filePaths?: string[];
    conversationSummary?: string;
    projectRoot?: string;
  };
}

export interface ExtractedMemoryInfo {
  name: string;
  responsibility: string;
  dir: string;
  files: string[];
  exports?: string[];
  imports?: string[];
  dataFlow?: string;
  confidence: number; // 0-1，置信度
}

export interface AutoRecordSuggestion {
  shouldSuggest: boolean;
  shouldAutoRecord: boolean;
  suggestedMemory?: ExtractedMemoryInfo;
  suggestedLongTermMemories?: LongTermMemoryItem[];
}

export class MemoryAutoRecorder {
  private readonly store: MemoryStore;
  private readonly autoRecordEnabled: boolean;
  private readonly suggestionThreshold: number;

  constructor(
    projectRoot: string,
    options?: { autoRecord?: boolean; suggestionThreshold?: number },
  ) {
    this.store = new MemoryStore(projectRoot);
    this.autoRecordEnabled = options?.autoRecord ?? false;
    this.suggestionThreshold = options?.suggestionThreshold ?? 0.7;
  }

  /**
   * 处理触发事件
   */
  async onTrigger(trigger: AutoRecordTrigger): Promise<{
    shouldSuggest: boolean;
    shouldAutoRecord: boolean;
    suggestedMemory?: ExtractedMemoryInfo;
    suggestedLongTermMemories?: LongTermMemoryItem[];
  }> {
    logger.info({ type: trigger.type }, 'MemoryAutoRecorder 触发');

    switch (trigger.type) {
      case 'module-not-found':
        return trigger.context.moduleName
          ? this.handleModuleNotFound(trigger.context.moduleName)
          : { shouldSuggest: false, shouldAutoRecord: false };

      case 'new-file-created':
        return trigger.context.filePaths
          ? this.handleNewFiles(trigger.context.filePaths)
          : { shouldSuggest: false, shouldAutoRecord: false };

      case 'session-end':
        return trigger.context.conversationSummary
          ? this.handleSessionEnd(trigger.context.conversationSummary)
          : { shouldSuggest: false, shouldAutoRecord: false, suggestedLongTermMemories: [] };

      case 'explicit-request':
        // 显式请求直接处理
        return { shouldSuggest: false, shouldAutoRecord: true };
    }
  }

  /**
   * 处理模块未找到
   */
  private async handleModuleNotFound(moduleName: string): Promise<{
    shouldSuggest: boolean;
    shouldAutoRecord: boolean;
  }> {
    // 检查是否已存在
    const existing = await this.store.readFeature(moduleName);
    if (existing) {
      return { shouldSuggest: false, shouldAutoRecord: false };
    }

    // 总是建议记录
    return {
      shouldSuggest: true,
      shouldAutoRecord: false,
    };
  }

  /**
   * 处理新文件创建
   */
  private async handleNewFiles(filePaths: string[]): Promise<{
    shouldSuggest: boolean;
    shouldAutoRecord: boolean;
    suggestedMemory?: ExtractedMemoryInfo;
  }> {
    // 分析文件，提取可能的模块信息
    const info = await this.extractMemoryFromFiles(filePaths);

    if (info.confidence >= this.suggestionThreshold) {
      return {
        shouldSuggest: true,
        shouldAutoRecord: this.autoRecordEnabled,
        suggestedMemory: info,
      };
    }

    return { shouldSuggest: false, shouldAutoRecord: false };
  }

  /**
   * 处理会话结束
   */
  private async handleSessionEnd(summary: string): Promise<{
    shouldSuggest: boolean;
    shouldAutoRecord: boolean;
    suggestedMemory?: ExtractedMemoryInfo;
    suggestedLongTermMemories?: LongTermMemoryItem[];
  }> {
    // 从会话摘要中提取新模块信息
    const info = await this.extractMemoryFromSummary(summary);
    const longTermMemories = this.extractLongTermMemoriesFromSummary(summary);

    const suggestedMemory = info && info.confidence >= this.suggestionThreshold ? info : undefined;
    const suggestedLongTermMemories = longTermMemories.filter(
      (memory) => memory.confidence >= this.suggestionThreshold,
    );

    if (suggestedMemory || suggestedLongTermMemories.length > 0) {
      return {
        shouldSuggest: true,
        shouldAutoRecord: this.autoRecordEnabled,
        suggestedMemory,
        suggestedLongTermMemories,
      };
    }

    return { shouldSuggest: false, shouldAutoRecord: false, suggestedLongTermMemories: [] };
  }

  /**
   * 从文件提取记忆信息
   */
  async extractMemoryFromFiles(filePaths: string[]): Promise<ExtractedMemoryInfo> {
    const dirs = new Set(filePaths.map((f) => path.dirname(f)));
    const dir = dirs.size === 1 ? Array.from(dirs)[0] : 'src/';

    // 从目录名推断模块名
    const moduleName = path.basename(dir);

    // 尝试读取文件内容，提取导出信息
    const exportsList: string[] = [];
    const importsList: string[] = [];

    for (const filePath of filePaths.slice(0, 5)) {
      // 限制文件数量
      try {
        const content = await fs.readFile(filePath, 'utf-8');

        // 提取 export 语句
        const exportMatches = content.matchAll(
          /export\s+(?:const|let|var|function|class|interface|type)\s+(\w+)/g,
        );
        for (const match of exportMatches) {
          exportsList.push(match[1]);
        }

        // 提取 import 语句
        const importMatches = content.matchAll(/import\s+.*\s+from\s+['"]([^'"]+)['"]/g);
        for (const match of importMatches) {
          importsList.push(match[1]);
        }
      } catch {
        // 文件读取失败，跳过
      }
    }

    // 计算置信度
    let confidence = 0.5;
    if (exportsList.length > 0) confidence += 0.2;
    if (filePaths.length > 0) confidence += 0.1;

    return {
      name: moduleName,
      responsibility: '', // 需要 AI 填充
      dir,
      files: filePaths.map((f) => path.basename(f)),
      exports: exportsList.slice(0, 10),
      imports: [...new Set(importsList)].slice(0, 10),
      confidence: Math.min(confidence, 0.9),
    };
  }

  /**
   * 从会话摘要提取记忆信息
   */
  private async extractMemoryFromSummary(summary: string): Promise<ExtractedMemoryInfo | null> {
    // 使用 AI 分析会话摘要，提取模块信息
    // 这里提供一个基于规则的简化实现，实际生产环境应调用 LLM

    // 从会话摘要中提取可能的模块名（通过常见模式）
    const modulePatterns = [
      /(?:创建了 | 实现了 | 修改了 | 开发了)\s*(?:一个\s*)?(\w+(?:Service|Module|Controller|Repository|Store|Manager))/g,
      /(?:add|create|implement|modify|develop)\s*(?:a\s+)?(\w+(?:Service|Module|Controller|Repository|Store|Manager))/gi,
    ];

    let moduleName: string | null = null;
    for (const pattern of modulePatterns) {
      const match = pattern.exec(summary);
      if (match) {
        moduleName = match[1];
        break;
      }
    }

    if (!moduleName) {
      return null;
    }

    // 从会话中提取相关文件路径（简单实现）
    const filePattern = /[\w./]+\.(ts|js|tsx|jsx|py|go|rs|java)/g;
    const files = summary.match(filePattern) || [];
    const uniqueFiles = [...new Set(files)];

    // 推断目录
    const dirs = uniqueFiles.map((f) => path.dirname(f));
    const dir = dirs.length > 0 && dirs[0] !== '.' ? dirs[0] : 'src/';

    // 提取职责描述（简化：取摘要中包含模块名的句子）
    const sentences = summary.split(/[.!?。！？]/);
    const responsibilitySentence = sentences.find((s) => s.includes(moduleName)) || '';

    // 计算置信度
    let confidence = 0.3;
    if (uniqueFiles.length > 0) confidence += 0.2;
    if (responsibilitySentence.length > 20) confidence += 0.2;
    if (moduleName.length > 3) confidence += 0.1;

    return {
      name: moduleName,
      responsibility: responsibilitySentence.trim(),
      dir,
      files: uniqueFiles.map((f) => path.basename(f)),
      exports: [moduleName], // 假设模块名即导出名
      confidence: Math.min(confidence, 0.9),
    };
  }

  private extractLongTermMemoriesFromSummary(summary: string): LongTermMemoryItem[] {
    const normalized = summary.replace(/\s+/g, ' ').trim();
    if (!normalized) {
      return [];
    }

    const items: LongTermMemoryItem[] = [];
    const now = new Date().toISOString();
    const sentences = normalized
      .split(/[。！？!?]/)
      .map((sentence) => sentence.trim())
      .filter(Boolean);

    for (const sentence of sentences) {
      const urlMatches = [...sentence.matchAll(/https?:\/\/[^\s]+/g)].map((match) => match[0]);
      if (urlMatches.length > 0) {
        items.push({
          id: `reference-${Buffer.from(sentence).toString('base64url').slice(0, 12)}`,
          type: 'reference',
          title: sentence.includes('Grafana') ? '外部引用: Grafana 仪表盘' : '外部引用',
          summary: sentence,
          howToApply: '当需要查看外部系统状态或文档时优先参考这里。',
          tags: ['external-reference'],
          scope: 'project',
          source: 'agent-inferred',
          confidence: 0.9,
          links: urlMatches,
          createdAt: now,
          updatedAt: now,
        });
      }

      if (/(必须|不要|别|以后|统一|提交前)/.test(sentence)) {
        const whyMatch = sentence.match(/因为(.+)$/);
        items.push({
          id: `feedback-${Buffer.from(sentence).toString('base64url').slice(0, 12)}`,
          type: 'feedback',
          title: this.buildFeedbackTitle(sentence),
          summary: sentence,
          why: whyMatch?.[1]?.trim(),
          howToApply: sentence,
          tags: ['workflow'],
          scope: 'project',
          source: 'agent-inferred',
          confidence: 0.88,
          createdAt: now,
          updatedAt: now,
        });
      }

      const validUntilMatch = sentence.match(/\b(\d{4}-\d{2}-\d{2})\b/);
      if (
        /(迁移|截止|完成了|接下来|下一步|进行中)/.test(sentence) &&
        !items.some((item) => item.summary === sentence && item.type === 'project-state')
      ) {
        items.push({
          id: `project-state-${Buffer.from(sentence).toString('base64url').slice(0, 12)}`,
          type: 'project-state',
          title: this.buildProjectStateTitle(sentence),
          summary: sentence,
          howToApply: '继续相关工作前先参考当前进度与约束。',
          tags: ['project-state'],
          scope: 'project',
          source: 'agent-inferred',
          confidence: 0.84,
          validUntil: validUntilMatch?.[1],
          createdAt: now,
          updatedAt: now,
        });
      }

      if (/(我(更)?熟悉|第一次接触|偏好|希望你|解释尽量)/.test(sentence)) {
        items.push({
          id: `user-${Buffer.from(sentence).toString('base64url').slice(0, 12)}`,
          type: 'user',
          title: '用户画像 / 偏好',
          summary: sentence,
          howToApply: '后续解释和协作方式应参考该偏好。',
          tags: ['user-preference'],
          scope: 'global-user',
          source: 'agent-inferred',
          confidence: 0.82,
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    return this.deduplicateLongTermMemories(items);
  }

  private deduplicateLongTermMemories(items: LongTermMemoryItem[]): LongTermMemoryItem[] {
    const seen = new Set<string>();
    return items.filter((item) => {
      const key = `${item.type}:${item.scope}:${item.summary}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  private buildFeedbackTitle(sentence: string): string {
    if (sentence.includes('lint')) {
      return '提交前先跑 lint';
    }
    if (sentence.includes('不要')) {
      return '用户纠正的行为规则';
    }
    return '团队/协作反馈';
  }

  private buildProjectStateTitle(sentence: string): string {
    const migrationTarget = sentence.match(/(\S+模块迁移)/)?.[1];
    if (migrationTarget) {
      return `${migrationTarget}状态`;
    }
    return '项目状态更新';
  }

  /**
   * 保存记忆
   */
  async saveMemory(info: ExtractedMemoryInfo): Promise<string> {
    const memory = {
      name: info.name,
      responsibility: info.responsibility || '待补充',
      location: {
        dir: info.dir,
        files: info.files,
      },
      api: {
        exports: info.exports || [],
        endpoints: [],
      },
      dependencies: {
        imports: info.imports || [],
        external: [],
      },
      dataFlow: '',
      keyPatterns: [],
      lastUpdated: new Date().toISOString(),
    };

    return this.store.saveFeature(memory);
  }
}
