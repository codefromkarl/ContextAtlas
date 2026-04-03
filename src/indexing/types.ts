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
}

export interface EnqueueIndexTaskInput {
  projectId: string;
  repoPath: string;
  scope: IndexTaskScope;
  priority?: number;
  reason?: string;
  requestedBy?: string;
}

export interface EnqueueIndexTaskResult {
  task: IndexTask;
  reusedExisting: boolean;
}
