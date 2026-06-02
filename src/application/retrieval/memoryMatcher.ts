/**
 * MemoryMatcher — 检索结果卡片中的记忆匹配逻辑
 *
 * 从 resultCard.ts 提取的纯函数：
 * - Feature Memory 排名
 * - Long-term Memory 排名
 * - Decision Record 排名
 * - Feedback Signal 排名
 *
 * 所有函数都是纯函数，不依赖数据库或外部状态，
 * 可以用 mock 数据独立测试排名逻辑。
 */

import path from 'node:path';
import type {
  DecisionRecord,
  FeatureMemory,
  ResolvedLongTermMemoryItem,
} from '../../memory/types.js';
import type { ContextPack } from '../../search/types.js';
import type {
  FeatureMemoryFreshness,
  ParsedFeedbackSignal,
  ResultCardDecisionMatch,
  ResultCardFeatureMemoryMatch,
  ResultCardFeedbackMatch,
  ResultCardLongTermMemoryMatch,
} from './retrievalTypes.js';

// ===========================================
// Feature Memory 排名
// ===========================================

export function rankFeatureMemoryMatches(
  memories: FeatureMemory[],
  informationRequest: string,
  technicalTerms: string[],
  pack: ContextPack,
): ResultCardFeatureMemoryMatch[] {
  const queryTerms = extractQueryTerms(informationRequest, technicalTerms);
  const fileSignals = buildFileSignals(pack);

  return memories
    .map((memory) => {
      if (memory.confirmationStatus === 'suggested') {
        return null;
      }
      let score = 0;
      const reasons: string[] = [];
      const searchableFields = [
        memory.name,
        memory.responsibility,
        memory.dataFlow,
        ...memory.api.exports,
        ...memory.keyPatterns,
        ...memory.dependencies.imports,
      ]
        .join(' ')
        .toLowerCase();

      const matchedTerms = queryTerms.filter((term) => searchableFields.includes(term));
      if (matchedTerms.length > 0) {
        score += 6 + matchedTerms.length * 2;
        reasons.push(`关键词匹配: ${matchedTerms.slice(0, 4).join(', ')}`);
      }

      const exactNames = [memory.name, ...memory.api.exports].map(normalizeToken);
      const matchedTechnicalTerms = technicalTerms
        .map(normalizeToken)
        .filter((term) => exactNames.includes(term));
      if (matchedTechnicalTerms.length > 0) {
        score += 12;
        reasons.push(`technical terms 精确命中: ${matchedTechnicalTerms.join(', ')}`);
      }

      const normalizedDir = normalizePath(memory.location.dir);
      const normalizedFiles = memory.location.files.map((file) =>
        normalizePath(path.posix.join(normalizedDir, normalizePath(file))),
      );
      const pathMatches = normalizedFiles.filter((file) => fileSignals.files.has(file));
      if (pathMatches.length > 0) {
        score += 16;
        reasons.push(`文件路径匹配: ${pathMatches.slice(0, 2).join(', ')}`);
      } else if (fileSignals.dirs.has(normalizedDir)) {
        score += 8;
        reasons.push(`目录匹配: ${normalizedDir}`);
      }

      score += getConfirmationStatusWeight(memory.confirmationStatus);
      reasons.push(`确认状态加权: ${memory.confirmationStatus || 'human-confirmed'}`);

      return {
        memory,
        score,
        reasons,
        freshness: resolveFeatureMemoryFreshness(memory, fileSignals),
      };
    })
    .filter((match): match is ResultCardFeatureMemoryMatch => Boolean(match && match.score > 0))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

// ===========================================
// Long-term Memory 排名
// ===========================================

export function rankLongTermMemoryMatches(
  memories: ResolvedLongTermMemoryItem[],
  informationRequest: string,
  technicalTerms: string[],
): ResultCardLongTermMemoryMatch[] {
  const queryTerms = extractQueryTerms(informationRequest, technicalTerms);

  return memories
    .map((memory) => {
      let score = 0;
      const reasons: string[] = [];
      const searchable = [
        memory.title,
        memory.summary,
        memory.why || '',
        memory.howToApply || '',
        memory.factKey || '',
        ...memory.tags,
      ]
        .join(' ')
        .toLowerCase();

      const matchedTerms = queryTerms.filter((term) => searchable.includes(term));
      if (matchedTerms.length > 0) {
        score += 6 + matchedTerms.length * 2;
        reasons.push(`关键词匹配: ${matchedTerms.slice(0, 4).join(', ')}`);
      }

      if (memory.status === 'active') {
        score += 2;
        reasons.push('当前有效');
      }

      if (memory.type === 'temporal-fact') {
        score += memory.status === 'active' ? 8 : 4;
        reasons.push(memory.factKey ? `时态事实: ${memory.factKey}` : '时态事实');
      }

      return { memory, score, reasons };
    })
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score)
    .filter((match, index, list) => {
      const groupKey = buildLongTermMemoryDedupKey(match.memory);
      return list.findIndex((entry) => buildLongTermMemoryDedupKey(entry.memory) === groupKey) === index;
    })
    .slice(0, 3);
}

export function resolveReferencedEvidenceMatches(
  memories: ResolvedLongTermMemoryItem[],
  memoryMatches: ResultCardFeatureMemoryMatch[],
  decisionMatches: ResultCardDecisionMatch[],
): ResultCardLongTermMemoryMatch[] {
  const evidenceById = new Map(
    memories
      .filter((memory) => memory.type === 'evidence')
      .map((memory) => [memory.id, memory] as const),
  );
  const referencedIds = new Set<string>();

  for (const match of memoryMatches) {
    for (const ref of match.memory.evidenceRefs || []) {
      const parsed = parseEvidenceRef(ref);
      if (parsed) referencedIds.add(parsed);
    }
  }

  for (const match of decisionMatches) {
    for (const ref of match.decision.evidenceRefs || []) {
      const parsed = parseEvidenceRef(ref);
      if (parsed) referencedIds.add(parsed);
    }
  }

  return [...referencedIds]
    .map((id) => evidenceById.get(id))
    .filter((memory): memory is ResolvedLongTermMemoryItem => Boolean(memory))
    .map((memory) => ({
      memory,
      score: 100,
      reasons: ['由命中的 feature memory / decision record 证据引用回链'],
    }));
}

export function mergeLongTermMemoryMatches(
  ...groups: ResultCardLongTermMemoryMatch[][]
): ResultCardLongTermMemoryMatch[] {
  const merged = new Map<string, ResultCardLongTermMemoryMatch>();

  for (const group of groups) {
    for (const match of group) {
      const key = buildLongTermMemoryDedupKey(match.memory);
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, match);
        continue;
      }

      merged.set(key, {
        memory: existing.score >= match.score ? existing.memory : match.memory,
        score: Math.max(existing.score, match.score),
        reasons: [...new Set([...existing.reasons, ...match.reasons])],
        scoreBreakdown: existing.score >= match.score ? existing.scoreBreakdown : match.scoreBreakdown,
      });
    }
  }

  return [...merged.values()]
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return new Date(b.memory.updatedAt).getTime() - new Date(a.memory.updatedAt).getTime();
    })
    .slice(0, 4);
}

// ===========================================
// Feedback Signal 排名
// ===========================================

export function rankFeedbackMatches(
  memories: ResolvedLongTermMemoryItem[],
  informationRequest: string,
  technicalTerms: string[],
  memoryMatches: ResultCardFeatureMemoryMatch[],
): ResultCardFeedbackMatch[] {
  const queryTerms = extractQueryTerms(informationRequest, technicalTerms);
  const matchedMemoryNames = new Set(memoryMatches.map((match) => normalizeToken(match.memory.name)));

  return memories
    .map((memory) => {
      const signal = parseFeedbackSignal(memory);
      if (!signal) return null;

      let score = 0;
      const reasons: string[] = [];

      const searchable = [memory.title, memory.summary, ...memory.tags].join(' ').toLowerCase();
      const matchedTerms = queryTerms.filter((term) => searchable.includes(term));
      if (matchedTerms.length > 0) {
        score += 4 + matchedTerms.length;
        reasons.push(`关键词匹配: ${matchedTerms.slice(0, 3).join(', ')}`);
      }

      if (signal.targetModule && matchedMemoryNames.has(normalizeToken(signal.targetModule))) {
        score += 8;
        reasons.push(`关联到已命中的模块: ${signal.targetModule}`);
      }

      if (signal.severity === 'critical') {
        score += 6;
        reasons.push('严重反馈');
      } else if (signal.severity === 'warning') {
        score += 3;
        reasons.push('警告反馈');
      }

      return { memory, score, reasons, signal };
    })
    .filter((match): match is ResultCardFeedbackMatch => Boolean(match && match.score > 0))
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);
}

// ===========================================
// Decision Record 排名
// ===========================================

export function rankDecisionMatches(
  decisions: DecisionRecord[],
  informationRequest: string,
  technicalTerms: string[],
  memoryMatches: ResultCardFeatureMemoryMatch[],
): ResultCardDecisionMatch[] {
  const queryTerms = extractQueryTerms(informationRequest, technicalTerms);
  const memoryTopics = memoryMatches.flatMap((m) => [m.memory.name, ...m.memory.keyPatterns]);

  return decisions
    .map((decision) => {
      let score = 0;
      const reasons: string[] = [];

      const searchable = [
        decision.title,
        decision.context,
        decision.decision,
        decision.rationale,
        ...decision.alternatives.map((a) => a.name),
        ...decision.consequences,
      ]
        .join(' ')
        .toLowerCase();

      const matchedTerms = queryTerms.filter((term) => searchable.includes(term));
      if (matchedTerms.length > 0) {
        score += 4 + matchedTerms.length;
        reasons.push(`关键词匹配: ${matchedTerms.slice(0, 4).join(', ')}`);
      }

      const decisionTopics = [decision.title, ...decision.consequences].map(normalizeToken);
      const topicOverlaps = memoryTopics
        .map(normalizeToken)
        .filter((topic) => decisionTopics.includes(topic));
      if (topicOverlaps.length > 0) {
        score += 6;
        reasons.push(`与已命中的模块记忆主题交叉: ${topicOverlaps.join(', ')}`);
      }

      if (decision.status === 'accepted') {
        score += 2;
        reasons.push('已接受决策');
      }

      return { decision, score, reasons };
    })
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);
}

// ===========================================
// 辅助工具函数
// ===========================================

export function getConfirmationStatusWeight(
  status?: 'suggested' | 'agent-inferred' | 'human-confirmed',
): number {
  switch (status) {
    case 'human-confirmed': return 4;
    case 'agent-inferred': return 2;
    default: return 0;
  }
}

export function resolveFeatureMemoryFreshness(
  memory: FeatureMemory,
  fileSignals: { files: Set<string>; dirs: Set<string> },
): FeatureMemoryFreshness {
  const normalizedDir = normalizePath(memory.location.dir);
  const isInPack = memory.location.files.some((file) =>
    fileSignals.files.has(normalizePath(path.posix.join(normalizedDir, normalizePath(file)))),
  );
  const dirInPack = fileSignals.dirs.has(normalizedDir);

  return {
    lastVerifiedAt: memory.lastUpdated,
    isInPack,
    dirInPack,
    confidence:
      memory.confirmationStatus === 'human-confirmed'
        ? 'high'
        : memory.confirmationStatus === 'agent-inferred'
          ? 'medium'
          : 'low',
  };
}

export function attachFeedbackToMemoryMatches(
  matches: ResultCardFeatureMemoryMatch[],
  feedback: ResultCardFeedbackMatch[],
): ResultCardFeatureMemoryMatch[] {
  if (feedback.length === 0) return matches;

  return matches.map((match) => {
    const relatedFeedback = feedback.filter((fb) => {
      const target = fb.signal.targetModule;
      return target && normalizeToken(target) === normalizeToken(match.memory.name);
    });

    if (relatedFeedback.length === 0) return match;

    return {
      ...match,
      score: match.score + relatedFeedback.length * 3,
      reasons: [...match.reasons, ...relatedFeedback.map((fb) => `关联反馈: ${fb.signal.summary}`)],
    };
  });
}

export async function syncMemoryReviewStatus(
  store: { markFeatureNeedsReview: (name: string, reason: string) => Promise<unknown> },
  matches: ResultCardFeatureMemoryMatch[],
): Promise<void> {
  for (const match of matches) {
    if (match.freshness.isInPack && match.memory.confirmationStatus === 'agent-inferred') {
      try {
        await store.markFeatureNeedsReview(match.memory.name, 'Memory content differs from current code evidence');
      } catch {
        // best-effort
      }
    }
  }
}

// ===========================================
// 内部工具函数
// ===========================================

export function extractQueryTerms(
  informationRequest: string,
  technicalTerms: string[],
): string[] {
  const terms = new Set<string>();

  for (const term of technicalTerms) {
    const normalized = normalizeToken(term);
    if (normalized.length >= 2) terms.add(normalized);
  }

  informationRequest
    .toLowerCase()
    .split(/[\s,._\-/]+/)
    .filter((token) => token.length >= 3)
    .forEach((token) => terms.add(token));

  return Array.from(terms);
}

function buildFileSignals(pack: ContextPack): { files: Set<string>; dirs: Set<string> } {
  const files = new Set<string>();
  const dirs = new Set<string>();

  for (const file of pack.files) {
    files.add(normalizePath(file.filePath));
    const dir = path.posix.dirname(file.filePath);
    if (dir !== '.') {
      dirs.add(normalizePath(dir));
    }
  }

  return { files, dirs };
}

export function normalizePath(rawPath: string): string {
  return rawPath.replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

export function normalizeToken(token: string): string {
  return token.trim().toLowerCase();
}

function buildLongTermMemoryDedupKey(memory: ResolvedLongTermMemoryItem): string {
  return memory.factKey
    ? `fk:${memory.factKey}`
    : `${memory.type}:${memory.id}`;
}

function parseEvidenceRef(ref: string): string | null {
  if (ref.startsWith('evidence:')) return ref.slice('evidence:'.length);
  if (!ref.includes(':') && ref.length >= 8) return ref;
  return null;
}

function parseFeedbackSignal(memory: ResolvedLongTermMemoryItem): ParsedFeedbackSignal | null {
  if (memory.type !== 'feedback') return null;

  const targetModule = memory.tags.find((tag) => tag.startsWith('module:'))?.slice('module:'.length);
  const severity = memory.tags.find((tag) => tag.startsWith('severity:'))?.slice('severity:'.length) as
    | 'critical'
    | 'warning'
    | 'info'
    | undefined;

  return {
    targetModule,
    severity: severity ?? 'info',
    summary: memory.summary,
  };
}
