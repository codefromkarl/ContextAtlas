/**
 * FeedbackLoop MCP Tool（Thin Adapter）
 *
 * Zod schema + 协议适配，业务逻辑在 application 层。
 */

import { z } from 'zod';
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
  const { executeRecordResultFeedback } = await import('../../application/memory/executeFeedbackLoop.js');
  return executeRecordResultFeedback(args, projectRoot);
}
