/**
 * C/C++ 解析策略 (#include 解析)
 *
 * 仅解析引号形式的本地 include（#include "file.h"），
 * 忽略尖括号形式（#include <header>）。
 */

import { commonPrefixLength, type ImportResolver } from './types.js';

const CPP_EXTENSIONS = new Set(['.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hh', '.hxx']);

export class CppResolver implements ImportResolver {
  supports(filePath: string): boolean {
    const ext = filePath.slice(filePath.lastIndexOf('.'));
    return CPP_EXTENSIONS.has(ext);
  }

  extract(content: string): string[] {
    const imports: string[] = [];

    // 匹配 #include "xxx" 形式（本地头文件）
    // 忽略 #include <xxx> 形式（系统/第三方库头文件）
    const includePattern = /^\s*#\s*include\s+"([^"]+)"/gm;
    for (const match of content.matchAll(includePattern)) {
      imports.push(match[1]);
    }

    return imports;
  }

  resolve(importStr: string, currentFile: string, allFiles: Set<string>): string | null {
    const currentDir = currentFile.split('/').slice(0, -1).join('/');

    // 1. 尝试相对于当前文件目录解析
    const relativePath = currentDir ? `${currentDir}/${importStr}` : importStr;
    if (allFiles.has(relativePath)) {
      return relativePath;
    }

    // 2. 后缀匹配：查找所有以 importStr 结尾的文件
    const candidates: string[] = [];
    for (const file of allFiles) {
      if (file.endsWith(`/${importStr}`) || file === importStr) {
        candidates.push(file);
      }
    }

    if (candidates.length === 0) {
      return null;
    }

    if (candidates.length === 1) {
      return candidates[0];
    }

    // 3. 歧义消解：优先选择与当前文件路径前缀重叠最多的
    let bestCandidate = candidates[0];
    let bestPrefixLen = commonPrefixLength(currentFile, bestCandidate);

    for (let i = 1; i < candidates.length; i++) {
      const prefixLen = commonPrefixLength(currentFile, candidates[i]);
      if (prefixLen > bestPrefixLen) {
        bestPrefixLen = prefixLen;
        bestCandidate = candidates[i];
      }
    }

    return bestCandidate;
  }
}
