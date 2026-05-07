/**
 * JCF Healthcare Agent Hub — Generous Token-Bucket Rate Limiter
 *
 * Phase C3 of remediation audit.
 *
 * Design philosophy: generous defaults — neither too restrictive nor
 * too permissive. Limits chosen so normal interactive workflows never
 * hit them; only pathological loops / abusive clients get throttled.
 *
 * Defaults:
 *   - Per-tool: 500 sustained, burst 1000 (bucket capacity)
 *   - Global:   2000 sustained, burst 5000
 *
 * Cost model: all tools default cost=1 token. Expensive operations
 * (build_cognitive_index, batch_operations) can declare higher cost.
 */

import { Logger } from './logger.js';

export interface TokenBucketConfig {
  /** Max tokens in the bucket (burst allowance) */
  capacity: number;
  /** Tokens refilled per second (sustained rate) */
  refillPerSecond: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** If blocked, ms until enough tokens are refilled for cost */
  retryAfterMs?: number;
  /** Remaining tokens in most-constraining bucket */
  remaining: number;
  /** Bucket that blocked (if blocked): 'per-tool' | 'global' | null */
  blockedBy: 'per-tool' | 'global' | null;
}

export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;
  public readonly capacity: number;
  public readonly refillPerSecond: number;

  constructor(config: TokenBucketConfig) {
    this.capacity = config.capacity;
    this.refillPerSecond = config.refillPerSecond;
    this.tokens = config.capacity;
    this.lastRefillMs = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefillMs) / 1000;
    const refill = elapsedSec * this.refillPerSecond;
    if (refill > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + refill);
      this.lastRefillMs = now;
    }
  }

  /** Attempt to consume `cost` tokens; returns true if successful */
  tryConsume(cost = 1): boolean {
    this.refill();
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }
    return false;
  }

  /** Tokens currently available (read-only, triggers refill) */
  getAvailable(): number {
    this.refill();
    return this.tokens;
  }

  /** ms until `cost` tokens will be available */
  retryAfterMs(cost = 1): number {
    this.refill();
    if (this.tokens >= cost) return 0;
    const deficit = cost - this.tokens;
    return Math.ceil((deficit / this.refillPerSecond) * 1000);
  }

  /** Refund tokens back into the bucket (capped at capacity). */
  refund(cost: number): void {
    this.tokens = Math.min(this.capacity, this.tokens + cost);
  }

  /** Reset bucket to full capacity */
  reset(): void {
    this.tokens = this.capacity;
    this.lastRefillMs = Date.now();
  }

  /** Snapshot for health-check */
  snapshot(): { available: number; capacity: number; refillPerSecond: number } {
    this.refill();
    return {
      available: Math.round(this.tokens * 100) / 100,
      capacity: this.capacity,
      refillPerSecond: this.refillPerSecond,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Defaults ──
// ═══════════════════════════════════════════════════════════════════════════

export const DEFAULT_PER_TOOL_LIMIT: TokenBucketConfig = {
  capacity: 1000,          // burst
  refillPerSecond: 500,    // sustained — generous
};

export const DEFAULT_GLOBAL_LIMIT: TokenBucketConfig = {
  capacity: 5000,
  refillPerSecond: 2000,
};

/** Cost multipliers per tool — heavy ops pay more, cheap ops pay 1 */
export const TOOL_COST_MAP: Record<string, number> = {
  build_cognitive_index: 50,
  query_code_intelligence: 5,
  batch_operations: 10,
  semantic_search: 2,
  search_files: 2,
  get_impact_analysis: 3,
  detect_circular_dependencies: 3,
  detect_patterns: 3,
};

export function getToolCost(toolName: string): number {
  return TOOL_COST_MAP[toolName] ?? 1;
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Rate Limiter ──
// ═══════════════════════════════════════════════════════════════════════════

export class RateLimiter {
  private perToolBuckets = new Map<string, TokenBucket>();
  private globalBucket: TokenBucket;
  private logger: Logger;
  private perToolConfig: TokenBucketConfig;
  private blockedCount = 0;
  private allowedCount = 0;

  constructor(config: {
    logger: Logger;
    perToolLimit?: TokenBucketConfig;
    globalLimit?: TokenBucketConfig;
  }) {
    this.logger = config.logger;
    this.perToolConfig = config.perToolLimit ?? DEFAULT_PER_TOOL_LIMIT;
    this.globalBucket = new TokenBucket(config.globalLimit ?? DEFAULT_GLOBAL_LIMIT);
  }

  private getOrCreateBucket(toolName: string): TokenBucket {
    let bucket = this.perToolBuckets.get(toolName);
    if (!bucket) {
      bucket = new TokenBucket(this.perToolConfig);
      this.perToolBuckets.set(toolName, bucket);
    }
    return bucket;
  }

  /** Check whether a call to `toolName` is allowed and consume tokens if so. */
  check(toolName: string, cost?: number): RateLimitDecision {
    const effectiveCost = cost ?? getToolCost(toolName);
    const perTool = this.getOrCreateBucket(toolName);

    // M14 (Bug #4 — P2 Logic): Atomic consume with rollback.
    // Previous implementation had a TOCTOU gap between the availability
    // check and the consume call, and the "rare race" branch leaked
    // tokens from whichever bucket succeeded when the other failed.
    // Fix: consume sequentially and rollback on partial failure.

    // Try global first
    const globalOk = this.globalBucket.tryConsume(effectiveCost);
    if (!globalOk) {
      this.blockedCount++;
      return {
        allowed: false,
        retryAfterMs: this.globalBucket.retryAfterMs(effectiveCost),
        remaining: this.globalBucket.getAvailable(),
        blockedBy: 'global',
      };
    }

    // Global succeeded — try per-tool
    const perToolOk = perTool.tryConsume(effectiveCost);
    if (!perToolOk) {
      // Rollback global consume to prevent token leak
      this.globalBucket.refund(effectiveCost);
      this.blockedCount++;
      return {
        allowed: false,
        retryAfterMs: perTool.retryAfterMs(effectiveCost),
        remaining: perTool.getAvailable(),
        blockedBy: 'per-tool',
      };
    }

    // Both consumed successfully
    this.allowedCount++;
    return {
      allowed: true,
      remaining: Math.min(perTool.getAvailable(), this.globalBucket.getAvailable()),
      blockedBy: null,
    };
  }

  /** Reset all buckets (for tests / administrative reset) */
  resetAll(): void {
    for (const b of this.perToolBuckets.values()) b.reset();
    this.globalBucket.reset();
    this.logger.info('Rate limiter buckets reset');
  }

  getStats(): {
    allowed: number;
    blocked: number;
    blockRate: number;
    global: ReturnType<TokenBucket['snapshot']>;
    perTool: Record<string, ReturnType<TokenBucket['snapshot']>>;
  } {
    const total = this.allowedCount + this.blockedCount;
    const perTool: Record<string, ReturnType<TokenBucket['snapshot']>> = {};
    for (const [name, bucket] of this.perToolBuckets) {
      perTool[name] = bucket.snapshot();
    }
    return {
      allowed: this.allowedCount,
      blocked: this.blockedCount,
      blockRate: total > 0 ? this.blockedCount / total : 0,
      global: this.globalBucket.snapshot(),
      perTool,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Error class ──
// ═══════════════════════════════════════════════════════════════════════════

export class RateLimitExceededError extends Error {
  public readonly retryAfterMs: number;
  public readonly blockedBy: string;
  public readonly toolName: string;

  constructor(toolName: string, decision: RateLimitDecision) {
    super(
      `Rate limit exceeded for tool '${toolName}' (blocked by ${decision.blockedBy}). ` +
      `Retry after ~${decision.retryAfterMs ?? 0}ms. Remaining: ${decision.remaining.toFixed(2)} tokens.`
    );
    this.name = 'RateLimitExceededError';
    this.toolName = toolName;
    this.retryAfterMs = decision.retryAfterMs ?? 0;
    this.blockedBy = decision.blockedBy ?? 'unknown';
  }
}
