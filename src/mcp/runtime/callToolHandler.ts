import { ZodError } from 'zod';
import { logger } from '../../utils/logger.js';
import {
  createInternalErrorResponse,
  createInvalidArgumentsResponse,
  validateToolTextResponse,
  type ToolTextResponse,
} from '../response.js';
import type { DispatcherProgressCallback } from '../registry/dispatcher.js';

export interface CallToolRequestLike {
  params: {
    name: string;
    arguments?: unknown;
  };
}

export interface CallToolExtraLike {
  _meta?: {
    progressToken?: unknown;
  };
  sendNotification: (payload: {
    method: 'notifications/progress';
    params: {
      progressToken: string | number;
      progress: number;
      total?: number;
      message?: string;
    };
  }) => Promise<void>;
}

export interface ToolUsageEvent {
  source: 'mcp';
  toolName: string;
  status: 'success' | 'error';
  durationMs: number;
  error?: string;
}

export interface CreateCallToolHandlerOptions {
  dispatchTool: (
    name: string,
    args: unknown,
    onProgress?: DispatcherProgressCallback,
  ) => Promise<ToolTextResponse>;
  now?: () => number;
  recordToolUsage?: (event: ToolUsageEvent) => void | Promise<void>;
}

function extractProgressToken(rawToken: unknown): string | number | undefined {
  return typeof rawToken === 'string' || typeof rawToken === 'number' ? rawToken : undefined;
}

function readErrorDetails(err: unknown): { message?: string; stack?: string } {
  if (!err || typeof err !== 'object') {
    return {};
  }

  const message = Reflect.get(err, 'message');
  const stack = Reflect.get(err, 'stack');

  return {
    message: typeof message === 'string' ? message : undefined,
    stack: typeof stack === 'string' ? stack : undefined,
  };
}

function createProgressReporter(extra: CallToolExtraLike): DispatcherProgressCallback | undefined {
  const progressToken = extractProgressToken(extra._meta?.progressToken);
  if (progressToken === undefined) {
    return undefined;
  }

  return async (current: number, total?: number, message?: string) => {
    try {
      await extra.sendNotification({
        method: 'notifications/progress',
        params: {
          progressToken,
          progress: current,
          total,
          message,
        },
      });
    } catch (err) {
      const { message } = readErrorDetails(err);
      logger.debug({ error: message }, '发送进度通知失败');
    }
  };
}

async function persistToolUsage(event: ToolUsageEvent): Promise<void> {
  const { recordToolUsage } = await import('../../usage/usageTracker.js');
  recordToolUsage(event);
}

export function createCallToolHandler(options: CreateCallToolHandlerOptions) {
  const now = options.now ?? Date.now;

  return async (request: CallToolRequestLike, extra: CallToolExtraLike): Promise<ToolTextResponse> => {
    const { name, arguments: args } = request.params;
    logger.info({ tool: name }, '收到 call_tool 请求');
    const startedAt = now();

    const recordGenericToolUsage = async (status: 'success' | 'error', error?: string) => {
      if (name === 'codebase-retrieval') return;
      try {
        const event: ToolUsageEvent = {
          source: 'mcp',
          toolName: name,
          status,
          durationMs: now() - startedAt,
          error,
        };
        if (options.recordToolUsage) {
          await options.recordToolUsage(event);
          return;
        }
        await persistToolUsage(event);
      } catch {
        // noop
      }
    };

    const onProgress = createProgressReporter(extra);

    try {
      const result = await options.dispatchTool(name, args, onProgress);
      await recordGenericToolUsage('success');
      return validateToolTextResponse(result);
    } catch (err) {
      const error = readErrorDetails(err);
      await recordGenericToolUsage('error', error.message);
      logger.error({ error: error.message, stack: error.stack, tool: name }, '工具调用失败');
      if (err instanceof ZodError) {
        return createInvalidArgumentsResponse(name, err);
      }
      return createInternalErrorResponse(name, error.message || 'Unknown error');
    }
  };
}
