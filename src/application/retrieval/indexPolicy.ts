export interface McpIndexPolicy {
  autoIndex: boolean;
  failFastOnLock: boolean;
  lockTimeoutMs: number;
}

export type AutoIndexScope = 'full' | 'incremental';

const DEFAULT_LOCK_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 解析布尔环境变量
 */
export function parseBooleanFlag(
  rawValue: string | undefined,
  defaultValue: boolean,
): boolean {
  if (rawValue === undefined) return defaultValue;
  const normalized = rawValue.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

/**
 * MCP 检索时的索引策略
 */
export function getMcpIndexPolicy(
  env: Record<string, string | undefined> = process.env,
): McpIndexPolicy {
  const parsedTimeout = parseInt(env.MCP_INDEX_LOCK_TIMEOUT_MS || '', 10);
  const lockTimeoutMs =
    Number.isFinite(parsedTimeout) && parsedTimeout >= 0
      ? parsedTimeout
      : DEFAULT_LOCK_TIMEOUT_MS;

  return {
    autoIndex: parseBooleanFlag(env.MCP_AUTO_INDEX, true),
    failFastOnLock: parseBooleanFlag(env.MCP_FAIL_FAST_ON_LOCK, true),
    lockTimeoutMs,
  };
}

/**
 * 在锁冲突时是否继续使用已有索引完成查询
 *
 * 语义：
 * - 开启 fail-fast 且已有可用索引：跳过本次自动索引，继续查询
 * - 开启 fail-fast 但没有可用索引：返回 busy（等待外部索引完成）
 */
export function shouldContinueQueryWithExistingIndexOnLockConflict(
  failFastOnLock: boolean,
  hasExistingIndex: boolean,
): boolean {
  return failFastOnLock && hasExistingIndex;
}

/**
 * 自动索引任务范围：
 * - 已有索引：增量
 * - 无索引：全量
 */
export function resolveAutoIndexScope(hasExistingIndex: boolean): AutoIndexScope {
  return hasExistingIndex ? 'incremental' : 'full';
}
