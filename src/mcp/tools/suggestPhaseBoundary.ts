import { z } from 'zod';
import { MemoryStore } from '../../memory/MemoryStore.js';
import type { TaskCheckpoint } from '../../memory/types.js';
import { logger } from '../../utils/logger.js';
import { responseFormatSchema } from './responseFormat.js';

const phaseSchema = z.enum(['overview', 'research', 'debug', 'implementation', 'verification', 'handoff']);
const assemblyProfileSchema = phaseSchema.exclude(['research']);

const taskCheckpointSchema = z.object({
  id: z.string(),
  repoPath: z.string().optional().default(''),
  title: z.string().optional().default(''),
  goal: z.string().optional().default(''),
  phase: phaseSchema,
  summary: z.string().optional().default(''),
  activeBlockIds: z.array(z.string()).optional().default([]),
  exploredRefs: z.array(z.string()).optional().default([]),
  keyFindings: z.array(z.string()).optional().default([]),
  unresolvedQuestions: z.array(z.string()).optional().default([]),
  nextSteps: z.array(z.string()).optional().default([]),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

const retrievalSignalSchema = z.object({
  codeBlocks: z.number().int().min(0).optional().default(0),
  memoryBlocks: z.number().int().min(0).optional().default(0),
  decisionBlocks: z.number().int().min(0).optional().default(0),
  nextInspectionSuggestions: z.number().int().min(0).optional().default(0),
  confidence: z.enum(['low', 'medium', 'high']).optional(),
  mode: z.enum(['overview', 'expanded']).optional(),
  note: z.string().optional(),
});

const assemblySignalSchema = z.object({
  profile: assemblyProfileSchema.optional(),
  source: z.enum(['default', 'phase', 'profile']).optional(),
  budgetUsed: z.number().int().min(0).optional(),
  budgetLimit: z.number().int().min(0).optional(),
  budgetExhausted: z.boolean().optional(),
  scopeCascadeApplied: z.boolean().optional(),
  selectionStrategy: z.enum(['mmr', 'ranked']).optional(),
});

export const suggestPhaseBoundarySchema = z.object({
  repo_path: z.string().describe('Absolute repository root path'),
  current_phase: phaseSchema.describe('Current task phase'),
  checkpoint_id: z.string().optional().describe('Checkpoint id to load from the project store'),
  checkpoint: taskCheckpointSchema.optional().describe('Optional explicit checkpoint payload'),
  retrieval_signal: retrievalSignalSchema.optional().describe('Optional retrieval quality / density signal'),
  assembly_signal: assemblySignalSchema.optional().describe('Optional context assembly signal'),
  format: responseFormatSchema.optional().default('text'),
});

export type SuggestPhaseBoundaryInput = z.infer<typeof suggestPhaseBoundarySchema>;

type NormalizedCheckpoint = Pick<
  TaskCheckpoint,
  | 'id'
  | 'repoPath'
  | 'title'
  | 'goal'
  | 'phase'
  | 'summary'
  | 'activeBlockIds'
  | 'exploredRefs'
  | 'keyFindings'
  | 'unresolvedQuestions'
  | 'nextSteps'
> & {
  createdAt?: string;
  updatedAt?: string;
};

type RetrievalSignal = z.infer<typeof retrievalSignalSchema>;
type AssemblySignal = z.infer<typeof assemblySignalSchema>;
type PhaseName = z.infer<typeof phaseSchema>;
type TransitionType = 'stay' | 'advance';

interface PhaseBoundaryRecommendation {
  recommendedPhase: PhaseName;
  transition: TransitionType;
  shouldTransition: boolean;
  reasons: string[];
  blockers: string[];
  suggestedActions: string[];
}

interface SuggestPhaseBoundaryPayload {
  tool: 'suggest_phase_boundary';
  currentPhase: PhaseName;
  checkpoint: NormalizedCheckpoint | null;
  retrievalSignal: RetrievalSignal | null;
  assemblySignal: AssemblySignal | null;
  recommendedPhase: PhaseName;
  transition: TransitionType;
  shouldTransition: boolean;
  reasons: string[];
  blockers: string[];
  suggestedActions: string[];
}

const PHASE_TARGETS: Record<PhaseName, PhaseName> = {
  overview: 'implementation',
  research: 'implementation',
  debug: 'verification',
  implementation: 'verification',
  verification: 'handoff',
  handoff: 'handoff',
};

const IMPLEMENTATION_ACTION_KEYWORDS = ['implement', 'build', 'ship', 'code', 'modify', 'patch'];
const VERIFICATION_ACTION_KEYWORDS = ['verify', 'test', 'regression', 'qa', 'validate', 'run'];
const HANDOFF_ACTION_KEYWORDS = ['handoff', 'resume', 'transfer', 'share', 'pass'];

export async function handleSuggestPhaseBoundary(
  args: SuggestPhaseBoundaryInput,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  logger.info(
    {
      repoPath: args.repo_path,
      currentPhase: args.current_phase,
      checkpointId: args.checkpoint_id,
    },
    'MCP suggest_phase_boundary 调用开始',
  );

  const checkpoint = await resolveCheckpoint(args.repo_path, args.checkpoint_id, args.checkpoint);
  if (args.checkpoint_id && !checkpoint) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Checkpoint not found: ${args.checkpoint_id}` }],
    };
  }

  const recommendation = buildRecommendation(args.current_phase, checkpoint, args.retrieval_signal, args.assembly_signal);
  const payload: SuggestPhaseBoundaryPayload = {
    tool: 'suggest_phase_boundary',
    currentPhase: args.current_phase,
    checkpoint,
    retrievalSignal: args.retrieval_signal ?? null,
    assemblySignal: args.assembly_signal ?? null,
    ...recommendation,
  };

  if (args.format === 'json') {
    return {
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    };
  }

  return {
    content: [{ type: 'text', text: formatTextOutput(payload) }],
  };
}

async function resolveCheckpoint(
  repoPath: string,
  checkpointId?: string,
  explicitCheckpoint?: z.infer<typeof taskCheckpointSchema>,
): Promise<NormalizedCheckpoint | null> {
  if (explicitCheckpoint) {
    return normalizeCheckpoint(explicitCheckpoint);
  }

  if (!checkpointId) {
    return null;
  }

  const store = new MemoryStore(repoPath);
  const checkpoint = await store.readCheckpoint(checkpointId);
  return checkpoint ? normalizeCheckpoint(checkpoint) : null;
}

function normalizeCheckpoint(checkpoint: z.infer<typeof taskCheckpointSchema> | TaskCheckpoint): NormalizedCheckpoint {
  return {
    id: checkpoint.id,
    repoPath: checkpoint.repoPath,
    title: checkpoint.title,
    goal: checkpoint.goal,
    phase: checkpoint.phase,
    summary: checkpoint.summary,
    activeBlockIds: [...checkpoint.activeBlockIds],
    exploredRefs: [...checkpoint.exploredRefs],
    keyFindings: [...checkpoint.keyFindings],
    unresolvedQuestions: [...checkpoint.unresolvedQuestions],
    nextSteps: [...checkpoint.nextSteps],
    createdAt: checkpoint.createdAt,
    updatedAt: checkpoint.updatedAt,
  };
}

function buildRecommendation(
  currentPhase: PhaseName,
  checkpoint: NormalizedCheckpoint | null,
  retrievalSignal?: RetrievalSignal,
  assemblySignal?: AssemblySignal,
): PhaseBoundaryRecommendation {
  const blockers: string[] = [];
  const reasons: string[] = [];
  const candidatePhase = PHASE_TARGETS[currentPhase];

  if (!checkpoint) {
    blockers.push('没有可用 checkpoint，建议先保存或加载当前任务状态');
  } else {
    if (checkpoint.phase !== currentPhase) {
      blockers.push(`checkpoint.phase (${checkpoint.phase}) 与 current_phase (${currentPhase}) 不一致`);
    }
    for (const question of checkpoint.unresolvedQuestions) {
      blockers.push(`未解决问题: ${question}`);
    }
  }

  if (assemblySignal?.budgetExhausted) {
    blockers.push('context assembly budget 已耗尽，建议先压缩上下文');
  }

  const implementationReadiness = scoreImplementationReadiness(
    checkpoint,
    retrievalSignal,
    assemblySignal,
  );
  const verificationReadiness = scoreVerificationReadiness(
    checkpoint,
    retrievalSignal,
    assemblySignal,
  );
  const handoffReadiness = scoreHandoffReadiness(checkpoint, retrievalSignal, assemblySignal);

  let recommendedPhase = currentPhase;
  let transition: TransitionType = 'stay';

  if (currentPhase === 'handoff') {
    reasons.push('handoff 是收尾阶段，默认保持不变，除非显式重新开启任务');
  } else if (blockers.length > 0) {
    reasons.push('存在 blocker，先保持当前阶段，等问题清理后再切换');
  } else if (isImplementationFastTrack(currentPhase, implementationReadiness)) {
    recommendedPhase = candidatePhase;
    transition = 'advance';
    reasons.push('checkpoint 与检索信号已经提供足够实现依据，可以直接进入实现');
  } else if (isVerificationFastTrack(currentPhase, verificationReadiness)) {
    recommendedPhase = candidatePhase;
    transition = 'advance';
    reasons.push('debug / implementation 的核心信号已经收敛，适合转入验证');
  } else if (currentPhase === 'verification' && handoffReadiness >= 2) {
    recommendedPhase = candidatePhase;
    transition = 'advance';
    reasons.push('验证信号足够稳定，可以进入交接');
  } else {
    reasons.push(`当前阶段的证据还不足以推进到 ${candidatePhase}，先保持 ${currentPhase}`);
  }

  if (checkpoint) {
    if (checkpoint.keyFindings.length > 0) {
      reasons.push(`checkpoint 已记录 ${checkpoint.keyFindings.length} 条关键发现`);
    }
    if (checkpoint.nextSteps.length > 0) {
      reasons.push(`checkpoint 已包含 ${checkpoint.nextSteps.length} 条下一步`);
    }
    if (currentPhase !== 'handoff' && checkpoint.phase === 'handoff' && transition === 'stay') {
      reasons.push('checkpoint 本身已经是 handoff 状态');
    }
  }

  if (retrievalSignal) {
    const evidenceCount =
      retrievalSignal.codeBlocks + retrievalSignal.memoryBlocks + retrievalSignal.decisionBlocks;
    if (evidenceCount > 0) {
      reasons.push(`retrieval signal 显示 ${evidenceCount} 个相关证据块`);
    }
    if (retrievalSignal.confidence) {
      reasons.push(`retrieval 信心为 ${retrievalSignal.confidence}`);
    }
    if (retrievalSignal.mode) {
      reasons.push(`retrieval 模式为 ${retrievalSignal.mode}`);
    }
  }

  if (assemblySignal) {
    if (assemblySignal.profile) {
      reasons.push(`context assembly profile 为 ${assemblySignal.profile}`);
    }
    if (typeof assemblySignal.budgetUsed === 'number' && typeof assemblySignal.budgetLimit === 'number') {
      reasons.push(`context assembly budget 使用 ${assemblySignal.budgetUsed}/${assemblySignal.budgetLimit}`);
    }
    if (assemblySignal.scopeCascadeApplied) {
      reasons.push('scope cascade 已启用');
    }
  }

  return {
    recommendedPhase,
    transition,
    shouldTransition: transition === 'advance',
    reasons: dedupeStrings(reasons),
    blockers: dedupeStrings(blockers),
    suggestedActions: buildSuggestedActions(
      currentPhase,
      recommendedPhase,
      checkpoint,
      blockers.length > 0,
    ),
  };
}

function scoreImplementationReadiness(
  checkpoint: NormalizedCheckpoint | null,
  retrievalSignal?: RetrievalSignal,
  assemblySignal?: AssemblySignal,
): number {
  let score = 0;

  if (retrievalSignal) {
    if (retrievalSignal.codeBlocks > 0) score += 2;
    if (retrievalSignal.memoryBlocks > 0) score += 1;
    if (retrievalSignal.confidence === 'high') score += 1;
    if (retrievalSignal.mode === 'expanded') score += 1;
  }

  if (assemblySignal) {
    if (assemblySignal.profile === 'implementation') score += 2;
    if (assemblySignal.source === 'phase' || assemblySignal.source === 'profile') score += 1;
    if (assemblySignal.scopeCascadeApplied) score += 1;
  }

  if (checkpoint) {
    if (checkpoint.keyFindings.length > 0) score += 1;
    if (containsAny(checkpoint.nextSteps, IMPLEMENTATION_ACTION_KEYWORDS)) score += 2;
    if (checkpoint.unresolvedQuestions.length === 0) score += 2;
    else score -= checkpoint.unresolvedQuestions.length;
  }

  return score;
}

function scoreVerificationReadiness(
  checkpoint: NormalizedCheckpoint | null,
  retrievalSignal?: RetrievalSignal,
  assemblySignal?: AssemblySignal,
): number {
  let score = 0;

  if (retrievalSignal) {
    if (retrievalSignal.codeBlocks > 0) score += 1;
    if (retrievalSignal.confidence === 'high') score += 1;
    if (retrievalSignal.mode === 'expanded') score += 1;
  }

  if (assemblySignal) {
    if (assemblySignal.profile === 'verification') score += 2;
    if (assemblySignal.source === 'phase' || assemblySignal.source === 'profile') score += 1;
    if (assemblySignal.budgetExhausted) score -= 1;
  }

  if (checkpoint) {
    if (checkpoint.unresolvedQuestions.length === 0) score += 2;
    if (containsAny(checkpoint.nextSteps, VERIFICATION_ACTION_KEYWORDS)) score += 2;
    if (containsAny(checkpoint.nextSteps, IMPLEMENTATION_ACTION_KEYWORDS)) score -= 1;
  }

  return score;
}

function scoreHandoffReadiness(
  checkpoint: NormalizedCheckpoint | null,
  retrievalSignal?: RetrievalSignal,
  assemblySignal?: AssemblySignal,
): number {
  let score = 0;

  if (checkpoint) {
    if (checkpoint.unresolvedQuestions.length === 0) score += 1;
    if (containsAny(checkpoint.nextSteps, HANDOFF_ACTION_KEYWORDS)) score += 2;
    if (checkpoint.keyFindings.length > 0) score += 1;
  }

  if (retrievalSignal?.confidence === 'high') score += 1;
  if (assemblySignal?.profile === 'handoff') score += 2;

  return score;
}

function isImplementationFastTrack(currentPhase: PhaseName, implementationReadiness: number): boolean {
  if (currentPhase !== 'overview' && currentPhase !== 'research') {
    return false;
  }

  return implementationReadiness >= 4;
}

function isVerificationFastTrack(currentPhase: PhaseName, verificationReadiness: number): boolean {
  if (currentPhase !== 'debug' && currentPhase !== 'implementation') {
    return false;
  }

  return verificationReadiness >= 4;
}

function containsAny(values: string[], keywords: string[]): boolean {
  return values.some((value) => {
    const lower = value.toLowerCase();
    return keywords.some((keyword) => lower.includes(keyword));
  });
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}

function buildSuggestedActions(
  currentPhase: PhaseName,
  recommendedPhase: PhaseName,
  checkpoint: NormalizedCheckpoint | null,
  hasBlockers: boolean,
): string[] {
  const nextStepHints = checkpoint?.nextSteps ?? [];

  if (recommendedPhase === currentPhase) {
    if (currentPhase === 'handoff') {
      return [
        '保留当前 checkpoint 作为交接锚点',
        '导出或更新 handoff bundle',
        '把未解决问题和下一步写清楚，交给下一个 agent 或人类继续',
      ];
    }

    if (hasBlockers) {
      return [
        '先清理 blocker，再重新评估是否可以切换阶段',
        currentPhase === 'debug'
          ? '把未解决问题收敛到可验证的失败路径'
          : '继续补充检索与上下文，消除当前阶段的不确定性',
        'blocker 清理后再调用 suggest_phase_boundary 复评',
      ];
    }

    return [
      currentPhase === 'overview' || currentPhase === 'research'
        ? '继续补充检索，直到可以明确推进到实现'
        : '继续收集验证证据，等信号稳定后再推进',
      '把新增证据写回 checkpoint，避免上下文漂移',
      '在准备好切换前，先保持当前阶段',
    ];
  }

  if (recommendedPhase === 'implementation') {
    return [
      '把 checkpoint 中的 nextSteps 收敛成可执行实现任务',
      hasBlockers ? '先清理 blocker，再开始改代码' : '直接进入代码修改并保留实现边界记录',
      nextStepHints.length > 0
        ? `优先对齐已有下一步: ${nextStepHints.slice(0, 3).join(' / ')}`
        : '实现完成后补一个 verification checkpoint',
    ];
  }

  if (recommendedPhase === 'verification') {
    return [
      '运行针对当前变更的最小回归测试或复现用例',
      hasBlockers ? '先确认 blocker 是否真的消失，再判断是否可以交接' : '记录通过与失败边界，避免把未验证内容带入 handoff',
      '验证通过后生成 handoff checkpoint',
    ];
  }

  if (recommendedPhase === 'handoff') {
    return [
      '保留当前 checkpoint 作为交接锚点',
      '导出或更新 handoff bundle',
      '把未解决问题和下一步写清楚，交给下一个 agent 或人类继续',
    ];
  }

  if (recommendedPhase === 'debug') {
    return [
      '重现当前问题并把失败路径缩到最小',
      '记录失败样本、错误信息和已排除的假设',
      '当修复完成后再切换到 verification',
    ];
  }

  return [
    '补充检索，扩大上下文覆盖面',
    '把当前发现整理进 checkpoint',
    '在准备好实现或验证边界前，不要提前收敛到最终结论',
  ];
}

function formatTextOutput(payload: SuggestPhaseBoundaryPayload): string {
  const lines = [
    '## Phase Boundary Suggestion',
    `- **Current Phase**: ${payload.currentPhase}`,
    `- **Recommended Phase**: ${payload.recommendedPhase}`,
    `- **Transition**: ${payload.transition}`,
    `- **Should Transition**: ${payload.shouldTransition ? 'yes' : 'no'}`,
    '',
    '### Reasons',
    ...(payload.reasons.length > 0 ? payload.reasons.map((reason) => `- ${reason}`) : ['- None']),
    '',
    '### Blockers',
    ...(payload.blockers.length > 0 ? payload.blockers.map((blocker) => `- ${blocker}`) : ['- None']),
    '',
    '### Suggested Actions',
    ...(payload.suggestedActions.length > 0
      ? payload.suggestedActions.map((action) => `- ${action}`)
      : ['- None']),
  ];

  if (payload.checkpoint) {
    lines.push('');
    lines.push('### Checkpoint Snapshot');
    lines.push(`- **ID**: ${payload.checkpoint.id}`);
    lines.push(`- **Phase**: ${payload.checkpoint.phase}`);
    lines.push(`- **Title**: ${payload.checkpoint.title || 'N/A'}`);
    lines.push(`- **Goal**: ${payload.checkpoint.goal || 'N/A'}`);
    lines.push(`- **Summary**: ${payload.checkpoint.summary || 'N/A'}`);
    lines.push(`- **Key Findings**: ${payload.checkpoint.keyFindings.length}`);
    lines.push(`- **Unresolved Questions**: ${payload.checkpoint.unresolvedQuestions.length}`);
    lines.push(`- **Next Steps**: ${payload.checkpoint.nextSteps.length}`);
  }

  return lines.join('\n');
}
