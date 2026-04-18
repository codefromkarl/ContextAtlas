/**
 * 检索结果卡片：排名 + 上下文块 + 格式化
 *
 * 从 MCP tool 层提取的结果卡片构建逻辑，MCP 和 CLI 共享。
 * 不依赖 mcp/ 目录。
 */

import crypto from 'node:crypto';
import path from 'node:path';
import { closeDb, generateProjectId, initDb } from '../../db/index.js';
import { GraphStore } from '../../graph/GraphStore.js';
import type {
  BlockFirstPayload,
  CheckpointCandidate,
  ContextBlock,
  DecisionRecord,
  FeatureMemory,
  ResolvedLongTermMemoryItem,
} from '../../memory/types.js';
import { segmentQuery } from '../../search/fts.js';
import type { ContextPack, QueryIntent, Segment } from '../../search/types.js';
import { resolveCurrentSnapshotId } from '../../storage/layout.js';
import { logger } from '../../utils/logger.js';
import type {
  FeatureMemoryFreshness,
  OverviewData,
  ParsedFeedbackSignal,
  RetrievalData,
  RetrievalGraphContextSummary,
  RetrievalGraphSymbolSummary,
  RetrievalResultCard,
  ResultCardDecisionMatch,
  ResultCardFeedbackMatch,
  ResultCardFeatureMemoryMatch,
  ResultCardLongTermMemoryMatch,
} from './retrievalTypes.js';

// ===========================================
// 结果卡片核心构建
// ===========================================

export async function buildRetrievalResultCard({
  repoPath,
  informationRequest,
  technicalTerms,
  pack,
  includeGraphContext,
  status,
}: {
  repoPath: string;
  informationRequest: string;
  technicalTerms: string[];
  pack: ContextPack;
  includeGraphContext: boolean;
  status?: RetrievalResultCard['status'];
}): Promise<RetrievalResultCard> {
  try {
    const { MemoryStore } = await import('../../memory/MemoryStore.js');
    const store = new MemoryStore(repoPath);
    const [featureMemories, decisions, longTermMemories] = await Promise.all([
      store.listFeatures(),
      store.listDecisions(),
      store.listLongTermMemories({ includeExpired: false, staleDays: 30 }),
    ]);

    const memoryMatches = rankFeatureMemoryMatches(featureMemories, informationRequest, technicalTerms, pack);
    await syncMemoryReviewStatus(store, memoryMatches);
    const feedbackSignals = rankFeedbackMatches(
      longTermMemories.filter((memory) => memory.type === 'feedback'),
      informationRequest,
      technicalTerms,
      memoryMatches,
    );
    const memoryMatchesWithFeedback = attachFeedbackToMemoryMatches(memoryMatches, feedbackSignals);
    const decisionMatches = rankDecisionMatches(
      decisions,
      informationRequest,
      technicalTerms,
      memoryMatchesWithFeedback,
    );
    const directLongTermMatches = rankLongTermMemoryMatches(
      longTermMemories.filter((memory) => memory.type !== 'feedback'),
      informationRequest,
      technicalTerms,
    );
    const longTermMatches = mergeLongTermMemoryMatches(
      directLongTermMatches,
      resolveReferencedEvidenceMatches(
        longTermMemories,
        memoryMatchesWithFeedback,
        decisionMatches,
      ),
    );

    const graphContext = includeGraphContext
      ? buildGraphContextSummary(repoPath, pack)
      : undefined;

    return {
      memories: memoryMatchesWithFeedback,
      decisions: decisionMatches,
      longTermMemories: longTermMatches,
      feedbackSignals,
      graphContext,
      reasoning: buildReasoningLines(
        informationRequest,
        technicalTerms,
        pack,
        memoryMatchesWithFeedback,
        decisionMatches,
        longTermMatches,
        feedbackSignals,
      ),
      trustRules: buildTrustRules(),
      nextActions: buildNextActions({
        informationRequest,
        memoryMatches,
        decisionMatches,
      }),
      status,
    };
  } catch (err) {
    logger.debug({ error: (err as Error).message }, '构建检索结果卡片上下文失败，回退到代码结果');
    return {
      memories: [],
      decisions: [],
      longTermMemories: [],
      feedbackSignals: [],
      graphContext: includeGraphContext ? buildGraphContextSummary(repoPath, pack) : undefined,
      reasoning: buildReasoningLines(informationRequest, technicalTerms, pack, [], [], [], []),
      trustRules: buildTrustRules(),
      nextActions: buildNextActions({
        informationRequest,
        memoryMatches: [],
        decisionMatches: [],
      }),
      status,
    };
  }
}

// ===========================================
// 图谱摘要
// ===========================================

export function buildGraphContextSummary(
  repoPath: string,
  pack: ContextPack,
): RetrievalGraphContextSummary | undefined {
  const projectId = generateProjectId(repoPath);
  const snapshotId = resolveCurrentSnapshotId(projectId);
  const db = initDb(projectId, snapshotId);

  try {
    const store = new GraphStore(db);
    const seen = new Set<string>();
    const symbols: RetrievalGraphSymbolSummary[] = [];

    for (const seed of pack.seeds) {
      const symbolName = extractSymbolNameFromBreadcrumb(seed.record.breadcrumb);
      if (!symbolName) continue;

      const matches = store
        .findSymbolsByName(symbolName)
        .filter((symbol) => symbol.filePath === seed.filePath);
      const match = matches[0];
      if (!match) continue;
      if (seen.has(match.id)) continue;
      seen.add(match.id);

      const upstream = store
        .getDirectRelations(match.id, 'upstream')
        .slice(0, 3)
        .map((relation) => `${relation.relationType}:${relation.targetName}`);
      const downstream = store
        .getDirectRelations(match.id, 'downstream')
        .slice(0, 3)
        .map((relation) => `${relation.relationType}:${relation.targetName}`);

      symbols.push({
        name: match.name,
        filePath: match.filePath,
        directUpstream: upstream,
        directDownstream: downstream,
      });

      if (symbols.length >= 3) {
        break;
      }
    }

    return symbols.length > 0 ? { symbols } : undefined;
  } catch (err) {
    logger.debug({ error: (err as Error).message }, '构建图谱摘要失败，忽略 code graph summary');
    return undefined;
  } finally {
    closeDb(db);
  }
}

export function extractSymbolNameFromBreadcrumb(breadcrumb: string): string | null {
  const parts = breadcrumb.split(' > ');
  const tail = parts[parts.length - 1];
  if (!tail || tail.includes('/')) {
    return null;
  }

  return tail
    .replace(/^(abstract class |class |interface |fn\*? |def |func |struct |enum |trait |record |@interface )/, '')
    .trim() || null;
}

export function formatGraphContextSummary(summary: RetrievalGraphContextSummary): string[] {
  return summary.symbols.flatMap((symbol) => [
    `- ${symbol.name} (${symbol.filePath})`,
    `  upstream: ${symbol.directUpstream.length > 0 ? symbol.directUpstream.join(', ') : 'none'}`,
    `  downstream: ${symbol.directDownstream.length > 0 ? symbol.directDownstream.join(', ') : 'none'}`,
  ]);
}

// ===========================================
// 排名函数
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
      if (parsed) {
        referencedIds.add(parsed);
      }
    }
  }

  for (const match of decisionMatches) {
    for (const ref of match.decision.evidenceRefs || []) {
      const parsed = parseEvidenceRef(ref);
      if (parsed) {
        referencedIds.add(parsed);
      }
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
      });
    }
  }

  return [...merged.values()]
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return new Date(b.memory.updatedAt).getTime() - new Date(a.memory.updatedAt).getTime();
    })
    .slice(0, 4);
}

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
      if (!signal) {
        return null;
      }

      let score = 0;
      const reasons: string[] = [];
      const searchable = [
        memory.title,
        memory.summary,
        signal.query || '',
        signal.details || '',
        ...memory.tags,
      ]
        .join(' ')
        .toLowerCase();

      const matchedTerms = queryTerms.filter((term) => searchable.includes(term));
      if (matchedTerms.length > 0) {
        score += 6 + matchedTerms.length * 2;
        reasons.push(`关键词匹配: ${matchedTerms.slice(0, 4).join(', ')}`);
      }

      if (signal.targetType === 'feature-memory' && signal.targetId) {
        const normalizedTarget = normalizeToken(signal.targetId);
        if (matchedMemoryNames.has(normalizedTarget)) {
          score += 14;
          reasons.push(`关联模块反馈: ${signal.targetId}`);
        }
      }

      if (signal.query && normalizeToken(signal.query) === normalizeToken(informationRequest)) {
        score += 8;
        reasons.push('同查询历史反馈');
      }

      if (signal.outcome === 'memory-stale' || signal.outcome === 'wrong-module') {
        score += 4;
        reasons.push(`负反馈: ${signal.outcome}`);
      }

      return { memory, score, reasons, signal };
    })
    .filter((match): match is ResultCardFeedbackMatch => Boolean(match && match.score > 0))
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return new Date(b.memory.updatedAt).getTime() - new Date(a.memory.updatedAt).getTime();
    })
    .slice(0, 3);
}

export function rankDecisionMatches(
  decisions: DecisionRecord[],
  informationRequest: string,
  technicalTerms: string[],
  memoryMatches: ResultCardFeatureMemoryMatch[],
): ResultCardDecisionMatch[] {
  const queryTerms = extractQueryTerms(informationRequest, technicalTerms);
  const memoryTerms = memoryMatches.flatMap((match) =>
    [match.memory.name, ...match.memory.api.exports].map(normalizeToken),
  );

  const scored = decisions
    .map((decision) => {
      let score = 0;
      const reasons: string[] = [];
      const searchableFields = [
        decision.title,
        decision.context,
        decision.decision,
        decision.rationale,
        ...decision.consequences,
      ]
        .join(' ')
        .toLowerCase();

      const matchedQueryTerms = queryTerms.filter((term) => searchableFields.includes(term));
      if (matchedQueryTerms.length > 0) {
        score += 5 + matchedQueryTerms.length * 2;
        reasons.push(`关键词匹配: ${matchedQueryTerms.slice(0, 4).join(', ')}`);
      }

      const matchedMemoryTerms = memoryTerms.filter((term) => searchableFields.includes(term));
      if (matchedMemoryTerms.length > 0) {
        score += 8;
        reasons.push(`关联模块提及: ${matchedMemoryTerms.slice(0, 3).join(', ')}`);
      }

      return { decision, score, reasons, fallback: false };
    })
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);

  if (scored.length > 0) {
    return scored;
  }

  return decisions.slice(0, 1).map((decision) => ({
    decision,
    score: 0,
    reasons: ['未找到直接关键词命中，回退展示最近决策记录'],
    fallback: true,
  }));
}

// ===========================================
// 辅助函数
// ===========================================

export function buildReasoningLines(
  informationRequest: string,
  technicalTerms: string[],
  pack: ContextPack,
  memoryMatches: ResultCardFeatureMemoryMatch[],
  decisionMatches: ResultCardDecisionMatch[],
  longTermMatches: ResultCardLongTermMemoryMatch[],
  feedbackMatches: ResultCardFeedbackMatch[],
): string[] {
  const reasoning: string[] = [];
  const seedSources = Array.from(new Set(pack.seeds.map((seed) => seed.source)));
  const fileSignals = buildFileSignals(pack);

  reasoning.push(`问题语义: ${informationRequest.trim()}`);

  if (technicalTerms.length > 0) {
    reasoning.push(`technical terms 参与精确匹配: ${technicalTerms.join(', ')}`);
  }

  if (seedSources.length > 0) {
    reasoning.push(`代码片段来自 ${seedSources.join(' + ')} 召回，并经过 rerank/pack 输出`);
  }

  if (fileSignals.files.size > 0) {
    reasoning.push(`优先保留命中文件: ${Array.from(fileSignals.files).slice(0, 3).join(', ')}`);
  }

  if (memoryMatches.length > 0) {
    reasoning.push('模块记忆按关键词、technical terms 和文件路径相关性排序');
    if (memoryMatches.some((match) => match.freshness.status.includes('stale') || match.freshness.status.includes('conflict'))) {
      reasoning.push('代码优先于 stale/conflict memory，冲突记忆只作为辅助背景展示');
    }
  } else {
    reasoning.push('当前项目没有命中可复用的模块记忆');
  }

  if (decisionMatches.length > 0) {
    reasoning.push(
      decisionMatches.some((match) => match.fallback)
        ? '决策记录没有直接命中时，回退展示最近记录，避免结果上下文断裂'
        : '决策记录按关键词和关联模块提及进行排序',
    );
  } else {
    reasoning.push('当前项目没有可展示的决策记录');
  }

  if (longTermMatches.length > 0) {
    reasoning.push('长期记忆只补充代码中推不出来的项目状态或协作约束');
    if (longTermMatches.some((match) => match.memory.type === 'temporal-fact')) {
      reasoning.push('时态事实会优先暴露当前仍有效的迁移窗口、兼容窗口和临时约束');
    }
    if (longTermMatches.some((match) => match.memory.type === 'evidence')) {
      reasoning.push('命中的记忆和决策若带有 evidenceRefs，会自动回链原始证据块');
    }
  } else {
    reasoning.push('当前项目没有命中相关长期记忆');
  }

  if (feedbackMatches.length > 0) {
    reasoning.push('近期反馈会直接外显，并为相关模块补充风险提示');
    if (
      feedbackMatches.some(
        (match) => match.signal.outcome === 'memory-stale' || match.signal.outcome === 'wrong-module',
      )
    ) {
      reasoning.push('负反馈不会覆盖代码命中，但会提示当前结果需要额外复核');
    }
  } else {
    reasoning.push('当前项目没有命中相关反馈记录');
  }

  return reasoning;
}

export function buildTrustRules(): string[] {
  return [
    'Code > Feature Memory > Decision Record > Long-term Memory',
    '代码优先于旧 memory；记忆和决策只补充代码上下文，不覆盖代码事实',
    '新 decision record 优先于旧 profile，用于解释当前设计意图',
    'Long-term Memory 只补充代码中推不出来的项目状态、协作约束和外部引用',
    '发生冲突时直接展示冲突状态，而不是静默覆盖',
    '近期反馈会直接外显，用于提示结果风险和记忆复核优先级',
  ];
}

export function buildNextActions({
  informationRequest,
  memoryMatches,
  decisionMatches,
}: {
  informationRequest: string;
  memoryMatches: ResultCardFeatureMemoryMatch[];
  decisionMatches: ResultCardDecisionMatch[];
}): string[] {
  const escapedQuery = informationRequest.replace(/"/g, '\\"');
  const actions = [
    `\`contextatlas feedback:record --outcome helpful --target-type code --query "${escapedQuery}"\``,
    `\`contextatlas feedback:record --outcome not-helpful --target-type code --query "${escapedQuery}"\``,
  ];

  const primaryMemory = memoryMatches[0];
  if (primaryMemory) {
    actions.push(
      `\`contextatlas feedback:record --outcome memory-stale --target-type feature-memory --query "${escapedQuery}" --target-id "${primaryMemory.memory.name}"\``,
    );
    actions.push(
      `\`contextatlas feedback:record --outcome wrong-module --target-type feature-memory --query "${escapedQuery}" --target-id "${primaryMemory.memory.name}"\``,
    );
    actions.push(
      `\`contextatlas memory:suggest ${primaryMemory.memory.name} --files "${primaryMemory.memory.location.files.join(',') || '<files>'}"\``,
    );
  } else {
    actions.push('`contextatlas memory:suggest <module> --files "src/.../file.ts"`');
  }

  const decisionSeed = decisionMatches[0]?.decision.id || '<id>';
  actions.push(
    `\`contextatlas decision:record ${decisionSeed} --title "<标题>" --owner "<责任人>" --reviewer "<审核人>" --context "<背景>" --decision "<决策>" --rationale "<原因>"\``,
  );
  actions.push(
    '`contextatlas memory:record-long-term --type reference --title "<标题>" --summary "<摘要>"`',
  );

  return actions;
}

export function buildFileSignals(pack: ContextPack): { files: Set<string>; dirs: Set<string> } {
  const files = new Set<string>();
  const dirs = new Set<string>();

  for (const file of pack.files) {
    const normalized = normalizePath(file.filePath);
    files.add(normalized);
    dirs.add(path.posix.dirname(normalized));
  }

  return { files, dirs };
}

export function extractQueryTerms(informationRequest: string, technicalTerms: string[]): string[] {
  const rawTerms = [
    ...technicalTerms.map((term) => term.trim()),
    ...tokenizeForMatching(informationRequest),
  ].filter(Boolean);

  return Array.from(new Set(rawTerms.map(normalizeToken)));
}

export function tokenizeForMatching(text: string): string[] {
  return (text.match(/[\p{L}\p{N}_-]+/gu) || []).filter((token) => {
    if (/[\u4e00-\u9fff]/u.test(token)) return true;
    return token.length >= 3;
  });
}

export function normalizeToken(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.?\//, '');
}

export function getConfirmationStatusWeight(
  status: FeatureMemory['confirmationStatus'],
): number {
  switch (status) {
    case 'human-confirmed':
      return 6;
    case 'agent-inferred':
      return 2;
    case 'suggested':
      return -100;
    default:
      return 4;
  }
}

export function resolveFeatureMemoryFreshness(
  memory: FeatureMemory,
  fileSignals: { files: Set<string>; dirs: Set<string> },
): FeatureMemoryFreshness {
  const status: Array<'active' | 'stale' | 'conflict'> = ['active'];
  const updatedTime = Date.parse(memory.lastUpdated);
  const ageDays = Number.isNaN(updatedTime)
    ? 0
    : (Date.now() - updatedTime) / (1000 * 60 * 60 * 24);

  if (!Number.isNaN(updatedTime) && ageDays > 180) {
    status[0] = 'stale';
  }

  const normalizedDir = normalizePath(memory.location.dir);
  const normalizedFiles = memory.location.files.map((file) =>
    normalizePath(path.posix.join(normalizedDir, normalizePath(file))),
  );
  const hasConflict = normalizedFiles.length > 0
    && normalizedFiles.every((file) => !fileSignals.files.has(file))
    && !fileSignals.dirs.has(normalizedDir);

  if (hasConflict) {
    if (!status.includes('conflict')) {
      status.push('conflict');
    }
  }

  let confidence: FeatureMemoryFreshness['confidence'] = 'high';
  if (memory.reviewStatus === 'needs-review' || status.includes('conflict')) {
    confidence = 'low';
  } else if (status.includes('stale')) {
    confidence = 'medium';
  }

  return {
    status,
    lastVerifiedAt: memory.lastUpdated,
    confidence,
    reviewStatus: memory.reviewStatus || (status.includes('conflict') ? 'needs-review' : 'verified'),
    reviewReason:
      memory.reviewReason
      || (status.includes('conflict') ? '当前查询命中的代码路径与记忆记录不一致' : undefined),
  };
}

export async function syncMemoryReviewStatus(
  store: { markFeatureNeedsReview: (moduleName: string, reason: string) => Promise<FeatureMemory | null> },
  memoryMatches: ResultCardFeatureMemoryMatch[],
): Promise<void> {
  for (const match of memoryMatches) {
    if (
      !match.freshness.status.includes('conflict')
      || match.memory.reviewStatus === 'needs-review'
    ) {
      continue;
    }

    const reason = '当前查询命中的代码路径与记忆记录不一致';
    match.memory.reviewStatus = 'needs-review';
    match.memory.reviewReason = reason;
    match.memory.reviewMarkedAt = new Date().toISOString();
    match.freshness.reviewStatus = 'needs-review';
    match.freshness.reviewReason = reason;

    try {
      await store.markFeatureNeedsReview(match.memory.name, reason);
    } catch (err) {
      logger.debug(
        { memory: match.memory.name, error: (err as Error).message },
        '自动标记功能记忆待复核失败',
      );
    }
  }
}

export function attachFeedbackToMemoryMatches(
  memoryMatches: ResultCardFeatureMemoryMatch[],
  feedbackMatches: ResultCardFeedbackMatch[],
): ResultCardFeatureMemoryMatch[] {
  return memoryMatches.map((match) => ({
    ...match,
    feedbackSignals: feedbackMatches.filter(
      (feedback) =>
        feedback.signal.targetType === 'feature-memory'
        && normalizeToken(feedback.signal.targetId || '') === normalizeToken(match.memory.name),
    ),
  }));
}

export function parseFeedbackSignal(memory: ResolvedLongTermMemoryItem): ParsedFeedbackSignal | null {
  if (memory.type !== 'feedback') {
    return null;
  }

  const pairs = memory.summary.split('|').map((part) => part.trim());
  const parsed = new Map<string, string>();
  for (const pair of pairs) {
    const [rawKey, ...rawValue] = pair.split('=');
    if (!rawKey || rawValue.length === 0) continue;
    parsed.set(rawKey.trim(), rawValue.join('=').trim());
  }

  const outcome = parsed.get('outcome') as ParsedFeedbackSignal['outcome'] | undefined;
  if (
    outcome !== 'helpful'
    && outcome !== 'not-helpful'
    && outcome !== 'memory-stale'
    && outcome !== 'wrong-module'
  ) {
    return null;
  }

  return {
    outcome,
    targetType: parsed.get('targetType') as ParsedFeedbackSignal['targetType'] | undefined,
    targetId: parsed.get('target'),
    query: parsed.get('query'),
    details: parsed.get('details'),
  };
}

export function buildLongTermMemoryDedupKey(memory: ResolvedLongTermMemoryItem): string {
  if (memory.type === 'temporal-fact' && memory.factKey) {
    return `temporal-fact:${normalizeToken(memory.factKey)}`;
  }
  return `${memory.type}:${memory.id}`;
}

export function parseEvidenceRef(ref: string): string | null {
  const trimmed = ref.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith('evidence:')) {
    return trimmed.slice('evidence:'.length) || null;
  }
  return null;
}

// ===========================================
// 文本格式化（MCP 和 CLI 共享）
// ===========================================

export function formatFeatureMemoryMatches(matches: ResultCardFeatureMemoryMatch[]): string {
  if (matches.length === 0) {
    return '- 暂无相关模块记忆';
  }

  return matches
    .map(
      ({ memory, reasons, freshness, feedbackSignals = [] }) =>
        `#### ${memory.name}
- 职责: ${memory.responsibility}
- 位置: ${memory.location.dir}/${memory.location.files.join(', ')}
- 导出: ${memory.api.exports.join(', ') || 'N/A'}
- 类型: ${memory.memoryType || 'local'}
- 来源项目: ${memory.sourceProjectId || 'current-project'}
- 确认状态: ${memory.confirmationStatus || 'human-confirmed'}
- 复核状态: ${freshness.reviewStatus}${freshness.reviewReason ? ` (${freshness.reviewReason})` : ''}
- 状态: ${freshness.status.join(', ')}
- 最后核验: ${freshness.lastVerifiedAt}
- 可信度: ${freshness.confidence}
- 反馈信号: ${formatFeatureFeedbackSummary(feedbackSignals)}
- 数据流: ${memory.dataFlow || 'N/A'}
- 命中原因: ${reasons.join('；')}`,
    )
    .join('\n\n');
}

export function formatDecisionMatches(matches: ResultCardDecisionMatch[]): string {
  if (matches.length === 0) {
    return '- 暂无相关决策记录';
  }

  return matches
    .map(
      ({ decision, reasons, fallback }) => {
        const governanceState = decision.owner
          ? decision.reviewer
            ? 'reviewed'
            : 'owner-owned'
          : 'unowned';
        return (
        `#### ${decision.title}
- 状态: ${decision.status}
- Owner: ${decision.owner || 'N/A'}
- Reviewer: ${decision.reviewer || 'N/A'}
- 治理状态: ${governanceState}
- 决策: ${decision.decision}
- 理由: ${decision.rationale || 'N/A'}
- 命中原因: ${reasons.join('；')}${fallback ? '（fallback）' : ''}`
        );
      },
    )
    .join('\n\n');
}

export function formatLongTermMemoryMatches(matches: ResultCardLongTermMemoryMatch[]): string {
  if (matches.length === 0) {
    return '- 暂无相关长期记忆';
  }

  return matches
    .map(
      ({ memory, reasons }) =>
        `#### ${memory.title}
- 类型: ${memory.type}
- 状态: ${memory.status}
- Fact Key: ${memory.factKey || 'N/A'}
- 生效区间: ${memory.validFrom || 'N/A'} -> ${memory.validUntil || 'active'}
- 来源: ${memory.source}
- 可信度: ${Math.round(memory.confidence * 100)}%
- 最后核验: ${memory.lastVerifiedAt || memory.updatedAt}
- 摘要: ${memory.summary}
- 命中原因: ${reasons.join('；')}`,
    )
    .join('\n\n');
}

export function formatFeedbackMatches(matches: ResultCardFeedbackMatch[]): string {
  if (matches.length === 0) {
    return '- 暂无相关反馈信号';
  }

  return matches
    .map(
      ({ memory, reasons, signal }) =>
        `#### ${memory.title}
- Outcome: ${signal.outcome}
- Target Type: ${signal.targetType || 'unknown'}
- Target ID: ${signal.targetId || 'N/A'}
- Query: ${signal.query || 'N/A'}
- 状态: ${memory.status}
- 最后核验: ${memory.lastVerifiedAt || memory.updatedAt}
- 摘要: ${memory.summary}
- 命中原因: ${reasons.join('；')}`,
    )
    .join('\n\n');
}

export function formatReasoning(lines: string[]): string {
  return lines.map((line) => `- ${line}`).join('\n');
}

export function formatFeatureFeedbackSummary(feedbackSignals: ResultCardFeedbackMatch[]): string {
  if (feedbackSignals.length === 0) {
    return '无';
  }

  const counts = feedbackSignals.reduce<Record<string, number>>((acc, feedback) => {
    acc[feedback.signal.outcome] = (acc[feedback.signal.outcome] || 0) + 1;
    return acc;
  }, {});
  const labels = Object.entries(counts).map(([outcome, count]) =>
    count > 1 ? `${outcome} x${count}` : outcome,
  );

  return `近期存在 ${labels.join(', ')} 反馈`;
}

export function formatSegment(seg: Segment): string {
  const lang = detectLanguage(seg.filePath);
  const header = `## ${seg.filePath} (L${seg.startLine}-${seg.endLine})`;
  const breadcrumb = seg.breadcrumb ? `> ${seg.breadcrumb}` : '';
  const code = `\`\`\`${lang}\n${seg.text}\n\`\`\``;

  return [header, breadcrumb, code].filter(Boolean).join('\n');
}

export function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const langMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    py: 'python',
    rs: 'rust',
    go: 'go',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    cs: 'csharp',
    rb: 'ruby',
    php: 'php',
    swift: 'swift',
    kt: 'kotlin',
    scala: 'scala',
    sql: 'sql',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    xml: 'xml',
    html: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    md: 'markdown',
    toml: 'toml',
  };
  return langMap[ext] || ext || 'plaintext';
}

// ===========================================
// 上下文块构建
// ===========================================

export function buildContextBlocks(pack: ContextPack, resultCard: RetrievalResultCard): ContextBlock[] {
  const blocks: ContextBlock[] = [];

  for (const file of pack.files) {
    for (const segment of file.segments) {
      blocks.push({
        id: `code:${segment.filePath}:${segment.startLine}-${segment.endLine}`,
        type: 'code-evidence',
        title: segment.filePath,
        purpose: 'Provide directly relevant code evidence for the current query',
        content: segment.text,
        priority: 'high',
        pinned: false,
        expandable: true,
        budgetChars: segment.text.length,
        memoryKind: 'semantic',
        provenance: [{ source: 'code', ref: `${segment.filePath}:L${segment.startLine}-L${segment.endLine}` }],
      });
    }
  }

  for (const match of resultCard.memories) {
    blocks.push({
      id: `memory:${match.memory.name}`,
      type: 'module-summary',
      title: match.memory.name,
      purpose: 'Summarize stable module responsibilities and interfaces',
      content: [
        match.memory.responsibility,
        `Memory Type: ${match.memory.memoryType || 'local'}`,
        `Source Project: ${match.memory.sourceProjectId || 'current-project'}`,
      ].join('\n'),
      priority: 'high',
      pinned: true,
      expandable: true,
      memoryKind: 'semantic',
      provenance: [{ source: 'feature-memory', ref: match.memory.name }],
      freshness: {
        lastVerifiedAt: match.freshness.lastVerifiedAt,
        stale: match.freshness.status.includes('stale') || match.freshness.status.includes('conflict'),
        confidence: match.freshness.confidence,
      },
    });
  }

  for (const match of resultCard.decisions) {
    const governanceState = match.decision.owner
      ? match.decision.reviewer
        ? 'reviewed'
        : 'owner-owned'
      : 'unowned';
    blocks.push({
      id: `decision:${match.decision.id}`,
      type: 'decision-context',
      title: match.decision.title,
      purpose: 'Capture relevant architecture and product decisions',
      content: [
        match.decision.decision,
        `Owner: ${match.decision.owner || 'N/A'}`,
        `Reviewer: ${match.decision.reviewer || 'N/A'}`,
        `Governance: ${governanceState}`,
      ].join('\n'),
      priority: 'medium',
      pinned: false,
      expandable: true,
      memoryKind: 'procedural',
      provenance: [{ source: 'decision-record', ref: match.decision.id }],
    });
  }

  for (const match of resultCard.longTermMemories) {
    if (match.memory.type === 'evidence') {
      blocks.push({
        id: `evidence:${match.memory.id}`,
        type: 'recent-findings',
        title: match.memory.title,
        purpose: 'Surface raw supporting evidence that explains why a conclusion should be trusted',
        content: match.memory.summary,
        priority: 'medium',
        pinned: false,
        expandable: true,
        memoryKind: 'episodic',
        provenance: [{ source: 'evidence', ref: match.memory.id }],
        freshness: {
          lastVerifiedAt: match.memory.lastVerifiedAt || match.memory.updatedAt,
        },
      });
      continue;
    }

    if (match.memory.type === 'temporal-fact') {
      blocks.push({
        id: `temporal:${match.memory.factKey || match.memory.id}`,
        type: 'recent-findings',
        title: match.memory.title,
        purpose: 'Surface time-bounded project facts that may expire or be invalidated later',
        content: [
          match.memory.summary,
          match.memory.factKey ? `Fact Key: ${match.memory.factKey}` : '',
          match.memory.validFrom ? `Valid From: ${match.memory.validFrom}` : '',
          match.memory.validUntil ? `Valid Until: ${match.memory.validUntil}` : '',
        ].filter(Boolean).join('\n'),
        priority: 'medium',
        pinned: false,
        expandable: true,
        memoryKind: 'episodic',
        provenance: [{ source: 'long-term-memory', ref: match.memory.id }],
        freshness: {
          lastVerifiedAt: match.memory.lastVerifiedAt || match.memory.updatedAt,
          stale: match.memory.status !== 'active',
        },
      });
      continue;
    }

    blocks.push({
      id: `ltm:${match.memory.id}`,
      type: 'repo-rules',
      title: match.memory.title,
      purpose: 'Provide non-code project state or durable repo rules',
      content: match.memory.summary,
      priority: 'medium',
      pinned: false,
      expandable: true,
      memoryKind: 'procedural',
      provenance: [{ source: 'long-term-memory', ref: match.memory.id }],
      freshness: {
        lastVerifiedAt: match.memory.lastVerifiedAt || match.memory.updatedAt,
        stale: match.memory.status !== 'active',
      },
    });
  }

  for (const match of resultCard.feedbackSignals) {
    blocks.push({
      id: `feedback:${match.memory.id}`,
      type: 'feedback-signals',
      title: match.memory.title,
      purpose: 'Surface recent feedback that may reduce trust in related context',
      content: match.memory.summary,
      priority: 'medium',
      pinned: false,
      expandable: false,
      memoryKind: 'episodic',
      provenance: [{ source: 'feedback', ref: match.memory.id }],
      freshness: {
        lastVerifiedAt: match.memory.lastVerifiedAt || match.memory.updatedAt,
      },
    });
  }

  blocks.push({
    id: 'task:open-questions',
    type: 'open-questions',
    title: 'Next actions',
    purpose: 'Capture immediate follow-up directions for the agent',
    content: resultCard.nextActions.join('\n'),
    priority: 'medium',
    pinned: true,
    expandable: false,
    memoryKind: 'task-state',
    provenance: [{ source: 'code', ref: 'result-card:next-actions' }],
  });

  return blocks;
}

export function buildOverviewData(
  pack: ContextPack,
  resultCard: RetrievalResultCard,
  contextBlocks: ContextBlock[],
): OverviewData {
  const architecturePrimaryFiles = buildOverviewArchitecturePrimaryFiles(pack);
  const topFiles = pack.files
    .map((file) => ({ filePath: file.filePath, segmentCount: file.segments.length }))
    .sort((a, b) => b.segmentCount - a.segmentCount)
    .slice(0, 5);

  const expansionCandidates = pack.expansionCandidates
    ? pack.expansionCandidates
      .filter((candidate) => !architecturePrimaryFiles.includes(candidate.filePath))
      .slice(0, 5)
      .map((candidate) => ({
        filePath: candidate.filePath,
        reason: candidate.reason,
        priority: candidate.priority,
      }))
    : (() => {
        const seen = new Set<string>();
        return [...pack.expanded]
          .sort((a, b) => b.score - a.score)
          .filter((chunk) => {
            const key = chunk.filePath;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .slice(0, 5)
          .map((chunk) => ({
            filePath: chunk.filePath,
            reason: `expanded via ${chunk.source}`,
            priority: (chunk.source === 'import' ? 'high' : chunk.source === 'breadcrumb' ? 'medium' : 'low') as 'high' | 'medium' | 'low',
          }));
      })();

  const references = contextBlocks
    .flatMap((block) => block.provenance.map((item) => ({ blockId: block.id, source: item.source, ref: item.ref })))
    .slice(0, 20);

  return {
    summary: {
      codeBlocks: pack.seeds.length,
      files: pack.files.length,
      totalSegments: pack.files.reduce((acc, file) => acc + file.segments.length, 0),
    },
    topFiles,
    architecturePrimaryFiles,
    references,
    expansionCandidates,
    nextInspectionSuggestions:
      pack.nextInspectionSuggestions && pack.nextInspectionSuggestions.length > 0
        ? pack.nextInspectionSuggestions
        : resultCard.nextActions,
  };
}

function buildOverviewArchitecturePrimaryFiles(pack: ContextPack): string[] {
  const primaryFiles = pack.architecturePrimaryFiles ?? [];
  const promotedExpansionFiles = (pack.expansionCandidates ?? [])
    .filter((candidate) => candidate.priority === 'high' || candidate.reason.includes('import'))
    .map((candidate) => candidate.filePath);

  if (primaryFiles.length === 0 && promotedExpansionFiles.length === 0) {
    return [];
  }

  const primarySet = new Set(primaryFiles);
  const limit = Math.max(primaryFiles.length, 3);

  return Array.from(new Set([...primaryFiles, ...promotedExpansionFiles]))
    .map((filePath) => ({
      filePath,
      queryScore: scoreOverviewPathRelevance(pack.query, filePath),
      sourcePriority: primarySet.has(filePath) ? 1 : 0,
      pathPriority: getOverviewPathPriority(filePath),
    }))
    .sort((a, b) =>
      b.queryScore - a.queryScore
      || b.sourcePriority - a.sourcePriority
      || b.pathPriority - a.pathPriority
      || a.filePath.localeCompare(b.filePath),
    )
    .slice(0, limit)
    .map((item) => item.filePath);
}

function scoreOverviewPathRelevance(query: string, filePath: string): number {
  const queryWeights = buildOverviewQueryWeights(query);
  if (queryWeights.size === 0) {
    return 0;
  }

  const pathTokens = new Set(splitOverviewPathTokens(filePath));
  let score = 0;
  for (const [token, weight] of queryWeights.entries()) {
    if (pathTokens.has(token)) {
      score += weight;
    }
  }
  return score;
}

function buildOverviewQueryWeights(query: string): Map<string, number> {
  const weights = new Map<string, number>();
  for (const rawToken of segmentQuery(query)) {
    const token = normalizeToken(rawToken);
    if (!token) continue;
    upsertOverviewTokenWeight(weights, token, 1);
    for (const [synonym, weight] of OVERVIEW_QUERY_PATH_SYNONYMS[token] || []) {
      upsertOverviewTokenWeight(weights, synonym, weight);
    }
  }
  return weights;
}

function upsertOverviewTokenWeight(target: Map<string, number>, token: string, weight: number): void {
  const normalized = normalizeToken(token);
  if (!normalized) return;
  const current = target.get(normalized) ?? 0;
  if (weight > current) {
    target.set(normalized, weight);
  }
}

function splitOverviewPathTokens(filePath: string): string[] {
  return Array.from(new Set(
    normalizePath(filePath)
      .split(/[/.\\_-]+/)
      .flatMap((segment) => segment.split(/(?=[A-Z])/))
      .map((segment) => normalizeToken(segment))
      .filter(Boolean),
  ));
}

function getOverviewPathPriority(filePath: string): number {
  const normalizedPath = normalizePath(filePath);
  if (normalizedPath.startsWith('src/')) return 2;
  if (normalizedPath.startsWith('tests/') || normalizedPath.startsWith('docs/')) return 0;
  return 1;
}

const OVERVIEW_QUERY_PATH_SYNONYMS: Record<string, Array<[string, number]>> = {
  entrypoint: [['index', 3], ['main', 2.5], ['bootstrap', 2.2]],
  startup: [['bootstrap', 2.5], ['start', 1.5], ['init', 1.5], ['server', 1.4]],
  registration: [['register', 2.5], ['commands', 1.5]],
  command: [['commands', 1.2], ['register', 1.2], ['cli', 0.8]],
  commands: [['command', 1.2], ['register', 1.2], ['cli', 0.8]],
  cli: [['commands', 0.8]],
  mcp: [['server', 0.6]],
  server: [['mcp', 0.6]],
};

export function buildCheckpointCandidate(
  repoPath: string,
  informationRequest: string,
  contextBlocks: ContextBlock[],
  resultCard: RetrievalResultCard,
  architecturePrimaryFiles: string[],
): CheckpointCandidate {
  const now = new Date().toISOString();
  return {
    id: `checkpoint:${crypto.createHash('sha1').update(`${repoPath}:${informationRequest}`).digest('hex').slice(0, 12)}`,
    repoPath,
    title: informationRequest,
    goal: informationRequest,
    phase: 'overview',
    summary: resultCard.reasoning[0] || informationRequest,
    activeBlockIds: contextBlocks.filter((block) => block.pinned).map((block) => block.id),
    supportingRefs: contextBlocks
      .filter((block) => block.provenance.some((item) => item.source === 'evidence'))
      .map((block) => block.id)
      .slice(0, 20),
    exploredRefs: contextBlocks.flatMap((block) => block.provenance.map((item) => item.ref)).slice(0, 20),
    keyFindings: resultCard.reasoning.slice(0, 5),
    unresolvedQuestions: [],
    nextSteps: resultCard.nextActions,
    architecturePrimaryFiles,
    createdAt: now,
    updatedAt: now,
    source: 'retrieval',
    confidence: 'high',
    reason: 'Generated from retrieval context blocks and result-card reasoning',
  };
}

export function buildBlockFirstPayload(
  contextBlocks: ContextBlock[],
  checkpointCandidate: CheckpointCandidate,
  architecturePrimaryFiles: string[],
  nextInspectionSuggestions: string[],
): BlockFirstPayload {
  return {
    schemaVersion: 1,
    contextBlocks,
    references: contextBlocks.flatMap((block) =>
      block.provenance.map((item) => ({
        blockId: block.id,
        source: item.source,
        ref: item.ref,
      })),
    ),
    checkpointCandidate,
    architecturePrimaryFiles,
    nextInspectionSuggestions,
  };
}

interface OverviewContextBlockSummary {
  id: string;
  type: ContextBlock['type'];
  title: string;
  summary: string;
  priority: ContextBlock['priority'];
  pinned: boolean;
  expandable: boolean;
  rank?: number;
  provenanceRefs: string[];
}

interface OverviewCheckpointCandidateSummary {
  id: string;
  title: string;
  goal: string;
  phase: CheckpointCandidate['phase'];
  summary: string;
  architecturePrimaryFiles?: string[];
  nextSteps: string[];
  source?: CheckpointCandidate['source'];
  confidence?: CheckpointCandidate['confidence'];
}

interface MinimalOverviewFileMatch {
  filePath: string;
  segmentCount: number;
  lines: string[];
}

function summarizeOverviewSuggestion(item: string): string {
  if (item.includes('feedback:record') && item.includes('--outcome helpful')) {
    return 'record helpful feedback';
  }
  if (item.includes('feedback:record') && item.includes('--outcome not-helpful')) {
    return 'record not-helpful feedback';
  }
  if (item.includes('feedback:record') && item.includes('--outcome memory-stale')) {
    return 'mark feature memory stale';
  }
  if (item.includes('feedback:record') && item.includes('--outcome wrong-module')) {
    return 'mark wrong module mapping';
  }
  if (item.includes('memory:suggest')) {
    return 'suggest feature memory update';
  }
  if (item.includes('decision:record')) {
    return 'record decision draft';
  }
  if (item.includes('memory:record-long-term')) {
    return 'record long-term reference';
  }
  return compactText(item.replace(/`/g, ''), 64);
}

function summarizeOverviewSuggestions(items: string[], limit = 3): string[] {
  return items.slice(0, limit).map((item) => summarizeOverviewSuggestion(item));
}

function compactText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 1)}…`;
}

function summarizeContextBlockForOverview(block: ContextBlock): OverviewContextBlockSummary {
  return {
    id: block.id,
    type: block.type,
    title: block.title,
    summary: compactText(block.summary || block.content, 160),
    priority: block.priority,
    pinned: block.pinned,
    expandable: block.expandable,
    ...(typeof block.rank === 'number' ? { rank: block.rank } : {}),
    provenanceRefs: block.provenance.slice(0, 3).map((item) => item.ref),
  };
}

function summarizeCheckpointCandidateForOverview(
  checkpointCandidate: CheckpointCandidate,
): OverviewCheckpointCandidateSummary {
  return {
    id: checkpointCandidate.id,
    title: checkpointCandidate.title,
    goal: checkpointCandidate.goal,
    phase: checkpointCandidate.phase,
    summary: compactText(checkpointCandidate.summary, 200),
    ...(checkpointCandidate.architecturePrimaryFiles
      ? { architecturePrimaryFiles: checkpointCandidate.architecturePrimaryFiles }
      : {}),
    nextSteps: checkpointCandidate.nextSteps.slice(0, 5),
    ...(checkpointCandidate.source ? { source: checkpointCandidate.source } : {}),
    ...(checkpointCandidate.confidence ? { confidence: checkpointCandidate.confidence } : {}),
  };
}

function pickOverviewContextBlocks(
  contextBlocks: ContextBlock[],
): OverviewContextBlockSummary[] {
  const prioritized = contextBlocks
    .filter((block) => block.type !== 'open-questions')
    .slice()
    .sort((a, b) => {
      const pinDelta = Number(b.pinned) - Number(a.pinned);
      if (pinDelta !== 0) return pinDelta;
      const priorityOrder = { high: 3, medium: 2, low: 1 } as const;
      const priorityDelta = priorityOrder[b.priority] - priorityOrder[a.priority];
      if (priorityDelta !== 0) return priorityDelta;
      return (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER);
    })
    .slice(0, 5);

  return prioritized.map((block) => summarizeContextBlockForOverview(block));
}

function buildOverviewJsonPayload(input: {
  responseMode: 'overview';
  resultCard: RetrievalResultCard;
  overview: OverviewData;
  contextBlocks: ContextBlock[];
  checkpointCandidate: CheckpointCandidate;
  pack: ContextPack;
}) {
  const compactBlocks = pickOverviewContextBlocks(input.contextBlocks);
  const compactReferences = input.overview.references.slice(0, 10);
  const compactCheckpoint = summarizeCheckpointCandidateForOverview(input.checkpointCandidate);
  const queryIntent = input.pack.debug?.retrievalStats?.queryIntent || 'balanced';

  if (queryIntent === 'symbol_lookup' || queryIntent === 'navigation') {
    const fileMatches: MinimalOverviewFileMatch[] = input.pack.files.slice(0, 5).map((file) => ({
      filePath: file.filePath,
      segmentCount: file.segments.length,
      lines: file.segments.slice(0, 3).map((segment) => `L${segment.startLine}-${segment.endLine}`),
    }));

    return {
      responseMode: input.responseMode,
      detailLevel: 'minimal' as const,
      queryIntent,
      summary: input.overview.summary,
      topFiles: input.overview.topFiles,
      fileMatches,
      architecturePrimaryFiles: input.overview.architecturePrimaryFiles,
      nextInspectionSuggestions: summarizeOverviewSuggestions(input.overview.nextInspectionSuggestions, 3),
      blockFirst: {
        schemaVersion: 1 as const,
        detailLevel: 'minimal' as const,
        queryIntent,
        contextBlockCount: 0,
        activeBlockIds: input.checkpointCandidate.activeBlockIds,
      },
    };
  }

  if (queryIntent === 'architecture') {
    return {
      responseMode: input.responseMode,
      detailLevel: 'focused' as const,
      queryIntent,
      summary: input.overview.summary,
      topFiles: input.overview.topFiles,
      architecturePrimaryFiles: input.overview.architecturePrimaryFiles,
      expansionCandidates: input.overview.expansionCandidates,
      nextInspectionSuggestions: summarizeOverviewSuggestions(input.overview.nextInspectionSuggestions, 3),
      blockFirst: {
        schemaVersion: 1 as const,
        detailLevel: 'focused' as const,
        queryIntent,
        contextBlockCount: 0,
      },
    };
  }

  return {
    responseMode: input.responseMode,
    summary: input.overview.summary,
    graphContext: input.resultCard.graphContext,
    topFiles: input.overview.topFiles,
    architecturePrimaryFiles: input.overview.architecturePrimaryFiles,
    contextBlockCount: compactBlocks.length,
    contextBlockSummaries: compactBlocks,
    expansionCandidates: input.overview.expansionCandidates,
    nextInspectionSuggestions: summarizeOverviewSuggestions(input.overview.nextInspectionSuggestions, 3),
    blockFirst: {
      schemaVersion: 1 as const,
      contextBlockCount: compactBlocks.length,
      activeBlockIds: input.checkpointCandidate.activeBlockIds,
      checkpointCandidate: compactCheckpoint,
      architecturePrimaryFiles: input.overview.architecturePrimaryFiles,
      nextInspectionSuggestions: summarizeOverviewSuggestions(input.overview.nextInspectionSuggestions, 3),
    },
  };
}

export function buildRetrievalData(input: {
  repoPath: string;
  informationRequest: string;
  pack: ContextPack;
  resultCard: RetrievalResultCard;
}): RetrievalData {
  const contextBlocks = buildContextBlocks(input.pack, input.resultCard);
  const checkpointCandidate = buildCheckpointCandidate(
    input.repoPath,
    input.informationRequest,
    contextBlocks,
    input.resultCard,
    input.pack.architecturePrimaryFiles ?? [],
  );
  const overview = buildOverviewData(input.pack, input.resultCard, contextBlocks);
  const blockFirst = buildBlockFirstPayload(
    contextBlocks,
    checkpointCandidate,
    overview.architecturePrimaryFiles,
    input.resultCard.nextActions,
  );

  return {
    contextPack: input.pack,
    resultCard: input.resultCard,
    contextBlocks,
    checkpointCandidate,
    blockFirst,
    overview,
  };
}

// ===========================================
// 响应格式化（统一入口）
// ===========================================

export function formatRetrievalResponse(
  pack: ContextPack,
  resultCard: RetrievalResultCard,
  options: {
    responseFormat: 'text' | 'json';
    responseMode: 'overview' | 'expanded';
    repoPath: string;
    informationRequest: string;
  },
): string {
  if (options.responseFormat === 'json') {
    return formatRetrievalJson(pack, resultCard, options);
  }
  return formatRetrievalText(pack, resultCard, options);
}

function formatRetrievalJson(
  pack: ContextPack,
  resultCard: RetrievalResultCard,
  options: {
    responseMode: 'overview' | 'expanded';
    repoPath: string;
    informationRequest: string;
  },
): string {
  const { files, seeds } = pack;
  const retrievalData = buildRetrievalData({
    repoPath: options.repoPath,
    informationRequest: options.informationRequest,
    pack,
    resultCard,
  });
  const { contextBlocks, checkpointCandidate, blockFirst, overview } = retrievalData;

  const payload = options.responseMode === 'overview'
      ? buildOverviewJsonPayload({
        responseMode: options.responseMode,
        resultCard,
        overview,
        contextBlocks,
        checkpointCandidate,
        pack,
      })
    : {
        responseMode: options.responseMode,
        summary: {
          codeBlocks: seeds.length,
          files: files.length,
          totalSegments: files.reduce((acc, f) => acc + f.segments.length, 0),
        },
        graphContext: resultCard.graphContext,
        architecturePrimaryFiles: overview.architecturePrimaryFiles,
        contextBlocks,
        references: contextBlocks.flatMap((block) => block.provenance.map((item) => ({ blockId: block.id, ...item }))),
        expansionCandidates: overview.expansionCandidates,
        nextInspectionSuggestions: resultCard.nextActions,
        checkpointCandidate,
        blockFirst,
      };

  return JSON.stringify(payload, null, 2);
}

function formatRetrievalText(
  pack: ContextPack,
  resultCard: RetrievalResultCard,
  options: {
    responseMode: 'overview' | 'expanded';
    repoPath: string;
    informationRequest: string;
  },
): string {
  const { files, seeds } = pack;
  const retrievalData = buildRetrievalData({
    repoPath: options.repoPath,
    informationRequest: options.informationRequest,
    pack,
    resultCard,
  });
  const { overview } = retrievalData;

  if (options.responseMode === 'overview') {
    const lines = [
      '## Retrieval Overview',
      `Files: ${overview.summary.files} | Code Blocks: ${overview.summary.codeBlocks} | Segments: ${overview.summary.totalSegments}`,
      '',
      '### Top Files',
      ...(overview.topFiles.length > 0 ? overview.topFiles.map((item) => `- ${item.filePath} (${item.segmentCount} segments)`) : ['- None']),
      '',
      '### Architecture Primary Files',
      ...(overview.architecturePrimaryFiles.length > 0 ? overview.architecturePrimaryFiles.map((filePath) => `- ${filePath}`) : ['- None']),
      '',
      '### Expansion Candidates',
      ...(overview.expansionCandidates.length > 0
        ? overview.expansionCandidates.map((item) => `- ${item.filePath} | ${item.reason} | priority=${item.priority}`)
        : ['- None']),
      '',
      '### Next Inspection Suggestions',
      ...(overview.nextInspectionSuggestions.length > 0 ? overview.nextInspectionSuggestions.map((item) => `- ${item}`) : ['- None']),
      ...(resultCard.graphContext
        ? [
            '',
            '### Graph Context',
            ...formatGraphContextSummary(resultCard.graphContext),
          ]
        : []),
    ];
    return lines.join('\n');
  }

  // expanded mode
  const fileBlocks = files
    .map((file) => {
      const segments = file.segments.map((seg) => formatSegment(seg)).join('\n\n');
      return segments;
    })
    .join('\n\n---\n\n');

  const summary = [
    `Found ${seeds.length} relevant code blocks`,
    `Files: ${files.length}`,
    `Total segments: ${files.reduce((acc, f) => acc + f.segments.length, 0)}`,
  ].join(' | ');

  const sections = [
    '## 结果卡片',
    summary,
    '',
    ...(resultCard.status
      ? ['### 索引状态', `- ${resultCard.status.headline}`, ...resultCard.status.details.map((detail) => `- ${detail}`), '']
      : []),
    ...(overview.architecturePrimaryFiles.length > 0
      ? [
          '### Architecture Primary Files',
          ...overview.architecturePrimaryFiles.map((filePath) => `- ${filePath}`),
          '',
        ]
      : []),
    '### 代码命中 (Source: Code)',
    fileBlocks || '- 未命中代码片段',
    '',
    '### 相关模块记忆 (Source: Feature Memory)',
    formatFeatureMemoryMatches(resultCard.memories),
    '',
    '### 相关决策记录 (Source: Decision Record)',
    formatDecisionMatches(resultCard.decisions),
    '',
    '### 相关长期记忆 (Source: Long-term Memory)',
    formatLongTermMemoryMatches(resultCard.longTermMemories),
    '',
    ...(resultCard.graphContext
      ? [
          '### 直接图谱摘要 (Source: Code Graph)',
          formatGraphContextSummary(resultCard.graphContext).join('\n'),
          '',
        ]
      : []),
    '### 近期反馈信号 (Source: Feedback Loop)',
    formatFeedbackMatches(resultCard.feedbackSignals),
    '',
    '### 跨项目参考 (Source: Cross-project Hub)',
    '- 暂无相关跨项目记忆',
    '',
    '### 来源层级与可信规则',
    ...resultCard.trustRules.map((line) => `- ${line}`),
    '',
    '### 下一步动作',
    ...resultCard.nextActions.map((line) => `- ${line}`),
    '',
    '### 为什么命中这些结果',
    formatReasoning(resultCard.reasoning),
  ];
  return sections.join('\n');
}
