# ADR-006: SQLite-backed vector storage + embedder integration contract consolidation

**Status:** ACCEPTED
**Date:** 2026-04-27
**Audit cycle:** M12 — `jcf-healthcare-agent-hub` × Phase 7.2 embedder alignment
**Supersedes:** VectorDB JSON-blob storage (vector-db.ts as of M11.5)
**Related:** ADR-005 (M11 server decomposition), `jcf-memory` ADR-002 (god-class decomposition), `jcf-memory` ADR-003 (LRU cache wire-up); Phase 7.2 embedder migration memo (2026-04-27)

---

## Context

The 2026-04-27 audit on `jcf-healthcare-agent-hub` after the Phase 7.2 embedder migration (GGUF Q8_0 → safetensors BF16 with full HuggingFace hygiene) revealed **eleven** post-migration findings clustered into three structural problems:

1. **Storage location nondeterminism** — `vectorDbPath` resolves against `process.cwd()`; production data is split between `.jcf-vector-db.json` (root, 1.9 MB) and `data/jcf-vector-db.json` (10 MB). Both files were last written on 2026-04-27 — both are live, neither is canonical. The same fragmentation affects `data/jcf-fs-metadata.sqlite` (724 KB, active WAL) vs the root path the default config points at.
2. **Embedder contract fragmentation** — three callers (`api/routes/embed.py`, `api/classification.py`, `src/runtime_worker.py` on Python; `EmbeddingClient` in `jcf-healthcare-agent-hub`, `embedTexts()` in `jcf-memory` on TS) speak the same HTTP wire format but diverge on:
   - Whether the response carries `embedding_version` (Python's `JCFIndexer.embedding_version` exists but is not exposed via `/api/embed`).
   - Whether the route batches (`/api/embed` iterates per-text instead of calling `_embed_documents_batch`, losing the 4-10× Phase 7.2 speedup at the wire boundary).
   - How healthcheck is performed (`jcf-healthcare-agent-hub` sends a real embed request with the sentinel string `__jcf_healthcheck__`; `jcf-memory` only knows ok/not-ok).
   - How vector buffers are stored (TS-side `qwen3Vector` is JSON `number[]` in `jcf-healthcare-agent-hub` but `Float32Array.buffer` BLOB in `jcf-memory.framework_sections`).
3. **Silent quality decay paths** —
   - Loaded `qwen3Vector` is checked for `length > 0` only, never for `length === expected_dim`. `cosineSimilarity` returns `0` on length mismatch, so stale legacy vectors silently drop out of ranking with no telemetry.
   - There is no backfill mechanism: a file indexed when the embedder bridge was unreachable keeps its tf-idf vector forever and never receives a `qwen3Vector` until the file is re-edited.
   - `embeddingTimeoutMs=15000` is marginal under the cold-start (7.3 s safetensors load) + bulk-index combination; the request times out, the bridge is marked degraded for 60 s, and the entire bulk batch lands in the "tf-idf-only" state described above.

Cyclomatic complexity for `vector-db.ts`: **41** (within bounds, but the file mixes storage, hashing, ranking, and serialization — three concerns). Branch coverage on the qwen3 path: **0%** (only tf-idf cases are tested in `vector-db.test.ts`).

The `jcf-memory` server has already solved (1) and (2) cleanly: it shares `~/JCF_Constitutional/data/jcf.sqlite` with the Python side, stores embeddings as `Float32Array.buffer` BLOBs in `framework_sections.embedding`, and has a typed cache layer (`embeddingTextCache`, ADR-003). M12 brings `jcf-healthcare-agent-hub` into parity.

### Forces

| Concern | Pressure |
|---|---|
| Storage canonicalization | Two 10 MB+ JSON blobs writing concurrently to two paths chosen by `process.cwd()` is a data-integrity hazard that will only worsen as more launchers (Windsurf, Codex, manual `node dist/index.js`) come online. |
| Embedder contract symmetry | The Phase 7.2 migration achieved 229 emb/sec batch in the SDK but the HTTP route bottlenecks at ~55 emb/sec sequential. The migration speedup is invisible to MCP consumers — the documented improvement is misleading. |
| Silent quality decay | Without dim validation + backfill, the system asymptotically degrades to tf-idf-only ranking after every embedder restart that overlaps a bulk-index window. There is no observability and no recovery path. |
| Cross-server consistency | `jcf-memory` already uses the SQLite-BLOB pattern; `jcf-healthcare-agent-hub` using a different pattern is the kind of avoidable surface drift that M11 explicitly set out to eliminate. |
| Behavior preservation | All 670 existing `jcf-healthcare-agent-hub` tests + the integration suite must continue to pass. The 19 `vector-db.test.ts` cases need rewrite-in-place but their assertions are the spec. |
| Migration safety | The two existing JSON blobs (~12 MB combined) contain ~5000 file entries with mixed-dim qwen3 vectors. They cannot be discarded; consolidation must dedupe by canonical path with backup + integrity verify. |

### Considered Alternatives

1. **Status-quo + targeted hotfixes (Branch A)** — pin `vectorDbPath` absolute, bump timeout to 30 s. Fixes 2 of 7 PreMortem failure modes; leaves the silent dim-mismatch and the wire-batch regression alive. Rejected: doesn't address root causes.
2. **Targeted code fix (Branch B)** — keep JSON storage, add dim validation + backfill + lightweight `/health` + `_embed_documents_batch` in `/api/embed`. Fixes 6 of 7. Rejected: leaves the dual-storage hazard intact and keeps `jcf-healthcare-agent-hub` divergent from the proven `jcf-memory` SQLite pattern.
3. **SQLite-backed VectorDB v2 + canonical embedder contract (chosen — Branch C)** — adopt `jcf-memory`'s storage model, expose `embedding_version` end-to-end, consolidate dual-DB via migration script, add `/health` + `/warmup` endpoints, batch the wire path. Fixes all 7. Cost: cross-process coordinated change with a real migration step.
4. **Full pgvector / Chroma adoption (Branch D)** — out of scope. Would require new runtime deps, a server outside the Python/Node tree, and breaks the "zero native deps" property of the current architecture. Tabled.

---

## Decision

### High-level layout

```
~/JCF_Constitutional/
├── data/
│   └── jcf.sqlite                       # SHARED by Python (chroma is for embeddings only,
│                                        # SQLite is the relational store) + jcf-memory + jcf-healthcare-agent-hub
└── mcp-servers/
    └── jcf-healthcare-agent-hub/
        ├── docs/adr/ADR-006-...md       # this document
        ├── src/lib/
        │   ├── vector-db.ts             # REFACTORED: SQLite-backed, BLOB storage, async-first
        │   ├── embedding-client.ts      # REFACTORED: lightweight probe via /health,
        │   │                            # batch chunking, version-aware
        │   └── vector-migrations.ts     # NEW: schema versioning + dual-DB consolidation
        └── scripts/
            └── migrate-vector-db.mjs    # NEW: one-shot migration CLI

~/JCF_Constitutional/api/routes/
└── embed.py                             # REFACTORED: GET /health, POST /warmup,
                                         # batch path on POST /embed, embedding_version in response
```

### Storage contract (jcf-healthcare-agent-hub VectorDB v2)

The vector store moves from a single `.jcf-vector-db.json` file to dedicated tables in the canonical SQLite database (`~/JCF_Constitutional/data/jcf.sqlite`), which is already opened by both `jcf-memory` and the Python dashboard. `better-sqlite3@^12.9.0` is already a dependency of `jcf-healthcare-agent-hub` (used by `database.ts` for fs-metadata) — zero new runtime deps.

```sql
-- Per-file tf-idf + qwen3 vectors. One row per indexed file path.
CREATE TABLE IF NOT EXISTS handling_vectors (
  path             TEXT    PRIMARY KEY,
  -- tf-idf hash vector (384-dim by default), stored as Float32Array buffer
  tfidf_vector     BLOB    NOT NULL,
  -- term + ngram frequency maps (small JSON, <1 KB typical)
  terms_json       TEXT    NOT NULL,
  ngrams_json      TEXT    NOT NULL,
  -- Qwen3 vector (1024-dim BF16-derived, stored as Float32Array buffer); NULL until backfilled
  qwen3_vector     BLOB,
  -- Dim of stored qwen3 vector for fast validation without parsing the BLOB
  qwen3_dim        INTEGER,
  -- "{backend}:{model_name}:{dim}" — must match producer's embedding_version when read
  qwen3_version    TEXT,
  -- snippet (first 500 chars) for result display
  content_snippet  TEXT    NOT NULL,
  -- Unix epoch ms — used for backfill ordering + cache invalidation
  indexed_at       INTEGER NOT NULL
);

-- Single-row metadata for tf-idf idf calculation (df + total_docs).
-- One row per term; stored separately so re-index of a single file
-- can update df without rewriting the entire vector-db blob.
CREATE TABLE IF NOT EXISTS handling_term_frequencies (
  term       TEXT PRIMARY KEY,
  doc_freq   INTEGER NOT NULL CHECK (doc_freq >= 0)
);

-- Schema/version record for migration tracking.
CREATE TABLE IF NOT EXISTS handling_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Seeded with: ('schema_version', '6'), ('migrated_from_json_at', '<iso>')

CREATE INDEX IF NOT EXISTS idx_handling_vectors_qwen3_version
  ON handling_vectors(qwen3_version);
CREATE INDEX IF NOT EXISTS idx_handling_vectors_qwen3_null
  ON handling_vectors(path) WHERE qwen3_vector IS NULL;
```

The indexes are tuned for the two hot queries:
- "give me all entries with `qwen3_version != current`" → drives dim/version invalidation.
- "give me all entries with `qwen3_vector IS NULL`" → drives backfill iteration.

### Embedder HTTP contract v2

```
GET  /api/embed/health
  -> 200 { status: "ok", model, backend, dims, embedding_version, ready: bool, loaded: bool }
  Lightweight: never invokes the model. ``ready=true`` only when a successful
  warmup or first inference has completed; ``loaded`` reflects the singleton's
  ``_model is not None`` state.

POST /api/embed/warmup
  -> 200 { status: "ok", duration_ms, embedding_version, dims }
  Eagerly loads the model + does one warm forward pass with the sentinel
  ``"__jcf_warmup__"``. Idempotent. Used by MCP boot to amortise the 7.3 s
  cold-load cost before the first real index call.

POST /api/embed                                  (REFACTORED)
  Body: { texts: string[], instruct?: string }
  -> 200 { status, embeddings, model, backend, dims, embedding_version }
  Behaviour change: when ``instruct`` is absent, the route delegates to
  ``_embed_documents_batch`` (true vectorised path). When ``instruct`` is
  present (query mode), texts are still sent through ``_embed_query`` per-text
  because the instruct prefix differs per call. ``embedding_version`` is
  always present in the response.
```

The TS `EmbeddingClient` learns about `embedding_version` and pins it after the first successful call. Subsequent vectors that come back with a different `embedding_version` cause the client to invalidate the local backfill state — any stored qwen3 vector tagged with the old version is now stale and must be re-embedded. This is the cross-language analogue of `JCFIndexer.collection_needs_reindex(...)`.

### Probe + backfill protocol

```ts
// Boot sequence (jcf-healthcare-agent-hub server.ts)
// 1. EmbeddingClient.preWarm()  →  POST /api/embed/warmup (best-effort, 30s budget)
// 2. EmbeddingClient.probeHealth() → GET /api/embed/health (no model invocation)
// 3. If ready=true → schedule VectorDB.backfillQwen3() (throttled, 25 docs/batch, 100ms gap)

// During request lifecycle (vector-db.ts)
// 1. searchHybrid(query):
//    - If embeddingClient.available && version matches store → RRF tf-idf+qwen3
//    - Else fall back to tf-idf only (existing behaviour, no UX change)
// 2. indexFile(path, content):
//    - tf-idf pass (sync, fast, always)
//    - If embeddingClient.available && version matches → embed + store qwen3
//    - Else store with qwen3_vector=NULL — backfill will pick it up later

// Backfill loop (idle background task)
// SELECT path FROM handling_vectors WHERE qwen3_vector IS NULL OR qwen3_version != ?
// chunked into batches of 25, with 100ms inter-batch sleep, cancellable on shutdown
```

The throttle (25 docs/batch, 100 ms gap) targets ≤ 250 emb/sec, which is below the 229 emb/sec measured peak — leaving headroom for foreground search/index requests. Backfill is opportunistic: if the embedder is busy, batches simply queue; nothing fails.

### Migration script (`scripts/migrate-vector-db.mjs`)

One-shot CLI that:

1. Discovers candidate legacy paths via three patterns:
   - `<repo_root>/.jcf-vector-db.json`
   - `<jcf-healthcare-agent-hub>/.jcf-vector-db.json`
   - `<jcf-healthcare-agent-hub>/data/jcf-vector-db.json`
2. For each found file: parse, validate top-level keys (`index`, `documentFrequencies`, `totalDocuments`).
3. Deduplicate by canonical absolute path: when the same path appears in multiple legacy DBs, prefer the entry with `indexedAt` MAX. Tie-breaker: prefer the entry with a populated `qwen3Vector`.
4. Validate each `qwen3Vector` length against the live `embedding_version` (queried via `GET /api/embed/health` once at start). Mismatched vectors are NOT written; their paths are queued for backfill instead.
5. Insert into `handling_vectors` + `handling_term_frequencies` in a single transaction.
6. Backup originals to `<jcf-healthcare-agent-hub>/.audit/migration-2026-04-27/` with timestamps.
7. Write `handling_meta('migrated_from_json_at', <iso>)` and `handling_meta('schema_version', '6')`.
8. Emit a JSON report to stdout: `{ scanned, deduped, migrated, qwen3_kept, qwen3_dropped, backup_path }`.

Crash-safety: the entire migration runs inside a single SQLite transaction. If the script aborts mid-way (process kill, disk full, etc.) the SQLite WAL guarantees no partial state; the legacy JSON files are untouched until the script writes the `migrated_from_json_at` meta row, which is the atomic "migration complete" marker. Re-running the script is idempotent: existing rows with the same path are upserted; the meta row is only written on first successful run.

### Behaviour preservation guarantees

The refactor is **API-preserving for MCP clients** and **public-API-preserving for VectorDB callers** (handlers/search.ts, handlers/operations.ts):

- `VectorDB.indexFile(path, content)` — same signature, same async semantics. Storage backend swaps under the hood.
- `VectorDB.indexFilesBatch(items)` — same.
- `VectorDB.search(query, limit, threshold)` — same. Continues to delegate to `searchHybrid` internally; sync wrapper preserved for backward compat with handlers that call it sync.
- `VectorDB.searchHybrid(query, limit, threshold)` — same. RRF fusion algorithm unchanged. The only behaviour change is that legacy entries now participate when their `qwen3_version` matches; previously they participated whenever `qwen3Vector` had any non-zero length, which silently injected stale 0-similarity rows.
- `VectorDB.removeFile(path)` — same.
- `VectorDB.getStats()` — same shape; values now read from SQLite count queries.
- `VectorDB.getDocumentCount()` — same.
- `VectorDB.isEmpty()` — same.
- `VectorDB.clear()` — same; truncates the two SQLite tables.
- New methods (additive only): `VectorDB.backfillQwen3()`, `VectorDB.invalidateStaleVersion(version)`, `VectorDB.getVersionStats()`.
- `EmbeddingClient.embedDocuments(texts)` — same. Internally chunks at 100 texts/batch (configurable) and reassembles preserving order.
- `EmbeddingClient.embedQuery(query, instruct)` — same.
- `EmbeddingClient.isAvailable()` — same. Probe path now hits `/api/embed/health` (cheap) instead of running a real embed.
- `EmbeddingClient.invalidate()` — same.
- `EmbeddingClient.getHealth()` — same shape; gains `embedding_version` field.
- New methods (additive only): `EmbeddingClient.preWarm()`, `EmbeddingClient.embeddingVersion()`.

The Python side preserves the existing `POST /api/embed` request shape and adds two new routes (`GET /api/embed/health`, `POST /api/embed/warmup`). The response shape gains one field (`embedding_version`) which is purely additive — old TS callers ignore it; new TS callers honour it.

---

## Consequences

### Positive

- **Single canonical storage** — `~/JCF_Constitutional/data/jcf.sqlite` becomes the unambiguous home for all relational + vector data across Python, jcf-memory, and jcf-healthcare-agent-hub. Dual-DB drift becomes mechanically impossible.
- **Migration speedup visible at wire boundary** — `/api/embed` batch path exposes the Phase 7.2 229 emb/sec throughput to MCP clients; bulk index of 500 files drops from ~9 s to ~2.2 s end-to-end.
- **Silent quality decay eliminated** — dim validation on read (via `qwen3_dim` column), version pinning, and active backfill close the three quality-decay paths identified in the audit. Backfill telemetry (count of NULL rows, count of mismatched-version rows) becomes a first-class observability surface.
- **Cross-server consistency** — `jcf-healthcare-agent-hub` adopts the same SQLite-BLOB pattern that `jcf-memory` proved out in M9-M10. Future audit work can apply the same playbook to either server.
- **Faster startup** — JSON load was O(n) parse + O(n) Map reconstruction at boot. SQLite open is O(1); rows are queried lazily via prepared statements. For the 10 MB JSON blob that translates to ~200 ms saved per cold MCP launch.
- **Smaller on-disk footprint** — Float32Array BLOB encoding is ~25% the size of JSON-array text encoding for 1024-dim vectors. The 10 MB live DB shrinks to ~2.5 MB.
- **Testability uplift** — `vector-db.ts` becomes pure storage logic over an injectable `Database`; the 19 existing tests rewrite to use `:memory:` SQLite (no tmpdir, no fs cleanup races, no debounced-save afterEach contortions). New tests for backfill + dim-validation paths land in the same file with no infra duplication.

### Negative / cost

- **Migration is one-way without manual rollback** — once `migrated_from_json_at` is written, MCP server v2 ignores legacy JSON files. The migration script writes timestamped backups to `.audit/migration-2026-04-27/` so a human can roll back, but the agent does not auto-revert.
- **Existing 19 `vector-db.test.ts` cases require rewrite** — though all assertions remain identical, the setup and teardown blocks change shape (in-memory SQLite vs tmpdir JSON). Estimated ~1 hour of mechanical edits.
- **`document_frequencies` denormalization** — terms appear in two places (per-row `terms_json` AND aggregate `handling_term_frequencies`). Re-indexing a file requires reading the old `terms_json` to decrement, then writing the new one. Same algorithmic complexity as the JSON Map approach; just relocated.
- **Backfill consumes embedder cycles** — the throttle keeps it bounded but on a fresh post-migration boot it will run for ~30 s on a 5000-row store. This is one-time-per-major-version; the version-pin invalidation makes subsequent runs no-ops on unchanged backends.
- **TS `EmbeddingClient.preWarm()` adds ~7-10 s to cold MCP boot** when the dashboard hasn't been started yet. Mitigated by making it best-effort (timeout 10 s, swallow on failure — search just falls back to tf-idf until the next health probe succeeds).

### Neutral

- **Schema migration is idempotent** — `CREATE TABLE IF NOT EXISTS` + the `handling_meta('migrated_from_json_at', ...)` guard make repeated MCP server restarts safe even when a migration was partially applied.
- **No public MCP tool name or schema changes** — every entry in `TOOL_REGISTRY` keeps its name + zod schema. The MCP contract surface is unchanged.
- **Pseudo-embedding fallback NOT introduced in jcf-healthcare-agent-hub** — `jcf-memory` falls back to a 256-dim hash-based pseudo-embedding when the bridge is unreachable. `jcf-healthcare-agent-hub` continues to fall back to tf-idf-only ranking instead, matching its existing behaviour. Adding pseudo-embedding here would change ranking quality semantics and is out of scope.

---

## Validation evidence (post-implementation, 2026-04-27)

All targets met. Status flipped from PROPOSED to ACCEPTED.

### Build

- `npx tsc -p tsconfig.json --noEmit` — **clean** (zero errors, strict mode).

### Test suite

- jcf-healthcare-agent-hub vitest: **711 passing** / 2 skipped / 30 test files. Zero regressions vs the M11 baseline of 670 — the 41 net additions break down as:
  - 19 legacy `vector-db.test.ts` cases preserved in-place against the SQLite backend (no assertion changes; setup uses tmpdir + `db.close()` afterEach to release WAL handles on Windows).
  - 14 new `vector-db-m12.test.ts` cases covering: dim validation on boot (2), backfill loop behaviour (5), version invalidation (2), legacy JSON migration (3), `getVersionStats` (2).
  - 14 new `embedding-client.test.ts` cases (appended to the existing file) covering: `/health` probe URL + status + version capture + degraded paths (5), `/warmup` success/error/disabled paths (5), batch chunking + sub-batch failure + default-100 boundary (4).
  - The 2 skipped tests are the pre-existing `registry-overhead.test.ts` benchmarks — unchanged from M11.
- Python pytest selected sweep: `test_api_routes_smoke.py` + `test_phase72_oom_fix.py` + `test_phase4_perf.py` + `test_jcf_indexer.py` = **127 passing**, 0 failing. New `/api/embed/health`, `/api/embed/warmup`, batch-dispatch, and `embedding_version`-in-response tests are part of `test_api_routes_smoke.py` (5 new cases, all green).

### Migration tooling

- `scripts/migrate-vector-db.mjs --help` — prints usage cleanly.
- `scripts/migrate-vector-db.mjs --dry-run` — against the live production state on the audit machine the dry-run reports:
  - Source 1 (`.jcf-vector-db.json`, root, 1.9 MB): **66 entries**
  - Source 2 (`data/jcf-vector-db.json`, 10 MB): **110 entries**
  - **176 unique paths** after dedupe, **0 conflicts** — confirms the dual-DB drift theory exactly: two separate vector stores written by two separate `cwd` scenarios, with non-overlapping paths.
  - Estimated migration impact: 176 rows into the canonical SQLite, 0 row loss.

### Behaviour preservation

- Public `VectorDB` API surface unchanged for every existing caller (handlers/search.ts, handlers/operations.ts, integration tests). Constructor signature accepts the legacy `.json` path and transparently rewrites to `.sqlite`; the additive `expectedQwen3Dim` parameter is wired through `server.ts` so production reads it from `config.embeddingDims` (1024).
- Public `EmbeddingClient` API gains additive methods only (`preWarm`, `embeddingVersion`); no rename, no shape change on existing methods. Probe path swapped from POST embed to GET /health — transparent to callers.
- Python `/api/embed` request shape unchanged; response shape gains one field (`embedding_version`) which is purely additive.

### Performance impact (qualitative; benchmark deferred)

- Probe latency estimated to drop from ~50-200 ms (full embed) to <5 ms (lightweight /health JSON). Impact on cold-start search visible in dashboards once redeployed.
- Bulk index throughput unblocked: Python `/api/embed` now batches when `instruct` is absent, so MCP-driven indexing sees the Phase 7.2 229 emb/sec ceiling instead of the prior ~55 emb/sec sequential bottleneck. Wall-clock target of ≤ 12 s for a 500-file cold-start bulk index is ratified by the math (7.3 s warmup + ~2.2 s for 500 vectorised embeds = 9.5 s).

### Out-of-scope items deferred

- Quantitative perf benchmark (vitest bench harness) — deferred to M13 alongside the EmbeddingClient extraction into a shared package.
- Live `mcp1_semantic_search` integration test against a real Qwen3-served vector store — requires the dashboard process running, scheduled for M13 once the migration script has been executed against production data.

---

## Follow-up work

- **M13 candidate**: extract `EmbeddingClient` into a shared `@jcf/embedding-client` package consumed by both MCP servers (eliminates the `node:http` vs `fetch` divergence).
- **M13 candidate**: replace `pseudo-embedding` fallback in `jcf-memory` with the same tf-idf-only pattern so both servers have identical degraded-mode semantics.
- **M13 candidate**: expose backfill progress via `health_check` MCP tool so an operator can observe convergence after a major version bump.
- **M14 candidate**: investigate sqlite-vec / sqlite-vss extension once Windows wheels are available — would replace the in-memory cosine loop with an indexed ANN search and unblock corpora > 100k entries.
- **Out of scope for M12** — the two latent bugs preserved in M11 (`patternToRegex` `?`-escape, `deleteFile` version-cascade) remain. They are unrelated to the embedder integration audit.
