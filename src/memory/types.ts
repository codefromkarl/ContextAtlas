/**
 * Project Memory 类型定义
 */

/**
 * 功能记忆 - 记录模块职责、API、数据流
 */
export interface FeatureMemory {
  /** 模块名称 */
  name: string;
  /** 位置信息 */
  location: {
    /** 源文件目录 */
    dir: string;
    /** 相关文件列表 */
    files: string[];
    /** 入口文件（可选） */
    entryPoint?: string;
  };
  /** 职责描述 */
  responsibility: string;
  /** API 信息 */
  api: {
    /** 导出的类/函数/类型 */
    exports: string[];
    /** API 端点（如适用） */
    endpoints?: Array<{
      method: string;
      path: string;
      handler: string;
      description?: string;
    }>;
  };
  /** 依赖关系 */
  dependencies: {
    /** 内部导入 */
    imports: string[];
    /** 外部依赖 */
    external: string[];
  };
  /** 数据流描述 */
  dataFlow: string;
  /** 关键模式 */
  keyPatterns: string[];
  /** 最后更新时间 */
  lastUpdated: string;
  /** 记忆确认状态 */
  confirmationStatus?: 'suggested' | 'agent-inferred' | 'human-confirmed';
  /** 复核状态 */
  reviewStatus?: 'verified' | 'needs-review';
  /** 复核原因 */
  reviewReason?: string;
  /** 标记待复核时间 */
  reviewMarkedAt?: string;
  /** 相关决策 ID */
  relatedDecisions?: string[];
  /** 相关记忆（跨模块/跨项目引用） */
  relatedMemories?: string[];
  /** 来源项目 ID（用于跨项目共享） */
  sourceProjectId?: string;
  /** 记忆类型 */
  memoryType?: 'local' | 'shared' | 'framework' | 'pattern';
  /** 共享记忆引用 */
  sharedReferences?: SharedReference[];
  /** 原始证据引用 */
  evidenceRefs?: string[];
}

/**
 * 共享记忆引用
 */
export interface SharedReference {
  /** 共享记忆来源（支持 sqlite uri 或旧文件路径） */
  from: string;
  /** 本地别名 */
  as: string;
  /** 版本号 */
  version?: string;
  /** 本地覆盖字段 */
  overrides?: Record<string, unknown>;
}

/**
 * 决策记录 - 记录架构决策
 */
export interface DecisionRecord {
  /** 唯一标识符 */
  id: string;
  /** 记录日期 */
  date: string;
  /** 责任人 */
  owner?: string;
  /** 审核人 / 责任人 */
  reviewer?: string;
  /** 决策标题 */
  title: string;
  /** 背景上下文 */
  context: string;
  /** 决策内容 */
  decision: string;
  /** 考虑的替代方案 */
  alternatives: Array<{
    name: string;
    pros: string[];
    cons: string[];
  }>;
  /** 决策理由 */
  rationale: string;
  /** 后果/影响 */
  consequences: string[];
  /** 原始证据引用 */
  evidenceRefs?: string[];
  /** 状态 */
  status: 'accepted' | 'rejected' | 'superseded';
}

/**
 * 项目档案 - 记录项目整体信息
 */
export interface ProjectProfile {
  /** 项目名称 */
  name: string;
  /** 项目描述 */
  description: string;
  /** 技术栈 */
  techStack: {
    language: string[];
    frameworks: string[];
    databases: string[];
    tools: string[];
  };
  /** 项目结构 */
  structure: {
    srcDir: string;
    mainEntry: string;
    keyModules: Array<{
      name: string;
      path: string;
      description: string;
    }>;
  };
  /** 开发约定 */
  conventions: {
    namingConventions: string[];
    codeStyle: string[];
    gitWorkflow: string;
  };
  /** 构建/运行命令 */
  commands: {
    build: string[];
    test: string[];
    dev: string[];
    start: string[];
  };
  /** 治理策略 */
  governance?: {
    /** 项目档案模式 */
    profileMode?: 'editable' | 'organization-readonly';
    /** shared memory 策略 */
    sharedMemory?: 'disabled' | 'readonly' | 'editable';
    /** personal memory 默认作用域 */
    personalMemory?: 'project' | 'global-user';
  };
  /** 最后更新时间 */
  lastUpdated: string;
}

/**
 * 记忆查找结果
 */
export type MemoryKind = 'procedural' | 'semantic' | 'episodic' | 'task-state';

export type ContextBlockPriority = 'high' | 'medium' | 'low';

export type ContextBlockType =
  | 'repo-rules'
  | 'module-summary'
  | 'decision-context'
  | 'task-state'
  | 'recent-findings'
  | 'open-questions'
  | 'code-evidence'
  | 'feedback-signals';

export interface ContextBlockProvenance {
  source: 'code' | 'feature-memory' | 'decision-record' | 'long-term-memory' | 'feedback' | 'evidence';
  ref: string;
}

export interface ContextBlockFreshness {
  lastVerifiedAt?: string;
  stale?: boolean;
  confidence?: 'high' | 'medium' | 'low';
}

export interface ContextBlockReference {
  blockId: string;
  source: ContextBlockProvenance['source'];
  ref: string;
}

export interface ContextBlockLink {
  blockId: string;
  relation: 'supports' | 'references' | 'expands' | 'conflicts-with' | 'follows-up';
  targetBlockId?: string;
  targetRef?: string;
  reason?: string;
}

export interface ContextBlock {
  id: string;
  type: ContextBlockType;
  title: string;
  purpose: string;
  content: string;
  priority: ContextBlockPriority;
  pinned: boolean;
  expandable: boolean;
  budgetChars?: number;
  memoryKind?: MemoryKind;
  provenance: ContextBlockProvenance[];
  freshness?: ContextBlockFreshness;
  summary?: string;
  score?: number;
  rank?: number;
  references?: ContextBlockReference[];
  relatedBlockIds?: string[];
  links?: ContextBlockLink[];
}

export interface TaskCheckpoint {
  id: string;
  repoPath: string;
  title: string;
  goal: string;
  phase: 'overview' | 'research' | 'debug' | 'implementation' | 'verification' | 'handoff';
  summary: string;
  activeBlockIds: string[];
  exploredRefs: string[];
  supportingRefs?: string[];
  keyFindings: string[];
  unresolvedQuestions: string[];
  nextSteps: string[];
  architecturePrimaryFiles?: string[];
  createdAt: string;
  updatedAt: string;
}

export type TaskCheckpointSource = 'retrieval' | 'manual' | 'auto' | 'handoff' | 'imported';

export interface TaskCheckpointCandidate extends TaskCheckpoint {
  source?: TaskCheckpointSource;
  confidence?: ContextBlockFreshness['confidence'];
  reason?: string;
}

export type CheckpointCandidate = TaskCheckpointCandidate;

export interface CheckpointHandoff {
  checkpointId: string;
  repoPath: string;
  title: string;
  goal: string;
  phase: TaskCheckpoint['phase'];
  summary: string;
  activeBlockIds: string[];
  exploredRefs: string[];
  supportingRefs?: string[];
  keyFindings: string[];
  unresolvedQuestions: string[];
  nextSteps: string[];
  architecturePrimaryFiles?: string[];
  contextBlockId: string;
}

export interface CheckpointSummary {
  activeBlockCount: number;
  exploredRefCount: number;
  keyFindingCount: number;
  unresolvedQuestionCount: number;
  nextStepCount: number;
}

export interface CheckpointToolPayload {
  tool: 'create_checkpoint' | 'load_checkpoint';
  checkpoint: TaskCheckpoint;
  contextBlocks: ContextBlock[];
  handoff: CheckpointHandoff;
  summary: CheckpointSummary;
  savedTo?: string;
}

export interface CheckpointBundleBase {
  bundleVersion: 1;
  checkpointId: string;
  repoPath: string;
  title: string;
  goal: string;
  phase: TaskCheckpoint['phase'];
  summary: string;
  contextBlocks: ContextBlock[];
}

export interface CheckpointHandoffBundle extends CheckpointBundleBase {
  kind: 'handoff-bundle';
  handoff: CheckpointHandoff;
  nextSteps: string[];
}

export interface CheckpointResumeBundle extends CheckpointBundleBase {
  kind: 'resume-bundle';
  resumeFromCheckpointId: string;
  activeBlockIds: string[];
  exploredRefs: string[];
  supportingRefs?: string[];
  keyFindings: string[];
  unresolvedQuestions: string[];
}

export interface CheckpointToolPayloadWithBundles extends CheckpointToolPayload {
  handoffBundle: CheckpointHandoffBundle;
  resumeBundle: CheckpointResumeBundle;
}

export interface CheckpointListSummary {
  total: number;
  phaseCounts: Record<TaskCheckpoint['phase'], number>;
}

export interface CheckpointListPayload {
  tool: 'list_checkpoints';
  total: number;
  checkpoints: TaskCheckpoint[];
  contextBlocks: ContextBlock[];
  summary: CheckpointListSummary;
}

export type BlockFirstSchemaVersion = 1;

export interface BlockFirstPayload {
  schemaVersion: BlockFirstSchemaVersion;
  contextBlocks: ContextBlock[];
  references: ContextBlockReference[];
  checkpointCandidate: TaskCheckpointCandidate;
  architecturePrimaryFiles: string[];
  nextInspectionSuggestions: string[];
}

export interface MemorySearchResult {
  memory: FeatureMemory;
  score: number;
  matchFields: string[];
}

/**
 * 查找选项
 */
export interface FindOptions {
  /** 最小分数阈值 */
  minScore?: number;
  /** 最大返回数量 */
  limit?: number;
  /** 是否包含详细信息 */
  includeDetails?: boolean;
}

// ===========================================
// 渐进式记忆加载 - 三层架构类型
// ===========================================

/**
 * Catalog 模块路由条目 - catalog 中每个模块的轻量索引
 *
 * 仅包含路由所需的元数据，不含完整记忆内容，
 * 用于在不加载完整模块记忆内容的前提下判断相关性。
 */
export interface CatalogModuleEntry {
  /** 模块记忆逻辑路径（用于路由与兼容映射，例如 "features/search-service.json"） */
  file: string;
  /** 所属域（如 "search", "indexing", "mcp"） */
  scope: string;
  /** 快速匹配关键词，从 FeatureMemory.keyPatterns + name + exports 提取 */
  keywords: string[];
  /** 文件路径 glob 模式，命中则加载该模块记忆 */
  triggerPaths: string[];
  /** 最后更新时间 */
  lastUpdated: string;
}

/**
 * Scope 定义 - 模块域的元数据
 */
export interface MemoryScope {
  /** 域描述 */
  description: string;
  /** 是否联动加载：当任一模块被匹配时，加载同 scope 下所有模块 */
  cascadeLoad: boolean;
}

/**
 * Memory Catalog - Tier 0 路由索引
 *
 * 始终加载的轻量索引（~1-2KB），用于路由查询到具体模块记忆。
 */
export interface MemoryCatalog {
  /** Schema 版本号 */
  version: number;
  /** 全局记忆文件列表（始终加载，不含 .json 后缀） */
  globalMemoryFiles: string[];
  /** 模块路由表：模块名 → 路由条目 */
  modules: Record<string, CatalogModuleEntry>;
  /** 域定义：scope 名 → scope 配置 */
  scopes: Record<string, MemoryScope>;
}

/**
 * 全局记忆类型枚举
 */
export type GlobalMemoryType =
  | 'profile'
  | 'conventions'
  | 'cross-cutting'
  | 'user'
  | 'feedback'
  | 'project-state'
  | 'reference';

/**
 * 全局记忆 - Tier 1 始终加载的公共记忆
 */
export interface GlobalMemory {
  /** 记忆类型 */
  type: GlobalMemoryType;
  /** 记忆内容（键值对形式，各类型不同） */
  data: Record<string, unknown>;
  /** 最后更新时间 */
  lastUpdated: string;
}

/**
 * 长期记忆作用域
 */
export type LongTermMemoryScope = 'project' | 'global-user';

/**
 * 长期记忆类型
 */
export type LongTermMemoryType =
  | 'user'
  | 'feedback'
  | 'project-state'
  | 'reference'
  | 'journal'
  | 'evidence'
  | 'temporal-fact';
export type LongTermMemoryStatus = 'active' | 'stale' | 'expired' | 'superseded';

/**
 * 长期记忆条目
 *
 * 仅保存无法从代码仓库稳定推导的事实：
 * - 用户背景与偏好
 * - 对 Agent 行为的纠正 / 确认
 * - 项目的非代码状态
 * - 外部系统引用
 */
export interface LongTermMemoryItem {
  /** 记忆唯一 ID */
  id: string;
  /** 长期记忆类型 */
  type: LongTermMemoryType;
  /** 标题 */
  title: string;
  /** 核心摘要 */
  summary: string;
  /** 治理层 durability：stable=长期保留，ephemeral=任务态/短周期 */
  durability?: 'stable' | 'ephemeral';
  /** 来源引用/证据标识 */
  provenance?: string[];
  /** 为什么要记住 */
  why?: string;
  /** 后续如何应用 */
  howToApply?: string;
  /** 标签 */
  tags: string[];
  /** 作用域 */
  scope: LongTermMemoryScope;
  /** 记忆来源 */
  source: 'user-explicit' | 'agent-inferred' | 'tool-result';
  /** 置信度 */
  confidence: number;
  /** 外部链接 */
  links?: string[];
  /** 时态事实或可定位条目的稳定键 */
  factKey?: string;
  /** 此条目主动失效的其他条目 */
  invalidates?: string[];
  /** 导致此条目失效的其他条目 */
  invalidatedBy?: string;
  /** 生效时间 */
  validFrom?: string;
  /** 失效时间 / 截止时间 */
  validUntil?: string;
  /** 上次核验时间 */
  lastVerifiedAt?: string;
  /** 创建时间 */
  createdAt: string;
  /** 更新时间 */
  updatedAt: string;
}

export interface ResolvedLongTermMemoryItem extends LongTermMemoryItem {
  /** 计算得出的当前状态 */
  status: LongTermMemoryStatus;
}

/**
 * 长期记忆搜索结果
 */
export interface LongTermMemorySearchResult {
  memory: ResolvedLongTermMemoryItem;
  score: number;
  matchFields: string[];
}

/**
 * 路由输入 - 传递给 MemoryRouter.route() 的查询参数
 */
export interface RouteInput {
  /** 显式指定模块名 */
  moduleName?: string;
  /** 文本查询关键词 */
  query?: string;
  /** 涉及的文件路径（用于 triggerPaths 匹配） */
  filePaths?: string[];
  /** 显式指定 scope */
  scope?: string;
  /** 是否启用 scope 级联加载（默认关闭，防止冗余） */
  enableScopeCascade?: boolean;
}

/**
 * 路由结果 - MemoryRouter.route() 的返回值
 */
export interface RouteResult {
  /** 匹配的模块名列表 */
  matchedModules: string[];
  /** 已加载的模块记忆 */
  memories: FeatureMemory[];
  /** 匹配来源标记（用于调试/审计） */
  matchDetails: Array<{
    module: string;
    matchedBy: 'keyword' | 'path' | 'scope-cascade' | 'explicit-scope' | 'explicit-module';
    detail: string;
  }>;
}
