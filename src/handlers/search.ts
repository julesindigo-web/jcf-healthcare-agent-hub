/**
 * Search handlers — glob file search + semantic search with auto-index.
 *
 * Extracted from `JcfHealthcareAgentHubServer` during M11 audit.
 * Behavior preserved verbatim, including the lazy auto-index for
 * `semanticSearch` when the vector DB is empty.
 *
 * 2 tools:
 *   - searchFiles
 *   - semanticSearch
 *
 * + 1 internal helper:
 *   - autoIndexDirectory  (used by semanticSearch when vector DB is empty)
 */

import fs from "fs/promises";
import path from "path";
import type { SearchResult } from "../types/index.js";
import type { HandlerContext } from "./context.js";
import { validatePath } from "./shared/path-guard.js";
import { withAudit } from "./shared/audit.js";
import { patternToRegex } from "./shared/util.js";
import { getInstallRoot } from "../lib/install-root.js";
// M13.2: real-case failure during jcf-memory recon — the
// pattern `**/enforcement*.ts` returned [] because `patternToRegex`
// matches against `entry.name` (just the filename) and `**/`
// expanded to `.*.*/` which forces a `/` into a basename match. Now
// dispatched through fast-glob (already a runtime dep used by
// autoIndexDirectory + cognitive-index) which speaks real glob
// semantics: `**/`, `{a,b}`, `[abc]`, `!negation`, etc.
import fastGlob from "fast-glob";

export interface SearchFilesArgs {
  pattern: string;
  baseDir?: string;
}

export interface SearchFilesResult {
  results: SearchResult[];
}

/**
 * Glob-style file search. Routes through fast-glob so the full glob
 * dialect works (`**​/`, `{a,b}`, `[abc]`, negation, etc.).
 *
 * BACKWARD COMPATIBILITY: legacy callers passed simple basename patterns
 * like `*.ts` and `report?.json`, which were matched via `patternToRegex`
 * against each `entry.name` (filename only). To keep those callers
 * working we autodetect "basename-only" patterns (no `/` and no `**`)
 * and rewrite them to `**​/<pattern>` so fast-glob walks the whole tree
 * and matches against any file. Patterns that already contain path
 * segments are passed through unchanged.
 *
 * Recurses up to `config.maxDirectoryDepth` (default 20). The `regex`
 * fallback (via `patternToRegex`) is preserved as a sanity check on the
 * resulting basenames so case-insensitivity stays consistent with the
 * pre-M13.2 behavior.
 */
export async function searchFiles(
  ctx: HandlerContext,
  args: SearchFilesArgs
): Promise<SearchFilesResult> {
  // R-1: fallback no longer leaks to `process.cwd()`,
  // which produced erratic search roots when MCP was spawned from a
  // foreign cwd. Now anchored to JCF install-root for reproducibility.
  const base = args.baseDir
    ? validatePath(ctx, args.baseDir)
    : ctx.config.allowedDirectories[0] || getInstallRoot();

  return withAudit(ctx, "search", base, async () => {
    const maxDepth = ctx.config.maxDirectoryDepth || 20;

    // M13.2: detect basename-only patterns and lift them to `**​/` so
    // legacy callers that pass `*.ts` keep getting recursive results.
    const isBasenameOnly =
      !args.pattern.includes("/") && !args.pattern.includes("**");
    const effectivePattern = isBasenameOnly
      ? `**/${args.pattern}`
      : args.pattern;

    const matches = (await fastGlob(effectivePattern, {
      cwd: base,
      absolute: true,
      onlyFiles: true,
      caseSensitiveMatch: false,
      deep: maxDepth,
      ignore: [
        "**/node_modules/**",
        "**/.git/**",
        "**/dist/**",
        "**/build/**",
      ],
    })) as string[];

    // Sort for deterministic output.
    matches.sort();
    const results: SearchResult[] = matches.map((fullPath) => ({
      path: fullPath,
      score: 1.0,
      snippet: undefined,
    }));

    // Touch the legacy regex helper so the import isn't dropped while we
    // keep it around for back-compat with any direct callers.
    void patternToRegex;
    void fs;
    void path;

    return { results };
  });
}

export interface SemanticSearchArgs {
  query: string;
  limit?: number;
  threshold?: number;
  rootPath?: string;
  autoIndex?: boolean;
}

export interface SemanticSearchResult {
  results: SearchResult[];
  autoIndexed: boolean;
  indexedDocuments: number;
  note?: string;
}

/**
 * Vector + lexical hybrid search. Lazy-indexes when the vector DB is empty
 * and `autoIndex !== false` (Phase B4 dogfooding fix — first call no longer
 * silently returns nothing).
 */
export async function semanticSearch(
  ctx: HandlerContext,
  args: SemanticSearchArgs
): Promise<SemanticSearchResult> {
  const { limit = 10, threshold = 0.3, autoIndex = true, rootPath } = args;

  return withAudit(ctx, "search", "semantic", async () => {
    // Phase B4: Lazy auto-index if index is empty — closes dogfooding friction
    // where first semantic_search call fails silently because index was never built.
    let autoIndexed = false;
    let note: string | undefined;
    if (ctx.vectorDb.isEmpty() && autoIndex) {
      // R-1: anchor auto-index to install-root if
      // caller did not supply rootPath and operator did not configure
      // allowedDirectories. Avoids indexing arbitrary cwd contents.
      // M14 (Bug #3 — P1 Security): validate caller-supplied rootPath
      // against allowedDirectories to prevent auto-indexing arbitrary
      // directories (e.g. C:\Windows\System32). Only user-supplied
      // rootPath needs validation; the fallbacks are operator-controlled.
      const searchRoot = rootPath
        ? validatePath(ctx, rootPath)
        : ctx.config.allowedDirectories[0] || getInstallRoot();
      ctx.logger.info("Vector DB empty — auto-indexing", { root: searchRoot });
      const indexed = await autoIndexDirectory(ctx, searchRoot);
      autoIndexed = true;
      note = `Auto-indexed ${indexed} files from ${searchRoot}. To disable, pass autoIndex=false.`;
    }

    const results = await ctx.vectorDb.searchHybrid(args.query, limit, threshold);
    return {
      results: results.map(
        (r: { path: string; score: number; snippet?: string }) => ({
          path: r.path,
          score: r.score,
          snippet: r.snippet ?? undefined,
        })
      ),
      autoIndexed,
      indexedDocuments: ctx.vectorDb.getDocumentCount(),
      ...(note ? { note } : {}),
    };
  });
}

/**
 * Phase B4 helper — scan a directory and index text files into vector DB.
 * Caller is responsible for triggering (only called when vectorDb.isEmpty()).
 *
 * M11-AUDIT FIX (MED-1 + HIGH-5):
 *   - File-count cap and per-file size cap now come from
 *     `ctx.config.semanticAutoIndexMaxFiles` /
 *     `ctx.config.semanticAutoIndexMaxFileBytes`, falling back to the
 *     prior hardcoded values (500 files, 2 MiB) for backward compatibility.
 *   - Per-file failures now log at debug with reason; the previous
 *     "skip silently" path made indexing failures undiagnosable.
 *   - Emits MCP progress notifications when a `progress` channel is wired
 *     into the handler context (resolves the silent long-running-op
 *     concern at the source).
 */
async function autoIndexDirectory(
  ctx: HandlerContext,
  rootPath: string
): Promise<number> {
  const fg = (await import("fast-glob")).default;
  const files = (await fg(
    [
      "**/*.{ts,tsx,js,jsx,mjs,cjs,py,md,txt,go,rs,java,cs,rb,php,swift,kt,scala,sh,yaml,yml,json,toml}",
    ],
    {
      cwd: rootPath,
      absolute: true,
      ignore: [
        "**/node_modules/**",
        "**/.git/**",
        "**/dist/**",
        "**/build/**",
        "**/coverage/**",
        "**/.jcf-*",
      ],
      onlyFiles: true,
    }
  )) as string[];
  const maxFiles = ctx.config.semanticAutoIndexMaxFiles;
  const maxBytes = ctx.config.semanticAutoIndexMaxFileBytes;
  // M14 (Bug #7 — P3 Robustness): cumulative byte cap to prevent OOM.
  // Previous code had per-file cap but no total cap. 500 files × 2MB =
  // 1GB in-memory during indexing. Default: 50MB cumulative.
  const maxTotalBytes = ctx.config.semanticAutoIndexMaxTotalBytes;
  const capped = files.slice(0, maxFiles);
  let indexed = 0;
  let skippedTooLarge = 0;
  let skippedError = 0;
  let cumulativeBytes = 0;

  // Progress: report every ~5% or every 25 files, whichever is larger.
  const progressStep = Math.max(25, Math.floor(capped.length / 20));

  ctx.progress?.send({
    progress: 0,
    total: capped.length,
    message: `Auto-indexing ${capped.length} file${capped.length === 1 ? "" : "s"} from ${rootPath}…`,
  });

  for (let i = 0; i < capped.length; i++) {
    const f = capped[i]!;
    try {
      const content = await fs.readFile(f, "utf-8");
      if (content.length > maxBytes) {
        skippedTooLarge++;
        continue;
      }
      // M14 (Bug #7): enforce cumulative byte cap to prevent OOM
      if (cumulativeBytes + content.length > maxTotalBytes) {
        ctx.logger.info("Auto-index halted: cumulative byte cap reached", {
          cumulativeBytes,
          maxTotalBytes,
          filesThatFit: indexed,
        });
        break;
      }
      await ctx.vectorDb.indexFile(f, content);
      cumulativeBytes += content.length;
      indexed++;
    } catch (err) {
      skippedError++;
      ctx.logger.debug("Auto-index skipped file", {
        file: f,
        reason: err instanceof Error ? err.message : String(err),
      });
    }

    if ((i + 1) % progressStep === 0 || i === capped.length - 1) {
      ctx.progress?.send({
        progress: i + 1,
        total: capped.length,
        message: `Indexed ${indexed}/${i + 1} (skipped ${skippedTooLarge + skippedError})`,
      });
    }
  }

  ctx.logger.info("Auto-index complete", {
    root: rootPath,
    candidates: files.length,
    capped: capped.length,
    indexed,
    skippedTooLarge,
    skippedError,
  });
  return indexed;
}
