import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { VectorDB } from '../lib/vector-db';
import { Logger } from '../lib/logger';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

/**
 * Phase E.4 (M5 audit) -- jcf-healthcare-agent-hub vector-db.ts contract tests.
 * Validates tf-idf indexing, n-gram tokenization, semantic search,
 * incremental updates, and persistence.
 *
 * Uses temp dir for fs-backed JSON storage; cleanup in afterEach.
 */
describe('VectorDB', () => {
  let db: VectorDB;
  let logger: Logger;
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jcf-vdb-test-'));
    // M12 (ADR-006): VectorDB now stores in SQLite. The constructor still
    // accepts the legacy `.json` path and transparently rewrites to
    // `.sqlite`, so existing tests don't need to change the extension.
    dbPath = path.join(tmpDir, 'test-vdb.json');
    logger = new Logger('error');
    db = new VectorDB({ path: dbPath, dimension: 384, logger });
    await db.initialize();
  });

  afterEach(async () => {
    // M12: close the SQLite connection BEFORE removing the tmpdir.
    // On Windows the WAL `-shm` / `-wal` files hold OS-level locks
    // that prevent unlink until close. The legacy debounced-save
    // drain is gone — SQLite writes are journal-protected, no
    // pending in-memory state to flush.
    try {
      db?.close();
    } catch {
      /* idempotent */
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('initialize', () => {
    it('creates new DB file when missing', async () => {
      // M12 (ADR-006): the constructor rewrites `.json` paths to `.sqlite`
      // so the actual on-disk artifact lives next to the requested path.
      const sqlitePath = dbPath.replace(/\.json$/, '.sqlite');
      const stat = await fs.stat(sqlitePath);
      expect(stat.isFile()).toBe(true);
    });

    it('starts with zero documents', () => {
      const stats = db.getStats();
      expect(stats.totalDocuments).toBe(0);
      expect(stats.indexedFiles).toBe(0);
    });

    it('re-initialize on existing path does not error', async () => {
      // M12: close the original instance before opening a second one so
      // the WAL handle isn't double-held while afterEach runs.
      db.close();
      const db2 = new VectorDB({ path: dbPath, dimension: 384, logger });
      await expect(db2.initialize()).resolves.not.toThrow();
      // Close the second instance so afterEach can rm the tmpdir cleanly.
      db2.close();
      // Re-open the original instance so the shared `db` handle in
      // afterEach is still valid (close() is idempotent so the second
      // afterEach close is a no-op).
      db = new VectorDB({ path: dbPath, dimension: 384, logger });
      await db.initialize();
    });
  });

  describe('indexFile', () => {
    it('indexes single file content', async () => {
      await db.indexFile('/path/a.ts', 'authentication middleware token validation');
      const stats = db.getStats();
      expect(stats.totalDocuments).toBeGreaterThanOrEqual(1);
    });

    it('re-indexing same file does NOT duplicate', async () => {
      await db.indexFile('/path/a.ts', 'first content here');
      await db.indexFile('/path/a.ts', 'updated content there');
      const stats = db.getStats();
      expect(stats.totalDocuments).toBe(1);
    });

    it('handles empty content gracefully', async () => {
      await expect(db.indexFile('/path/empty.ts', '')).resolves.not.toThrow();
    });

    it('handles large content', async () => {
      const large = 'word '.repeat(10000);
      await expect(db.indexFile('/path/big.ts', large)).resolves.not.toThrow();
    });
  });

  describe('removeFile', () => {
    it('removes indexed file', async () => {
      await db.indexFile('/path/a.ts', 'some content');
      await db.removeFile('/path/a.ts');
      const stats = db.getStats();
      expect(stats.totalDocuments).toBe(0);
    });

    it('removeFile on non-existent path is no-op', async () => {
      await expect(db.removeFile('/nonexistent')).resolves.not.toThrow();
    });
  });

  describe('search (tf-idf)', () => {
    beforeEach(async () => {
      await db.indexFile('/path/auth.ts', 'authentication middleware token validation jwt bearer security');
      await db.indexFile('/path/cache.ts', 'caching layer redis memcache lru ttl invalidation');
      await db.indexFile('/path/router.ts', 'routing endpoints handlers middleware controller');
    });

    it('returns ranked matches for relevant query', () => {
      const results = db.search('authentication token jwt', 5);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].path).toBe('/path/auth.ts');
    });

    it('ranks cache file for cache query', () => {
      const results = db.search('redis lru cache', 5);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].path).toBe('/path/cache.ts');
    });

    it('respects limit parameter', () => {
      const results = db.search('middleware', 2);
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('returns empty for irrelevant query above threshold', () => {
      const results = db.search('xyzqwerty_no_match_term_unique', 5, 0.5);
      expect(results.length).toBe(0);
    });

    it('returns snippets in results', () => {
      const results = db.search('authentication', 1);
      if (results.length > 0) {
        expect(results[0].snippet).toBeDefined();
        expect(results[0].score).toBeGreaterThan(0);
      }
    });

    it('returns valid score (finite non-negative number)', () => {
      const results = db.search('authentication', 5);
      for (const r of results) {
        expect(r.score).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(r.score)).toBe(true);
      }
      // Top result must be > 0 since query matches indexed content
      if (results.length > 0) {
        expect(results[0].score).toBeGreaterThan(0);
      }
    });
  });

  describe('indexFilesBatch', () => {
    it('indexes multiple files in one call', async () => {
      await db.indexFilesBatch([
        { path: '/a.ts', content: 'alpha content one alpha' },
        { path: '/b.ts', content: 'beta content two beta' },
        { path: '/c.ts', content: 'gamma content three gamma' },
      ]);
      const stats = db.getStats();
      expect(stats.totalDocuments).toBe(3);
    });

    it('handles empty batch', async () => {
      await expect(db.indexFilesBatch([])).resolves.not.toThrow();
      expect(db.getStats().totalDocuments).toBe(0);
    });

    it('re-indexing via batch does NOT duplicate', async () => {
      await db.indexFile('/x.ts', 'original');
      await db.indexFilesBatch([
        { path: '/x.ts', content: 'updated' },
        { path: '/y.ts', content: 'new file' },
      ]);
      expect(db.getStats().totalDocuments).toBe(2);
    });
  });

  describe('getStats', () => {
    it('reports zero stats for fresh DB', () => {
      const stats = db.getStats();
      expect(stats.totalDocuments).toBe(0);
      expect(stats.indexedFiles).toBe(0);
    });

    it('reports accurate document count', async () => {
      await db.indexFile('/a.ts', 'content a');
      await db.indexFile('/b.ts', 'content b');
      const stats = db.getStats();
      expect(stats.totalDocuments).toBe(2);
      expect(stats.indexedFiles).toBe(2);
    });

    it('uniqueTerms increases with vocabulary', async () => {
      await db.indexFile('/a.ts', 'authentication middleware');
      const before = db.getStats().uniqueTerms;
      await db.indexFile('/b.ts', 'caching layer redis');
      const after = db.getStats().uniqueTerms;
      expect(after).toBeGreaterThan(before);
    });
  });

  describe('getDocumentCount', () => {
    it('matches totalDocuments from getStats', async () => {
      await db.indexFile('/a.ts', 'test content');
      expect(db.getDocumentCount()).toBe(db.getStats().totalDocuments);
    });
  });

  describe('search with stop word filtering', () => {
    it('common English stop words do not match', async () => {
      await db.indexFile('/a.ts', 'the quick brown fox jumps over the lazy dog');
      // Stop words like "the", "over" should be filtered
      const results = db.search('the', 5, 0.1);
      // Either no match or very low score
      expect(results.length === 0 || (results[0]?.score ?? 0) < 0.5).toBe(true);
    });
  });
});
