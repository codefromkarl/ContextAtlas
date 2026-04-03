/**
 * 清理孤立代理项，避免上游 Embedding API 对非法 Unicode 直接返回 400。
 *
 * 保留合法代理对，不破坏正常 emoji/非 BMP 字符。
 */
export function sanitizeEmbeddingInput(text: string): string {
  let changed = false;
  let out = '';

  for (let i = 0; i < text.length; i++) {
    const current = text.charCodeAt(i);

    // 高位代理
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text[i] + text[i + 1];
        i++;
      } else {
        out += '\uFFFD';
        changed = true;
      }
      continue;
    }

    // 低位代理（前面没有高位代理与其配对）
    if (current >= 0xdc00 && current <= 0xdfff) {
      out += '\uFFFD';
      changed = true;
      continue;
    }

    out += text[i];
  }

  return changed ? out : text;
}
