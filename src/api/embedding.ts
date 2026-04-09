/**
 * Embedding 客户端
 *
 * 调用 SiliconFlow Embedding API，将文本转换为向量
 * 支持并发控制、批量处理和智能速率限制
 *
 * 速率限制策略：
 * - 遇到 429 时，暂停所有批次请求
 * - 使用指数退避等待（初始 5s，每次加倍，最大 60s）
 * - 恢复后从并发=1 开始，逐步恢复到 maxConcurrency
 * - 连续成功 N 次后才提升并发数
 */

import fs from 'node:fs';
import path from 'node:path';
import pLimit from 'p-limit';
import { type EmbeddingConfig, getEmbeddingConfig } from '../config.js';
import { resolveBaseDir } from '../runtimePaths.js';
import { logger } from '../utils/logger.js';
import { sanitizeEmbeddingInput } from './unicode.js';

/** Embedding 请求体 */
interface EmbeddingRequest {
  model: string;
  input: string | string[];
  encoding_format?: 'float' | 'base64';
}

/** 单个 Embedding 结果 */
interface EmbeddingData {
  object: 'embedding';
  index: number;
  embedding: number[];
}

/** Embedding 响应体 */
interface EmbeddingResponse {
  object: 'list';
  data: EmbeddingData[];
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

/** Embedding 错误响应 */
interface EmbeddingErrorResponse {
  error?: {
    message: string;
    type?: string;
    code?: string;
  };
}

/** Embedding 结果 */
export interface EmbeddingResult {
  text: string;
  embedding: number[];
  index: number;
}

/**
 * 单条文本触发 413 且无法继续拆分时抛出
 * 用于上层精确定位问题文件，避免整批反复自愈。
 */
export class EmbeddingPayloadTooLargeError extends Error {
  readonly failedGlobalIndex: number;
  readonly textLength: number;

  constructor(failedGlobalIndex: number, textLength: number, rawMessage: string) {
    super(`Embedding payload too large at index=${failedGlobalIndex}: ${rawMessage}`);
    this.name = 'EmbeddingPayloadTooLargeError';
    this.failedGlobalIndex = failedGlobalIndex;
    this.textLength = textLength;
  }
}

/**
 * 进度追踪器
 * 定时输出进度，避免每个批次都打印日志
 */
class ProgressTracker {
  private completed = 0;
  private total: number;
  private totalTokens = 0;
  private startTime: number;
  private lastLogTime = 0;
  private readonly logIntervalMs = 2000; // 每 2 秒输出一次
  private onProgress?: (completed: number, total: number) => void;
  /** 是否跳过日志（单批次时跳过，避免与索引日志混淆） */
  private readonly skipLogs: boolean;

  constructor(total: number, onProgress?: (completed: number, total: number) => void) {
    this.total = total;
    this.startTime = Date.now();
    this.onProgress = onProgress;
    // 单批次（如查询 embedding）时跳过进度日志
    this.skipLogs = total <= 1;
  }

  /** 记录一个批次完成 */
  recordBatch(tokens: number): void {
    this.completed++;
    this.totalTokens += tokens;

    // 调用外部回调
    this.onProgress?.(this.completed, this.total);

    const now = Date.now();
    if (now - this.lastLogTime >= this.logIntervalMs) {
      this.logProgress();
      this.lastLogTime = now;
    }
  }

  /** 输出进度 */
  private logProgress(): void {
    if (this.skipLogs) return;

    const elapsed = (Date.now() - this.startTime) / 1000;
    const percent = Math.round((this.completed / this.total) * 100);
    const rate = this.completed / elapsed;
    const eta = rate > 0 ? Math.round((this.total - this.completed) / rate) : 0;

    logger.info(
      {
        progress: `${this.completed}/${this.total}`,
        percent: `${percent}%`,
        tokens: this.totalTokens,
        elapsed: `${elapsed.toFixed(1)}s`,
        eta: `${eta}s`,
      },
      'Embedding 进度',
    );
  }

  /** 完成时输出最终统计 */
  complete(): void {
    if (this.skipLogs) return;

    const elapsed = (Date.now() - this.startTime) / 1000;
    logger.info(
      {
        batches: this.total,
        tokens: this.totalTokens,
        elapsed: `${elapsed.toFixed(1)}s`,
        avgTokensPerBatch: Math.round(this.totalTokens / this.total),
      },
      'Embedding 完成',
    );
  }

  /** 动态扩展总批次数（用于 413 自动拆批） */
  addDynamicBatches(extra: number): void {
    if (extra <= 0) return;
    this.total += extra;
  }
}

const BASE_DIR = resolveBaseDir();
const GLOBAL_RATE_LIMIT_LOCK_DIR = path.join(BASE_DIR, 'embedding.rate.lock.d');
const GLOBAL_RATE_LIMIT_STATE = path.join(BASE_DIR, 'embedding.rate.json');
const GLOBAL_RATE_LIMIT_CHECK_INTERVAL_MS = 25;
const GLOBAL_RATE_LIMIT_LOCK_TIMEOUT_MS = 10000;
const GLOBAL_RATE_LIMIT_LOCK_WRITE_GRACE_MS = 2000;
let globalRateSlotQueue: Promise<void> = Promise.resolve();

interface GlobalRateState {
  nextAllowedAt: number;
}

function removeStaleGlobalRateLock(): void {
  try {
    const stat = fs.statSync(GLOBAL_RATE_LIMIT_LOCK_DIR);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > GLOBAL_RATE_LIMIT_LOCK_WRITE_GRACE_MS) {
      fs.rmSync(GLOBAL_RATE_LIMIT_LOCK_DIR, { recursive: true, force: true });
      logger.warn({ ageMs }, '移除异常全局速率锁');
    }
  } catch {
    // 锁目录可能已被其他进程删除，忽略
  }
}

async function acquireGlobalRateLock(): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < GLOBAL_RATE_LIMIT_LOCK_TIMEOUT_MS) {
    try {
      fs.mkdirSync(BASE_DIR, { recursive: true });
      fs.mkdirSync(GLOBAL_RATE_LIMIT_LOCK_DIR);
      return true;
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'EEXIST') {
        removeStaleGlobalRateLock();
      } else {
        logger.debug({ error: error.message }, '获取全局速率锁失败，重试中');
      }
      await sleep(GLOBAL_RATE_LIMIT_CHECK_INTERVAL_MS);
    }
  }

  logger.warn(
    { timeoutMs: GLOBAL_RATE_LIMIT_LOCK_TIMEOUT_MS },
    '获取全局速率锁超时，降级为无锁模式',
  );
  return false;
}

function releaseGlobalRateLock(): void {
  try {
    fs.rmdirSync(GLOBAL_RATE_LIMIT_LOCK_DIR);
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code !== 'ENOENT') {
      logger.debug({ error: error.message }, '释放全局速率锁失败');
    }
  }
}

async function acquireGlobalRateSlotInner(minIntervalMs: number): Promise<void> {
  if (minIntervalMs <= 0) return;

  const locked = await acquireGlobalRateLock();
  if (!locked) return;

  let waitMs = 0;
  try {
    let state: GlobalRateState = { nextAllowedAt: 0 };
    try {
      const raw = fs.readFileSync(GLOBAL_RATE_LIMIT_STATE, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<GlobalRateState>;
      state.nextAllowedAt = Number.isFinite(parsed.nextAllowedAt)
        ? Number(parsed.nextAllowedAt)
        : 0;
    } catch {
      // 状态文件不存在或损坏时重置
      state = { nextAllowedAt: 0 };
    }

    const now = Date.now();
    const scheduledAt = Math.max(now, state.nextAllowedAt);
    waitMs = Math.max(0, scheduledAt - now);

    const nextState: GlobalRateState = {
      nextAllowedAt: scheduledAt + minIntervalMs,
    };
    fs.writeFileSync(GLOBAL_RATE_LIMIT_STATE, JSON.stringify(nextState));
  } finally {
    releaseGlobalRateLock();
  }

  if (waitMs > 0) {
    await sleep(waitMs);
  }
}

async function acquireGlobalRateSlot(minIntervalMs: number): Promise<void> {
  if (minIntervalMs <= 0) return;

  const queued = globalRateSlotQueue.then(() => acquireGlobalRateSlotInner(minIntervalMs));
  globalRateSlotQueue = queued.catch(() => {});
  await queued;
}

/**
 * 全局速率限制控制器
 *
 * 实现自适应并发控制，遇到 429 时协调所有请求暂停和恢复
 */
class RateLimitController {
  /** 是否处于暂停状态 */
  private isPaused = false;
  /** 暂停恢复的 Promise（所有请求等待此 Promise） */
  private pausePromise: Promise<void> | null = null;
  /** 当前有效并发数 */
  private currentConcurrency: number;
  /** 配置的最大并发数 */
  private maxConcurrency: number;
  /** 当前活跃请求数 */
  private activeRequests = 0;
  /** 连续成功次数（用于渐进恢复并发） */
  private consecutiveSuccesses = 0;
  /** 当前退避时间（毫秒） */
  private backoffMs = 5000;
  /** 恢复并发所需的连续成功次数 */
  private readonly successesPerConcurrencyIncrease = 3;
  /** 最小退避时间 */
  private readonly minBackoffMs = 5000;
  /** 最大退避时间 */
  private readonly maxBackoffMs = 60000;

  constructor(maxConcurrency: number) {
    this.maxConcurrency = maxConcurrency;
    this.currentConcurrency = maxConcurrency;
  }

  /**
   * 获取执行槽位
   * 如果当前暂停或并发已满，则等待
   */
  async acquire(): Promise<void> {
    // 如果暂停中，等待恢复
    if (this.pausePromise) {
      await this.pausePromise;
    }

    // 等待并发槽位
    while (this.activeRequests >= this.currentConcurrency) {
      await sleep(50);
      // 再次检查是否暂停（可能在等待期间触发了 429）
      if (this.pausePromise) {
        await this.pausePromise;
      }
    }

    this.activeRequests++;
  }

  /**
   * 释放执行槽位（请求成功时调用）
   */
  releaseSuccess(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    this.consecutiveSuccesses++;

    // 渐进恢复并发数
    if (
      this.currentConcurrency < this.maxConcurrency &&
      this.consecutiveSuccesses >= this.successesPerConcurrencyIncrease
    ) {
      this.currentConcurrency++;
      this.consecutiveSuccesses = 0;
    }

    // 连续成功 10 次后，逐步减少退避时间
    if (this.consecutiveSuccesses > 0 && this.consecutiveSuccesses % 10 === 0) {
      this.backoffMs = Math.max(this.minBackoffMs, this.backoffMs / 2);
    }
  }

  /**
   * 释放执行槽位（请求失败但非 429 时调用）
   */
  releaseFailure(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    // 普通失败不重置成功计数
  }

  /**
   * 释放执行槽位（429 重试前调用）
   * 释放槽位并重置成功计数
   */
  releaseForRetry(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    this.consecutiveSuccesses = 0;
  }

  /**
   * 触发 429 暂停
   * 所有请求将等待恢复
   */
  async triggerRateLimit(): Promise<void> {
    // 如果已经在暂停中，等待现有的暂停结束
    if (this.isPaused && this.pausePromise) {
      logger.debug('速率限制：等待现有暂停结束');
      await this.pausePromise;
      return;
    }

    this.isPaused = true;
    this.consecutiveSuccesses = 0;

    // 降低并发数
    const previousConcurrency = this.currentConcurrency;
    this.currentConcurrency = 1;

    logger.warn(
      {
        backoffMs: this.backoffMs,
        previousConcurrency,
        newConcurrency: this.currentConcurrency,
        activeRequests: this.activeRequests,
      },
      '速率限制：触发 429，暂停所有请求',
    );

    // 创建暂停 Promise
    let resumeResolve: () => void = () => {};
    this.pausePromise = new Promise<void>((resolve) => {
      resumeResolve = resolve;
    });

    // 等待退避时间
    await sleep(this.backoffMs);

    // 增加下次的退避时间（指数退避）
    this.backoffMs = Math.min(this.maxBackoffMs, this.backoffMs * 2);

    // 恢复
    this.isPaused = false;
    this.pausePromise = null;
    resumeResolve();

    logger.info({ waitMs: this.backoffMs }, '速率限制：恢复请求');
  }

  /**
   * 获取当前状态（用于调试）
   */
  getStatus(): {
    isPaused: boolean;
    currentConcurrency: number;
    maxConcurrency: number;
    activeRequests: number;
    backoffMs: number;
  } {
    return {
      isPaused: this.isPaused,
      currentConcurrency: this.currentConcurrency,
      maxConcurrency: this.maxConcurrency,
      activeRequests: this.activeRequests,
      backoffMs: this.backoffMs,
    };
  }
}

/** 全局速率限制控制器实例 */
let globalRateLimitController: RateLimitController | null = null;

/**
 * 获取或创建全局速率限制控制器
 */
function getRateLimitController(maxConcurrency: number): RateLimitController {
  if (!globalRateLimitController) {
    globalRateLimitController = new RateLimitController(maxConcurrency);
  }
  return globalRateLimitController;
}

/**
 * Embedding 客户端类
 */
export class EmbeddingClient {
  private config: EmbeddingConfig;
  private rateLimiter: RateLimitController;

  constructor(config?: EmbeddingConfig) {
    this.config = config || getEmbeddingConfig();
    this.rateLimiter = getRateLimitController(this.config.maxConcurrency);
  }

  /**
   * 获取单个文本的 Embedding
   */
  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    return results[0].embedding;
  }

  /**
   * 批量获取 Embedding
   * @param texts 待处理的文本数组
   * @param batchSize 每批次发送的文本数量（默认 20）
   * @param onProgress 可选的进度回调 (completed, total) => void
   */
  async embedBatch(
    texts: string[],
    batchSize = 20,
    onProgress?: (completed: number, total: number) => void,
  ): Promise<EmbeddingResult[]> {
    if (texts.length === 0) {
      return [];
    }

    // 将文本分批
    const batches: string[][] = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      batches.push(texts.slice(i, i + batchSize));
    }

    // 创建进度追踪器（传入外部回调）
    const progress = new ProgressTracker(batches.length, onProgress);
    const limit = pLimit(this.config.maxConcurrency);
    const batchTasks = batches.map((batch, batchIndex) =>
      limit(() => this.processWithRateLimit(batch, batchIndex * batchSize, progress)),
    );

    // 使用速率限制控制器处理各批次
    const batchResults = await Promise.all(batchTasks);

    // 输出完成统计
    progress.complete();

    // 扁平化结果
    return batchResults.flat();
  }

  /**
   * 带速率限制和网络错误重试的批次处理
   * 使用循环而非递归，避免栈溢出和槽位泄漏
   */
  private async processWithRateLimit(
    texts: string[],
    startIndex: number,
    progress: ProgressTracker,
  ): Promise<EmbeddingResult[]> {
    const MAX_NETWORK_RETRIES = 3;
    const INITIAL_RETRY_DELAY_MS = 1000;

    let networkRetries = 0;

    while (true) {
      // 获取执行槽位（可能等待）
      await this.rateLimiter.acquire();

      try {
        await acquireGlobalRateSlot(this.config.globalMinIntervalMs);
        const result = await this.processBatch(texts, startIndex, progress);
        this.rateLimiter.releaseSuccess();
        return result;
      } catch (err) {
        const error = err as { message?: string; code?: string };
        const errorMessage = error.message || '';
        const isRateLimited = errorMessage.includes('429') || errorMessage.includes('rate');
        const isPayloadTooLarge = this.isPayloadTooLarge(err);
        const isNetworkError = this.isNetworkError(err);

        if (isRateLimited) {
          // 429 错误：释放槽位，触发全局暂停
          this.rateLimiter.releaseForRetry();
          await this.rateLimiter.triggerRateLimit();
          networkRetries = 0; // 重置网络重试计数
          // 循环继续，重新获取槽位并重试
        } else if (isPayloadTooLarge && texts.length > 1) {
          this.rateLimiter.releaseFailure();

          const splitAt = Math.floor(texts.length / 2);
          const leftTexts = texts.slice(0, splitAt);
          const rightTexts = texts.slice(splitAt);
          progress.addDynamicBatches(1);

          logger.warn(
            {
              batchSize: texts.length,
              leftSize: leftTexts.length,
              rightSize: rightTexts.length,
            },
            'Embedding 触发 413，自动拆批重试',
          );

          const leftResults = await this.processWithRateLimit(leftTexts, startIndex, progress);
          const rightResults = await this.processWithRateLimit(
            rightTexts,
            startIndex + leftTexts.length,
            progress,
          );
          return [...leftResults, ...rightResults];
        } else if (isPayloadTooLarge && texts.length === 1) {
          this.rateLimiter.releaseFailure();
          throw new EmbeddingPayloadTooLargeError(startIndex, texts[0]?.length ?? 0, errorMessage);
        } else if (isNetworkError && networkRetries < MAX_NETWORK_RETRIES) {
          // 网络错误：指数退避重试
          networkRetries++;
          const delayMs = INITIAL_RETRY_DELAY_MS * 2 ** (networkRetries - 1);

          logger.warn(
            {
              error: errorMessage,
              retry: networkRetries,
              maxRetries: MAX_NETWORK_RETRIES,
              delayMs,
            },
            '网络错误，准备重试',
          );

          this.rateLimiter.releaseForRetry();
          await sleep(delayMs);
          // 循环继续，重新获取槽位并重试
        } else {
          // 其他错误或重试次数耗尽：抛出异常
          this.rateLimiter.releaseFailure();

          if (isNetworkError) {
            logger.error({ error: errorMessage, retries: networkRetries }, '网络错误重试次数耗尽');
          }

          throw err;
        }
      }
    }
  }

  /**
   * 判断是否为请求体过大（413）错误
   */
  private isPayloadTooLarge(err: unknown): boolean {
    const error = err as { message?: string };
    const message = (error.message || '').toLowerCase();
    return (
      message.includes('413') ||
      message.includes('payload too large') ||
      message.includes('request entity too large')
    );
  }

  /**
   * 判断是否为网络错误
   *
   * 常见网络错误类型：
   * - terminated: 连接被中断（TLS 断开）
   * - ECONNRESET: 连接被远端重置
   * - ETIMEDOUT: 连接超时
   * - ENOTFOUND: DNS 解析失败
   * - fetch failed: 通用 fetch 失败
   * - socket hang up: 套接字意外关闭
   */
  private isNetworkError(err: unknown): boolean {
    const error = err as { message?: string; code?: string };
    const message = (error.message || '').toLowerCase();
    const code = error.code || '';

    const networkErrorPatterns = [
      'terminated',
      'econnreset',
      'etimedout',
      'enotfound',
      'econnrefused',
      'fetch failed',
      'socket hang up',
      'network',
      'aborted',
    ];

    // 检查错误消息
    for (const pattern of networkErrorPatterns) {
      if (message.includes(pattern)) {
        return true;
      }
    }

    // 检查错误代码
    const networkErrorCodes = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'EPIPE'];
    if (networkErrorCodes.includes(code)) {
      return true;
    }

    return false;
  }

  /**
   * 处理单个批次（单次请求，不含重试逻辑）
   */
  private async processBatch(
    texts: string[],
    startIndex: number,
    progress: ProgressTracker,
  ): Promise<EmbeddingResult[]> {
    const sanitizedTexts = texts.map((text) => sanitizeEmbeddingInput(text));
    const sanitizedCount = sanitizedTexts.reduce(
      (count, text, idx) => count + (text === texts[idx] ? 0 : 1),
      0,
    );

    if (sanitizedCount > 0) {
      logger.warn(
        { startIndex, batchSize: texts.length, sanitizedCount },
        'Embedding 输入含非法 Unicode 代理项，已自动清洗',
      );
    }

    const requestBody: EmbeddingRequest = {
      model: this.config.model,
      input: sanitizedTexts,
      encoding_format: 'float',
    };

    const response = await fetch(this.config.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    const rawBody = await response.text();
    let data: (EmbeddingResponse & EmbeddingErrorResponse) | null = null;

    try {
      data = rawBody ? (JSON.parse(rawBody) as EmbeddingResponse & EmbeddingErrorResponse) : null;
    } catch {
      data = null;
    }

    if (!response.ok || data?.error) {
      const errorMsg = data?.error?.message || `HTTP ${response.status}`;
      throw new Error(`Embedding API 错误: ${errorMsg}`);
    }
    if (!data || !Array.isArray(data.data)) {
      throw new Error('Embedding API 响应格式错误');
    }

    const results: EmbeddingResult[] = data.data.map((item) => ({
      text: texts[item.index],
      embedding: item.embedding,
      index: startIndex + item.index,
    }));

    // 记录批次完成（进度追踪器会定时输出）
    progress.recordBatch(data.usage?.total_tokens || 0);

    return results;
  }

  /**
   * 获取当前配置
   */
  getConfig(): EmbeddingConfig {
    return { ...this.config };
  }

  /**
   * 获取速率限制器状态（用于调试）
   */
  getRateLimiterStatus(): ReturnType<RateLimitController['getStatus']> {
    return this.rateLimiter.getStatus();
  }
}

/**
 * 创建默认的 Embedding 客户端实例
 */
let defaultClient: EmbeddingClient | null = null;

export function getEmbeddingClient(): EmbeddingClient {
  if (!defaultClient) {
    defaultClient = new EmbeddingClient();
  }
  return defaultClient;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
