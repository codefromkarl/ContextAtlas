/**
 * FeedbackLoop Application Layer
 *
 * 从 MCP adapter 提取的 result feedback 业务逻辑。
 * CLI 和 MCP adapter 统一通过此入口调用。
 */

import { MemoryStore } from '../../memory/MemoryStore.js';
import { logger } from '../../utils/logger.js';
import type { ResponseFormat, MemoryToolResponse } from './memoryTypes.js';

// ===========================================
// Input 类型（Zod-free，接收已验证的 plain input）
// ===========================================

export interface RecordResultFeedbackInput {
  outcome: 'helpful' | 'not-helpful' | 'memory-stale' | 'wrong-module';
  targetType: 'code' | 'feature-memory' | 'decision-record' | 'long-term-memory';
  query: string;
  targetId?: string;
  title?: string;
  details?: string;
  format: ResponseFormat;
}

// ===========================================
// 业务逻辑
// ===========================================

export async function executeRecordResultFeedback(
  args: RecordResultFeedbackInput,
  projectRoot: string,
): Promise<MemoryToolResponse> {
  logger.info(
    { outcome: args.outcome, targetType: args.targetType, targetId: args.targetId },
    'MCP record_result_feedback 调用开始',
  );

  const store = new MemoryStore(projectRoot);
  const title =
    args.title || `${args.targetType}:${args.targetId || 'general'}:${args.outcome}`;
  const summary = [
    `outcome=${args.outcome}`,
    `targetType=${args.targetType}`,
    args.targetId ? `target=${args.targetId}` : undefined,
    `query=${args.query}`,
    args.details ? `details=${args.details}` : undefined,
  ]
    .filter(Boolean)
    .join(' | ');

  const { memory, action } = await store.appendLongTermMemoryItem({
    type: 'feedback',
    title,
    summary,
    why: args.details || `反馈用于修正 ${args.targetType} 结果质量`,
    howToApply: `后续检索到 ${args.targetId || args.targetType} 时优先参考这条反馈`,
    tags: ['feedback', args.outcome, args.targetType, ...(args.targetId ? [args.targetId] : [])],
    scope: 'project',
    source: 'user-explicit',
    confidence: 1,
    durability: 'stable',
    provenance: [args.query, args.targetId || args.targetType],
    lastVerifiedAt: new Date().toISOString(),
  });

  if (args.format === 'json') {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              tool: 'record_result_feedback',
              write_action: action,
              memory,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  return {
    content: [
      {
        type: 'text',
        text: `## Result Feedback Recorded\n\n- **Outcome**: ${args.outcome}\n- **Target Type**: ${args.targetType}\n- **Target ID**: ${args.targetId || 'N/A'}\n- **Saved Memory ID**: ${memory.id}`,
      },
    ],
  };
}
