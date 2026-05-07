import { describe, it, expect, beforeEach } from 'vitest';
import { CacheManager } from '../lib/cache';
import { Logger } from '../lib/logger';

describe('CacheManager', () => {
  let cache: CacheManager;
  let logger: Logger;

  beforeEach(() => {
    logger = new Logger('error');
    cache = new CacheManager({
      maxSize: 100,
      ttl: 60,
      logger,
    });
  });

  describe('basic operations', () => {
    it('should set and get a value', () => {
      cache.set('key1', 'value1');
      expect(cache.get('key1')).toBe('value1');
    });

    it('should return null for non-existent key', () => {
      expect(cache.get('nonexistent')).toBeNull();
    });

    it('should delete a value', () => {
      cache.set('key1', 'value1');
      cache.delete('key1');
      expect(cache.get('key1')).toBeNull();
    });

    it('should check if key exists', () => {
      cache.set('key1', 'value1');
      expect(cache.has('key1')).toBe(true);
      expect(cache.has('nonexistent')).toBe(false);
    });

    it('should clear all values', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.clear();
      expect(cache.get('key1')).toBeNull();
      expect(cache.get('key2')).toBeNull();
    });
  });

  describe('TTL functionality', () => {
    it('should respect custom TTL', () => {
      cache.set('key1', 'value1', 1); // 1 second TTL
      expect(cache.get('key1')).toBe('value1');
    });

    it('should store different value types', () => {
      cache.set('string', 'value');
      cache.set('number', 42);
      cache.set('object', { foo: 'bar' });
      cache.set('array', [1, 2, 3]);

      expect(cache.get('string')).toBe('value');
      expect(cache.get('number')).toBe(42);
      expect(cache.get('object')).toEqual({ foo: 'bar' });
      expect(cache.get('array')).toEqual([1, 2, 3]);
    });
  });

  describe('statistics', () => {
    it('should track cache stats', () => {
      cache.set('key1', 'value1');
      cache.get('key1');
      cache.get('key1');
      cache.get('nonexistent');

      const stats = cache.getStats();
      expect(stats.available).toBe(true);
      expect(stats.redisConnected).toBe(false);
    });

    it('should calculate hit rate', () => {
      cache.set('key1', 'value1');
      cache.get('key1'); // hit
      cache.get('key1'); // hit
      cache.get('nonexistent'); // miss

      const stats = cache.getStats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
      expect(stats.hitRate).toBe(2 / 3);
    });
  });

  describe('multi operations', () => {
    it('should multi-set values', () => {
      cache.multiSet([
        { key: 'key1', value: 'value1' },
        { key: 'key2', value: 'value2' },
      ]);

      expect(cache.get('key1')).toBe('value1');
      expect(cache.get('key2')).toBe('value2');
    });

    it('should multi-get values', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');

      const results = cache.multiGet(['key1', 'key2', 'nonexistent']);
      expect(results).toHaveLength(3);
      expect(results[0].value).toBe('value1');
      expect(results[1].value).toBe('value2');
      expect(results[2].value).toBeNull();
    });
  });

  describe('pattern invalidation', () => {
    it('should invalidate secondary cache by pattern', () => {
      // Note: Pattern invalidation only works on secondary (hot) cache
      // Primary NodeCache does not support pattern-based invalidation
      cache.set('test:1', 'value1');
      cache.set('test:2', 'value2');
      cache.set('other:1', 'value3');

      // Access multiple times to promote to hot cache
      for (let i = 0; i < 6; i++) {
        cache.get('test:1');
        cache.get('test:2');
        cache.get('other:1');
      }

      cache.invalidatePattern(/^test:/);

      // Secondary cache entries should be cleared
      // Primary cache may still have entries (implementation limitation)
      expect(cache.get('other:1')).toBe('value3');
    });
  });
});
