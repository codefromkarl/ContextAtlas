/**
 * 检索层共享类型定义
 *
 * 从 MCP tool 层提取的 ResultCard 相关接口 + application 层 I/O 类型。
 * MCP adapter 和 CLI adapter 共享这些类型，不依赖彼此。
 */

import type {
  BlockFirstPayload,
  CheckpointCandidate,
  ContextBlock,
  DecisionRecord,
  FeatureMemory,
  ResolvedLongTermMemoryItem,
} from '../../memory/types.js';
import type { ContextPack } from '../../search/types.js';

// ===========================================
// ResultCard 相关接口（原 MCP tool 内部类型）
// ===========================================

export interface ResultCardFeatureMemoryMatch {
  memory: FeatureMemory;
  score: number;
  reasons: string[];
  freshness: FeatureMemoryFreshness;
  feedbackSignals?: ResultCardFeedbackMatch[];
}

export interface ResultCardDecisionMatch {
  decision: DecisionRecord;
  score: number;
  reasons: string[];
  fallback: boolean;
}

export interface ResultCardLongTermMemoryMatch {
  memory: ResolvedLongTermMemoryItem;
  score: number;
  reasons: string[];
  scoreBreakdown?: Record<string, number | string>;
}

export interface ParsedFeedbackSignal {
  outcome: 'helpful' | 'not-helpful' | 'memory-stale' | 'wrong-module';
  targetType?: 'code' | 'feature-memory' | 'decision-record' | 'long-term-memory';
  targetId?: string;
  query?: string;
  details?: string;
}

export interface ResultCardFeedbackMatch {
  memory: ResolvedLongTermMemoryItem;
  score: number;
  reasons: string[];
  signal: ParsedFeedbackSignal;
}

export interface FeatureMemoryFreshness {
  status: Array<'active' | 'stale' | 'conflict'>;
  lastVerifiedAt: string;
  confidence: 'high' | 'medium' | 'low';
  reviewStatus: 'verified' | 'needs-review';
  reviewReason?: string;
}

export interface RetrievalResultCard {
  memories: ResultCardFeatureMemoryMatch[];
  decisions: ResultCardDecisionMatch[];
  longTermMemories: ResultCardLongTermMemoryMatch[];
  feedbackSignals: ResultCardFeedbackMatch[];
  reasoning: string[];
  trustRules: string[];
  nextActions: string[];
  graphContext?: RetrievalGraphContextSummary;
  status?: {
    headline: string;
    details: string[];
  };
}

export interface RetrievalGraphSymbolSummary {
  name: string;
  filePath: string;
  directUpstream: string[];
  directDownstream: string[];
}

export interface RetrievalGraphProcessSummary {
  id: string;
  entryKind: string;
  entryName: string;
  keySymbols: string[];
  keyFiles: string[];
  modules: Array<{
    modulePath: string;
    symbolCount: number;
    fileCount: number;
    callDensity: number;
    sharedDependencyCount: number;
  }>;
  depth: number;
  score: number;
  scoreReasons: string[];
}

export interface RetrievalGraphContextSummary {
  symbols: RetrievalGraphSymbolSummary[];
  processes?: RetrievalGraphProcessSummary[];
}

// ===========================================
// Application 层 I/O 类型
// ===========================================

export interface RetrievalInput {
  repoPath: string;
  informationRequest: string;
  technicalTerms?: string[];
  responseFormat?: 'text' | 'json';
  responseMode?: 'overview' | 'expanded';
  includeGraphContext?: boolean;
}

export interface OverviewData {
  summary: { codeBlocks: number; files: number; totalSegments: number };
  topFiles: Array<{ filePath: string; segmentCount: number }>;
  architecturePrimaryFiles: string[];
  references: Array<{ blockId: string; source: string; ref: string }>;
  expansionCandidates: Array<{ filePath: string; reason: string; priority: 'high' | 'medium' | 'low' }>;
  nextInspectionSuggestions: string[];
}

export interface RetrievalData {
  contextPack: ContextPack;
  resultCard: RetrievalResultCard;
  contextBlocks: ContextBlock[];
  checkpointCandidate: CheckpointCandidate;
  blockFirst: BlockFirstPayload;
  overview: OverviewData;
}

export interface RetrievalOutput {
  text: string;
  isError?: boolean;
  data?: RetrievalData;
}

// ===========================================
// 检索进度阶段
// ===========================================

export type RetrievalProgressStage =
  | 'prepare'
  | 'init'
  | 'retrieve'
  | 'rerank'
  | 'expand'
  | 'pack'
  | 'done';

export const RETRIEVAL_PROGRESS_ORDER: RetrievalProgressStage[] = [
  'prepare',
  'init',
  'retrieve',
  'rerank',
  'expand',
  'pack',
  'done',
];
