#!/usr/bin/env node
/**
 * migrate-vector-db.mjs — ADR-006 (M12) one-shot consolidation tool.
 *
 * Audit recon confirmed two parallel `.jcf-vector-db.json`
 * files were being written today: `.jcf-vector-db.json` (1.9 MB at the
 * server root) and `data/jcf-vector-db.json` (10 MB inside the same
 * folder). The split happened because `getVectorDbPath()` resolves
 * against `process.cwd()` and different launchers use different
 * working directories. This script consolidates every legacy JSON it
 * can find into a single canonical SQLite store, dedupes by absolute
 * file path, preserves the entry with the freshest `indexedAt` (and
 * prefers the one that already has a `qwen3Vector` on a tiebreak),
 * and timestamps the source files into an audit backup folder so a
 * human can roll back.
 *
 * Defaults discover legacy files in `.jcf-vector-db.json` and
 * `data/jcf-vector-db.json` relative to the cwd; pass --source flags
 * to override. The target SQLite path defaults to the same canonical
 * location VectorStorage opens at runtime (`<root>/.jcf-vector-db.sqlite`)
 * so post-migration the MCP server boot is a no-op.
 *
 * Usage:
 *   node scripts/migrate-vector-db.mjs                        # auto-discover
 *   node scripts/migrate-vector-db.mjs --dry-run              # report only
 *   node scripts/migrate-vector-db.mjs \
 *       --target=./data/jcf-vectors.sqlite \
 *       --source=./.jcf-vector-db.json \
 *       --source=./data/jcf-vector-db.json
 *
 * Exit codes:
 *   0  — success (or dry-run completed)
 *   1  — partial failure (one or more sources failed; others migrated)
 *   2  — fatal failure (target schema setup failed)
 */

import { createRequire } from "node:module";
import { existsSync, readFileSync, renameSync, mkdirSync } from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import process from "node:process";

const require = createRequire(import.meta.url);
// better-sqlite3 is a runtime dep of jcf-handling-tool. Use require so
// the script runs both from a built dist and from the repo root without
// extra ESM gymnastics.
const SQLite = require("better-sqlite3");

const SCHEMA_VERSION = "6";

// ── CLI parsing ──────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { sources: [], target: null, dryRun: false, help: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg.startsWith("--target=")) out.target = arg.slice("--target=".length);
    else if (arg.startsWith("--source=")) out.sources.push(arg.slice("--source=".length));
    else {
      console.error(`Unknown argument: ${arg}`);
      out.help = true;
    }
  }
  return out;
}

function printHelp() {
  console.log(`migrate-vector-db.mjs — ADR-006 (M12) consolidation tool

Usage:
  node scripts/migrate-vector-db.mjs [options]

Options:
  --target=<path>     Canonical SQLite output path. Default: ./.jcf-vector-db.sqlite
  --source=<path>     Legacy JSON to import. May be repeated. Defaults to
                      auto-discovery of ./.jcf-vector-db.json and ./data/jcf-vector-db.json.
  --dry-run           Print the report without writing anything.
  -h, --help          Show this message.

After a successful migration each source JSON is moved to
<source>.backup-<unix-ts>.json so a human can roll back.`);
}

// ── Discovery + dedup ────────────────────────────────────────────────

const DEFAULT_DISCOVERY_PATHS = [".jcf-vector-db.json", "data/jcf-vector-db.json"];

function discoverDefaultSources(cwd) {
  return DEFAULT_DISCOVERY_PATHS.map((p) => resolve(cwd, p)).filter((p) =>
    existsSync(p)
  );
}

function loadLegacy(sourcePath) {
  const raw = readFileSync(sourcePath, "utf-8");
  const parsed = JSON.parse(raw);
  return {
    index: parsed.index ?? {},
    documentFrequencies: parsed.documentFrequencies ?? {},
    totalDocuments: parsed.totalDocuments ?? 0,
  };
}

/**
 * Merge multiple legacy stores by canonical path. When the same path
 * appears in two legacy files, the entry with the freshest
 * `indexedAt` wins; ties resolve in favour of the entry that carries
 * a `qwen3Vector` (the M12 audit found that one of the two production
 * files had qwen3 vectors and the other didn't — preferring the
 * populated one preserves the most signal).
 */
function dedupeByPath(legacyStores) {
  const merged = new Map(); // path -> { entry, source }
  const termFreq = new Map(); // term -> doc_freq

  for (const store of legacyStores) {
    // Term frequency table is union-summed; the next maintenance pass
    // (boot-time backfill) will reconcile via re-indexing if needed.
    for (const [term, df] of Object.entries(store.documentFrequencies)) {
      if (typeof df === "number" && df > 0) {
        termFreq.set(term, (termFreq.get(term) ?? 0) + df);
      }
    }

    for (const [path, entryRaw] of Object.entries(store.index)) {
      const entry = entryRaw;
      const prev = merged.get(path);
      if (!prev) {
        merged.set(path, { entry, source: store.sourcePath });
        continue;
      }
      // Prefer freshest indexedAt; tie-break on qwen3Vector presence.
      const prevTs = prev.entry.indexedAt ?? 0;
      const newTs = entry.indexedAt ?? 0;
      if (newTs > prevTs) {
        merged.set(path, { entry, source: store.sourcePath });
      } else if (newTs === prevTs) {
        const prevHasQ = Array.isArray(prev.entry.qwen3Vector) && prev.entry.qwen3Vector.length > 0;
        const newHasQ = Array.isArray(entry.qwen3Vector) && entry.qwen3Vector.length > 0;
        if (newHasQ && !prevHasQ) {
          merged.set(path, { entry, source: store.sourcePath });
        }
      }
    }
  }

  return { merged, termFreq };
}

// ── SQLite schema (mirrors VectorStorage.initSchema) ─────────────────

function initSchema(db) {
  db.exec(`
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
      term     TEXT PRIMARY KEY,
      doc_freq INTEGER NOT NULL CHECK (doc_freq >= 0)
    );
    CREATE TABLE IF NOT EXISTS handling_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  db.prepare(
    "INSERT OR IGNORE INTO handling_meta (key, value) VALUES (?, ?)"
  ).run("schema_version", SCHEMA_VERSION);
}

function encodeFloat32Buffer(arr) {
  // Reject mismatched-length / non-numeric shapes upstream; here we
  // assume `arr` is a number[] of finite floats.
  const f32 = Float32Array.from(arr);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

// ── Migration core ───────────────────────────────────────────────────

function migrate({ targetPath, sources, dryRun, logger }) {
  const stores = [];
  const skipped = [];
  for (const source of sources) {
    try {
      const data = loadLegacy(source);
      stores.push({ ...data, sourcePath: source });
      logger.info(
        `loaded ${Object.keys(data.index).length} entries from ${source}`
      );
    } catch (err) {
      skipped.push({ source, error: err.message });
      logger.warn(`skipped ${source}: ${err.message}`);
    }
  }

  if (stores.length === 0) {
    logger.warn("no usable legacy stores discovered; nothing to migrate");
    return { migrated: 0, dedupedConflicts: 0, skipped };
  }

  const { merged, termFreq } = dedupeByPath(stores);
  const dedupedConflicts =
    stores.reduce((s, st) => s + Object.keys(st.index).length, 0) - merged.size;

  if (dryRun) {
    logger.info(
      `dry-run: would write ${merged.size} unique paths (deduped ${dedupedConflicts}) into ${targetPath}`
    );
    return { migrated: merged.size, dedupedConflicts, skipped, dryRun: true };
  }

  // Make sure target dir exists.
  mkdirSync(dirname(targetPath), { recursive: true });

  const db = new SQLite(targetPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  initSchema(db);

  const upsertVector = db.prepare(`
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
  `);
  const upsertTermFreq = db.prepare(`
    INSERT INTO handling_term_frequencies (term, doc_freq)
    VALUES (?, ?)
    ON CONFLICT(term) DO UPDATE SET doc_freq = excluded.doc_freq
  `);
  const setMeta = db.prepare(
    "INSERT INTO handling_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );

  const tx = db.transaction(() => {
    let totalCount = 0;
    for (const { entry } of merged.values()) {
      const path = entry.path ?? "";
      if (!path) continue;
      const tfidf = Array.isArray(entry.vector) ? entry.vector : [];
      const qwen3 =
        Array.isArray(entry.qwen3Vector) && entry.qwen3Vector.length > 0
          ? entry.qwen3Vector
          : null;
      upsertVector.run({
        path,
        tfidf_vector: encodeFloat32Buffer(tfidf),
        terms_json: JSON.stringify(entry.terms ?? {}),
        ngrams_json: JSON.stringify(entry.ngrams ?? {}),
        qwen3_vector: qwen3 ? encodeFloat32Buffer(qwen3) : null,
        qwen3_dim: qwen3 ? qwen3.length : null,
        // qwen3_version stays NULL — the boot-time validation sweep
        // will mark dim-mismatch rows for backfill, and the next
        // backfill cycle will re-tag with the live producer version.
        qwen3_version: null,
        content_snippet: entry.content ?? "",
        indexed_at: entry.indexedAt ?? Date.now(),
      });
      totalCount++;
    }

    for (const [term, df] of termFreq) {
      upsertTermFreq.run(term, df);
    }
    setMeta.run("total_documents", String(totalCount));
    setMeta.run("migrated_via_script_at", new Date().toISOString());
    setMeta.run(
      "migrated_via_script_sources",
      JSON.stringify(sources)
    );
  });

  tx();
  db.close();

  // Backup the source files so a human can roll back.
  for (const store of stores) {
    const ts = Date.now();
    const backupPath = `${store.sourcePath}.backup-${ts}`;
    try {
      renameSync(store.sourcePath, backupPath);
      logger.info(`backed up ${store.sourcePath} -> ${backupPath}`);
    } catch (err) {
      logger.warn(
        `backup rename failed for ${store.sourcePath}: ${err.message}`
      );
    }
  }

  return { migrated: merged.size, dedupedConflicts, skipped, dryRun: false };
}

// ── Tiny logger (so ESM script has zero deps beyond better-sqlite3) ──

const logger = {
  info: (msg) => console.error(`[migrate-vector-db] ${msg}`),
  warn: (msg) => console.error(`[migrate-vector-db] WARN ${msg}`),
  error: (msg) => console.error(`[migrate-vector-db] ERROR ${msg}`),
};

// ── Main ─────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  const cwd = process.cwd();
  const sources =
    args.sources.length > 0
      ? args.sources.map((s) => resolve(cwd, s))
      : discoverDefaultSources(cwd);

  if (sources.length === 0) {
    logger.warn(
      "no source JSON files found via auto-discovery; pass --source explicitly"
    );
    console.log(JSON.stringify({ migrated: 0, sources: [], note: "nothing-to-do" }, null, 2));
    process.exit(0);
  }

  const targetPath =
    args.target !== null
      ? resolve(cwd, args.target)
      : resolve(cwd, ".jcf-vector-db.sqlite");

  logger.info(`target: ${targetPath}`);
  logger.info(`sources: ${sources.map((s) => basename(s)).join(", ")}`);

  let result;
  try {
    result = migrate({
      targetPath,
      sources,
      dryRun: args.dryRun,
      logger,
    });
  } catch (err) {
    logger.error(err.stack ?? err.message ?? String(err));
    process.exit(2);
  }

  console.log(
    JSON.stringify(
      {
        target: targetPath,
        sources,
        ...result,
      },
      null,
      2
    )
  );
  // Partial failure (some sources skipped) → exit 1 so CI can flag it.
  process.exit(result.skipped.length > 0 ? 1 : 0);
}

main();
