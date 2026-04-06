import { logger } from '../utils/logger.js';

export function splitCommaSeparated(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function toJsonLine(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function toTextLine(text: string): string {
  return `${text}\n`;
}

type WritableLike = Pick<NodeJS.WriteStream, 'write'>;
type ExitFn = (code?: number) => never;

export function writeJson(value: unknown, output: WritableLike = process.stdout): void {
  output.write(toJsonLine(value));
}

export function writeText(text: string, output: WritableLike = process.stdout): void {
  output.write(toTextLine(text));
}

export function exitWithError(
  message: string,
  details?: unknown,
  exit: ExitFn = process.exit,
): never {
  if (details === undefined) {
    logger.error(message);
  } else {
    logger.error(details, message);
  }
  return exit(1);
}

export function exitWithStderr(message: string, exit: ExitFn = process.exit): never {
  writeText(message, process.stderr);
  return exit(1);
}

export function joinToolText(response: { content: Array<{ text: string }> }): string {
  return response.content.map((item) => item.text).join('\n');
}
