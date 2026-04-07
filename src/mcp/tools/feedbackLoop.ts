import { z } from 'zod';
import { MemoryStore } from '../../memory/MemoryStore.js';
import { logger } from '../../utils/logger.js';
import { responseFormatSchema } from './responseFormat.js';

export const recordResultFeedbackSchema = z.object({
  outcome: z
    .enum(['helpful', 'not-helpful', 'memory-stale', 'wrong-module'])
    .describe('Feedback outcome for the retrieval result'),
  targetType: z
    .enum(['code', 'feature-memory', 'decision-record', 'long-term-memory'])
    .describe('What the feedback is about'),
  query: z.string().describe('Original user query or information request'),
  targetId: z.string().optional().describe('Target identifier, such as module name or decision id'),
  title: z.string().optional().describe('Optional short title for the feedback entry'),
  details: z.string().optional().describe('Optional detailed user feedback'),
  format: responseFormatSchema,
});

export type RecordResultFeedbackInput = z.infer<typeof recordResultFeedbackSchema>;

export async function handleRecordResultFeedback(
  args: RecordResultFeedbackInput,
  projectRoot: string,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
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
