/**
 * ContextAtlas MCP Server
 *
 * 提供代码库检索能力的 Model Context Protocol 服务器
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Readable } from 'node:stream';
import { closeAllCachedResources } from '../runtime/closeAllCachedResources.js';
import { logger } from '../utils/logger.js';
import { createToolDispatcher } from './registry/dispatcher.js';
import { TOOLS } from './registry/tools.js';
import { assertToolAllowed, filterToolsForToolset, getConfiguredMcpToolsetMode } from './registry/toolset.js';
import { ensureEmbeddingGatewayForMcp } from './runtime/autoStartEmbeddingGateway.js';
import { createCallToolHandler } from './runtime/callToolHandler.js';
import { createListToolsHandler } from './runtime/listToolsHandler.js';

// ===========================================
// 服务器配置
// ===========================================

const SERVER_NAME = 'contextatlas';

export { TOOLS } from './registry/tools.js';

export interface McpLifecycleDependencies {
  stdin: Pick<Readable, 'on' | 'off'>;
  closeResources: () => Promise<void>;
  closeServer: () => Promise<void>;
}

export interface McpLifecycleController {
  cleanup: (reason: string, error?: unknown) => Promise<void>;
}

export function createMcpLifecycleController(
  dependencies: McpLifecycleDependencies,
): McpLifecycleController {
  let cleanupPromise: Promise<void> | null = null;

  const removeListeners = () => {
    process.off('SIGINT', handleSigint);
    process.off('SIGTERM', handleSigterm);
    dependencies.stdin.off('end', handleStdinEnd);
    dependencies.stdin.off('close', handleStdinClose);
    dependencies.stdin.off('error', handleStdinError);
  };

  const runCleanup = async (reason: string, error?: unknown) => {
    if (!cleanupPromise) {
      cleanupPromise = (async () => {
        removeListeners();
        try {
          if (error) {
            logger.warn({ reason, err: error }, 'MCP 服务器开始清理');
          } else {
            logger.info({ reason }, 'MCP 服务器开始清理');
          }
          await dependencies.closeResources();
          await dependencies.closeServer();
          logger.info({ reason }, 'MCP 服务器已优雅关闭');
        } catch (err) {
          logger.error({ reason, err }, 'MCP 服务器关闭时出错');
        }
      })();
    }
    return cleanupPromise;
  };

  const handleSigint = () => {
    void runCleanup('signal:SIGINT');
  };
  const handleSigterm = () => {
    void runCleanup('signal:SIGTERM');
  };
  const handleStdinEnd = () => {
    void runCleanup('stdin:end');
  };
  const handleStdinClose = () => {
    void runCleanup('stdin:close');
  };
  const handleStdinError = (error: unknown) => {
    void runCleanup('stdin:error', error);
  };

  process.on('SIGINT', handleSigint);
  process.on('SIGTERM', handleSigterm);
  dependencies.stdin.on('end', handleStdinEnd);
  dependencies.stdin.on('close', handleStdinClose);
  dependencies.stdin.on('error', handleStdinError);

  return {
    cleanup: runCleanup,
  };
}

/**
 * 启动 MCP 服务器
 */
export async function startMcpServer(): Promise<void> {
  logger.info({ name: SERVER_NAME }, '启动 MCP 服务器');

  await ensureEmbeddingGatewayForMcp();

  const server = new Server(
    {
      name: SERVER_NAME,
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );
  const toolsetMode = getConfiguredMcpToolsetMode();
  const tools = filterToolsForToolset(TOOLS, toolsetMode);
  const baseDispatchTool = createToolDispatcher(process.cwd());
  const dispatchTool = async (
    name: string,
    args: unknown,
    onProgress?: Parameters<typeof baseDispatchTool>[2],
  ) => {
    assertToolAllowed(name, toolsetMode);
    return baseDispatchTool(name, args, onProgress);
  };

  logger.info({ toolsetMode, toolCount: tools.length }, 'MCP 工具集已加载');

  server.setRequestHandler(ListToolsRequestSchema, createListToolsHandler(tools));
  server.setRequestHandler(CallToolRequestSchema, createCallToolHandler({ dispatchTool }));

  const transport = new StdioServerTransport();
  transport.onerror = (error) => {
    logger.error({ err: error }, 'MCP stdio transport 发生错误');
  };
  logger.info('MCP 服务器已启动，等待连接...');
  await server.connect(transport);

  createMcpLifecycleController({
    stdin: process.stdin,
    closeResources: async () => closeAllCachedResources(),
    closeServer: async () => server.close(),
  });
}
