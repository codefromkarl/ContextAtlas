import type { DecisionRecord } from './types.js';
import { MemoryHubDatabase } from './MemoryHubDatabase.js';

export interface DecisionStoreOptions {
  hub: MemoryHubDatabase;
  projectId: string;
}

export class DecisionStore {
  private readonly hub: MemoryHubDatabase;
  private readonly projectId: string;

  constructor({ hub, projectId }: DecisionStoreOptions) {
    this.hub = hub;
    this.projectId = projectId;
  }

  async save(decision: DecisionRecord): Promise<string> {
    const contextPayload = JSON.stringify({
      context: decision.context,
      alternatives: decision.alternatives,
      consequences: decision.consequences,
      evidenceRefs: decision.evidenceRefs,
      date: decision.date,
      owner: decision.owner,
      reviewer: decision.reviewer,
    });

    this.hub.saveDecision({
      project_id: this.projectId,
      decision_id: decision.id,
      title: decision.title,
      context: contextPayload,
      decision: decision.decision,
      rationale: decision.rationale,
      status: decision.status,
    });

    return `sqlite://memory-hub.db#project=${this.projectId}&decision=${encodeURIComponent(decision.id)}`;
  }

  async read(decisionId: string): Promise<DecisionRecord | null> {
    const row = this.hub.getDecision(this.projectId, decisionId) as Record<string, unknown> | null;
    if (!row) {
      return null;
    }

    return this.mapDecisionRecord(row, decisionId);
  }

  async list(): Promise<DecisionRecord[]> {
    const rows = this.hub.listDecisions(this.projectId) as Array<Record<string, unknown>>;
    return rows
      .map((row) => this.mapDecisionRecord(row, String(row.decision_id ?? '')))
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }

  private mapDecisionRecord(row: Record<string, unknown>, fallbackId: string): DecisionRecord {
    const contextPayload = this.parseJson<Record<string, unknown>>(
      typeof row.context === 'string' ? row.context : '',
      {},
    );

    return {
      id: String(row.decision_id ?? fallbackId),
      date: String(contextPayload.date ?? row.created_at ?? new Date().toISOString().split('T')[0]),
      owner: typeof contextPayload.owner === 'string' ? contextPayload.owner : undefined,
      reviewer: typeof contextPayload.reviewer === 'string' ? contextPayload.reviewer : undefined,
      title: String(row.title ?? ''),
      context: String(contextPayload.context ?? ''),
      decision: String(row.decision ?? ''),
      alternatives: this.parseAlternatives(contextPayload.alternatives),
      rationale: String(row.rationale ?? ''),
      consequences: this.parseStringArray(contextPayload.consequences),
      evidenceRefs: this.parseStringArray(contextPayload.evidenceRefs),
      status: (row.status as DecisionRecord['status']) || 'accepted',
    };
  }

  private parseJson<T>(input: string, fallback: T): T {
    try {
      return JSON.parse(input) as T;
    } catch {
      return fallback;
    }
  }

  private parseStringArray(input: unknown): string[] {
    if (!Array.isArray(input)) {
      return [];
    }
    return input.filter((item): item is string => typeof item === 'string');
  }

  private parseAlternatives(input: unknown): DecisionRecord['alternatives'] {
    if (!Array.isArray(input)) {
      return [];
    }

    return input
      .filter(
        (item): item is { name?: unknown; pros?: unknown; cons?: unknown } =>
          !!item && typeof item === 'object',
      )
      .map((item) => ({
        name: typeof item.name === 'string' ? item.name : 'unknown',
        pros: this.parseStringArray(item.pros),
        cons: this.parseStringArray(item.cons),
      }));
  }
}
