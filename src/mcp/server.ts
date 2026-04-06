/**
 * ContextAtlas MCP Server
 *
 * 提供代码库检索能力的 Model Context Protocol 服务器
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../utils/logger.js';
import { createToolDispatcher } from './registry/dispatcher.js';
import { TOOLS } from './registry/tools.js';
import { assertToolAllowed, filterToolsForToolset, getConfiguredMcpToolsetMode } from './registry/toolset.js';
import { createCallToolHandler } from './runtime/callToolHandler.js';
import { createListToolsHandler } from './runtime/listToolsHandler.js';

// ===========================================
// 服务器配置
// ===========================================

const SERVER_NAME = 'contextatlas';

export { TOOLS } from './registry/tools.js';

/**
 * 启动 MCP 服务器
 */
export async function startMcpServer(): Promise<void> {
  logger.info({ name: SERVER_NAME }, '启动 MCP 服务器');

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
  logger.info('MCP 服务器已启动，等待连接...');
  await server.connect(transport);
}
