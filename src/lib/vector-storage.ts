/**
 * VectorStorage — SQLite-backed persistence for {@link VectorDB}.
 *
 * Introduced in M12 audit (ADR-006). Replaces the JSON-blob
 * storage path with three indexed SQLite tables backed by `better-sqlite3`:
 *
 *   - **handling_vectors**            — one row per indexed file, holds the
 *     tf-idf hash vector (Float32Array BLOB), the optional Qwen3 1024-dim
 *     vector (Float32Array BLOB) with version + dim fields for validation,
 *     a JSON-serialised term + ngram frequency map, content snippet, and
 *     the indexed timestamp.
 *   - **handling_term_frequencies**   — single source of truth for tf-idf
 *     idf calculation. Per-term `doc_freq` decoupled from the vectors
 *     table so re-indexing one file updates only the affected rows.
 *   - **handling_meta**               — schema_version, migration markers,
 *     totalDocuments counter (mirrors the legacy JSON `totalDocuments`
 *     so callers can probe size cheaply without `SELECT COUNT(*)`).
 *
 * Key wins vs. JSON storage:
 *
 *   - O(1) row reads (prepared statements + indexed lookups) vs. O(n) Map
 *     reconstruction at boot.
 *   - Atomic writes (single transaction) — no partial-write hazard from
 *     SIGINT mid-save that the legacy debounced rewrite suffered.
 *   - Native dim validation column (`qwen3_dim`) — silent length-mismatch
 *     dropouts the M12 audit identified are now an EXPLICIT branch that
 *     drops the row + logs a warning at load time.
 *   - Versioned `qwen3_version` column — when the producer's
 *     ``embedding_version`` flips (backend swap, model upgrade, dim
 *     change), one indexed query identifies every stale row for backfill.
 *   - Crash-safe via SQLite WAL — power loss mid-write rolls back.
 *
 * Backwards compatibility: the previous JSON file is detected on first
 * boot via {@link maybeMigrateFromLegacy} and consolidated into the
 * three tables in a single transaction. Original JSON is preserved as a
 * timestamped backup so a human can roll back if needed.
 */

import fs from "fs/promises";
import path from "path";
import SQLite, { type Database as SqliteDB, type Statement } from "better-sqlite3";
import { Logger } from "./logger.js";

/**
 * Parsed shape of a single row in `handling_vectors` when projected back
 * into the in-memory representation expected by {@link VectorDB}.
 *
 * BLOB columns are decoded into `number[]` for consistency with the
 * legacy JSON contract; vector-db's algorithms operate on `number[]`
 * everywhere and would otherwise need to be touched in lock-step.
 */
export interface VectorRow {
  path: string;
  tfidf_vector: number[];
  qwen3_vector: number[] | null;
  qwen3_dim: number | null;
  qwen3_version: string | null;
  terms: Map<string, number>;
  ngrams: Map<string, number>;
  content_snippet: string;
  indexed_at: number;
}

/**
 * Constructor configuration for {@link VectorStorage}. Mirrors the
 * legacy {@link VectorDB} options so the migration is invisible to
 * `server.ts` apart from the path now being a `.sqlite` file (or
 * `:memory:` for tests).
 */
export interface VectorStorageConfig {
  /** SQLite file path. Use `:memory:` for tests. Legacy `.json` paths
   *  are auto-rewritten to `.sqlite` and the `.json` content is migrated
   *  on first boot. */
  path: string;
  logger: Logger;
}

const SCHEMA_VERSION = "6";

/**
 * SQLite-backed storage for {@link VectorDB}. Owns its own better-sqlite3
 * connection (separate from {@link Database} which manages fs-metadata)
 * so the two stores can evolve independently. WAL mode permits both
 * connections to share the same file when paths align, but in practice
 * VectorStorage points at a vector-specific `.sqlite` file (the legacy
 * `.jcf-vector-db.json` path with extension swapped).
 */
export class VectorStorage {
  private readonly dbPath: string;
  private readonly originalJsonPath: string | null;
  private readonly logger: Logger;
  private db!: SqliteDB;

  // Prepared statements — initialised in `prepareStatements()`.
  private stmts!: {
    upsertVector: Statement;
    deleteVector: Statement;
    selectVector: Statement;
    selectAllVectors: Statement;
    selectMissingQwen3: Statement;
    selectStaleVersion: Statement;
    countVectors: Statement;
    truncateVectors: Statement;

    upsertTermFreq: Statement;
    decrementTermFreq: Statement;
    deleteTermFreqIfZero: Statement;
    countUniqueTerms: Statement;
    truncateTermFreqs: Statement;
    selectAllTermFreqs: Statement;

    getMeta: Statement;
    setMeta: Statement;
  };

  constructor(config: VectorStorageConfig) {
    this.logger = config.logger;
    if (config.path.endsWith(".json")) {
      // Auto-rewrite legacy JSON path to .sqlite. Original is preserved
      // for one-shot migration on first boot.
      this.originalJsonPath = config.path;
      this.dbPath = config.path.replace(/\.json$/, ".sqlite");
    } else {
      this.originalJsonPath = null;
      this.dbPath = config.path;
    }
  }

  /**
   * Open the SQLite connection, materialise the schema, prepare
   * statements, and migrate from legacy JSON if a sibling `.json` file
   * is present and the SQLite tables are empty.
   *
   * Idempotent — calling twice is safe but pointless. After this the
   * connection is held until {@link close} is called.
   */
  async initialize(): Promise<void> {
    this.logger.info("Initializing vector storage", {
      path: this.dbPath,
      migrationSource: this.originalJsonPath,
    });

    if (this.dbPath !== ":memory:") {
      await fs.mkdir(path.dirname(this.dbPath), { recursive: true });
    }

    this.db = new SQLite(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("temp_store = MEMORY");
    this.db.pragma("mmap_size = 67108864"); // 64 MB hot-page cache

    this.initSchema();
    this.prepareStatements();
    this.seedMeta();

    await this.maybeMigrateFromLegacy();
  }

  /**
   * Close the connection. After this call the instance is dead — any
   * subsequent operation throws. Idempotent.
   */
  close(): void {
    try {
      this.db?.close();
    } catch {
      /* best-effort */
    }
  }

  // ───────────────────────────────────────────────────────────────────
  // ── Schema + Statements ──
  // ───────────────────────────────────────────────────────────────────

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS handling_vectors (
        path             TEXT PRIMARY KEY,
        tfidf_vector     BLOB    NOT NULL,
        terms_json       TEXT    NOT NULL,
        ngrams_json      TEXT    NOT NULL,
        qwen3_vector     BLOB,
        qwen3_dim        INTEGER,
        qwen3_version    TEXT,
        content_snippet  TEXT    NOT NULL,
        indexed_at       INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_handling_vectors_qwen3_version
        ON handling_vectors(qwen3_version);
      CREATE INDEX IF NOT EXISTS idx_handling_vectors_qwen3_null
        ON handling_vectors(path) WHERE qwen3_vector IS NULL;

      CREATE TABLE IF NOT EXISTS handling_term_frequencies (
        term       TEXT PRIMARY KEY,
        doc_freq   INTEGER NOT NULL CHECK (doc_freq >= 0)
      );

      CREATE TABLE IF NOT EXISTS handling_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  private seedMeta(): void {
    const setIfMissing = this.db.prepare(
      "INSERT OR IGNORE INTO handling_meta (key, value) VALUES (?, ?)"
    );
    setIfMissing.run("schema_version", SCHEMA_VERSION);
    setIfMissing.run("total_documents", "0");
  }

  private prepareStatements(): void {
    this.stmts = {
      upsertVector: this.db.prepare(`
        INSERT INTO handling_vectors (
          path, tfidf_vector, terms_json, ngrams_json,
          qwen3_vector, qwen3_dim, qwen3_version,
          content_snippet, indexed_at
        ) VALUES (
          @path, @tfidf_vector, @terms_json, @ngrams_json,
          @qwen3_vector, @qwen3_dim, @qwen3_version,
          @content_snippet, @indexed_at
        )
        ON CONFLICT(path) DO UPDATE SET
          tfidf_vector    = excluded.tfidf_vector,
          terms_json      = excluded.terms_json,
          ngrams_json     = excluded.ngrams_json,
          qwen3_vector    = COALESCE(excluded.qwen3_vector, handling_vectors.qwen3_vector),
          qwen3_dim       = COALESCE(excluded.qwen3_dim, handling_vectors.qwen3_dim),
          qwen3_version   = COALESCE(excluded.qwen3_version, handling_vectors.qwen3_version),
          content_snippet = excluded.content_snippet,
          indexed_at      = excluded.indexed_at
      `),
      deleteVector: this.db.prepare("DELETE FROM handling_vectors WHERE path = ?"),
      selectVector: this.db.prepare("SELECT * FROM handling_vectors WHERE path = ?"),
      selectAllVectors: this.db.prepare("SELECT * FROM handling_vectors"),
      selectMissingQwen3: this.db.prepare(
        "SELECT * FROM handling_vectors WHERE qwen3_vector IS NULL ORDER BY indexed_at ASC"
      ),
      selectStaleVersion: this.db.prepare(
        "SELECT * FROM handling_vectors WHERE qwen3_version IS NOT NULL AND qwen3_version != ? ORDER BY indexed_at ASC"
      ),
      countVectors: this.db.prepare(
        "SELECT COUNT(*) AS n FROM handling_vectors"
      ),
      truncateVectors: this.db.prepare("DELETE FROM handling_vectors"),

      upsertTermFreq: this.db.prepare(`
        INSERT INTO handling_term_frequencies (term, doc_freq)
        VALUES (@term, @doc_freq)
        ON CONFLICT(term) DO UPDATE SET doc_freq = handling_term_frequencies.doc_freq + @delta
      `),
      decrementTermFreq: this.db.prepare(
        "UPDATE handling_term_frequencies SET doc_freq = doc_freq - 1 WHERE term = ? AND doc_freq > 0"
      ),
      deleteTermFreqIfZero: this.db.prepare(
        "DELETE FROM handling_term_frequencies WHERE term = ? AND doc_freq <= 0"
      ),
      countUniqueTerms: this.db.prepare(
        "SELECT COUNT(*) AS n FROM handling_term_frequencies"
      ),
      truncateTermFreqs: this.db.prepare(
        "DELETE FROM handling_term_frequencies"
      ),
      selectAllTermFreqs: this.db.prepare(
        "SELECT term, doc_freq FROM handling_term_frequencies"
      ),

      getMeta: this.db.prepare(
        "SELECT value FROM handling_meta WHERE key = ?"
      ),
      setMeta: this.db.prepare(
        "INSERT INTO handling_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ),
    };
  }

  // ───────────────────────────────────────────────────────────────────
  // ── Public API consumed by VectorDB ──
  // ───────────────────────────────────────────────────────────────────

  /** Total indexed documents (denormalised counter, kept in lock-step
   *  with `handling_vectors` row count via {@link adjustTotalDocuments}). */
  getTotalDocuments(): number {
    const row = this.stmts.getMeta.get("total_documents") as
      | { value: string }
      | undefined;
    return row ? parseInt(row.value, 10) || 0 : 0;
  }

  setTotalDocuments(n: number): void {
    this.stmts.setMeta.run("total_documents", String(Math.max(0, n)));
  }

  adjustTotalDocuments(delta: number): void {
    this.setTotalDocuments(this.getTotalDocuments() + delta);
  }

  countVectors(): number {
    const row = this.stmts.countVectors.get() as { n: number };
    return row.n;
  }

  countUniqueTerms(): number {
    const row = this.stmts.countUniqueTerms.get() as { n: number };
    return row.n;
  }

  /**
   * Read a single row by path. Returns `null` when missing.
   * Decodes BLOB columns into `number[]` and `terms_json` / `ngrams_json`
   * into `Map<string, number>` for direct use by {@link VectorDB}.
   */
  getVector(filePath: string): VectorRow | null {
    const row = this.stmts.selectVector.get(filePath) as
      | RawVectorRow
      | undefined;
    return row ? this.rowToVector(row) : null;
  }

  /**
   * Stream every row without materialising the whole set. Used by
   * {@link VectorDB.searchHybrid} which needs to compute cosine
   * similarity against every stored qwen3 vector.
   *
   * Note: this returns the full result eagerly — better-sqlite3 doesn't
   * expose a cursor API in TypeScript. For corpora > 100k rows we'd
   * pivot to FTS-style ranking; until then this is a flat scan.
   */
  getAllVectors(): VectorRow[] {
    const rows = this.stmts.selectAllVectors.all() as RawVectorRow[];
    return rows.map((r) => this.rowToVector(r));
  }

  /** Rows whose `qwen3_vector` is NULL — backfill candidates. */
  getMissingQwen3(): VectorRow[] {
    const rows = this.stmts.selectMissingQwen3.all() as RawVectorRow[];
    return rows.map((r) => this.rowToVector(r));
  }

  /** Rows whose `qwen3_version` differs from the currently-pinned
   *  producer fingerprint — rebuild candidates after a backend swap. */
  getStaleVersion(currentVersion: string): VectorRow[] {
    const rows = this.stmts.selectStaleVersion.all(
      currentVersion
    ) as RawVectorRow[];
    return rows.map((r) => this.rowToVector(r));
  }

  /**
   * Persist a row. The `ON CONFLICT(path)` clause does an upsert that
   * preserves the existing `qwen3_vector` when the new row only carries
   * a tf-idf vector — this is the legitimate "tf-idf-fast-path,
   * Qwen3-backfill-later" sequence the M12 audit demanded.
   */
  upsertVector(row: VectorRow): void {
    this.stmts.upsertVector.run({
      path: row.path,
      tfidf_vector: this.encodeBuffer(row.tfidf_vector),
      terms_json: this.encodeMap(row.terms),
      ngrams_json: this.encodeMap(row.ngrams),
      qwen3_vector: row.qwen3_vector
        ? this.encodeBuffer(row.qwen3_vector)
        : null,
      qwen3_dim: row.qwen3_dim,
      qwen3_version: row.qwen3_version,
      content_snippet: row.content_snippet,
      indexed_at: row.indexed_at,
    });
  }

  /**
   * Update only the qwen3 columns for an existing path. Used by the
   * backfill loop where the row already carries tf-idf data.
   */
  updateQwen3(
    filePath: string,
    qwen3Vector: number[],
    qwen3Version: string
  ): void {
    const stmt = this.db.prepare(`
      UPDATE handling_vectors
      SET qwen3_vector = @qwen3_vector,
          qwen3_dim    = @qwen3_dim,
          qwen3_version = @qwen3_version
      WHERE path = @path
    `);
    stmt.run({
      path: filePath,
      qwen3_vector: this.encodeBuffer(qwen3Vector),
      qwen3_dim: qwen3Vector.length,
      qwen3_version: qwen3Version,
    });
  }

  /** Drop the qwen3 column for every row whose `qwen3_version` does
   *  not match `currentVersion`. Used when the producer flips backends:
   *  the next backfill cycle will repopulate from the new model. */
  invalidateStaleQwen3(currentVersion: string): number {
    const stmt = this.db.prepare(`
      UPDATE handling_vectors
      SET qwen3_vector = NULL, qwen3_dim = NULL, qwen3_version = NULL
      WHERE qwen3_version IS NOT NULL AND qwen3_version != ?
    `);
    const info = stmt.run(currentVersion);
    return info.changes;
  }

  /** Drop the qwen3 column for a specific row. Used by the boot-time
   *  dim-validation sweep to nuke vectors whose stored length does not
   *  match the expected producer dim — the M12 audit fix for silent
   *  length-mismatch dropouts that previously zeroed cosine sim. */
  dropQwen3(filePath: string): void {
    const stmt = this.db.prepare(`
      UPDATE handling_vectors
      SET qwen3_vector = NULL, qwen3_dim = NULL, qwen3_version = NULL
      WHERE path = ?
    `);
    stmt.run(filePath);
  }

  deleteVector(filePath: string): void {
    this.stmts.deleteVector.run(filePath);
  }

  /** Atomic clear of all three tables. Used by `VectorDB.clear()` and
   *  by the self-healing recovery path. */
  truncateAll(): void {
    const tx = this.db.transaction(() => {
      this.stmts.truncateVectors.run();
      this.stmts.truncateTermFreqs.run();
      this.setTotalDocuments(0);
    });
    tx();
  }

  /**
   * Adjust per-term `doc_freq` by `delta` (positive on new term in a
   * document, negative on stale term removal). Auto-deletes rows that
   * decay to zero so unique-term counts stay accurate.
   */
  adjustTermFreq(term: string, delta: number): void {
    if (delta > 0) {
      this.stmts.upsertTermFreq.run({ term, doc_freq: delta, delta });
    } else if (delta < 0) {
      // SQLite doesn't have a single-statement "decrement and prune at zero"
      // primitive — split into two ops inside an implicit transaction.
      for (let i = 0; i < -delta; i++) {
        this.stmts.decrementTermFreq.run(term);
      }
      this.stmts.deleteTermFreqIfZero.run(term);
    }
  }

  /** Bulk re-write of the term frequency table. Used by the legacy JSON
   *  migration path so the import is one transaction. */
  setAllTermFreqs(freqs: Map<string, number>): void {
    const tx = this.db.transaction(() => {
      this.stmts.truncateTermFreqs.run();
      const insert = this.db.prepare(
        "INSERT INTO handling_term_frequencies (term, doc_freq) VALUES (?, ?)"
      );
      for (const [term, freq] of freqs) {
        if (freq > 0) insert.run(term, freq);
      }
    });
    tx();
  }

  /** Snapshot of the term frequency table — only used in tests + the
   *  legacy migration path. Not on the hot path. */
  getAllTermFreqs(): Map<string, number> {
    const rows = this.stmts.selectAllTermFreqs.all() as Array<{
      term: string;
      doc_freq: number;
    }>;
    const result = new Map<string, number>();
    for (const row of rows) result.set(row.term, row.doc_freq);
    return result;
  }

  /** Run an arbitrary callback inside a SQLite transaction. Exposed for
   *  callers (e.g. {@link VectorDB.indexFilesBatch}) that need to atomically
   *  upsert many rows. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ───────────────────────────────────────────────────────────────────
  // ── Encoding helpers ──
  // ───────────────────────────────────────────────────────────────────

  private encodeBuffer(vec: number[]): Buffer {
    // Float32Array.buffer is the canonical compact wire format for
    // embedding vectors — matches the `framework_sections.embedding`
    // shape used by jcf-memory.
    const arr = Float32Array.from(vec);
    return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
  }

  private decodeBuffer(buf: Buffer | null): number[] | null {
    if (!buf) return null;
    // Buffer view may not start at offset 0 — use byteOffset/byteLength
    // explicitly so a sliced Buffer still decodes correctly.
    const arr = new Float32Array(
      buf.buffer,
      buf.byteOffset,
      buf.byteLength / 4
    );
    return Array.from(arr);
  }

  private encodeMap(m: Map<string, number>): string {
    return JSON.stringify(Object.fromEntries(m));
  }

  private decodeMap(s: string | null | undefined): Map<string, number> {
    if (!s) return new Map();
    try {
      return new Map(Object.entries(JSON.parse(s) as Record<string, number>));
    } catch {
      return new Map();
    }
  }

  private rowToVector(row: RawVectorRow): VectorRow {
    return {
      path: row.path,
      tfidf_vector: this.decodeBuffer(row.tfidf_vector) ?? [],
      qwen3_vector: this.decodeBuffer(row.qwen3_vector),
      qwen3_dim: row.qwen3_dim ?? null,
      qwen3_version: row.qwen3_version ?? null,
      terms: this.decodeMap(row.terms_json),
      ngrams: this.decodeMap(row.ngrams_json),
      content_snippet: row.content_snippet ?? "",
      indexed_at: row.indexed_at ?? 0,
    };
  }

  // ───────────────────────────────────────────────────────────────────
  // ── Legacy JSON migration (one-shot) ──
  // ───────────────────────────────────────────────────────────────────

  /**
   * If the constructor was given a `.json` path, attempt to migrate the
   * legacy blob into the new tables. Skips when the SQLite file already
   * has rows (idempotent) or when the JSON file is missing.
   *
   * The original JSON is renamed to `<path>.backup-<ts>` after a
   * successful migration so a human can restore it manually if needed
   * — the agent never re-imports from the backup.
   */
  private async maybeMigrateFromLegacy(): Promise<void> {
    if (!this.originalJsonPath) return;
    if (this.countVectors() > 0) return;

    let raw: string;
    try {
      raw = await fs.readFile(this.originalJsonPath, "utf-8");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") {
        this.logger.warn("Legacy JSON read failed; migration skipped", {
          path: this.originalJsonPath,
          error: String(err),
        });
      }
      return;
    }

    let parsed: LegacyVectorDB;
    try {
      parsed = JSON.parse(raw) as LegacyVectorDB;
    } catch (err) {
      this.logger.warn("Legacy JSON parse failed; migration skipped", {
        path: this.originalJsonPath,
        error: String(err),
      });
      return;
    }

    const indexEntries = Object.entries(parsed.index ?? {});
    const documentFrequencies = parsed.documentFrequencies ?? {};
    const totalDocuments = parsed.totalDocuments ?? indexEntries.length;

    this.logger.info("Migrating legacy JSON vector-db", {
      source: this.originalJsonPath,
      entries: indexEntries.length,
      uniqueTerms: Object.keys(documentFrequencies).length,
    });

    const tx = this.db.transaction(() => {
      for (const [filePath, entryRaw] of indexEntries) {
        const entry = entryRaw as LegacyVectorEntry;
        const tfidf = Array.isArray(entry.vector) ? entry.vector : [];
        const qwen3 =
          Array.isArray(entry.qwen3Vector) && entry.qwen3Vector.length > 0
            ? entry.qwen3Vector
            : null;
        this.upsertVector({
          path: entry.path ?? filePath,
          tfidf_vector: tfidf,
          terms: new Map(Object.entries(entry.terms ?? {})),
          ngrams: new Map(Object.entries(entry.ngrams ?? {})),
          qwen3_vector: qwen3,
          // qwen3_dim and qwen3_version stay NULL until the backfill
          // pass validates length against the live producer fingerprint.
          // This is the M12 audit fix for silent length-mismatch
          // dropouts: legacy vectors enter the new store WITHOUT a
          // version stamp and are treated as untrusted until validated.
          qwen3_dim: qwen3 ? qwen3.length : null,
          qwen3_version: null,
          content_snippet: entry.content ?? "",
          indexed_at: entry.indexedAt ?? Date.now(),
        });
      }

      const freqMap = new Map<string, number>();
      for (const [term, df] of Object.entries(documentFrequencies)) {
        if (typeof df === "number" && df > 0) freqMap.set(term, df);
      }
      this.setAllTermFreqs(freqMap);
      this.setTotalDocuments(totalDocuments);
      this.stmts.setMeta.run(
        "migrated_from_json_at",
        new Date().toISOString()
      );
      this.stmts.setMeta.run(
        "migrated_from_json_path",
        this.originalJsonPath as string
      );
    });

    try {
      tx();
    } catch (err) {
      this.logger.error(
        "Legacy JSON migration transaction failed",
        err instanceof Error ? err : new Error(String(err))
      );
      throw err;
    }

    const backupPath = `${this.originalJsonPath}.backup-${Date.now()}`;
    try {
      await fs.rename(this.originalJsonPath, backupPath);
      this.logger.info("Legacy JSON migration complete; backup preserved", {
        backup: backupPath,
        totalDocuments,
      });
    } catch (err) {
      this.logger.warn("Legacy JSON backup rename failed", {
        path: this.originalJsonPath,
        error: String(err),
      });
    }
  }
}

// ── Internal types ───────────────────────────────────────────────────

interface RawVectorRow {
  path: string;
  tfidf_vector: Buffer;
  terms_json: string;
  ngrams_json: string;
  qwen3_vector: Buffer | null;
  qwen3_dim: number | null;
  qwen3_version: string | null;
  content_snippet: string;
  indexed_at: number;
}

/** Shape of the legacy `.jcf-vector-db.json` blob — defensively typed
 *  because the file may have been written by an older revision. */
interface LegacyVectorDB {
  index?: Record<string, LegacyVectorEntry>;
  documentFrequencies?: Record<string, number>;
  totalDocuments?: number;
}

interface LegacyVectorEntry {
  path?: string;
  vector?: number[];
  qwen3Vector?: number[];
  terms?: Record<string, number>;
  ngrams?: Record<string, number>;
  content?: string;
  indexedAt?: number;
}
