/**
 * 冷启动词法降级包
 *
 * 当项目未建立索引时，使用文件扫描 + 词法匹配生成降级结果。
 * 从 MCP tool 层提取，MCP 和 CLI 共享。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ContextPack } from '../../search/types.js';
import { detectLanguage, extractQueryTerms, normalizePath, normalizeToken } from './resultCard.js';

/**
 * 构建冷启动词法降级 ContextPack
 */
export async function buildColdStartLexicalFallbackPack({
  repoPath,
  informationRequest,
  technicalTerms,
}: {
  repoPath: string;
  informationRequest: string;
  technicalTerms: string[];
}): Promise<ContextPack> {
  const { crawl } = await import('../../scanner/crawler.js');
  const { initFilter } = await import('../../scanner/filter.js');

  await initFilter(repoPath);
  const filePaths = await crawl(repoPath);
  const queryTerms = extractQueryTerms(informationRequest, technicalTerms);
  const matches: Array<{
    filePath: string;
    relPath: string;
    score: number;
    snippetStart: number;
    snippetEnd: number;
    text: string;
    startLine: number;
    endLine: number;
    matchedToken: string;
  }> = [];

  for (const filePath of filePaths) {
    const stat = await fs.promises.stat(filePath);
    if (stat.size > 256 * 1024) {
      continue;
    }

    let content: string;
    try {
      content = await fs.promises.readFile(filePath, 'utf-8');
    } catch {
      continue;
    }

    const relPath = normalizePath(path.relative(repoPath, filePath));
    const match = computeColdStartLexicalMatch(content, relPath, queryTerms, technicalTerms);
    if (!match) continue;

    const snippet = sliceSnippet(content, match.offset);
    matches.push({
      filePath,
      relPath,
      score: match.score,
      snippetStart: snippet.start,
      snippetEnd: snippet.end,
      text: snippet.text,
      startLine: snippet.startLine,
      endLine: snippet.endLine,
      matchedToken: match.token,
    });
  }

  matches.sort((a, b) => b.score - a.score);
  const topMatches = matches.slice(0, 5);

  return {
    query: [informationRequest, ...technicalTerms].filter(Boolean).join(' '),
    seeds: topMatches.map((match, index) => ({
      filePath: match.relPath,
      chunkIndex: index,
      score: match.score,
      source: 'lexical' as const,
      record: {
        chunk_id: `${match.relPath}#cold-start#${index}`,
        file_path: match.relPath,
        file_hash: 'cold-start',
        chunk_index: index,
        vector: [],
        display_code: match.text,
        vector_text: match.text,
        language: detectLanguage(match.relPath),
        breadcrumb: `${match.relPath} > lexical fallback`,
        start_index: match.snippetStart,
        end_index: match.snippetEnd,
        raw_start: match.snippetStart,
        raw_end: match.snippetEnd,
        vec_start: match.snippetStart,
        vec_end: match.snippetEnd,
        _distance: 0,
      },
    })),
    expanded: [],
    files: topMatches.map((match) => ({
      filePath: match.relPath,
      segments: [
        {
          filePath: match.relPath,
          rawStart: match.snippetStart,
          rawEnd: match.snippetEnd,
          startLine: match.startLine,
          endLine: match.endLine,
          score: match.score,
          breadcrumb: `${match.relPath} > lexical fallback (${match.matchedToken})`,
          text: match.text,
        },
      ],
    })),
    debug: {
      wVec: 0,
      wLex: 1,
      timingMs: {},
      retrievalStats: {
        queryIntent: technicalTerms.length > 0 ? 'symbol_lookup' : 'balanced',
        lexicalStrategy: 'files_fts',
        vectorCount: 0,
        lexicalCount: topMatches.length,
        fusedCount: topMatches.length,
        topMCount: topMatches.length,
        rerankInputCount: 0,
        rerankedCount: 0,
      },
      resultStats: {
        seedCount: topMatches.length,
        expandedCount: 0,
        fileCount: topMatches.length,
        segmentCount: topMatches.length,
        totalChars: topMatches.reduce((sum, match) => sum + match.text.length, 0),
        budgetLimitChars: 0,
        budgetUsedChars: topMatches.reduce((sum, match) => sum + match.text.length, 0),
        budgetExhausted: false,
        filesConsidered: filePaths.length,
        filesIncluded: topMatches.length,
      },
    },
  };
}

/**
 * 计算冷启动词法匹配得分
 */
export function computeColdStartLexicalMatch(
  content: string,
  relPath: string,
  queryTerms: string[],
  technicalTerms: string[],
): { score: number; offset: number; token: string } | null {
  const lowerContent = content.toLowerCase();
  const lowerPath = relPath.toLowerCase();
  let score = 0;
  let bestOffset = -1;
  let bestToken = '';

  for (const technicalTerm of technicalTerms.map(normalizeToken).filter(Boolean)) {
    const pathIndex = lowerPath.indexOf(technicalTerm);
    if (pathIndex >= 0) {
      score += 10;
      if (bestOffset < 0) {
        bestOffset = 0;
        bestToken = technicalTerm;
      }
    }

    const contentIndex = lowerContent.indexOf(technicalTerm);
    if (contentIndex >= 0) {
      score += 20;
      if (bestOffset < 0 || contentIndex < bestOffset) {
        bestOffset = contentIndex;
        bestToken = technicalTerm;
      }
    }
  }

  for (const term of queryTerms) {
    if (!term) continue;
    const pathIndex = lowerPath.indexOf(term);
    if (pathIndex >= 0) {
      score += 3;
      if (bestOffset < 0) {
        bestOffset = 0;
        bestToken = term;
      }
    }

    const contentIndex = lowerContent.indexOf(term);
    if (contentIndex >= 0) {
      score += 5;
      if (bestOffset < 0 || contentIndex < bestOffset) {
        bestOffset = contentIndex;
        bestToken = term;
      }
    }
  }

  if (score <= 0) {
    return null;
  }

  return {
    score,
    offset: Math.max(bestOffset, 0),
    token: bestToken || normalizeToken(relPath),
  };
}

/**
 * 截取代码片段
 */
export function sliceSnippet(
  content: string,
  offset: number,
): { start: number; end: number; startLine: number; endLine: number; text: string } {
  const lines = content.split('\n');
  let runningOffset = 0;
  let lineIndex = 0;

  for (let index = 0; index < lines.length; index++) {
    const lineLength = lines[index].length + 1;
    if (runningOffset + lineLength > offset) {
      lineIndex = index;
      break;
    }
    runningOffset += lineLength;
  }

  const startLineIndex = Math.max(0, lineIndex - 3);
  const endLineIndex = Math.min(lines.length - 1, lineIndex + 4);
  const start = lines.slice(0, startLineIndex).join('\n').length + (startLineIndex > 0 ? 1 : 0);
  const end = lines.slice(0, endLineIndex + 1).join('\n').length;

  return {
    start,
    end,
    startLine: startLineIndex + 1,
    endLine: endLineIndex + 1,
    text: lines.slice(startLineIndex, endLineIndex + 1).join('\n'),
  };
}
