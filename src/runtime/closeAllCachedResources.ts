import { closeAllIndexers } from '../indexer/index.js';
import { closeAllVectorStores } from '../vectorStore/index.js';

/**
 * 关闭所有缓存的全局资源
 *
 * 聚合所有模块的资源清理逻辑，确保进程退出时无资源泄漏。
 * 调用方：MCP server 信号处理、CLI 退出钩子等。
 */
export async function closeAllCachedResources(): Promise<void> {
  closeAllIndexers();
  closeAllVectorStores();

  // 以下模块延迟导入，避免循环依赖
  const { closeRateCoordDb } = await import('../api/rateCoord.js');
  closeRateCoordDb();

  const { clearSegmentCache } = await import('../search/fts.js');
  clearSegmentCache();

  const { closeAllGraphExpanders } = await import('../search/GraphExpander.js');
  closeAllGraphExpanders();

  const { closeAllParsers } = await import('../chunking/ParserPool.js');
  closeAllParsers();
}
