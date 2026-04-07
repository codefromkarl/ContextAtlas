export interface SnippetExtractorConfig {
  maxBreadcrumbChars: number;
  maxRerankChars: number;
  headRatio: number;
}

export function truncateMiddle(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const half = Math.floor((maxLen - 3) / 2);
  return `${text.slice(0, half)}...${text.slice(-half)}`;
}

export function truncateHeadTail(text: string, maxLen: number, headRatio: number): string {
  if (text.length <= maxLen) return text;
  const headLen = Math.floor(maxLen * headRatio);
  const tailLen = maxLen - headLen - 3;
  if (tailLen <= 0) return text.slice(0, maxLen);
  return `${text.slice(0, headLen)}...${text.slice(-tailLen)}`;
}

export function extractAroundHit(
  text: string,
  queryTokens: Set<string>,
  maxLen: number,
  headRatio: number,
): string {
  if (text.length <= maxLen) return text;

  const lines = text.split('\n');
  let hitLineIdx = -1;
  let bestScore = 0;

  for (let i = 0; i < lines.length; i++) {
    const lineLower = lines[i].toLowerCase();
    let lineScore = 0;
    for (const token of queryTokens) {
      if (lineLower.includes(token)) {
        lineScore++;
      }
    }
    if (lineScore > bestScore) {
      bestScore = lineScore;
      hitLineIdx = i;
    }
  }

  if (hitLineIdx === -1) {
    return truncateHeadTail(text, maxLen, headRatio);
  }

  let start = hitLineIdx;
  let end = hitLineIdx;
  let currentLen = lines[hitLineIdx].length;

  while (currentLen < maxLen) {
    const canUp = start > 0;
    const canDown = end < lines.length - 1;

    if (!canUp && !canDown) break;

    if (canUp) {
      const upLen = lines[start - 1].length + 1;
      if (currentLen + upLen <= maxLen) {
        start--;
        currentLen += upLen;
      }
    }

    if (canDown) {
      const downLen = lines[end + 1].length + 1;
      if (currentLen + downLen <= maxLen) {
        end++;
        currentLen += downLen;
      }
    }

    if (
      (start === 0 || lines[start - 1].length + 1 + currentLen > maxLen) &&
      (end === lines.length - 1 || lines[end + 1].length + 1 + currentLen > maxLen)
    ) {
      break;
    }
  }

  const result = lines.slice(start, end + 1).join('\n');
  const prefix = start > 0 ? '...' : '';
  const suffix = end < lines.length - 1 ? '...' : '';

  return prefix + result + suffix;
}

export function buildRerankText(
  input: {
    breadcrumb: string;
    displayCode: string;
  },
  queryTokens: Set<string>,
  config: SnippetExtractorConfig,
): string {
  const breadcrumb = truncateMiddle(input.breadcrumb, config.maxBreadcrumbChars);
  const budget = Math.max(0, config.maxRerankChars - breadcrumb.length - 1);
  const code = extractAroundHit(input.displayCode, queryTokens, budget, config.headRatio);
  return `${breadcrumb}\n${code}`;
}
