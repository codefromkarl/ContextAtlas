/**
 * C# 解析策略 (命名空间→路径映射 + 后缀匹配)
 */

import { commonPrefixLength, type ImportResolver } from './types.js';

export class CSharpResolver implements ImportResolver {
  supports(filePath: string): boolean {
    return filePath.endsWith('.cs');
  }

  extract(content: string): string[] {
    const imports: string[] = [];
    // 匹配: using Namespace.Type; 或 using Alias = Namespace.Type;
    // 不匹配: using static, global using
    const pattern = /^\s*using\s+(?!static\s)(?!global\s)(?:\w+\s*=\s*)?([\w.]+);/gm;
    for (const match of content.matchAll(pattern)) {
      imports.push(match[1]);
    }
    return imports;
  }

  resolve(importStr: string, currentFile: string, allFiles: Set<string>): string | null {
    // C# using: Namespace.Type -> Namespace/Type.cs
    // 命名空间通常与目录结构对应

    // 将命名空间转换为路径
    const namespacePath = importStr.replace(/\./g, '/');
    const suffix = `/${namespacePath}.cs`;

    const candidates: string[] = [];
    for (const filePath of allFiles) {
      if (filePath.endsWith(suffix)) {
        candidates.push(filePath);
      }
    }

    // 回退策略：尝试匹配最后一个类型名
    // 例如 System.Collections.Generic.List -> 找 List.cs
    if (candidates.length === 0) {
      const parts = importStr.split('.');
      const typeName = parts[parts.length - 1];
      const typeSuffix = `/${typeName}.cs`;

      for (const filePath of allFiles) {
        if (filePath.endsWith(typeSuffix)) {
          candidates.push(filePath);
        }
      }
    }

    if (candidates.length === 0) {
      return null;
    }

    if (candidates.length === 1) {
      return candidates[0];
    }

    // 歧义消解：优先选择与当前文件路径前缀重叠最多的
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
