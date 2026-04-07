import fs from 'node:fs';
import path from 'node:path';
import { getEmbeddingConfig } from '../config.js';
import { initDb } from '../db/index.js';
import { resolveBaseDir } from '../runtimePaths.js';
import { resolveCurrentSnapshotId, resolveIndexPaths } from '../storage/layout.js';
import { VectorStore } from '../vectorStore/index.js';

export interface StorageRedundancyReport {
  projectId: string;
  snapshotId: string | null;
  onDisk: {
    dbSizeBytes: number;
    vectorSizeBytes: number;
  };
  sqlite: {
    files: {
      rows: number;
      contentBytes: number;
    };
    filesFts: {
      rows: number;
      contentBytes: number;
    };
    chunksFts: {
      rows: number;
      contentBytes: number;
    };
  };
  vectorStore: {
    rows: number;
    displayCodeBytes: number;
    vectorTextBytes: number;
  };
  duplicatedTextBytes: number;
  recommendations: Array<{
    id: string;
    severity: 'low' | 'medium' | 'high';
    message: string;
  }>;
}

function dirSize(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += dirSize(fullPath);
    } else {
      total += fs.statSync(fullPath).size;
    }
  }
  return total;
}

function queryContentStats(
  db: ReturnType<typeof initDb>,
  table: 'files' | 'files_fts' | 'chunks_fts',
  contentColumn = 'content',
  where = '',
): { rows: number; contentBytes: number } {
  const row = db
    .prepare(
      `SELECT COUNT(*) as rows, COALESCE(SUM(LENGTH(CAST(${contentColumn} AS BLOB))), 0) as bytes FROM ${table}${where}`,
    )
    .get() as { rows: number; bytes: number };

  return {
    rows: row.rows,
    contentBytes: row.bytes,
  };
}

export async function analyzeStorageRedundancy(options: {
  projectId: string;
  baseDir?: string;
}): Promise<StorageRedundancyReport> {
  const baseDir = options.baseDir || resolveBaseDir();
  const snapshotId = resolveCurrentSnapshotId(options.projectId, baseDir);
  const db = initDb(options.projectId, snapshotId);
  const indexPaths = resolveIndexPaths(options.projectId, { baseDir, snapshotId });

  try {
    const files = queryContentStats(db, 'files', 'content', ' WHERE content IS NOT NULL');
    const filesFts = queryContentStats(db, 'files_fts');
    const chunksFts = queryContentStats(db, 'chunks_fts');

    const vectorStore = new VectorStore(
      options.projectId,
      getEmbeddingConfig().dimensions,
      snapshotId,
    );
    await vectorStore.init();
    const vectorStats = await vectorStore.analyzeTextPayloads();
    await vectorStore.close();

    const duplicatedTextBytes =
      files.contentBytes
      + filesFts.contentBytes
      + chunksFts.contentBytes
      + vectorStats.displayCodeBytes
      + vectorStats.vectorTextBytes;

    const recommendations: StorageRedundancyReport['recommendations'] = [];
    if (vectorStats.vectorTextBytes > 0) {
      recommendations.push({
        id: 'trim-vector-text',
        severity: 'high',
        message: 'vector_text 仅用于索引时生成 embedding，可优先停止持久化以减少 LanceDB 冗余。',
      });
    }
    if (files.contentBytes > 0) {
      recommendations.push({
        id: 'keep-files-content-for-online-read-paths',
        severity: 'medium',
        message: 'files.content 仍被 ContextPacker 和 GraphExpander 在线读取，当前不适合直接裁剪。',
      });
    }
    if (filesFts.contentBytes > 0 && chunksFts.contentBytes > 0) {
      recommendations.push({
        id: 'evaluate-files-fts-dependency',
        severity: 'medium',
        message: '词法链路已优先使用 chunks_fts，可继续评估 files_fts 在在线查询中的真实降级命中率。',
      });
    }

    return {
      projectId: options.projectId,
      snapshotId,
      onDisk: {
        dbSizeBytes: fs.existsSync(indexPaths.dbPath) ? fs.statSync(indexPaths.dbPath).size : 0,
        vectorSizeBytes: dirSize(indexPaths.vectorPath),
      },
      sqlite: {
        files,
        filesFts,
        chunksFts,
      },
      vectorStore: vectorStats,
      duplicatedTextBytes,
      recommendations,
    };
  } finally {
    db.close();
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${bytes} B`;
}

export function formatStorageRedundancyReport(report: StorageRedundancyReport): string {
  const lines: string[] = [];
  lines.push('Storage Redundancy Report');
  lines.push(`Project ID: ${report.projectId}`);
  lines.push(`Snapshot: ${report.snapshotId || 'legacy/current'}`);
  lines.push('');
  lines.push('On Disk:');
  lines.push(`  - index.db: ${formatBytes(report.onDisk.dbSizeBytes)}`);
  lines.push(`  - vectors.lance: ${formatBytes(report.onDisk.vectorSizeBytes)}`);
  lines.push('');
  lines.push('SQLite Payloads:');
  lines.push(`  - files.content: rows=${report.sqlite.files.rows} bytes=${formatBytes(report.sqlite.files.contentBytes)}`);
  lines.push(`  - files_fts.content: rows=${report.sqlite.filesFts.rows} bytes=${formatBytes(report.sqlite.filesFts.contentBytes)}`);
  lines.push(`  - chunks_fts.content: rows=${report.sqlite.chunksFts.rows} bytes=${formatBytes(report.sqlite.chunksFts.contentBytes)}`);
  lines.push('');
  lines.push('Vector Payloads:');
  lines.push(`  - display_code: rows=${report.vectorStore.rows} bytes=${formatBytes(report.vectorStore.displayCodeBytes)}`);
  lines.push(`  - vector_text: rows=${report.vectorStore.rows} bytes=${formatBytes(report.vectorStore.vectorTextBytes)}`);
  lines.push('');
  lines.push(`Duplicated Text Footprint: ${formatBytes(report.duplicatedTextBytes)}`);
  lines.push('');
  lines.push('Recommendations:');
  if (report.recommendations.length === 0) {
    lines.push('  - none');
  } else {
    for (const recommendation of report.recommendations) {
      lines.push(`  - [${recommendation.severity}] ${recommendation.id}: ${recommendation.message}`);
    }
  }
  return lines.join('\n');
}
