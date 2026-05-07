import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  TokenBucket,
  RateLimiter,
  RateLimitExceededError,
  DEFAULT_PER_TOOL_LIMIT,
  DEFAULT_GLOBAL_LIMIT,
  getToolCost,
  TOOL_COST_MAP,
} from '../lib/rate-limiter';
import { Logger } from '../lib/logger';

describe('TokenBucket', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  it('starts full at capacity', () => {
    const b = new TokenBucket({ capacity: 10, refillPerSecond: 1 });
    expect(b.getAvailable()).toBe(10);
  });

  it('tryConsume succeeds while tokens available', () => {
    const b = new TokenBucket({ capacity: 5, refillPerSecond: 1 });
    for (let i = 0; i < 5; i++) {
      expect(b.tryConsume(1)).toBe(true);
    }
  });

  it('tryConsume fails when exhausted', () => {
    const b = new TokenBucket({ capacity: 3, refillPerSecond: 0.01 });
    expect(b.tryConsume(3)).toBe(true);
    expect(b.tryConsume(1)).toBe(false);
  });

  it('refills proportionally to elapsed time', async () => {
    const b = new TokenBucket({ capacity: 10, refillPerSecond: 100 });
    expect(b.tryConsume(10)).toBe(true);
    // Advance fake timers by 60ms — deterministic time progression
    vi.advanceTimersByTime(60);
    expect(b.getAvailable()).toBeGreaterThanOrEqual(4);
  });

  it('capacity ceiling cannot be exceeded', async () => {
    const b = new TokenBucket({ capacity: 5, refillPerSecond: 1000 });
    vi.advanceTimersByTime(50);
    expect(b.getAvailable()).toBeLessThanOrEqual(5);
  });

  it('retryAfterMs reports remaining wait', () => {
    const b = new TokenBucket({ capacity: 2, refillPerSecond: 10 });
    b.tryConsume(2);
    const wait = b.retryAfterMs(1);
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(200); // 1 token / 10 per sec = 100 ms
  });

  it('reset restores full capacity', () => {
    const b = new TokenBucket({ capacity: 5, refillPerSecond: 0.01 });
    b.tryConsume(5);
    expect(b.tryConsume(1)).toBe(false);
    b.reset();
    expect(b.getAvailable()).toBe(5);
  });

  it('snapshot exposes state without mutation', () => {
    const b = new TokenBucket({ capacity: 10, refillPerSecond: 5 });
    const snap = b.snapshot();
    expect(snap.capacity).toBe(10);
    expect(snap.refillPerSecond).toBe(5);
    expect(snap.available).toBeLessThanOrEqual(10);
  });
});

describe('getToolCost', () => {
  it('returns 1 for unknown tools', () => {
    expect(getToolCost('totally_unknown_tool_xyz')).toBe(1);
  });

  it('returns mapped cost for known expensive tools', () => {
    for (const [name, expected] of Object.entries(TOOL_COST_MAP)) {
      expect(getToolCost(name)).toBe(expected);
    }
  });

  it('build_cognitive_index has highest cost', () => {
    expect(getToolCost('build_cognitive_index')).toBeGreaterThanOrEqual(50);
  });
});

describe('RateLimiter', () => {
  let limiter: RateLimiter;
  let logger: Logger;

  beforeEach(() => {
    logger = new Logger('error');
    limiter = new RateLimiter({ logger });
  });

  it('allows initial calls within generous default limits', () => {
    for (let i = 0; i < 20; i++) {
      const d = limiter.check('read_file');
      expect(d.allowed).toBe(true);
    }
  });

  it('blocks when per-tool bucket exhausted', () => {
    const tight = new RateLimiter({
      logger,
      perToolLimit: { capacity: 2, refillPerSecond: 0.01 },
    });
    expect(tight.check('x').allowed).toBe(true);
    expect(tight.check('x').allowed).toBe(true);
    const blocked = tight.check('x');
    expect(blocked.allowed).toBe(false);
    expect(blocked.blockedBy).toBe('per-tool');
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it('blocks when global bucket exhausted', () => {
    const global = new RateLimiter({
      logger,
      globalLimit: { capacity: 2, refillPerSecond: 0.01 },
    });
    expect(global.check('a').allowed).toBe(true);
    expect(global.check('b').allowed).toBe(true);
    const blocked = global.check('c');
    expect(blocked.allowed).toBe(false);
    expect(blocked.blockedBy).toBe('global');
  });

  it('honours tool-specific cost multipliers', () => {
    const small = new RateLimiter({
      logger,
      globalLimit: { capacity: 10, refillPerSecond: 0.01 },
    });
    // build_cognitive_index costs 50 tokens — should fail immediately
    const decision = small.check('build_cognitive_index');
    expect(decision.allowed).toBe(false);
  });

  it('resetAll restores all buckets', () => {
    const tight = new RateLimiter({
      logger,
      perToolLimit: { capacity: 1, refillPerSecond: 0.01 },
    });
    tight.check('x');
    expect(tight.check('x').allowed).toBe(false);
    tight.resetAll();
    expect(tight.check('x').allowed).toBe(true);
  });

  it('getStats reports allowed/blocked counters', () => {
    const tight = new RateLimiter({
      logger,
      perToolLimit: { capacity: 1, refillPerSecond: 0.01 },
    });
    tight.check('x'); // allowed
    tight.check('x'); // blocked
    const stats = tight.getStats();
    expect(stats.allowed).toBe(1);
    expect(stats.blocked).toBe(1);
    expect(stats.blockRate).toBe(0.5);
  });
});

describe('RateLimitExceededError', () => {
  it('captures decision metadata', () => {
    const err = new RateLimitExceededError('read_file', {
      allowed: false,
      retryAfterMs: 500,
      remaining: 0,
      blockedBy: 'global',
    });
    expect(err.name).toBe('RateLimitExceededError');
    expect(err.toolName).toBe('read_file');
    expect(err.retryAfterMs).toBe(500);
    expect(err.blockedBy).toBe('global');
  });
});

describe('Default limits are generous', () => {
  it('per-tool bucket >= 1000 capacity (burst) + 500/s sustained', () => {
    expect(DEFAULT_PER_TOOL_LIMIT.capacity).toBeGreaterThanOrEqual(1000);
    expect(DEFAULT_PER_TOOL_LIMIT.refillPerSecond).toBeGreaterThanOrEqual(500);
  });

  it('global bucket >= 5000 capacity (burst) + 2000/s sustained', () => {
    expect(DEFAULT_GLOBAL_LIMIT.capacity).toBeGreaterThanOrEqual(5000);
    expect(DEFAULT_GLOBAL_LIMIT.refillPerSecond).toBeGreaterThanOrEqual(2000);
  });
});

// M14 Bug #4 regressions: TokenBucket.refund() + RateLimiter rollback
describe('TokenBucket.refund — M14 Bug #4 regression', () => {
  it('refund restores tokens up to capacity', () => {
    const b = new TokenBucket({ capacity: 5, refillPerSecond: 0.01 });
    b.tryConsume(3);
    expect(b.getAvailable()).toBe(2);
    b.refund(3);
    expect(b.getAvailable()).toBe(5); // capped at capacity
  });

  it('refund does not exceed capacity', () => {
    const b = new TokenBucket({ capacity: 5, refillPerSecond: 0.01 });
    b.refund(10); // refund on full bucket
    expect(b.getAvailable()).toBe(5);
  });
});

describe('RateLimiter rollback on per-tool failure — M14 Bug #4 regression', () => {
  it('global tokens are refunded when per-tool bucket is exhausted', () => {
    const logger = new Logger('error');
    // Global: large capacity. Per-tool: capacity=1 so second call is blocked.
    const limiter = new RateLimiter({
      logger,
      globalLimit: { capacity: 100, refillPerSecond: 0.01 },
      perToolLimit: { capacity: 1, refillPerSecond: 0.01 },
    });
    const before = limiter.getStats().global.available;
    limiter.check('x'); // allowed: consumes 1 global + 1 per-tool
    const afterFirst = limiter.getStats().global.available;
    // First call consumed one global token
    expect(afterFirst).toBe(before - 1);

    const d = limiter.check('x'); // per-tool exhausted: global must be refunded
    expect(d.allowed).toBe(false);
    expect(d.blockedBy).toBe('per-tool');
    // Global tokens must be back to same level as after first call (rollback)
    expect(limiter.getStats().global.available).toBe(afterFirst);
  });
});

// Ensure fake timers don't leak between tests
afterEach(() => {
  vi.useRealTimers();
});
