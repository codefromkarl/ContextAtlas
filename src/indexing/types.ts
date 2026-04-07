export const INDEX_TASK_SCOPE = {
  full: 'full',
  incremental: 'incremental',
} as const;

export type IndexTaskScope = (typeof INDEX_TASK_SCOPE)[keyof typeof INDEX_TASK_SCOPE];

export const INDEX_TASK_STATUS = {
  queued: 'queued',
  running: 'running',
  done: 'done',
  failed: 'failed',
  canceled: 'canceled',
} as const;

export type IndexTaskStatus = (typeof INDEX_TASK_STATUS)[keyof typeof INDEX_TASK_STATUS];

export interface IncrementalHintEntry {
  relPath: string;
  mtime: number;
  size: number;
}

export interface IncrementalExecutionHint {
  generatedAt: number;
  ttlMs: number;
  changeSummary: {
    added: number;
    modified: number;
    deleted: number;
    unchangedNeedingVectorRepair: number;
    unchanged: number;
    skipped: number;
    errors: number;
    totalFiles: number;
  };
  candidates: IncrementalHintEntry[];
  deletedPaths: string[];
  healingPaths: IncrementalHintEntry[];
}

export interface IndexTask {
  taskId: string;
  projectId: string;
  repoPath: string;
  scope: IndexTaskScope;
  status: IndexTaskStatus;
  priority: number;
  dedupeKey: string;
  reason: string | null;
  requestedBy: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  attempts: number;
  lastError: string | null;
  executionHint: IncrementalExecutionHint | null;
}

export interface EnqueueIndexTaskInput {
  projectId: string;
  repoPath: string;
  scope: IndexTaskScope;
  priority?: number;
  reason?: string;
  requestedBy?: string;
  executionHint?: IncrementalExecutionHint | null;
}

export interface EnqueueIndexTaskResult {
  task: IndexTask;
  reusedExisting: boolean;
}
