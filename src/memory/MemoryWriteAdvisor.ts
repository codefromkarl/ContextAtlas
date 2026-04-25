import crypto from 'node:crypto';
import type { DecisionRecord, FeatureMemory, LongTermMemoryItem, LongTermMemoryScope } from './types.js';
import type { MemoryStore } from './MemoryStore.js';

export interface MemoryWriteHint {
  name: string;
  score: number;
  reason: string;
}

export class MemoryWriteAdvisor {
  async suggestFeatureMemoryHints(
    store: Pick<MemoryStore, 'listFeatures'>,
    memory: FeatureMemory,
  ): Promise<MemoryWriteHint[]> {
    const existing = await store.listFeatures();
    const currentTerms = this.buildFeatureSimilarityTerms(memory);

    return existing
      .filter((item) => item.name !== memory.name)
      .map((item) => {
        const otherTerms = this.buildFeatureSimilarityTerms(item);
        const overlap = [...currentTerms].filter((term) => otherTerms.has(term));
        const sameDir = item.location.dir === memory.location.dir;
        const sameResponsibility =
          this.normalizeText(item.responsibility) === this.normalizeText(memory.responsibility);
        const score =
          overlap.length / Math.max(1, Math.min(currentTerms.size, otherTerms.size))
          + (sameDir ? 0.25 : 0)
          + (sameResponsibility ? 0.35 : 0);

        return {
          name: item.name,
          score,
          reason: sameResponsibility
            ? '职责描述高度接近'
            : sameDir
              ? `同目录且关键词重叠: ${overlap.slice(0, 4).join(', ')}`
              : `关键词重叠: ${overlap.slice(0, 4).join(', ')}`,
        };
      })
      .filter((item) => item.score >= 0.45)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
  }

  async suggestDecisionHints(
    store: Pick<MemoryStore, 'listDecisions'>,
    decision: DecisionRecord,
  ): Promise<MemoryWriteHint[]> {
    const existing = await store.listDecisions();
    const currentTerms = this.buildDecisionSimilarityTerms(decision);

    return existing
      .filter((item) => item.id !== decision.id)
      .map((item) => {
        const otherTerms = this.buildDecisionSimilarityTerms(item);
        const overlap = [...currentTerms].filter((term) => otherTerms.has(term));
        const sameTitle = this.normalizeText(item.title) === this.normalizeText(decision.title);
        const sameContext = this.normalizeText(item.context) === this.normalizeText(decision.context);
        const sameDecision = this.normalizeText(item.decision) === this.normalizeText(decision.decision);
        const score =
          overlap.length / Math.max(1, Math.min(currentTerms.size, otherTerms.size))
          + (sameTitle ? 0.28 : 0)
          + (sameContext ? 0.18 : 0)
          + (sameDecision ? 0.22 : 0);

        return {
          name: item.id,
          score,
          reason: sameTitle && sameDecision
            ? '决策标题与内容高度接近'
            : sameTitle
              ? '决策标题高度接近'
              : sameContext
                ? '背景上下文高度接近'
                : `关键词重叠: ${overlap.slice(0, 4).join(', ')}`,
        };
      })
      .filter((item) => item.score >= 0.45)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
  }

  async suggestLongTermMemoryHints(
    store: Pick<MemoryStore, 'listLongTermMemories'>,
    memory: Pick<LongTermMemoryItem, 'type' | 'title' | 'summary' | 'scope' | 'factKey' | 'links' | 'tags'>,
  ): Promise<MemoryWriteHint[]> {
    const existing = await store.listLongTermMemories({
      types: [memory.type],
      scope: memory.scope as LongTermMemoryScope,
      includeExpired: true,
    });
    const currentTerms = this.buildLongTermSimilarityTerms(memory);

    return existing
      .map((item) => {
        const otherTerms = this.buildLongTermSimilarityTerms(item);
        const overlap = [...currentTerms].filter((term) => otherTerms.has(term));
        const sameFactKey = Boolean(memory.factKey && item.factKey && this.normalizeFactKey(memory.factKey) === this.normalizeFactKey(item.factKey));
        const sameTitle = this.normalizeText(item.title) === this.normalizeText(memory.title);
        const sameSummary = this.normalizeText(item.summary) === this.normalizeText(memory.summary);
        const sameHash = this.getLongTermHash(item) === this.getLongTermHash(memory);
        const summarySimilarity = this.calculateTextSimilarity(item.summary, memory.summary);
        const sharedLinks = (memory.links || []).filter((link) => (item.links || []).includes(link));
        const score =
          overlap.length / Math.max(1, Math.min(currentTerms.size, otherTerms.size))
          + (sameFactKey ? 0.7 : 0)
          + (sameHash ? 0.45 : 0)
          + (sameTitle ? 0.18 : 0)
          + (sameSummary ? 0.22 : 0)
          + (summarySimilarity >= 0.8 ? 0.2 : 0)
          + (sharedLinks.length > 0 ? 0.18 : 0);

        return {
          name: item.factKey || item.id,
          score,
          reason: sameFactKey
            ? `factKey 冲突/复用: ${item.factKey}`
            : sameHash
              ? `summary hash duplicate: ${this.getLongTermHash(item)}`
            : sameTitle && sameSummary
              ? '标题与摘要高度接近'
              : summarySimilarity >= 0.8
                ? `摘要高度相似: ${(summarySimilarity * 100).toFixed(0)}%`
              : sharedLinks.length > 0
                ? `外部链接重叠: ${sharedLinks.slice(0, 2).join(', ')}`
                : `关键词重叠: ${overlap.slice(0, 4).join(', ')}`,
        };
      })
      .filter((item) => item.score >= 0.45)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
  }

  formatDiagnosticsSection(
    hints: MemoryWriteHint[],
    emptyMessage: string,
    title = 'Potential Duplicates',
  ): string {
    const body =
      hints.length > 0
        ? hints
            .map((hint) => `- **${hint.name}** (score=${hint.score.toFixed(2)}): ${hint.reason}`)
            .join('\n')
        : `- ${emptyMessage}`;

    const advice =
      hints.length > 0
        ? '\n\n建议先人工确认是否应合并、复用或改名，避免记忆污染。'
        : '';

    return `### Write Diagnostics\n\n#### ${title}\n${body}${advice}`;
  }

  private buildFeatureSimilarityTerms(memory: FeatureMemory): Set<string> {
    const tokens = [
      memory.name,
      memory.responsibility,
      memory.location.dir,
      ...memory.location.files,
      ...memory.api.exports,
      ...memory.dependencies.imports,
      ...memory.keyPatterns,
    ]
      .join(' ')
      .toLowerCase()
      .split(/[\s,./\\|[\]{}()"':;!?<>`~@#$%^&*+=-]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3);

    return new Set(tokens);
  }

  private buildDecisionSimilarityTerms(decision: DecisionRecord): Set<string> {
    const tokens = [
      decision.id,
      decision.title,
      decision.context,
      decision.decision,
      decision.rationale,
      ...decision.consequences,
      ...decision.alternatives.flatMap((alternative) => [
        alternative.name,
        ...alternative.pros,
        ...alternative.cons,
      ]),
    ]
      .join(' ')
      .toLowerCase()
      .split(/[\s,./\\|[\]{}()"':;!?<>`~@#$%^&*+=-]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3);

    return new Set(tokens);
  }

  private buildLongTermSimilarityTerms(
    memory: Pick<LongTermMemoryItem, 'title' | 'summary' | 'factKey' | 'links' | 'tags'>,
  ): Set<string> {
    const tokens = [
      memory.title,
      memory.summary,
      memory.factKey || '',
      ...(memory.links || []),
      ...(memory.tags || []),
    ]
      .join(' ')
      .toLowerCase()
      .split(/[\s,./\\|[\]{}()"':;!?<>`~@#$%^&*+=-]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3);

    return new Set(tokens);
  }

  private normalizeText(input: string): string {
    return input.toLowerCase().trim().replace(/\s+/g, ' ');
  }

  private normalizeFactKey(input: string): string {
    return input
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  private getLongTermHash(memory: Pick<LongTermMemoryItem, 'title' | 'summary'>): string {
    return crypto
      .createHash('sha256')
      .update(this.normalizeText(`${memory.title}\n${memory.summary}`))
      .digest('hex')
      .slice(0, 16);
  }

  private calculateTextSimilarity(a: string, b: string): number {
    const left = this.tokenize(a);
    const right = this.tokenize(b);
    if (left.size === 0 || right.size === 0) {
      return 0;
    }
    const intersection = [...left].filter((token) => right.has(token)).length;
    const union = new Set([...left, ...right]).size;
    return union === 0 ? 0 : intersection / union;
  }

  private tokenize(input: string): Set<string> {
    return new Set(
      input
        .toLowerCase()
        .split(/[\s,./\\|[\]{}()"':;!?<>`~@#$%^&*+=-]+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3),
    );
  }
}
