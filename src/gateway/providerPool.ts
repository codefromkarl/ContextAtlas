import type { EmbeddingGatewayUpstreamConfig } from './config.js';

export interface EmbeddingGatewayProviderSnapshot {
  name: string;
  baseUrl: string;
  weight: number;
  available: boolean;
  disabledUntil: number;
  cooldownRemainingMs: number;
  models: string[];
  metrics: {
    requests: number;
    successes: number;
    failures: number;
    successRate: number;
    failureRate: number;
    avgLatencyMs: number;
    lastLatencyMs?: number;
    cooldowns: number;
    lastStatus?: number;
    lastError?: string;
    lastSuccessAt?: number;
    lastFailureAt?: number;
  };
}

export interface EmbeddingGatewayProviderPoolSummary {
  totalRequests: number;
  successes: number;
  failures: number;
  successRate: number;
  failureRate: number;
  avgLatencyMs: number;
  available: number;
  cooldownActive: number;
}

export interface EmbeddingGatewayProvider extends EmbeddingGatewayUpstreamConfig {
  disabledUntil: number;
  metrics: {
    requests: number;
    successes: number;
    failures: number;
    totalLatencyMs: number;
    lastLatencyMs?: number;
    cooldowns: number;
    lastStatus?: number;
    lastError?: string;
    lastSuccessAt?: number;
    lastFailureAt?: number;
  };
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
      metrics: {
        requests: 0,
        successes: 0,
        failures: 0,
        totalLatencyMs: 0,
        cooldowns: 0,
      },
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

  markFailure(
    name: string,
    input: { latencyMs?: number; status?: number; error?: string; cooldown?: boolean } = {},
  ): void {
    const provider = this.providers.find((item) => item.name === name);
    if (!provider) {
      return;
    }

    provider.metrics.requests += 1;
    provider.metrics.failures += 1;
    if (typeof input.latencyMs === 'number' && Number.isFinite(input.latencyMs) && input.latencyMs >= 0) {
      provider.metrics.totalLatencyMs += input.latencyMs;
      provider.metrics.lastLatencyMs = input.latencyMs;
    }
    provider.metrics.lastStatus = input.status;
    provider.metrics.lastError = input.error;
    provider.metrics.lastFailureAt = Date.now();

    if (input.cooldown) {
      provider.disabledUntil = Date.now() + this.failoverCooldownMs;
      provider.metrics.cooldowns += 1;
    }
  }

  markSuccess(name: string, input: { latencyMs?: number; status?: number } = {}): void {
    const provider = this.providers.find((item) => item.name === name);
    if (!provider) {
      return;
    }

    provider.metrics.requests += 1;
    provider.metrics.successes += 1;
    if (typeof input.latencyMs === 'number' && Number.isFinite(input.latencyMs) && input.latencyMs >= 0) {
      provider.metrics.totalLatencyMs += input.latencyMs;
      provider.metrics.lastLatencyMs = input.latencyMs;
    }
    provider.metrics.lastStatus = input.status;
    provider.metrics.lastError = undefined;
    provider.metrics.lastSuccessAt = Date.now();
    provider.disabledUntil = 0;
  }

  getSummary(): EmbeddingGatewayProviderPoolSummary {
    const now = Date.now();
    const aggregate = this.providers.reduce(
      (accumulator, provider) => {
        accumulator.totalRequests += provider.metrics.requests;
        accumulator.successes += provider.metrics.successes;
        accumulator.failures += provider.metrics.failures;
        accumulator.totalLatencyMs += provider.metrics.totalLatencyMs;
        accumulator.available += provider.disabledUntil <= now ? 1 : 0;
        accumulator.cooldownActive += provider.disabledUntil > now ? 1 : 0;
        return accumulator;
      },
      {
        totalRequests: 0,
        successes: 0,
        failures: 0,
        totalLatencyMs: 0,
        available: 0,
        cooldownActive: 0,
      },
    );

    return {
      totalRequests: aggregate.totalRequests,
      successes: aggregate.successes,
      failures: aggregate.failures,
      successRate: aggregate.totalRequests > 0 ? aggregate.successes / aggregate.totalRequests : 0,
      failureRate: aggregate.totalRequests > 0 ? aggregate.failures / aggregate.totalRequests : 0,
      avgLatencyMs: aggregate.totalRequests > 0 ? aggregate.totalLatencyMs / aggregate.totalRequests : 0,
      available: aggregate.available,
      cooldownActive: aggregate.cooldownActive,
    };
  }

  getSnapshots(): EmbeddingGatewayProviderSnapshot[] {
    const now = Date.now();
    return this.providers.map((provider) => ({
      name: provider.name,
      baseUrl: provider.baseUrl,
      weight: provider.weight,
      available: provider.disabledUntil <= now,
      disabledUntil: provider.disabledUntil,
      cooldownRemainingMs: Math.max(0, provider.disabledUntil - now),
      models: [...provider.models],
      metrics: {
        requests: provider.metrics.requests,
        successes: provider.metrics.successes,
        failures: provider.metrics.failures,
        successRate:
          provider.metrics.requests > 0 ? provider.metrics.successes / provider.metrics.requests : 0,
        failureRate:
          provider.metrics.requests > 0 ? provider.metrics.failures / provider.metrics.requests : 0,
        avgLatencyMs:
          provider.metrics.requests > 0 ? provider.metrics.totalLatencyMs / provider.metrics.requests : 0,
        lastLatencyMs: provider.metrics.lastLatencyMs,
        cooldowns: provider.metrics.cooldowns,
        lastStatus: provider.metrics.lastStatus,
        lastError: provider.metrics.lastError,
        lastSuccessAt: provider.metrics.lastSuccessAt,
        lastFailureAt: provider.metrics.lastFailureAt,
      },
    }));
  }
}
