/**
 * 全局速率协调器 (SQLite 实现)
 *
 * 替代文件系统锁实现跨进程速率协调：
 * - 使用 SQLite 事务保证原子性
 * - 异常退出后无残留锁，自动清理过期记录
 * - 所有 ContextAtlas 项目共享单一协调 DB
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ===========================================
// 协调数据库管理
// ===========================================

/** 协调数据库路径 */
const RATE_COORD_DB_PATH = path.join(os.homedir(), '.contextatlas', 'rate-coord.db');

/** 过期记录阈值 (60s) */
const STALE_THRESHOLD_MS = 60_000;

/** 单例数据库实例 */
let coordDb: Database.Database | null = null;

/**
 * 获取或创建协调数据库
 */
function getCoordDb(): Database.Database {
  if (coordDb) return coordDb;

  // 确保目录存在
  const dir = path.dirname(RATE_COORD_DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(RATE_COORD_DB_PATH);
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');

  // 建表（幂等）
  db.exec(`
    CREATE TABLE IF NOT EXISTS rate_slots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issuer TEXT NOT NULL,
      next_allowed_at INTEGER NOT NULL,
      acquired_at INTEGER NOT NULL
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_rate_slots_acquired ON rate_slots(acquired_at)`);

  coordDb = db;
  return coordDb;
}

/**
 * 清理过期记录
 */
function pruneStaleSlots(db: Database.Database): void {
  const cutoff = Date.now() - STALE_THRESHOLD_MS;
  db.prepare('DELETE FROM rate_slots WHERE acquired_at < ?').run(cutoff);
}

// ===========================================
// 公共接口
// ===========================================

/**
 * 获取全局速率槽位
 *
 * 在事务中读取最新 next_allowed_at，计算等待时间并写入新行。
 * SQLite 事务提供真正的原子性，无需文件系统锁。
 *
 * @param issuer 进程标识 (pid + hostname)
 * @param minIntervalMs 最小间隔 (ms)
 * @returns 需要等待的时间 (ms)，0 表示无需等待
 */
export function acquireRateSlot(issuer: string, minIntervalMs: number): number {
  if (minIntervalMs <= 0) return 0;

  const db = getCoordDb();

  // 在事务中执行原子操作
  const waitMs = db.transaction(() => {
    // 1. 清理过期记录
    pruneStaleSlots(db);

    // 2. 读取当前最大的 next_allowed_at
    const row = db
      .prepare('SELECT MAX(next_allowed_at) as max_next FROM rate_slots')
      .get() as { max_next: number | null };

    const now = Date.now();
    const currentMax = row?.max_next ?? 0;
    const scheduledAt = Math.max(now, currentMax);
    const wait = Math.max(0, scheduledAt - now);

    // 3. 写入新行
    db.prepare(
      'INSERT INTO rate_slots (issuer, next_allowed_at, acquired_at) VALUES (?, ?, ?)',
    ).run(issuer, scheduledAt + minIntervalMs, now);

    return wait;
  })();

  return waitMs;
}

/**
 * 关闭协调数据库
 *
 * 供 closeAllCachedResources 调用
 */
export function closeRateCoordDb(): void {
  if (coordDb) {
    try {
      coordDb.close();
    } catch {
      // 忽略关闭错误
    }
    coordDb = null;
  }
}
