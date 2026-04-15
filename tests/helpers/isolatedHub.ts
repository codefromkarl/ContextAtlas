/**
 * 测试隔离 helper — 防止 MemoryStore 写入生产 hub
 *
 * 用法:
 *   const { baseDir, hub, cleanup } = createIsolatedHub();
 *   try { ... tests ... } finally { cleanup(); }
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryHubDatabase } from '../../src/memory/MemoryHubDatabase.js';
import { MemoryStore } from '../../src/memory/MemoryStore.js';

export interface IsolatedHubContext {
  baseDir: string;
  hub: MemoryHubDatabase;
  cleanup: () => void;
}

export function createIsolatedHub(prefix = 'cw-isolated-'): IsolatedHubContext {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const hubDbPath = path.join(baseDir, 'memory-hub.db');
  const hub = new MemoryHubDatabase(hubDbPath);
  MemoryStore.setSharedHubForTests(hub);

  return {
    baseDir,
    hub,
    cleanup: () => {
      MemoryStore.resetSharedHubForTests();
      hub.close();
      fs.rmSync(baseDir, { recursive: true, force: true });
    },
  };
}
