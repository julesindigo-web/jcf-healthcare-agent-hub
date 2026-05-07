import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { VectorDB } from '../lib/vector-db';
import { EmbeddingClient } from '../lib/embedding-client';
import { Logger } from '../lib/logger';
import { VectorStorage } from '../lib/vector-storage';

/**
 * M12 (ADR-006) — feature tests for the SQLite-backed
 * VectorDB:
 *
 *   - Dim validation drops mismatched-length qwen3 vectors on boot
 *   - Backfill loop populates missing qwen3 vectors when the bridge
 *     becomes available
 *   - Version invalidation purges qwen3 columns when the producer flips
 *     backends or upgrades the model
 *   - Legacy JSON migration consolidates `.jcf-vector-db.json` into the
 *     three SQLite tables on first boot
 *   - `getVersionStats` reports coverage that match expectations
 *
 * Each test uses its own tmpdir + closes the connection in afterEach so
 * the Windows WAL `-shm` / `-wal` lock release happens before the
 * directory is removed (same pattern as `vector-db.test.ts`).
 */

// ── Mock EmbeddingClient ─────────────────────────────────────────────

/**
 * Vitest-friendly mock of {@link EmbeddingClient} that lets us drive
 * `isAvailable`, `embedDocuments`, and the captured `embeddingVersion`
 * deterministically. Mirrors the public API surface VectorDB consumes
 * so we can use it without changing the production code.
 */
class MockEmbeddingClient {
  available: boolean = true;
  version: string = 'safetensors:Qwen3-Embedding-0.6B:1024';
  vectorFactory: (text: string) => number[];
  embedCalls: number = 0;
  embedBatchCalls: number = 0;
  failureMode: 'none' | 'returns-null' | 'returns-wrong-dim' = 'none';
  expectedDim: number;

  constructor(
    expectedDim = 1024,
    factory?: (text: string) => number[]
  ) {
    this.expectedDim = expectedDim;
    this.vectorFactory =
      factory ?? ((_text: string) => new Array(this.expectedDim).fill(0).map((_, i) => (i === 0 ? 1 : 0)));
  }

  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  async embedDocuments(texts: string[]): Promise<number[][] | null> {
    this.embedBatchCalls++;
    if (this.failureMode === 'returns-null') return null;
    if (texts.length === 0) return [];
    return texts.map((t) => {
      this.embedCalls++;
      const vec = this.vectorFactory(t);
      if (this.failureMode === 'returns-wrong-dim') return vec.slice(0, this.expectedDim - 2);
      return vec;
    });
  }

  async embedQuery(query: string): Promise<number[] | null> {
    if (!this.available) return null;
    this.embedCalls++;
    return this.vectorFactory(query);
  }

  embeddingVersion(): string | undefined {
    return this.version;
  }

  invalidate(): void {
    this.available = false;
  }
}

function asEmbeddingClient(mock: MockEmbeddingClient): EmbeddingClient {
  // The mock implements the duck-typed surface VectorDB uses; cast so
  // the constructor accepts it without forcing a real EmbeddingClient.
  return mock as unknown as EmbeddingClient;
}

// ── Test scaffolding ─────────────────────────────────────────────────

let tmpDir: string;
let dbPath: string;
let logger: Logger;
let db: VectorDB | null;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jcf-vdb-m12-'));
  dbPath = path.join(tmpDir, 'm12-vdb.sqlite');
  logger = new Logger('error');
  db = null;
});

afterEach(async () => {
  try {
    db?.close();
  } catch {
    /* idempotent */
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── Dim validation on boot ───────────────────────────────────────────

describe('VectorDB M12 — dim validation on boot', () => {
  it('drops qwen3 vectors with unexpected dimension during initialize', async () => {
    // Pre-seed the SQLite store with one good (4-dim) vector and one
    // mismatched (2-dim) vector. Use a separate VectorStorage instance
    // so VectorDB.initialize() encounters them during its boot sweep.
    const storage = new VectorStorage({ path: dbPath, logger });
    await storage.initialize();
    storage.upsertVector({
      path: '/good.ts',
      tfidf_vector: [1, 0, 0, 0],
      terms: new Map([['good', 1]]),
      ngrams: new Map(),
      qwen3_vector: [1, 0, 0, 0],
      qwen3_dim: 4,
      qwen3_version: 'safetensors:Qwen3-Embedding-0.6B:4',
      content_snippet: 'good content',
      indexed_at: Date.now(),
    });
    storage.upsertVector({
      path: '/bad.ts',
      tfidf_vector: [0, 1, 0, 0],
      terms: new Map([['bad', 1]]),
      ngrams: new Map(),
      qwen3_vector: [0.5, 0.5], // wrong dim — should be dropped on init
      qwen3_dim: 2,
      qwen3_version: 'legacy:old-model:2',
      content_snippet: 'bad content',
      indexed_at: Date.now(),
    });
    storage.adjustTotalDocuments(2);
    storage.close();

    db = new VectorDB({
      path: dbPath,
      dimension: 4,
      logger,
      expectedQwen3Dim: 4,
    });
    await db.initialize();

    const stats = db.getVersionStats();
    expect(stats.total).toBe(2);
    // Only `/good.ts` retains its qwen3_vector; `/bad.ts` was nuked
    // during the boot validation sweep.
    expect(stats.withQwen3).toBe(1);
    expect(stats.missingQwen3).toBe(1);
  });

  it('keeps qwen3 vectors that match the expected dim untouched', async () => {
    const storage = new VectorStorage({ path: dbPath, logger });
    await storage.initialize();
    const expected = 8;
    storage.upsertVector({
      path: '/x.ts',
      tfidf_vector: new Array(expected).fill(0),
      terms: new Map(),
      ngrams: new Map(),
      qwen3_vector: new Array(expected).fill(0.1),
      qwen3_dim: expected,
      qwen3_version: 'safetensors:Qwen3:8',
      content_snippet: 'x',
      indexed_at: Date.now(),
    });
    storage.adjustTotalDocuments(1);
    storage.close();

    db = new VectorDB({
      path: dbPath,
      dimension: 8,
      logger,
      expectedQwen3Dim: expected,
    });
    await db.initialize();

    const stats = db.getVersionStats();
    expect(stats.withQwen3).toBe(1);
    expect(stats.missingQwen3).toBe(0);
  });
});

// ── Backfill mechanism ────────────────────────────────────────────────

describe('VectorDB M12 — backfill loop', () => {
  it('populates missing qwen3 vectors when bridge becomes available', async () => {
    const expectedDim = 4;
    const mock = new MockEmbeddingClient(expectedDim);
    db = new VectorDB({
      path: dbPath,
      dimension: expectedDim,
      logger,
      embeddingClient: asEmbeddingClient(mock),
      expectedQwen3Dim: expectedDim,
    });
    await db.initialize();

    // Index two files while the bridge is "down" — qwen3 vectors stay null.
    mock.available = false;
    await db.indexFile('/a.ts', 'authentication middleware token');
    await db.indexFile('/b.ts', 'caching layer redis ttl');

    let stats = db.getVersionStats();
    expect(stats.total).toBe(2);
    expect(stats.missingQwen3).toBe(2);

    // Bridge comes back online — backfill should fill in both qwen3 vectors.
    mock.available = true;
    const report = await db.backfillQwen3({
      batchSize: 10,
      interBatchDelayMs: 0,
    });

    expect(report.processed).toBe(2);
    expect(report.updated).toBe(2);
    expect(report.skipped).toBe(0);
    expect(report.aborted).toBe(false);

    stats = db.getVersionStats();
    expect(stats.withQwen3).toBe(2);
    expect(stats.missingQwen3).toBe(0);
    expect(stats.versions[mock.version]).toBe(2);
  });

  it('aborts cleanly when bridge is unavailable mid-loop', async () => {
    const expectedDim = 4;
    const mock = new MockEmbeddingClient(expectedDim);
    db = new VectorDB({
      path: dbPath,
      dimension: expectedDim,
      logger,
      embeddingClient: asEmbeddingClient(mock),
      expectedQwen3Dim: expectedDim,
    });
    await db.initialize();

    mock.available = false;
    await db.indexFile('/a.ts', 'auth content');

    // Bridge stays down at backfill time — should abort with aborted=true.
    const report = await db.backfillQwen3({
      batchSize: 10,
      interBatchDelayMs: 0,
    });
    expect(report.aborted).toBe(true);
    expect(report.updated).toBe(0);
  });

  it('skips rows where embed returns wrong dim', async () => {
    const expectedDim = 4;
    const mock = new MockEmbeddingClient(expectedDim);
    db = new VectorDB({
      path: dbPath,
      dimension: expectedDim,
      logger,
      embeddingClient: asEmbeddingClient(mock),
      expectedQwen3Dim: expectedDim,
    });
    await db.initialize();

    mock.available = false;
    await db.indexFile('/a.ts', 'auth content');

    mock.available = true;
    mock.failureMode = 'returns-wrong-dim';
    const report = await db.backfillQwen3({
      batchSize: 10,
      interBatchDelayMs: 0,
    });
    expect(report.processed).toBe(1);
    expect(report.skipped).toBe(1);
    expect(report.updated).toBe(0);

    const stats = db.getVersionStats();
    expect(stats.missingQwen3).toBe(1);
  });

  it('throttles between batches when interBatchDelayMs > 0', async () => {
    const expectedDim = 4;
    const mock = new MockEmbeddingClient(expectedDim);
    db = new VectorDB({
      path: dbPath,
      dimension: expectedDim,
      logger,
      embeddingClient: asEmbeddingClient(mock),
      expectedQwen3Dim: expectedDim,
    });
    await db.initialize();

    mock.available = false;
    for (let i = 0; i < 5; i++) {
      await db.indexFile(`/f${i}.ts`, `content number ${i}`);
    }

    mock.available = true;
    const start = Date.now();
    const report = await db.backfillQwen3({
      batchSize: 2,
      interBatchDelayMs: 50,
    });
    const elapsed = Date.now() - start;

    expect(report.updated).toBe(5);
    // 3 batches of size 2/2/1 with 2 inter-batch sleeps of 50 ms each
    // → at least ~100 ms elapsed.
    expect(elapsed).toBeGreaterThanOrEqual(80);
  });

  it('returns no-op report when embeddingClient missing', async () => {
    const expectedDim = 4;
    db = new VectorDB({
      path: dbPath,
      dimension: expectedDim,
      logger,
      expectedQwen3Dim: expectedDim,
    });
    await db.initialize();

    const report = await db.backfillQwen3();
    expect(report.processed).toBe(0);
    expect(report.updated).toBe(0);
    expect(report.aborted).toBe(false);
  });
});

// ── Version invalidation ─────────────────────────────────────────────

describe('VectorDB M12 — version invalidation', () => {
  it('drops qwen3 columns whose version differs from current', async () => {
    const expectedDim = 4;
    const mock = new MockEmbeddingClient(expectedDim);
    mock.version = 'safetensors:Qwen3:4';

    db = new VectorDB({
      path: dbPath,
      dimension: expectedDim,
      logger,
      embeddingClient: asEmbeddingClient(mock),
      expectedQwen3Dim: expectedDim,
    });
    await db.initialize();

    await db.indexFile('/a.ts', 'auth token jwt bearer');
    await db.indexFile('/b.ts', 'cache layer redis ttl');

    let stats = db.getVersionStats();
    expect(stats.withQwen3).toBe(2);
    expect(stats.versions['safetensors:Qwen3:4']).toBe(2);

    // Producer flips backend (e.g., gguf rebuild) → invalidate stale rows.
    const dropped = db.invalidateStaleVersion('gguf:Qwen3:4');
    expect(dropped).toBe(2);

    stats = db.getVersionStats();
    expect(stats.withQwen3).toBe(0);
    expect(stats.missingQwen3).toBe(2);
  });

  it('keeps qwen3 columns whose version matches', async () => {
    const expectedDim = 4;
    const mock = new MockEmbeddingClient(expectedDim);
    mock.version = 'safetensors:Qwen3:4';
    db = new VectorDB({
      path: dbPath,
      dimension: expectedDim,
      logger,
      embeddingClient: asEmbeddingClient(mock),
      expectedQwen3Dim: expectedDim,
    });
    await db.initialize();

    await db.indexFile('/a.ts', 'auth token');
    const dropped = db.invalidateStaleVersion('safetensors:Qwen3:4');
    expect(dropped).toBe(0);

    const stats = db.getVersionStats();
    expect(stats.withQwen3).toBe(1);
  });
});

// ── Legacy JSON migration ────────────────────────────────────────────

describe('VectorDB M12 — legacy JSON migration', () => {
  it('consolidates a legacy .jcf-vector-db.json into SQLite on first boot', async () => {
    const expectedDim = 4;
    const legacyPath = path.join(tmpDir, 'legacy-vdb.json');
    const legacyBlob = {
      index: {
        '/foo.ts': {
          path: '/foo.ts',
          vector: [0.5, 0.5, 0.5, 0.5],
          terms: { foo: 1, bar: 2 },
          ngrams: { foo_bar: 1 },
          content: 'foo bar baz',
          indexedAt: 1000,
          qwen3Vector: new Array(expectedDim).fill(0.1),
        },
        '/bar.ts': {
          path: '/bar.ts',
          vector: [0, 1, 0, 0],
          terms: { hello: 1 },
          ngrams: {},
          content: 'hello world',
          indexedAt: 2000,
          // No qwen3Vector — should land as NULL.
        },
      },
      documentFrequencies: { foo: 1, bar: 1, hello: 1 },
      totalDocuments: 2,
    };
    await fs.writeFile(legacyPath, JSON.stringify(legacyBlob), 'utf-8');

    db = new VectorDB({
      path: legacyPath,
      dimension: expectedDim,
      logger,
      expectedQwen3Dim: expectedDim,
    });
    await db.initialize();

    const stats = db.getVersionStats();
    expect(stats.total).toBe(2);
    // /foo.ts had a qwen3Vector → migrated; /bar.ts didn't → still null.
    expect(stats.withQwen3).toBe(1);
    expect(stats.missingQwen3).toBe(1);

    const generalStats = db.getStats();
    expect(generalStats.indexedFiles).toBe(2);
    expect(generalStats.totalDocuments).toBe(2);
    expect(generalStats.uniqueTerms).toBe(3);

    // Backup file written next to original.
    const tmpEntries = await fs.readdir(tmpDir);
    expect(tmpEntries.some((f) => f.includes('legacy-vdb.json.backup-'))).toBe(true);
    // Original `.json` removed.
    expect(tmpEntries.includes('legacy-vdb.json')).toBe(false);
    // SQLite file exists.
    expect(tmpEntries.includes('legacy-vdb.sqlite')).toBe(true);
  });

  it('is idempotent — second initialize does not re-migrate', async () => {
    const expectedDim = 4;
    const legacyPath = path.join(tmpDir, 'legacy-idempotent.json');
    await fs.writeFile(
      legacyPath,
      JSON.stringify({
        index: {
          '/a.ts': {
            path: '/a.ts',
            vector: [1, 0, 0, 0],
            terms: { foo: 1 },
            ngrams: {},
            content: 'foo',
            indexedAt: 1,
          },
        },
        documentFrequencies: { foo: 1 },
        totalDocuments: 1,
      })
    );

    db = new VectorDB({
      path: legacyPath,
      dimension: expectedDim,
      logger,
      expectedQwen3Dim: expectedDim,
    });
    await db.initialize();
    expect(db.getStats().indexedFiles).toBe(1);
    db.close();

    // Second init — JSON already moved to .backup, should be a no-op.
    db = new VectorDB({
      path: legacyPath,
      dimension: expectedDim,
      logger,
      expectedQwen3Dim: expectedDim,
    });
    await db.initialize();
    expect(db.getStats().indexedFiles).toBe(1);
  });

  it('preserves tf-idf cosine similarity post-migration', async () => {
    const expectedDim = 4;
    const legacyPath = path.join(tmpDir, 'legacy-search.json');
    // Hand-craft normalised vectors so tf-idf cosine is predictable.
    const vec = (i: number) => {
      const v = new Array(expectedDim).fill(0);
      v[i] = 1; // unit basis vector
      return v;
    };
    await fs.writeFile(
      legacyPath,
      JSON.stringify({
        index: {
          '/auth.ts': {
            path: '/auth.ts',
            vector: vec(0),
            terms: { authentication: 1, token: 1 },
            ngrams: {},
            content: 'authentication token',
            indexedAt: 1,
          },
          '/cache.ts': {
            path: '/cache.ts',
            vector: vec(1),
            terms: { cache: 1, redis: 1 },
            ngrams: {},
            content: 'cache redis',
            indexedAt: 2,
          },
        },
        documentFrequencies: { authentication: 1, token: 1, cache: 1, redis: 1 },
        totalDocuments: 2,
      })
    );

    db = new VectorDB({
      path: legacyPath,
      dimension: expectedDim,
      logger,
      expectedQwen3Dim: expectedDim,
    });
    await db.initialize();

    const results = db.search('authentication token', 5, 0);
    expect(results.length).toBeGreaterThan(0);
    // /auth.ts has the matching terms → must rank ahead of /cache.ts.
    expect(results[0].path).toBe('/auth.ts');
  });
});

// ── getVersionStats ──────────────────────────────────────────────────

describe('VectorDB M12 — getVersionStats', () => {
  it('returns zero counts for an empty store', async () => {
    db = new VectorDB({
      path: dbPath,
      dimension: 4,
      logger,
      expectedQwen3Dim: 4,
    });
    await db.initialize();
    const stats = db.getVersionStats();
    expect(stats.total).toBe(0);
    expect(stats.withQwen3).toBe(0);
    expect(stats.missingQwen3).toBe(0);
    expect(stats.versions).toEqual({});
  });

  it('groups counts by version when multiple versions present', async () => {
    const expectedDim = 4;
    const storage = new VectorStorage({ path: dbPath, logger });
    await storage.initialize();
    storage.upsertVector({
      path: '/v1.ts',
      tfidf_vector: [1, 0, 0, 0],
      terms: new Map(),
      ngrams: new Map(),
      qwen3_vector: [1, 0, 0, 0],
      qwen3_dim: expectedDim,
      qwen3_version: 'safetensors:Qwen3:4',
      content_snippet: '',
      indexed_at: 1,
    });
    storage.upsertVector({
      path: '/v2.ts',
      tfidf_vector: [0, 1, 0, 0],
      terms: new Map(),
      ngrams: new Map(),
      qwen3_vector: [0, 1, 0, 0],
      qwen3_dim: expectedDim,
      qwen3_version: 'gguf:Qwen3:4',
      content_snippet: '',
      indexed_at: 2,
    });
    storage.adjustTotalDocuments(2);
    storage.close();

    db = new VectorDB({
      path: dbPath,
      dimension: expectedDim,
      logger,
      expectedQwen3Dim: expectedDim,
    });
    await db.initialize();
    const stats = db.getVersionStats();
    expect(stats.total).toBe(2);
    expect(stats.withQwen3).toBe(2);
    expect(stats.versions['safetensors:Qwen3:4']).toBe(1);
    expect(stats.versions['gguf:Qwen3:4']).toBe(1);
  });
});
