import type { EmbeddingGatewayUpstreamConfig } from './config.js';

export interface EmbeddingGatewayProviderSnapshot {
  name: string;
  baseUrl: string;
  weight: number;
  available: boolean;
  disabledUntil: number;
  models: string[];
}

export interface EmbeddingGatewayProvider extends EmbeddingGatewayUpstreamConfig {
  disabledUntil: number;
}

export class EmbeddingGatewayProviderPool {
  private readonly providers: EmbeddingGatewayProvider[];
  private readonly failoverCooldownMs: number;
  private readonly ring: number[];
  private cursor = 0;

  constructor(upstreams: EmbeddingGatewayUpstreamConfig[], failoverCooldownMs: number) {
    if (upstreams.length === 0) {
      throw new Error('embedding gateway 至少需要一个上游 provider');
    }

    this.providers = upstreams.map((provider) => ({
      ...provider,
      disabledUntil: 0,
    }));
    this.failoverCooldownMs = failoverCooldownMs;
    this.ring = upstreams.flatMap((provider, index) =>
      Array.from({ length: Math.max(1, provider.weight) }, () => index),
    );
  }

  selectCandidates(model: string): EmbeddingGatewayProvider[] {
    const compatible = this.providers
      .map((provider, index) => ({ provider, index }))
      .filter(({ provider }) => provider.models.length === 0 || provider.models.includes(model));

    if (compatible.length === 0) {
      return [];
    }

    const now = Date.now();
    const healthyIndexes = compatible
      .filter(({ provider }) => provider.disabledUntil <= now)
      .map(({ index }) => index);
    const candidateIndexes = healthyIndexes.length > 0 ? healthyIndexes : compatible.map(({ index }) => index);

    const startCursor = this.cursor;
    this.cursor = (this.cursor + 1) % this.ring.length;

    const ordered: number[] = [];
    for (let offset = 0; offset < this.ring.length; offset++) {
      const index = this.ring[(startCursor + offset) % this.ring.length];
      if (!candidateIndexes.includes(index) || ordered.includes(index)) {
        continue;
      }
      ordered.push(index);
    }

    for (const index of candidateIndexes) {
      if (!ordered.includes(index)) {
        ordered.push(index);
      }
    }

    return ordered.map((index) => this.providers[index]).filter(Boolean);
  }

  markFailure(name: string): void {
    const provider = this.providers.find((item) => item.name === name);
    if (!provider) {
      return;
    }
    provider.disabledUntil = Date.now() + this.failoverCooldownMs;
  }

  markSuccess(name: string): void {
    const provider = this.providers.find((item) => item.name === name);
    if (!provider) {
      return;
    }
    provider.disabledUntil = 0;
  }

  getSnapshots(): EmbeddingGatewayProviderSnapshot[] {
    const now = Date.now();
    return this.providers.map((provider) => ({
      name: provider.name,
      baseUrl: provider.baseUrl,
      weight: provider.weight,
      available: provider.disabledUntil <= now,
      disabledUntil: provider.disabledUntil,
      models: [...provider.models],
    }));
  }
}
