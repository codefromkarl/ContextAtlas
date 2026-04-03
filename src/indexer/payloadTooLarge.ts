export interface IndexedFileRef {
  path: string;
  hash: string;
}

export interface PayloadTooLargeLocation<T extends IndexedFileRef> {
  offending: T;
  remaining: T[];
}

/**
 * 根据全局 chunk 索引定位触发 413 的文件，并返回其余可继续索引的文件
 */
export function locatePayloadTooLargeFile<T extends IndexedFileRef>(
  files: T[],
  globalIndexByFileChunk: number[][],
  failedGlobalIndex: number,
): PayloadTooLargeLocation<T> | null {
  let fileIndex = -1;
  for (let i = 0; i < globalIndexByFileChunk.length; i++) {
    if (globalIndexByFileChunk[i].includes(failedGlobalIndex)) {
      fileIndex = i;
      break;
    }
  }

  if (fileIndex < 0 || fileIndex >= files.length) {
    return null;
  }

  return {
    offending: files[fileIndex],
    remaining: files.filter((_, idx) => idx !== fileIndex),
  };
}

