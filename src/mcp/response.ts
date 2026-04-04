import { ZodError, z } from 'zod';

const toolTextContentSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

const toolTextResponseSchema = z.object({
  content: z.array(toolTextContentSchema).min(1),
  isError: z.boolean().optional(),
});

export type ToolTextResponse = z.infer<typeof toolTextResponseSchema>;

export function createTextResponse(text: string, isError = false): ToolTextResponse {
  return {
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
  };
}

export function createInvalidArgumentsResponse(toolName: string, error: ZodError): ToolTextResponse {
  const details = error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : 'arguments';
      return `- ${path}: ${issue.message}`;
    })
    .join('\n');

  return createTextResponse(
    [`Invalid arguments for ${toolName}.`, '', details || '- arguments: invalid input'].join('\n'),
    true,
  );
}

export function createInternalErrorResponse(toolName: string, message: string): ToolTextResponse {
  return createTextResponse(`Error in ${toolName}: ${message}`, true);
}

export function validateToolTextResponse(response: unknown): ToolTextResponse {
  return toolTextResponseSchema.parse(response);
}
