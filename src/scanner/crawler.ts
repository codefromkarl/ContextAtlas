import fs from 'node:fs';
import { fdir } from 'fdir';
import { isAllowedFile, isFiltered } from './filter.js';
import { logger } from '../utils/logger.js';

/**
 * 转义正则表达式特殊字符
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isIgnorableCrawlError(error: NodeJS.ErrnoException): boolean {
  return error.code === 'ENOENT' || error.code === 'EACCES' || error.code === 'EPERM';
}

/**
 * 使用 fdir 扫描文件系统
 */
export async function crawl(rootPath: string): Promise<string[]> {
  const rootStat = await fs.promises.stat(rootPath);
  if (!rootStat.isDirectory()) {
    throw new Error(`Root path is not a directory: ${rootPath}`);
  }

  let unexpectedError: NodeJS.ErrnoException | null = null;
  const originalReaddir = fs.readdir.bind(fs);
  const tolerantFs = { ...fs } as typeof fs;

  (tolerantFs as unknown as { readdir: (...args: unknown[]) => unknown }).readdir = (
    ...args: unknown[]
  ) => {
    const targetPath = args[0];
    const maybeOptions = args[1];
    const callback = (typeof maybeOptions === 'function' ? maybeOptions : args[2]) as
      | ((error: NodeJS.ErrnoException | null, entries?: fs.Dirent[] | string[]) => void)
      | undefined;

    if (!callback) {
      return (originalReaddir as (...inner: unknown[]) => unknown)(...args);
    }

    const wrappedCallback = (
      error: NodeJS.ErrnoException | null,
      entries?: fs.Dirent[] | string[],
    ) => {
      if (!error) {
        callback(null, entries);
        return;
      }

      if (isIgnorableCrawlError(error)) {
        logger.warn(
          { path: String(targetPath), code: error.code, message: error.message },
          '目录遍历遇到可恢复错误，已跳过该目录',
        );
        callback(null, []);
        return;
      }

      if (!unexpectedError) {
        unexpectedError = error;
      }
      callback(null, []);
    };

    if (typeof maybeOptions === 'function') {
      return (originalReaddir as (...inner: unknown[]) => unknown)(targetPath, wrappedCallback);
    }

    return (originalReaddir as (...inner: unknown[]) => unknown)(
      targetPath,
      maybeOptions,
      wrappedCallback,
    );
  };

  const api = new fdir({ fs: tolerantFs })
    .withFullPaths()
    .filter((filePath: string) => {
      // 标准化路径分隔符为 /，确保跨平台兼容
      const normalizedFilePath = filePath.replace(/\\/g, '/');
      const normalizedRootPath = rootPath.replace(/\\/g, '/');
      const relativePath = normalizedFilePath.replace(
        new RegExp(`^${escapeRegExp(normalizedRootPath)}/?`),
        '',
      );
      return !isFiltered(relativePath) && isAllowedFile(filePath);
    });

  const paths = await api.crawl(rootPath).withPromise();

  if (unexpectedError) {
    throw unexpectedError;
  }

  return paths;
}
