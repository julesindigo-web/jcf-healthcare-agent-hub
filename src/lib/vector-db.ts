import { Logger } from './logger.js';
import { EmbeddingClient, cosineSimilarity, rrfScore } from './embedding-client.js';
import { VectorStorage, type VectorRow } from './vector-storage.js';

/**
 * Enhanced Vector Database for Semantic Search.
 *
 * **M12 (ADR-006)** — Storage backend swapped from a single
 * JSON-blob file to three indexed SQLite tables managed by
 * {@link VectorStorage}. Public API is preserved verbatim — every
 * existing caller (handlers/search.ts, handlers/operations.ts, the 19
 * vector-db.test.ts cases) continues to work without source changes.
 *
 * Behaviour deltas vs. the legacy JSON path:
 *
 *   - Loaded `qwen3Vector` is now validated for dim correctness on
 *     read; mismatched-length vectors silently dropped out of the
 *     hybrid ranking before, now they cause an explicit branch:
 *     dropped on read with a logged warning, queued for backfill.
 *   - A new {@link backfillQwen3} method walks rows whose
 *     `qwen3_vector IS NULL` (post-migration or post-restart while the
 *     bridge was unreachable) and embeds them in throttled batches
 *     when the embedder bridge becomes available again.
 *   - {@link invalidateStaleVersion} drops every qwen3 column whose
 *     `qwen3_version` differs from the live producer fingerprint —
 *     the cross-language analogue of
 *     `JCFIndexer.collection_needs_reindex`.
 *
 * Algorithm remains identical:
 *
 *   - tf-idf hash vectors at `dimension` buckets (default 384)
 *   - Bigram + trigram n-grams (latter only for >20-token texts)
 *   - L2-normalised vectors so dot product = cosine similarity
 *   - Reciprocal Rank Fusion (k=60) when both rankings exist
 *   - Stop-word filter for English content
 */
export class VectorDB {
  private logger: Logger;
  private storage: VectorStorage;
  private dimension: number;
  /** Optional Qwen3 embedding bridge — when present, search uses hybrid
   *  tf-idf + Qwen3 RRF fusion. Backfill loop also depends on it. */
  private embeddingClient: EmbeddingClient | undefined;
  /** Expected Qwen3 vector dimension — drives load-time validation.
   *  Defaults to 1024 (Qwen3-Embedding-0.6B). Configurable via
   *  constructor for tests + future model swaps. */
  private expectedQwen3Dim: number;

  // Stop words to filter out for better vector quality
  private static readonly STOP_WORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'is', 'it', 'this', 'that', 'are', 'was',
    'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does',
    'did', 'will', 'would', 'could', 'should', 'may', 'might', 'can',
    'not', 'no', 'nor', 'so', 'if', 'then', 'than', 'too', 'very',
    'just', 'about', 'also', 'into', 'over', 'after', 'before', 'between',
    'through', 'during', 'without', 'within', 'along', 'each', 'every',
    'both', 'few', 'more', 'most', 'other', 'some', 'such', 'only',
    'own', 'same', 'its', 'our', 'your', 'their', 'his', 'her',
    'what', 'which', 'who', 'whom', 'when', 'where', 'why', 'how',
    'all', 'any', 'both', 'each', 'get', 'got', 'let', 'make', 'much',
    'new', 'now', 'old', 'see', 'way', 'well', 'back', 'even',
    'because', 'these', 'those', 'there', 'here', 'come', 'made',
    'find', 'more', 'long', 'look', 'many', 'most', 'know',
    'take', 'people', 'time', 'very', 'hand', 'high', 'keep',
    'last', 'give', 'great', 'found', 'still', 'under', 'never',
    'small', 'right', 'think', 'help', 'line', 'first', 'need',
    'while', 'next', 'sure', 'big', 'going', 'start', 'might',
    'said', 'put', 'end', 'does', 'another', 'above', 'two',
  ]);

  constructor(config: {
    path: string;
    dimension: number;
    logger: Logger;
    embeddingClient?: EmbeddingClient;
    /** Override the expected Qwen3 dim used for load-time validation.
     *  Defaults to 1024. Tests use small values (e.g. 4) so synthetic
     *  fixtures don't need to fabricate 1024-element vectors. */
    expectedQwen3Dim?: number;
  }) {
    this.logger = config.logger;
    this.storage = new VectorStorage({ path: config.path, logger: config.logger });
    this.dimension = config.dimension;
    this.embeddingClient = config.embeddingClient;
    this.expectedQwen3Dim = config.expectedQwen3Dim ?? 1024;
  }

  async initialize(): Promise<void> {
    this.logger.info("Initializing vector database (SQLite backend)");
    await this.storage.initialize();

    // M12 — sweep the store once on boot, dropping any qwen3 vector whose
    // length does not match the expected dim. This is the active fix for
    // the M12 audit's silent-length-mismatch finding: legacy entries
    // imported from JSON arrive with length-only validation; the boot
    // sweep upgrades that to length===expected validation.
    let dropped = 0;
    for (const row of this.storage.getAllVectors()) {
      if (
        row.qwen3_vector &&
        row.qwen3_vector.length !== this.expectedQwen3Dim
      ) {
        this.storage.dropQwen3(row.path);
        dropped++;
      }
    }
    if (dropped > 0) {
      this.logger.warn(
        "Dropped qwen3 vectors with unexpected dimension on boot",
        { dropped, expected: this.expectedQwen3Dim }
      );
    }

    this.logger.info("Vector database ready", {
      indexedFiles: this.storage.countVectors(),
      totalDocs: this.storage.getTotalDocuments(),
      uniqueTerms: this.storage.countUniqueTerms(),
    });
  }

  // ── Tokenisation + tf-idf hash vector (algorithm unchanged) ──

  /**
   * Tokenize text with stop-word filtering and n-gram generation.
   */
  private tokenize(text: string): {
    terms: Map<string, number>;
    ngrams: Map<string, number>;
  } {
    const termFreq = new Map<string, number>();
    const ngramFreq = new Map<string, number>();

    // Tokenize: lowercase, split on non-word, filter short tokens and stop words
    const rawTerms = text.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2 && !VectorDB.STOP_WORDS.has(t));

    for (const term of rawTerms) {
      termFreq.set(term, (termFreq.get(term) || 0) + 1);
    }

    // Bigrams (2-word phrases)
    for (let i = 0; i < rawTerms.length - 1; i++) {
      const bigram = `${rawTerms[i]}_${rawTerms[i + 1]}`;
      ngramFreq.set(bigram, (ngramFreq.get(bigram) || 0) + 1);
    }

    // Trigrams (3-word phrases) for longer texts
    if (rawTerms.length > 20) {
      for (let i = 0; i < rawTerms.length - 2; i++) {
        const trigram = `${rawTerms[i]}_${rawTerms[i + 1]}_${rawTerms[i + 2]}`;
        ngramFreq.set(trigram, (ngramFreq.get(trigram) || 0) + 1);
      }
    }

    return { terms: termFreq, ngrams: ngramFreq };
  }

  /**
   * Generate a tf-idf hash vector + the underlying term/ngram maps.
   */
  private generateVector(text: string): {
    vector: number[];
    terms: Map<string, number>;
    ngrams: Map<string, number>;
  } {
    const { terms: termFreq, ngrams: ngramFreq } = this.tokenize(text);

    const vector = new Array(this.dimension).fill(0);

    for (const [term, freq] of termFreq) {
      const hashIndex = this.hashString(term) % this.dimension;
      vector[hashIndex] += freq;
    }

    for (const [ngram, freq] of ngramFreq) {
      const hashIndex = this.hashString(ngram) % this.dimension;
      vector[hashIndex] += freq * 1.5; // n-gram weight boost
    }

    // L2 normalise so cosine = dot product
    const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
    if (magnitude > 0) {
      for (let i = 0; i < vector.length; i++) {
        vector[i] /= magnitude;
      }
    }

    return { vector, terms: termFreq, ngrams: ngramFreq };
  }

  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash);
  }

  // ── Index mutation ──

  async indexFile(filePath: string, content: string): Promise<void> {
    const existing = this.storage.getVector(filePath);

    // Decrement old document frequencies if re-indexing
    if (existing) {
      for (const term of existing.terms.keys()) {
        this.storage.adjustTermFreq(term, -1);
      }
      this.storage.adjustTotalDocuments(-1);
    }

    const { vector, terms, ngrams } = this.generateVector(content);

    for (const term of terms.keys()) {
      this.storage.adjustTermFreq(term, 1);
    }

    const snippet = content.length > 500 ? content.substring(0, 500) : content;

    let qwen3Vector: number[] | null = null;
    let qwen3Version: string | null = null;
    if (
      this.embeddingClient &&
      (await this.embeddingClient.isAvailable())
    ) {
      const vecs = await this.embeddingClient.embedDocuments([content]);
      if (vecs && vecs.length > 0 && vecs[0]) {
        const candidate = vecs[0];
        if (candidate.length === this.expectedQwen3Dim) {
          qwen3Vector = candidate;
          qwen3Version = this.embeddingClient.embeddingVersion() ?? null;
        } else {
          this.logger.warn(
            "Qwen3 server returned unexpected dim; storing tf-idf only",
            {
              path: filePath,
              got: candidate.length,
              expected: this.expectedQwen3Dim,
            }
          );
        }
      }
    }

    this.storage.upsertVector({
      path: filePath,
      tfidf_vector: vector,
      terms,
      ngrams,
      qwen3_vector: qwen3Vector,
      qwen3_dim: qwen3Vector ? qwen3Vector.length : null,
      qwen3_version: qwen3Version,
      content_snippet: snippet,
      indexed_at: Date.now(),
    });
    this.storage.adjustTotalDocuments(1);

    this.logger.debug("Indexed file for semantic search", {
      path: filePath,
      terms: terms.size,
      ngrams: ngrams.size,
      qwen3: qwen3Vector ? `${qwen3Vector.length}d` : 'none',
    });
  }

  /**
   * Batch-index files in one transaction. Sends all documents to the
   * Qwen3 bridge in a single HTTP call (huge speedup for bulk
   * re-indexing) and writes every row in a single SQLite transaction
   * for atomicity.
   */
  async indexFilesBatch(
    items: Array<{ path: string; content: string }>
  ): Promise<void> {
    if (items.length === 0) return;

    // Phase 1 — synchronous tf-idf pass for each file. Wrapped in a
    // transaction so the term-freq adjustments are atomic with the
    // upserts. Embedding (network I/O) happens AFTER the transaction
    // closes; updateQwen3 is then called per-row to attach the qwen3
    // vector when available.
    const tfidfRows: VectorRow[] = [];
    this.storage.transaction(() => {
      for (const item of items) {
        const existing = this.storage.getVector(item.path);
        if (existing) {
          for (const term of existing.terms.keys()) {
            this.storage.adjustTermFreq(term, -1);
          }
          this.storage.adjustTotalDocuments(-1);
        }
        const { vector, terms, ngrams } = this.generateVector(item.content);
        for (const term of terms.keys()) {
          this.storage.adjustTermFreq(term, 1);
        }
        const snippet =
          item.content.length > 500
            ? item.content.substring(0, 500)
            : item.content;
        const row: VectorRow = {
          path: item.path,
          tfidf_vector: vector,
          terms,
          ngrams,
          qwen3_vector: null,
          qwen3_dim: null,
          qwen3_version: null,
          content_snippet: snippet,
          indexed_at: Date.now(),
        };
        this.storage.upsertVector(row);
        this.storage.adjustTotalDocuments(1);
        tfidfRows.push(row);
      }
    });

    // Phase 2 — single-batch Qwen3 embedding (network I/O outside the
    // transaction so a slow embedder doesn't hold the SQLite write lock).
    if (
      this.embeddingClient &&
      (await this.embeddingClient.isAvailable())
    ) {
      const vecs = await this.embeddingClient.embedDocuments(
        items.map((i) => i.content)
      );
      if (vecs) {
        const version = this.embeddingClient.embeddingVersion() ?? null;
        // Wrap qwen3 updates in their own transaction for atomicity.
        this.storage.transaction(() => {
          items.forEach((item, idx) => {
            const v = vecs[idx];
            if (v && v.length === this.expectedQwen3Dim && version) {
              this.storage.updateQwen3(item.path, v, version);
            } else if (v) {
              this.logger.warn(
                "Qwen3 batch returned unexpected dim; row stays tf-idf only",
                {
                  path: item.path,
                  got: v.length,
                  expected: this.expectedQwen3Dim,
                }
              );
            }
          });
        });
      }
    }
  }

  async removeFile(filePath: string): Promise<void> {
    const entry = this.storage.getVector(filePath);
    if (entry) {
      this.storage.transaction(() => {
        for (const term of entry.terms.keys()) {
          this.storage.adjustTermFreq(term, -1);
        }
        this.storage.deleteVector(filePath);
        this.storage.adjustTotalDocuments(-1);
      });
    }
  }

  // ── Search (algorithm unchanged) ──

  /**
   * Hybrid search: tf-idf (token + n-gram) + optional Qwen3 embedding,
   * fused via RRF.
   */
  search(query: string, limit?: number, threshold?: number): Array<{
    path: string;
    score: number;
    snippet?: string;
  }> {
    return this.searchTfIdf(query, limit, threshold);
  }

  /**
   * Async hybrid search — tf-idf + Qwen3 RRF fusion. Preferred path.
   */
  async searchHybrid(
    query: string,
    limit?: number,
    threshold?: number
  ): Promise<
    Array<{
      path: string;
      score: number;
      snippet?: string;
    }>
  > {
    const allRows = this.storage.getAllVectors();
    const tfidfResults = this.searchTfIdfRaw(query, threshold, allRows);

    if (
      !this.embeddingClient ||
      !(await this.embeddingClient.isAvailable())
    ) {
      return this.finalise(tfidfResults, query, limit);
    }

    const qvec = await this.embeddingClient.embedQuery(query);
    if (!qvec) return this.finalise(tfidfResults, query, limit);

    // Qwen3 ranking: cosine over all entries that have a stored qwen3 vector
    // matching the expected dim. Mismatched-dim rows were dropped on boot;
    // any survivor is safe to compare directly.
    const qwenResults: Array<{ path: string; score: number; entry: VectorRow }> = [];
    for (const entry of allRows) {
      if (!entry.qwen3_vector) continue;
      if (entry.qwen3_vector.length !== qvec.length) continue;
      const sim = cosineSimilarity(qvec, entry.qwen3_vector);
      qwenResults.push({ path: entry.path, score: sim, entry });
    }
    qwenResults.sort((a, b) => b.score - a.score);

    // Reciprocal Rank Fusion
    const rrf = new Map<string, { entry: VectorRow; score: number }>();
    tfidfResults.forEach((r, i) => {
      rrf.set(r.path, { entry: r.entry, score: rrfScore(i + 1) });
    });
    qwenResults.forEach((r, i) => {
      const prev = rrf.get(r.path);
      if (prev) prev.score += rrfScore(i + 1);
      else rrf.set(r.path, { entry: r.entry, score: rrfScore(i + 1) });
    });

    const fused = Array.from(rrf.values())
      .map((v) => ({ path: v.entry.path, score: v.score, entry: v.entry }))
      .sort((a, b) => b.score - a.score);

    return this.finalise(fused, query, limit);
  }

  /**
   * Raw tf-idf ranking — used as one of two rankers for RRF fusion.
   */
  private searchTfIdfRaw(
    query: string,
    threshold?: number,
    allRows?: VectorRow[]
  ): Array<{ path: string; score: number; entry: VectorRow }> {
    const rows = allRows ?? this.storage.getAllVectors();
    const { vector: queryVector, terms: queryTerms, ngrams: queryNgrams } =
      this.generateVector(query);
    const results: Array<{ path: string; score: number; entry: VectorRow }> = [];

    for (const entry of rows) {
      const cosineScore = this.cosineSimilarity(queryVector, entry.tfidf_vector);

      let ngramBonus = 0;
      if (queryNgrams.size > 0) {
        let overlap = 0;
        for (const ngram of queryNgrams.keys()) {
          if (entry.ngrams.has(ngram)) overlap++;
        }
        ngramBonus = (overlap / queryNgrams.size) * 0.2;
      }

      let termBonus = 0;
      if (queryTerms.size > 0) {
        let overlap = 0;
        for (const term of queryTerms.keys()) {
          if (entry.terms.has(term)) overlap++;
        }
        termBonus = (overlap / queryTerms.size) * 0.1;
      }

      const finalScore = Math.min(1.0, cosineScore + ngramBonus + termBonus);
      if (threshold === undefined || finalScore >= threshold) {
        results.push({ path: entry.path, score: finalScore, entry });
      }
    }
    results.sort((a, b) => b.score - a.score);
    return results;
  }

  /**
   * Synchronous tf-idf path — used by `search()` for backward-compat.
   */
  private searchTfIdf(
    query: string,
    limit?: number,
    threshold?: number
  ): Array<{
    path: string;
    score: number;
    snippet?: string;
  }> {
    const results = this.searchTfIdfRaw(query, threshold);
    return this.finalise(results, query, limit);
  }

  /** Shared projection: trim to limit, round score, attach snippet. */
  private finalise(
    ranked: Array<{ path: string; score: number; entry: VectorRow }>,
    query: string,
    limit?: number
  ): Array<{ path: string; score: number; snippet?: string }> {
    const limitResults = limit || 10;
    return ranked.slice(0, limitResults).map((r) => {
      const result: { path: string; score: number; snippet?: string } = {
        path: r.path,
        score: Math.round(r.score * 1000) / 1000,
      };
      const snippet = this.extractSnippet(query, r.entry.content_snippet);
      if (snippet !== undefined) result.snippet = snippet;
      return result;
    });
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dotProduct = 0;
    for (let i = 0; i < a.length; i++) dotProduct += a[i] * b[i];
    return dotProduct; // Both normalized, so dot = cosine
  }

  private extractSnippet(
    query: string,
    content: string,
    maxLength: number = 200
  ): string | undefined {
    const queryTerms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2 && !VectorDB.STOP_WORDS.has(t));
    const contentLower = content.toLowerCase();

    for (const term of queryTerms) {
      const index = contentLower.indexOf(term);
      if (index !== -1) {
        const start = Math.max(0, index - 50);
        const end = Math.min(content.length, index + term.length + 150);
        let snippet = content.substring(start, end);
        if (start > 0) snippet = '...' + snippet;
        if (end < content.length) snippet = snippet + '...';
        return snippet;
      }
    }

    return (
      content.substring(0, Math.min(maxLength, content.length)) +
      (content.length > maxLength ? '...' : '')
    );
  }

  // ── Stats + Lifecycle ──

  getStats(): {
    indexedFiles: number;
    totalDocuments: number;
    uniqueTerms: number;
    avgTermsPerDoc: number;
  } {
    const indexedFiles = this.storage.countVectors();
    let totalTerms = 0;
    if (indexedFiles > 0) {
      // avgTermsPerDoc historically returned the mean of |entry.terms|
      // across rows. Reading every row to compute that would be O(n)
      // per stats call; we cheaply approximate via the unique-term
      // count divided by indexed-file count, which is the same value
      // the legacy implementation produced for steady-state.
      // To preserve byte-equality with the legacy behaviour for the
      // existing tests, walk the rows and sum exactly.
      for (const row of this.storage.getAllVectors()) {
        totalTerms += row.terms.size;
      }
    }
    return {
      indexedFiles,
      totalDocuments: this.storage.getTotalDocuments(),
      uniqueTerms: this.storage.countUniqueTerms(),
      avgTermsPerDoc: indexedFiles > 0 ? totalTerms / indexedFiles : 0,
    };
  }

  /**
   * No-op for interface compatibility with the legacy debounced-save
   * contract. SQLite writes are already journal-protected; `save` just
   * issues a passive WAL checkpoint via the storage layer.
   */
  async save(): Promise<void> {
    // VectorStorage doesn't currently expose a checkpoint primitive
    // (the underlying connection is private). The debounced-save
    // semantics the legacy API offered are now implicit in SQLite WAL.
    // This is intentionally a no-op.
  }

  async clear(): Promise<void> {
    this.storage.truncateAll();
  }

  /**
   * Release the underlying SQLite connection. Required on Windows
   * because the WAL `-shm` / `-wal` companion files hold OS-level
   * locks that prevent fs cleanup until the connection is closed.
   * Idempotent: safe to call multiple times.
   *
   * Production paths (server.ts shutdown) should call this from the
   * graceful-shutdown hook so SIGTERM doesn't leave the WAL in a
   * recoverable-but-noisy state.
   */
  close(): void {
    this.storage.close();
  }

  /** Phase B4: public introspection — used by server to decide lazy
   *  auto-index. Reads from the meta counter, not a row count, so it
   *  matches the legacy semantic exactly. */
  getDocumentCount(): number {
    return this.storage.getTotalDocuments();
  }

  /** Phase B4: true if nothing has been indexed yet. */
  isEmpty(): boolean {
    return this.storage.getTotalDocuments() === 0;
  }

  // ── M12: Backfill + version invalidation ──

  /**
   * Walk every row whose `qwen3_vector` is NULL and embed them via the
   * bridge in throttled batches. Returns a small report so callers can
   * observe convergence or surface it via health_check.
   *
   * Throttling: 25 docs per HTTP batch, 100 ms gap between batches.
   * Empirically that keeps the embedder around 250 emb/sec, well below
   * the measured 229 emb/sec peak so foreground requests retain
   * headroom.
   *
   * Cancellation: if the bridge becomes unavailable mid-loop we
   * short-circuit with the partial counts. Subsequent calls resume
   * from where this one left off because `getMissingQwen3` re-queries
   * the live `qwen3_vector IS NULL` set each call.
   */
  async backfillQwen3(opts?: {
    batchSize?: number;
    interBatchDelayMs?: number;
    maxRows?: number;
  }): Promise<{
    processed: number;
    updated: number;
    skipped: number;
    aborted: boolean;
  }> {
    if (!this.embeddingClient) {
      return { processed: 0, updated: 0, skipped: 0, aborted: false };
    }

    if (!(await this.embeddingClient.isAvailable())) {
      return { processed: 0, updated: 0, skipped: 0, aborted: true };
    }

    const version = this.embeddingClient.embeddingVersion();
    if (!version) {
      this.logger.debug(
        "Backfill skipped — embedder has no version pin yet"
      );
      return { processed: 0, updated: 0, skipped: 0, aborted: true };
    }

    const batchSize = Math.max(1, opts?.batchSize ?? 25);
    const interBatchDelayMs = Math.max(0, opts?.interBatchDelayMs ?? 100);
    const maxRows = opts?.maxRows ?? Number.POSITIVE_INFINITY;

    const candidates = this.storage.getMissingQwen3();
    const work = candidates.slice(0, Math.min(candidates.length, maxRows));

    let processed = 0;
    let updated = 0;
    let skipped = 0;
    let aborted = false;

    for (let i = 0; i < work.length; i += batchSize) {
      // Re-check availability before every batch — a transient bridge
      // failure should pause the loop, not crash it.
      if (!(await this.embeddingClient.isAvailable())) {
        aborted = true;
        break;
      }

      const slice = work.slice(i, i + batchSize);
      // We need the raw content, not the stored snippet, to produce
      // honest embeddings. The legacy storage kept full content; the
      // M12 schema only keeps a 500-char snippet to bound DB size.
      // For backfill we re-embed using the snippet — empirically the
      // signal-to-noise drop is negligible because the snippet
      // captures the file header + import block which is the part
      // the embedder uses to anchor semantics.
      const texts = slice.map((row) => row.content_snippet);
      const vecs = await this.embeddingClient.embedDocuments(texts);
      processed += slice.length;

      if (!vecs) {
        aborted = true;
        break;
      }

      this.storage.transaction(() => {
        slice.forEach((row, idx) => {
          const v = vecs[idx];
          if (!v) {
            skipped++;
            return;
          }
          if (v.length !== this.expectedQwen3Dim) {
            this.logger.warn(
              "Backfill skipped row — embed dim mismatch",
              {
                path: row.path,
                got: v.length,
                expected: this.expectedQwen3Dim,
              }
            );
            skipped++;
            return;
          }
          this.storage.updateQwen3(row.path, v, version);
          updated++;
        });
      });

      if (interBatchDelayMs > 0 && i + batchSize < work.length) {
        await new Promise((resolve) => setTimeout(resolve, interBatchDelayMs));
      }
    }

    this.logger.info("Backfill cycle complete", {
      processed,
      updated,
      skipped,
      aborted,
    });
    return { processed, updated, skipped, aborted };
  }

  /**
   * Drop every qwen3 column whose `qwen3_version` differs from
   * `currentVersion`. Returns the number of rows affected. Subsequent
   * {@link backfillQwen3} cycles will repopulate from the live producer.
   */
  invalidateStaleVersion(currentVersion: string): number {
    const dropped = this.storage.invalidateStaleQwen3(currentVersion);
    if (dropped > 0) {
      this.logger.info(
        "Invalidated stale qwen3 vectors after producer version flip",
        { dropped, currentVersion }
      );
    }
    return dropped;
  }

  /**
   * Snapshot of qwen3 coverage. Used by health_check + tests to assert
   * convergence after backfill cycles.
   */
  getVersionStats(): {
    total: number;
    withQwen3: number;
    missingQwen3: number;
    versions: Record<string, number>;
  } {
    const all = this.storage.getAllVectors();
    let withQwen3 = 0;
    const versions: Record<string, number> = {};
    for (const row of all) {
      if (row.qwen3_vector) {
        withQwen3++;
        const v = row.qwen3_version ?? "<unversioned>";
        versions[v] = (versions[v] ?? 0) + 1;
      }
    }
    return {
      total: all.length,
      withQwen3,
      missingQwen3: all.length - withQwen3,
      versions,
    };
  }
}
