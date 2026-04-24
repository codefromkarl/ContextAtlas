import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pLimit from 'p-limit';
import {
  getParser,
  isLanguageSupported,
  type ProcessedChunk,
  SemanticSplitter,
} from '../chunking/index.js';
import type { GraphWritePayload, SkeletonWritePayload } from '../graph/types.js';
import { buildFallbackFileSkeleton, buildSkeletonPayload } from '../graph/SkeletonBuilder.js';
import { SymbolExtractor } from '../graph/SymbolExtractor.js';
import { readFileWithEncoding } from '../utils/encoding.js';
import { sha256 } from './hash.js';
import { getLanguage } from './language.js';

/**
 * 大文件阈值（字节）
 */
const DEFAULT_MAX_FILE_SIZE = 512 * 1024; // 512KB
const maxFileSizeFromEnv = parseInt(process.env.MAX_FILE_SIZE_BYTES || '', 10);
const MAX_FILE_SIZE =
  Number.isFinite(maxFileSizeFromEnv) && maxFileSizeFromEnv > 0
    ? maxFileSizeFromEnv
    : DEFAULT_MAX_FILE_SIZE;

/**
 * 需要兜底分片支持的目标语言集合
 * 这些语言的文件即使 AST 解析失败也会使用行分片保证可检索
 */
const FALLBACK_LANGS = new Set([
  'typescript',
  'javascript',
  'python',
  'go',
  'rust',
  'java',
  'markdown',
  'json',
  'c',
  'cpp',
  'c_sharp',
  'kotlin',
  'swift',
  'shell',
  'powershell',
  'sql',
  'yaml',
  'toml',
  'xml',
  'html',
  'css',
  'scss',
  'sass',
  'less',
  'vue',
  'svelte',
  'ruby',
  'php',
  'dart',
  'lua',
  'r',
]);

/**
 * 索引内容 schema 版本
 *
 * 用于显式标记 AST / 语义分片 / chunk metadata 规则的兼容性边界。
 * 当分片策略或 chunk 结构发生不兼容变化时，应递增该版本，触发全量重建。
 */
export const INDEX_CONTENT_SCHEMA_VERSION = 4;

/**
 * 检查 JSON 文件是否应该跳过索引
 *
 * 跳过条件：
 * 1. lock 文件（*-lock.json, package-lock.json）
 * 2. node_modules 目录下的文件
 *
 * @param relPath 相对路径
 * @returns 是否应该跳过
 */
function shouldSkipJson(relPath: string): boolean {
  // Skip lock files
  if (relPath.endsWith('-lock.json') || relPath.endsWith('package-lock.json')) {
    return true;
  }
  // Skip node_modules (handle both Unix and Windows path separators)
  if (relPath.includes('node_modules/') || relPath.includes('node_modules\\')) {
    return true;
  }
  return false;
}

/**
 * 自适应并发度
 *
 * 基于 CPU 核心数动态调整并发度：
 * - 保留 1 个核心给系统和其他进程
 * - 最小并发度为 4（保证 I/O 密集型任务效率）
 * - 最大并发度为 32（避免过多上下文切换开销）
 */
function getAdaptiveConcurrency(): number {
  const cpuCount = os.cpus().length;
  const concurrency = Math.max(4, Math.min(cpuCount - 1, 32));
  return concurrency;
}

/**
 * 分片器单例
 */
const splitter = new SemanticSplitter({
  maxChunkSize: 500,
  minChunkSize: 50,
  chunkOverlap: 40, // 混合检索(BM25+向量+rerank)下的保守 overlap
});
const symbolExtractor = new SymbolExtractor();

/**
 * 文件处理结果
 */
export interface ProcessResult {
  absPath: string;
  relPath: string;
  hash: string;
  content: string | null;
  chunks: ProcessedChunk[];
  /** Phase 0 先固定接缝，Phase 1 再写入真实 graph payload。 */
  graph?: GraphWritePayload;
  skeleton?: SkeletonWritePayload;
  language: string;
  mtime: number;
  size: number;
  status: 'added' | 'modified' | 'unchanged' | 'deleted' | 'skipped' | 'error';
  error?: string;
  chunking?: {
    strategy: 'ast' | 'fallback' | 'empty';
    astFailed: boolean;
    settleNoChunks: boolean;
    emptyReason?: 'empty-content' | 'parse-failed' | 'splitter-returned-empty' | 'unsupported-language';
  };
}

/**
 * 已知文件元数据
 */
export interface KnownFileMeta {
  mtime: number;
  hash: string;
  size: number;
}

function resolveChunkingState(input: {
  hasIndexableContent: boolean;
  usedFallback: boolean;
  astFailed: boolean;
  astAttempted: boolean;
  hasChunks: boolean;
}): NonNullable<ProcessResult['chunking']> {
  if (!input.hasIndexableContent) {
    return {
      strategy: 'empty',
      astFailed: false,
      settleNoChunks: true,
      emptyReason: 'empty-content',
    };
  }

  if (input.hasChunks) {
    return {
      strategy: input.usedFallback ? 'fallback' : 'ast',
      astFailed: input.astFailed,
      settleNoChunks: false,
    };
  }

  if (input.astFailed) {
    return {
      strategy: 'empty',
      astFailed: true,
      settleNoChunks: false,
      emptyReason: 'parse-failed',
    };
  }

  if (input.astAttempted) {
    return {
      strategy: 'empty',
      astFailed: false,
      settleNoChunks: false,
      emptyReason: 'splitter-returned-empty',
    };
  }

  return {
    strategy: 'empty',
    astFailed: false,
    settleNoChunks: false,
    emptyReason: 'unsupported-language',
  };
}

/**
 * 处理单个文件
 */
async function processFile(
  absPath: string,
  relPath: string,
  known?: KnownFileMeta,
): Promise<ProcessResult> {
  const language = getLanguage(relPath);

  try {
    const stat = await fs.stat(absPath);
    const mtime = stat.mtimeMs;
    const size = stat.size;

    // 检查大文件
    if (size > MAX_FILE_SIZE) {
      return {
        absPath,
        relPath,
        hash: '',
        content: null,
        chunks: [],
        language,
        mtime,
        size,
        status: 'skipped',
        error: `File too large (${size} bytes > ${MAX_FILE_SIZE} bytes)`,
      };
    }

    // 快速跳过：如果 mtime 和 size 都没变，则认为文件未修改
    if (known && known.mtime === mtime && known.size === size) {
      return {
        absPath,
        relPath,
        hash: known.hash,
        content: null,
        chunks: [],
        language,
        mtime,
        size,
        status: 'unchanged',
      };
    }

    // 读取文件内容（自动检测编码并转换为 UTF-8）
    const { content, originalEncoding } = await readFileWithEncoding(absPath);

    // 二进制检测：检查 NULL 字节
    if (content.includes('\0')) {
      return {
        absPath,
        relPath,
        hash: '',
        content: null,
        chunks: [],
        language,
        mtime,
        size,
        status: 'skipped',
        error: `Binary file detected (original encoding: ${originalEncoding})`,
      };
    }

    // 计算哈希
    const hash = sha256(content);

    // 如果已知 hash 且相同，则认为未修改（mtime 可能由于某些原因变了）
    if (known && known.hash === hash) {
      return {
        absPath,
        relPath,
        hash,
        content,
        chunks: [],
        language,
        mtime,
        size,
        status: 'unchanged',
      };
    }

    // ===== JSON 文件特殊处理 =====
    if (language === 'json' && shouldSkipJson(relPath)) {
      return {
        absPath,
        relPath,
        hash,
        content: null,
        chunks: [],
        language,
        mtime,
        size,
        status: 'skipped',
        error: 'Lock file or node_modules JSON',
      };
    }

    const hasIndexableContent = content.trim().length > 0;
    if (!hasIndexableContent) {
      return {
        absPath,
        relPath,
        hash,
        content,
        chunks: [],
        language,
        mtime,
        size,
        status: known ? 'modified' : 'added',
        chunking: resolveChunkingState({
          hasIndexableContent,
          usedFallback: false,
          astFailed: false,
          astAttempted: false,
          hasChunks: false,
        }),
      };
    }

    // 语义分片
    let chunks: ProcessedChunk[] = [];
    let graph: GraphWritePayload | undefined;
    let skeleton: SkeletonWritePayload | undefined;
    let astAttempted = false;
    let astFailed = false;
    let usedFallback = false;

    // 1. 尝试 AST 分片（如果语言支持）
    if (isLanguageSupported(language)) {
      astAttempted = true;
      try {
        const parser = await getParser(language);
        if (parser) {
          const tree = parser.parse(content);
          chunks = splitter.split(tree, content, relPath, language);
          graph = symbolExtractor.extract(tree, content, relPath, language);
          if (graph.symbols.length > 0 || graph.relations.length > 0) {
            skeleton = buildSkeletonPayload({
              filePath: relPath,
              language,
              graph,
              content,
            });
          }
        }
      } catch (err) {
        const error = err as { message?: string };
        astFailed = true;
        // AST 分片失败，记录警告
        console.warn(`[Chunking] AST failed for ${relPath}: ${error.message}`);
      }
    }

    // 兜底分片：对 FALLBACK_LANGS 语言，如果 AST 分片失败或返回空，使用行分片
    if (chunks.length === 0 && FALLBACK_LANGS.has(language)) {
      chunks = splitter.splitPlainText(content, relPath, language);
      usedFallback = chunks.length > 0;
    }

    if (!skeleton && content.trim().length > 0 && (language === 'typescript' || language === 'javascript')) {
      skeleton = buildFallbackFileSkeleton({
        filePath: relPath,
        language,
        content,
      });
    }

    return {
      absPath,
      relPath,
      hash,
      content,
      chunks,
      graph,
      skeleton,
      language,
      mtime,
      size,
      status: known ? 'modified' : 'added',
      chunking: resolveChunkingState({
        hasIndexableContent,
        usedFallback,
        astFailed,
        astAttempted,
        hasChunks: chunks.length > 0,
      }),
    };
  } catch (err) {
    const error = err as { message?: string };
    return {
      absPath,
      relPath,
      hash: '',
      content: null,
      chunks: [],
      language,
      mtime: 0,
      size: 0,
      status: 'error',
      error: error.message,
    };
  }
}

/**
 * 批量处理文件
 */
export async function processFiles(
  rootPath: string,
  filePaths: string[],
  knownFiles: Map<string, KnownFileMeta>,
): Promise<ProcessResult[]> {
  const concurrency = getAdaptiveConcurrency();
  const limit = pLimit(concurrency);

  const tasks = filePaths.map((filePath) => {
    // 标准化路径分隔符为 /，确保跨平台一致性
    const relPath = path.relative(rootPath, filePath).replace(/\\/g, '/');
    const known = knownFiles.get(relPath);
    return limit(() => processFile(filePath, relPath, known));
  });

  return Promise.all(tasks);
}
