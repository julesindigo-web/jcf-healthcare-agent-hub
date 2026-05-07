import NodeCache from 'node-cache';
import QuickLRU from 'quick-lru';
import { Logger } from './logger.js';
import type { CacheEntry } from '../types/index.js';

/**
 * Multi-Level Cache Manager
 *
 * Features:
 * - Primary: node-cache (in-memory, TTL-based)
 * - Secondary: Map (hot items)
 * - Automatic cache warming
 * - Cache hit/miss metrics
 * - Distributed Redis support (optional)
 */
export class CacheManager {
  private primaryCache: NodeCache;
  private secondaryCache: QuickLRU<string, CacheEntry<any>>; // Phase D2 — LRU-bounded hot items
  private logger: Logger;
  private stats: Map<string, { hits: number; misses: number }> = new Map();
  private redis?: any; // Optional Redis client

  constructor(config: {
    maxSize: number;
    ttl: number;
    logger: Logger;
    redisUrl?: string;
  }) {
    this.logger = config.logger;
    this.primaryCache = new NodeCache({
      stdTTL: config.ttl,
      checkperiod: 120,
      useClones: false, // we handle cloning in get() via cloneValue()
    });
    // Phase D2: LRU for hot (secondary) cache — prevents unbounded memory growth.
    // Capacity = 2× primary maxSize (room for hot items across evictions), floor 100.
    this.secondaryCache = new QuickLRU<string, CacheEntry<any>>({
      maxSize: Math.max(100, config.maxSize * 2),
    });

    if (config.redisUrl) {
      this.initRedis(config.redisUrl).catch(err => {
        this.logger.warn("Failed to initialize Redis cache", { error: err });
      });
    }
  }

  private async initRedis(redisUrl: string): Promise<void> {
    try {
      const Redis = (await import('ioredis')).default;
      this.redis = new Redis(redisUrl);
      this.logger.info("Redis cache initialized", { url: redisUrl });
    } catch (error) {
      this.logger.warn("Redis not available, using local cache only");
      this.redis = undefined;
    }
  }

  /**
   * Get item from cache (with metrics)
   */
  get<T>(key: string): T | null {
    // Try primary cache first (synchronous, fastest)
    const entry = this.primaryCache.get<CacheEntry<T>>(key);
    if (entry) {
      if (entry.expires > Date.now()) {
        // Promote to secondary (hot) cache — LRU-bounded, no unbounded growth
        this.secondaryCache.set(key, entry);
        this.recordHit(key);
        // Phase D1: defensive clone on return
        return this.cloneValue(entry.value);
      } else {
        this.primaryCache.del(key);
      }
    }

    // Try secondary (hot) cache
    const hotEntry = this.secondaryCache.get(key);
    if (hotEntry && hotEntry.expires > Date.now()) {
      this.recordHit(key);
      // Phase D1: defensive clone on return
      return this.cloneValue(hotEntry.value) as T;
    }

    // Redis is async — skip in sync get(). Use getAsync() for Redis-backed lookups.
    this.recordMiss(key);
    return null;
  }

  /**
   * Phase D1: Defensive deep clone for data returns.
   *
   * Threat model (Phase D1): the calling agent is trusted via constitutional
   * binding — but the layers ABOVE the agent (model developers, host platform,
   * middleware plugins, supply-chain interlopers) are NOT. Returning a reference
   * lets those layers mutate cache internals and corrupt
   * state across later reads. `structuredClone` isolates cached state from any
   * mutation performed by callers or their ambient runtime.
   *
   * Uses `structuredClone` (Node 17+) which correctly handles Date, Map, Set,
   * typed arrays, RegExp, ArrayBuffer, nested refs. Falls back to identity for
   * non-cloneable values (functions, DOM nodes) — rare in this cache.
   */
  private cloneValue<T>(value: T): T {
    if (value === null || value === undefined) return value;
    if (typeof value !== 'object') return value; // primitives are immutable
    try {
      return structuredClone(value);
    } catch {
      // Non-cloneable (e.g., contains functions) — fall back; rare for cached data.
      return value;
    }
  }

  /**
   * Get item from cache asynchronously (includes Redis)
   */
  async getAsync<T>(key: string): Promise<T | null> {
    // Try local caches first (same as sync get)
    const localResult = this.get<T>(key);
    if (localResult !== null) return localResult;

    // Try Redis if available
    if (this.redis) {
      try {
        const cached = await this.redis.get(key);
        if (cached) {
          this.recordHit(key);
          const value = JSON.parse(cached) as T;
          // Warm local cache from Redis
          this.set(key, value);
          return value;
        }
      } catch {
        // Redis error, return null
      }
    }

    return null;
  }

  /** Maximum size per cached item (100MB default) to prevent memory exhaustion */
  private readonly MAX_ITEM_BYTES = 100 * 1024 * 1024;

  /**
   * Set item in cache (with automatic warming for hot items)
   * Rejects items that exceed MAX_ITEM_BYTES to prevent cache exhaustion.
   */
  set<T>(key: string, value: T, ttl?: number): void {
    // D1 FIX: Check item size before caching
    try {
      const itemSize = this.estimateSize(value);
      if (itemSize > this.MAX_ITEM_BYTES) {
        this.logger.warn('Cache item too large, not caching', {
          key,
          size: itemSize,
          maxSize: this.MAX_ITEM_BYTES,
        });
        return; // Don't cache oversized items
      }
    } catch {
      // If size estimation fails, proceed (defensive)
    }

    const effectiveTtl = ttl ?? 300; // Default 5 minutes
    const expires = Date.now() + effectiveTtl * 1000;
    const entry: CacheEntry<T> = {
      value,
      expires,
      created: Date.now(),
    };

    // Set in primary cache (NodeCache uses seconds)
    this.primaryCache.set(key, entry, effectiveTtl);

    // Also set in Redis if available
    if (this.redis) {
      this.redis.setex(key, effectiveTtl, JSON.stringify(value)).catch(() => {});
    }

    // Warm secondary cache for frequently accessed items (tracked via stats)
    const stats = this.stats.get(key);
    if (stats && stats.hits > 5) {
      this.secondaryCache.set(key, entry);
    }
  }

  /**
   * Delete item from cache
   */
  delete(key: string): boolean {
    this.primaryCache.del(key);
    this.secondaryCache.delete(key);
    if (this.redis) {
      this.redis.del(key).catch(() => {});
    }
    return true;
  }

  /**
   * Invalidate key (alias for delete)
   */
  invalidate(key: string): void {
    this.delete(key);
  }

  /**
   * Check if key exists (without returning value)
   */
  has(key: string): boolean {
    return this.get(key) !== null;
  }

  /**
   * Clear all caches.
   *
   * M11-AUDIT FIX (MED-6): Redis flushall failures are no longer
   * silently swallowed. When Redis fails to clear, the local primary +
   * secondary tiers are still cleared (so callers get a fresh local
   * cache), but a warning is emitted so operators see the partial-clear
   * state and can investigate the Redis-side issue.
   */
  clear(): void {
    this.primaryCache.flushAll();
    this.secondaryCache.clear();
    if (this.redis) {
      this.redis.flushall().catch((err: unknown) => {
        this.logger.warn("Redis flushall failed during cache.clear", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  /**
   * Get cache statistics
   */
  getStats(): {
    primarySize: number;
    secondarySize: number;
    hits: number;
    misses: number;
    hitRate: number;
    available: boolean;
    redisConnected: boolean;
  } {
    let totalHits = 0;
    let totalMisses = 0;
    for (const { hits, misses } of this.stats.values()) {
      totalHits += hits;
      totalMisses += misses;
    }

    const total = totalHits + totalMisses;
    const hitRate = total > 0 ? totalHits / total : 0;

    // NodeCache doesn't have keysCount, use getStats()
    const primaryStats = this.primaryCache.getStats();
    // Type: { keys: number; hits: number; misses: number; etc }

    return {
      primarySize: primaryStats.keys,
      secondarySize: this.secondaryCache.size,
      hits: totalHits,
      misses: totalMisses,
      hitRate,
      available: true,
      redisConnected: this.redis !== undefined,
    };
  }

  /**
   * Record cache hit
   */
  private recordHit(key: string): void {
    const stats = this.stats.get(key) || { hits: 0, misses: 0 };
    stats.hits++;
    this.stats.set(key, stats);
  }

  /**
   * Record cache miss
   */
  private recordMiss(key: string): void {
    const stats = this.stats.get(key) || { hits: 0, misses: 0 };
    stats.misses++;
    this.stats.set(key, stats);
  }

  /**
   * Pre-warm cache with multiple items
   */
  multiSet<T>(items: Array<{ key: string; value: T; ttl?: number }>): void {
    for (const { key, value, ttl } of items) {
      this.set(key, value, ttl);
    }
  }

  /**
   * Estimate byte size of a value for cache admission control.
   * Uses JSON.stringify for objects, Buffer.byteLength for strings.
   * Returns 0 for primitives (they have negligible cache overhead).
   */
  private estimateSize<T>(value: T): number {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'string') {
      return Buffer.byteLength(value, 'utf-8');
    }
    if (typeof value === 'object') {
      try {
        return Buffer.byteLength(JSON.stringify(value), 'utf-8');
      } catch {
        // Circular refs or non-serializable — assume large
        return this.MAX_ITEM_BYTES + 1; // Force rejection
      }
    }
    return 0; // primitives
  }

  /**
   * Get multiple items at once (reduces cache lookups)
   */
  multiGet<T>(keys: string[]): Array<{ key: string; value: T | null }> {
    return keys.map(key => ({
      key,
      value: this.get<T>(key),
    }));
  }

  /**
   * Invalidate pattern (delete all keys matching pattern)
   */
  invalidatePattern(pattern: RegExp): void {
    // Primary cache - NodeCache doesn't expose keys, so we can't efficiently invalidate by pattern
    // This is a limitation of node-cache, but we can clear secondary cache
    for (const [key] of this.secondaryCache) {
      if (pattern.test(key)) {
        this.secondaryCache.delete(key);
      }
    }

    // Redis (if available) - limited support
    if (this.redis) {
      this.redis.keys('*').then((keys: string[]) => {
        for (const key of keys) {
          if (pattern.test(key)) {
            this.redis?.del(key).catch(() => {});
          }
        }
      }).catch(() => {});
    }
  }

  /**
   * Initialize cache (no-op for node-cache, kept for interface compatibility)
   */
  async initialize(): Promise<void> {
    // NodeCache is ready immediately
  }
}

export { CacheManager as Cache };
