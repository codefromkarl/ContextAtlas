import { z } from 'zod';

export const responseFormatSchema = z
  .preprocess(
    (value) => (value === 'markdown' ? 'text' : value),
    z.enum(['text', 'json']).optional().default('text'),
  )
  .describe('Response format: text, markdown(alias of text), or json');

export function createResponseFormatInputSchemaProperty(): {
  type: 'string';
  enum: ['text', 'markdown', 'json'];
  description: string;
  default: 'text';
} {
  return {
    type: 'string',
    enum: ['text', 'markdown', 'json'],
    description: 'Response format (markdown is an alias of text)',
    default: 'text',
  };
}
