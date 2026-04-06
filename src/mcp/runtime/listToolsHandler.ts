import { logger } from '../../utils/logger.js';
import type { ToolMetadata } from '../registry/tools.js';

export function createListToolsHandler(tools: ToolMetadata[]) {
  return async () => {
    logger.debug('收到 list_tools 请求');
    return { tools };
  };
}
