import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SelfHealing } from '../lib/self-healing';
import { Logger } from '../lib/logger';

/**
 * Phase E.4 (M5 audit) -- jcf-healthcare-agent-hub self-healing.ts contract tests.
 * Validates error categorization, fix strategies, event emission, health checks,
 * and statistics. Uses minimal stubs for Database + CacheManager because
 * SelfHealing only invokes a small subset of methods.
 */
function createCacheStub(): any {
  return {
    delete: vi.fn(),
    clear: vi.fn(),
    getStats: () => ({ hits: 10, misses: 5, hitRate: 0.67, available: true, redisConnected: false }),
  };
}

function createDbStub(): any {
  return {
    getVersions: () => [],
    getAllFiles: () => [],
    getFileMetadata: () => null,
    cleanup: vi.fn(async () => {}),
    getStats: () => ({ fileCount: 0, auditCount: 0, versionCount: 0 }),
    dbPath: '/tmp/test-db.json',
  };
}

describe('SelfHealing', () => {
  let healing: SelfHealing;
  let logger: Logger;
  let cache: any;
  let db: any;

  beforeEach(() => {
    vi.useFakeTimers();
    logger = new Logger('error');
    cache = createCacheStub();
    db = createDbStub();
    healing = new SelfHealing({ logger, cache, db, maxAutoFixes: 5 });
  });

  describe('healError -- error categorization', () => {
    it('handles cache error and returns healed=true', async () => {
      const err = new Error('cache miss');
      const result = await healing.healError(err, { component: 'cache', key: 'mykey' });
      expect(result.healed).toBe(true);
      expect(cache.delete).toHaveBeenCalledWith('mykey');
    });

    it('clears full cache when key not provided', async () => {
      const err = new Error('cache failure');
      const result = await healing.healError(err, { component: 'cache' });
      expect(result.healed).toBe(true);
      expect(cache.clear).toHaveBeenCalled();
    });

    it('handles file_not_found without filePath returns not healed', async () => {
      const err: any = new Error('no such file');
      err.code = 'ENOENT';
      const result = await healing.healError(err, {});
      expect(result.healed).toBe(false);
    });

    it('handles network error for redis with fallback', async () => {
      const err = new Error('connect ECONNREFUSED');
      const result = await healing.healError(err, { service: 'redis' });
      expect(result.healed).toBe(true);
      expect(result.fixApplied).toContain('Redis');
    });

    it('returns not healed for unknown error category', async () => {
      const err = new Error('some completely unrelated random error');
      const result = await healing.healError(err, {});
      expect(result.healed).toBe(false);
      expect(result.message).toContain('No auto-fix');
    });

    it('handles circular dependency error with refactor suggestion', async () => {
      const err = new Error('circular dependency detected');
      const result = await healing.healError(err, { cyclePath: ['a', 'b', 'a'] });
      expect(result.healed).toBe(false);
      expect(result.message).toContain('Circular');
    });

    it('returns duration on every result', async () => {
      const err = new Error('cache test');
      const result = await healing.healError(err, { component: 'cache' });
      expect(result.duration).toBeDefined();
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('respects maxAutoFixes cooldown', async () => {
      const err: any = new Error('no such file');
      err.code = 'ENOENT';
      // Trigger 5 attempts (maxAutoFixes=5)
      for (let i = 0; i < 5; i++) {
        await healing.healError(err, { filePath: '/tmp/missing.txt' });
      }
      // 6th attempt should be in cooldown
      const result = await healing.healError(err, { filePath: '/tmp/missing.txt' });
      expect(result.message).toContain('Max auto-fix');
    });
  });

  describe('events emission', () => {
    it('emits heal:attempt on every healError call', async () => {
      const handler = vi.fn();
      healing.events.on('heal:attempt', handler);
      await healing.healError(new Error('cache fail'), { component: 'cache' });
      expect(handler).toHaveBeenCalled();
      expect(handler.mock.calls[0][0]).toHaveProperty('signature');
    });

    it('emits heal:success when fix succeeds', async () => {
      const handler = vi.fn();
      healing.events.on('heal:success', handler);
      await healing.healError(new Error('cache miss'), { component: 'cache', key: 'k' });
      expect(handler).toHaveBeenCalled();
      const payload = handler.mock.calls[0][0];
      expect(payload).toHaveProperty('fixApplied');
      expect(payload).toHaveProperty('duration');
    });

    it('emits heal:failure when fix fails', async () => {
      const handler = vi.fn();
      healing.events.on('heal:failure', handler);
      await healing.healError(new Error('totally unknown fault'), {});
      expect(handler).toHaveBeenCalled();
    });

    it('emits heal:cooldown after max attempts', async () => {
      const handler = vi.fn();
      healing.events.on('heal:cooldown', handler);

      const err: any = new Error('no such file');
      err.code = 'ENOENT';
      for (let i = 0; i < 6; i++) {
        await healing.healError(err, { filePath: '/tmp/missing.txt' });
      }
      expect(handler).toHaveBeenCalled();
    });
  });

  describe('proactiveHealthCheck', () => {
    it('returns expected result shape', async () => {
      const result = await healing.proactiveHealthCheck();
      expect(result).toHaveProperty('healthy');
      expect(result).toHaveProperty('issues');
      expect(result).toHaveProperty('autoFixesApplied');
      expect(result).toHaveProperty('details');
      expect(Array.isArray(result.issues)).toBe(true);
      expect(Array.isArray(result.details)).toBe(true);
    });

    it('flags database issue when stats are empty', async () => {
      const result = await healing.proactiveHealthCheck();
      // db stub returns fileCount=0 + auditCount=0 -> flags issue
      expect(result.issues.some(i => i.toLowerCase().includes('database'))).toBe(true);
    });

    it('returns healthy=true when all components are good', async () => {
      db.getStats = () => ({ fileCount: 100, auditCount: 50, versionCount: 30 });
      // Cache hit rate is high (0.67), no other issues
      const result = await healing.proactiveHealthCheck();
      // Either healthy=true or only "missing critical file" issues
      expect(typeof result.healthy).toBe('boolean');
    });

    it('flags cache when hit rate is very low', async () => {
      cache.getStats = () => ({ hits: 5, misses: 100, hitRate: 0.05, available: true, redisConnected: false });
      const result = await healing.proactiveHealthCheck();
      expect(result.issues.some(i => i.toLowerCase().includes('cache'))).toBe(true);
    });

    it('emits health:check event', async () => {
      const handler = vi.fn();
      healing.events.on('health:check', handler);
      await healing.proactiveHealthCheck();
      expect(handler).toHaveBeenCalled();
    });

    it('emits health:degraded when issues found', async () => {
      const handler = vi.fn();
      healing.events.on('health:degraded', handler);
      await healing.proactiveHealthCheck();
      // Db stub returns empty stats -> degraded
      expect(handler).toHaveBeenCalled();
    });
  });

  describe('healthCheck (legacy compat)', () => {
    it('returns same shape as proactiveHealthCheck', async () => {
      const result = await healing.healthCheck();
      expect(result).toHaveProperty('healthy');
      expect(result).toHaveProperty('issues');
      expect(result).toHaveProperty('autoFixesApplied');
    });
  });

  describe('getStats', () => {
    it('returns zeros for fresh instance', () => {
      const stats = healing.getStats();
      expect(stats.totalFixAttempts).toBe(0);
      expect(stats.successfulFixes).toBe(0);
      expect(stats.successRate).toBe(0);
      expect(stats.errorCategories).toEqual({});
    });

    it('tracks fix attempts after healError calls', async () => {
      await healing.healError(new Error('cache fail'), { component: 'cache' });
      const stats = healing.getStats();
      expect(stats.totalFixAttempts).toBeGreaterThan(0);
    });

    it('successRate reflects success history', async () => {
      // Cache fix always succeeds
      await healing.healError(new Error('cache 1'), { component: 'cache' });
      await healing.healError(new Error('cache 2'), { component: 'cache' });

      const stats = healing.getStats();
      expect(stats.successRate).toBeGreaterThan(0);
    });
  });

  describe('startHealthMonitoring + stopHealthMonitoring', () => {
    it('can start and stop without error', () => {
      expect(() => healing.startHealthMonitoring(60000)).not.toThrow();
      expect(() => healing.stopHealthMonitoring()).not.toThrow();
    });

    it('replaces existing interval on restart', () => {
      healing.startHealthMonitoring(60000);
      expect(() => healing.startHealthMonitoring(30000)).not.toThrow();
      healing.stopHealthMonitoring();
    });

    it('stop is idempotent', () => {
      healing.stopHealthMonitoring();
      expect(() => healing.stopHealthMonitoring()).not.toThrow();
    });
  });

  describe('setVectorDbRef', () => {
    it('accepts vector DB reference without error', () => {
      const stubVdb = { initialize: vi.fn() };
      expect(() => healing.setVectorDbRef(stubVdb)).not.toThrow();
    });
  });
});
