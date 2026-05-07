/**
 * Filesystem handlers — read / write / edit / append / delete / list.
 *
 * Extracted from `JcfHealthcareAgentHubServer` during M11 audit.
 * Behavior preserved verbatim from the original `handle*` methods. The only
 * mechanical change: `this.X` → `ctx.X`, helpers imported from shared/.
 *
 * 6 tools:
 *   - readFile
 *   - writeFile
 *   - editFile
 *   - appendFile
 *   - deleteFile
 *   - listDirectory
 */

import fs from "fs/promises";
import path from "path";
import type { FileMetadata } from "../types/index.js";
import type { HandlerContext } from "./context.js";
import { validatePath } from "./shared/path-guard.js";
import { withAudit } from "./shared/audit.js";
import { fsGetMetadata } from "./shared/metadata.js";
import { hashContent } from "./shared/util.js";
import { detectLanguage } from "./shared/content-analysis.js";
import {
  assessEditRisk,
  verifyPostEditIntegrity,
  summarizeEditDiff,
  type EditRiskReport,
  type EditDiffSummary,
} from "./shared/edit-safety.js";

export interface ReadFileArgs {
  path: string;
  offset?: number;
  limit?: number;
  maxLines?: number;
}

export interface ReadFileResult {
  content: string;
  metadata: FileMetadata;
  readInfo: {
    totalLines: number;
    totalBytes: number;
    offset: number;
    limit: number;
    returnedLines: number;
    truncated: boolean;
    nextOffset?: number;
    resumeHint?: string;
  };
}

/**
 * Cache-aware file read with line-based pagination.
 *
 * - Cache hit: return cached content if mtime matches.
 * - Cache stale: invalidate + re-read.
 * - Pagination: 1-indexed `offset`, default `limit` = 2000 lines.
 *
 * Behavior preserved verbatim from `JcfHealthcareAgentHubServer.handleReadFile`.
 */
export async function readFile(
  ctx: HandlerContext,
  args: ReadFileArgs
): Promise<ReadFileResult> {
  const filePath = validatePath(ctx, args.path);
  return withAudit(ctx, "read", filePath, async () => {
    const cacheKey = `file:${filePath}`;
    const cached = ctx.cache.get(cacheKey) as string | null;

    // Check if file was modified since caching by comparing stat mtime
    let fileStat: Awaited<ReturnType<typeof fs.stat>> | null = null;
    try {
      fileStat = await fs.stat(filePath);
    } catch {
      // File doesn't exist
    }

    // ── Resolve full content (cache-aware) ──
    // M11-AUDIT FIX (HIGH-5): use ctx.config.cacheTTL (configurable) instead
    // of the previously-hardcoded 300000ms (5min). Honors mcp-fs-config.json
    // and MCP_FS_CACHETTL env override.
    const cacheTtl = ctx.config.cacheTTL;
    let fullContent: string;
    if (cached && fileStat) {
      const cachedMeta = ctx.cache.get(`meta:${filePath}`) as
        | { mtime: number }
        | null;
      if (cachedMeta && cachedMeta.mtime === fileStat.mtimeMs) {
        ctx.logger.debug("Cache hit (fresh)", { path: filePath });
        fullContent = cached;
      } else {
        // Cache is stale — invalidate & re-read
        ctx.cache.delete(cacheKey);
        ctx.cache.delete(`meta:${filePath}`);
        ctx.logger.debug("Cache stale — invalidated", { path: filePath });
        fullContent = await fs.readFile(filePath, "utf-8");
        ctx.cache.set(cacheKey, fullContent, cacheTtl);
        ctx.cache.set(`meta:${filePath}`, { mtime: fileStat.mtimeMs }, cacheTtl);
      }
    } else {
      fullContent = await fs.readFile(filePath, "utf-8");
      ctx.cache.set(cacheKey, fullContent, cacheTtl);
      if (fileStat) {
        ctx.cache.set(`meta:${filePath}`, { mtime: fileStat.mtimeMs }, cacheTtl);
      }
    }

    const metadata = await fsGetMetadata(filePath);

    // ── Line-based pagination (Phase B1/B2 — dogfooding fix) ──
    const DEFAULT_MAX_LINES = 2000;
    const effectiveMaxLines = args.maxLines ?? DEFAULT_MAX_LINES;
    const offset = Math.max(1, args.offset ?? 1); // 1-indexed
    const limit = args.limit ?? effectiveMaxLines;

    const lines = fullContent.split(/\r?\n/);
    const totalLines = lines.length;
    const totalBytes = Buffer.byteLength(fullContent, "utf-8");

    const startIdx = offset - 1;
    const endIdx = Math.min(totalLines, startIdx + limit);
    const slicedLines = lines.slice(startIdx, endIdx);
    const returnedContent = slicedLines.join("\n");
    const returnedLines = slicedLines.length;
    const truncated = endIdx < totalLines;

    const readInfo: ReadFileResult["readInfo"] = {
      totalLines,
      totalBytes,
      offset,
      limit,
      returnedLines,
      truncated,
    };

    if (truncated) {
      readInfo.nextOffset = endIdx + 1;
      readInfo.resumeHint =
        `File has ${totalLines} lines total (${totalBytes} bytes). ` +
        `Returned lines ${offset}-${endIdx}. ` +
        `To continue, call read_file with offset=${endIdx + 1} limit=${limit}.`;
    }

    return { content: returnedContent, metadata, readInfo };
  });
}

export interface WriteFileArgs {
  path: string;
  content: string;
  author?: string;
  message?: string;
}

export interface WriteFileResult {
  success: boolean;
  versionId: string;
  metadata: FileMetadata;
}

/**
 * Write file with secret-scan, version snapshot, dependency + vector index
 * updates. Refuses if scanned content contains potential secrets. Throws on
 * size > `config.maxFileSize` (default 100 MB).
 */
export async function writeFile(
  ctx: HandlerContext,
  args: WriteFileArgs
): Promise<WriteFileResult> {
  const filePath = validatePath(ctx, args.path);

  // M6: Input length validation (prevent memory exhaustion)
  const MAX_CONTENT_CHARS = 10 * 1024 * 1024; // 10MB in characters
  if (args.content && args.content.length > MAX_CONTENT_CHARS) {
    throw new Error(
      `Content length (${args.content.length} chars) exceeds maximum allowed (${MAX_CONTENT_CHARS} chars)`
    );
  }

  const secrets = ctx.security.scanForSecrets(args.content, filePath);
  if (secrets.length > 0) {
    throw new Error(
      `Refusing to write file containing ${secrets.length} potential secret(s)`
    );
  }

  return withAudit(ctx, "write", filePath, async () => {
    // Enforce max file size
    const maxSize = ctx.config.maxFileSize || 100 * 1024 * 1024; // 100MB default
    const contentSize = Buffer.byteLength(args.content, "utf-8");
    if (contentSize > maxSize) {
      throw new Error(
        `File size (${contentSize} bytes) exceeds maximum allowed size (${maxSize} bytes)`
      );
    }

    // T2 FIX: TOCTOU prevention - read current content FIRST, before any async gaps
    // This ensures version history captures the TRUE state at time of decision
    let currentContent = "";
    const existingMetadata = await ctx.db.getFileMetadata(filePath);

    if (existingMetadata) {
      // Read BEFORE computing hashes to avoid TOCTOU window
      currentContent = await fs.readFile(filePath, "utf-8").catch(() => "");
    }

    const newHash = hashContent(args.content);

    if (existingMetadata && currentContent) {
      const existingHash = hashContent(currentContent);
      if (existingHash !== newHash) {
        // Store version history with the content we JUST read (no TOCTOU gap)
        await ctx.db.addVersion(
          filePath,
          hashContent(currentContent),
          args.author || "anonymous",
          args.message || "Auto-save",
          Buffer.byteLength(currentContent, "utf-8"),
          currentContent
        );
      }
    }

    // M11.5: ensure parent dir exists before writing. validatePath has
    // already confirmed `filePath` is inside `allowedDirectories`, so the
    // parent directory is also allowed — `mkdir(..., { recursive: true })`
    // is safe and a no-op when the dir already exists.
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    // T2 FIX: Atomic write via temp file + rename to prevent partial writes
    const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    try {
      await fs.writeFile(tempPath, args.content, "utf-8");
      await fs.rename(tempPath, filePath); // Atomic on most filesystems
    } catch (writeErr) {
      // Clean up temp file on failure
      await fs.unlink(tempPath).catch(() => {});
      throw writeErr;
    }

    const metadata = await fsGetMetadata(filePath);
    await ctx.db.setFileMetadata(metadata);

    await ctx.dependencyGraph.updateFile(filePath, args.content);
    await ctx.vectorDb.indexFile(filePath, args.content);
    await ctx.codeIntelligence.incrementalUpdate(filePath, args.content);
    ctx.cache.delete(`file:${filePath}`);

    return {
      success: true,
      versionId: existingMetadata ? newHash : "initial",
      metadata,
    };
  });
}

export interface AppendFileArgs {
  path: string;
  content: string;
  createIfMissing?: boolean;
}

export interface AppendFileResult {
  success: boolean;
  bytesAppended: number;
}

/**
 * Append content to an existing file. Optional `createIfMissing` flag allows
 * creating the file if absent. Scans appended content for secrets when the
 * file already exists. Enforces size budget against append.
 */
export async function appendFile(
  ctx: HandlerContext,
  args: AppendFileArgs
): Promise<AppendFileResult> {
  const filePath = validatePath(ctx, args.path);

  return withAudit(ctx, "write", filePath, async () => {
    const bytesToAppend = Buffer.byteLength(args.content, "utf-8");
    const maxSize = ctx.config.maxFileSize || 100 * 1024 * 1024;

    let fileExists = false;
    try {
      const stat = await fs.stat(filePath);
      fileExists = true;
      if (stat.size + bytesToAppend > maxSize) {
        throw new Error(
          `Appending ${bytesToAppend} bytes would exceed max file size (${maxSize} bytes)`
        );
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        if (!args.createIfMissing) {
          throw new Error(
            "File does not exist. Set createIfMissing=true to create it."
          );
        }
      } else {
        throw err;
      }
    }

    if (fileExists) {
      // Scan only the appended content for secrets
      const secrets = ctx.security.scanForSecrets(args.content, filePath);
      if (secrets.length > 0) {
        throw new Error(
          `Refusing to append content containing ${secrets.length} potential secret(s)`
        );
      }
    } else {
      // M11.5: createIfMissing path — ensure parent dir exists. Reached only
      // when the earlier ENOENT branch did NOT throw (i.e. createIfMissing
      // is true). validatePath has already confirmed filePath is inside
      // allowedDirectories, so mkdir on its parent stays inside the sandbox.
      await fs.mkdir(path.dirname(filePath), { recursive: true });
    }

    await fs.appendFile(filePath, args.content, "utf-8");
    ctx.cache.delete(`file:${filePath}`);
    ctx.cache.delete(`meta:${filePath}`);

    // Update metadata and index
    const content = await fs.readFile(filePath, "utf-8");
    const metadata = await fsGetMetadata(filePath);
    await ctx.db.setFileMetadata(metadata);
    await ctx.dependencyGraph.updateFile(filePath, content);
    await ctx.vectorDb.indexFile(filePath, content);
    await ctx.codeIntelligence.incrementalUpdate(filePath, content);

    ctx.logger.info("Content appended to file", {
      path: filePath,
      bytesAppended: bytesToAppend,
    });
    return { success: true, bytesAppended: bytesToAppend };
  });
}

export interface EditFileArgs {
  path: string;
  edits: Array<{ oldText: string; newText: string }>;
  /**
   * M13.2: when `true`, suppress the pre-flight risk scan
   * AND the post-edit integrity check. Use only when the agent has
   * independent justification (e.g. intentionally introducing a
   * template-literal backtick into a `.ts` file). Default: false.
   */
  unsafe?: boolean;
  /**
   * M13.2: when `true`, runs the full pipeline (risk scan,
   * apply edits in-memory, integrity check, diff summary) but DO NOT
   * write to disk and DO NOT touch metadata / dep-graph / vector index /
   * version history. The returned envelope reports what *would* happen.
   * Default: false.
   */
  dryRun?: boolean;
}

export interface EditFileResult {
  success: boolean;
  applied: number;
  /**
   * M13.2: pre-flight risk assessment. Always present. `level: 'low'`
   * means no warnings were detected; `'medium'`/`'high'` carry
   * actionable findings.
   */
  risk: EditRiskReport;
  /** M13.2: structural diff summary vs the prior content. */
  diff: EditDiffSummary;
  /** M13.2: true when `dryRun: true` was requested AND no write occurred. */
  dryRun: boolean;
}

/**
 * Apply find/replace edits sequentially. Throws if no `oldText` patterns
 * matched (no-op edits are an error). Updates metadata, dep graph, vector
 * index on success.
 *
 * M11-AUDIT FIX (MED-23): snapshots the prior content into version
 * history BEFORE writing, mirroring `writeFile`. Previously edits silently
 * dropped history — `rollback_file` could not undo an edit because no
 * version row was created.
 *
 * M13.2 (god-mode hardening): adds three layers of safety on
 * top of the M11 baseline:
 *   1. PRE-FLIGHT — `assessEditRisk` scans for known-dangerous patterns
 *      (most importantly, raw backticks injected into JS/TS files that
 *      already use template literals). The report is *always* attached
 *      to the response so the caller has the diagnostic regardless of
 *      whether the edit succeeded.
 *   2. POST-EDIT INTEGRITY — before writing the candidate to disk we
 *      run `verifyPostEditIntegrity`. JSON targets must JSON.parse; JS/TS
 *      targets must preserve their delimiter balance. A violation aborts
 *      the write, leaves the file untouched, and surfaces a structured
 *      `IntegrityViolation` to the caller. Bypass via `unsafe: true`.
 *   3. DRY-RUN — `dryRun: true` runs the entire pipeline through
 *      integrity-check + diff-summary but suppresses the write. Useful
 *      for agent self-verification before committing destructive edits.
 */
export async function editFile(
  ctx: HandlerContext,
  args: EditFileArgs
): Promise<EditFileResult> {
  const filePath = validatePath(ctx, args.path);
  const unsafe = args.unsafe === true;
  const dryRun = args.dryRun === true;

  return withAudit(ctx, dryRun ? "read" : "write", filePath, async () => {
    const currentContent = await fs.readFile(filePath, "utf-8");

    // M13.2 pre-flight: always compute the risk envelope (cheap; pure).
    const risk: EditRiskReport = unsafe
      ? { level: "low", warnings: [] }
      : assessEditRisk(filePath, currentContent, args.edits);

    // M11-AUDIT FIX (MED-24): use split+join rather than replaceAll.
    // String.prototype.replaceAll interprets `$` characters in the
    // replacement as special tokens (`$$` → `$`, `$&` → match, `$1` →
    // capture group), so an "identity" edit { oldText: "$$", newText:
    // "$$" } actually corrupts the file ("$$" → "$"). split/join is a
    // pure literal substitution.

    // M14 (Bug #1 — P2 Functional): CRLF mismatch fix.
    // `readFile` normalizes CRLF→LF for the agent, so agent-crafted
    // oldText uses LF. But `editFile` reads raw disk content (CRLF on
    // Windows). Fix: detect original line ending, normalize to LF for
    // matching, then restore original line ending style before writing.
    const hasCRLF = currentContent.includes('\r\n');
    const normalizedContent = hasCRLF
      ? currentContent.replace(/\r\n/g, '\n')
      : currentContent;

    let newContent = normalizedContent;
    let applied = 0;
    for (const edit of args.edits) {
      // Normalize edit.oldText too, in case it contains mixed line endings
      const normalizedOld = edit.oldText.replace(/\r\n/g, '\n');
      const normalizedNew = edit.newText.replace(/\r\n/g, '\n');
      const parts = newContent.split(normalizedOld);
      const count = parts.length - 1;
      if (count > 0) {
        newContent = parts.join(normalizedNew);
        applied += count;
      }
    }

    // M14 (Bug #8 — P3 Logic): detect sequential edit interference.
    // When edits are applied sequentially, a prior edit's newText may
    // introduce text that a later edit's oldText matches, causing
    // unintended replacements. Log a warning when this is detected.
    if (args.edits.length > 1) {
      for (let i = 0; i < args.edits.length; i++) {
        const normalizedNew = args.edits[i].newText.replace(/\r\n/g, '\n');
        for (let j = i + 1; j < args.edits.length; j++) {
          const laterOld = args.edits[j].oldText.replace(/\r\n/g, '\n');
          if (normalizedNew.includes(laterOld) && laterOld.length > 0) {
            ctx.logger.warn("Sequential edit interference detected", {
              editIndex: i,
              laterEditIndex: j,
              message: `Edit #${i}'s newText contains edit #${j}'s oldText — later edit may match unintended content`,
            });
          }
        }
      }
    }

    // Restore original line ending style if file was CRLF
    if (hasCRLF) {
      newContent = newContent.replace(/\n/g, '\r\n');
    }

    if (applied === 0) {
      throw new Error(
        "No edits were applied - none of the oldText patterns were found"
      );
    }

    // M13.2 post-edit integrity check. Returns null on success, or a
    // structured violation that callers can branch on. Bypass requires
    // explicit `unsafe: true`.
    if (!unsafe) {
      const violation = verifyPostEditIntegrity(
        filePath,
        currentContent,
        newContent
      );
      if (violation) {
        const err = new Error(
          `Edit aborted by integrity check: ${violation.code} — ${violation.message}`
        );
        type EditIntegrityError = Error & {
          violation?: typeof violation;
          risk?: typeof risk;
        };
        (err as EditIntegrityError).violation = violation;
        (err as EditIntegrityError).risk = risk;
        throw err;
      }
    }

    const diff = summarizeEditDiff(
      currentContent,
      newContent,
      args.edits.length,
      applied
    );

    // M13.2 dry-run: pipeline ran, integrity passed, diff captured.
    // Suppress the side-effecting half of the operation and return
    // a structured preview.
    if (dryRun) {
      return { success: true, applied, risk, diff, dryRun: true };
    }

    // M11-AUDIT FIX (MED-23): snapshot prior content for rollback before
    // overwriting. Skip when content is identical (no-op edit shouldn't
    // pollute version history).
    const oldHash = hashContent(currentContent);
    const newHash = hashContent(newContent);
    if (oldHash !== newHash) {
      await ctx.db.addVersion(
        filePath,
        oldHash,
        "system",
        `edit_file: ${applied} replacement${applied === 1 ? "" : "s"} across ${args.edits.length} pattern${args.edits.length === 1 ? "" : "s"}`,
        Buffer.byteLength(currentContent, "utf-8"),
        currentContent
      );
    }

    await fs.writeFile(filePath, newContent, "utf-8");

    const metadata = await fsGetMetadata(filePath);
    await ctx.db.setFileMetadata(metadata);
    await ctx.dependencyGraph.updateFile(filePath, newContent);
    await ctx.vectorDb.indexFile(filePath, newContent);
    await ctx.codeIntelligence.incrementalUpdate(filePath, newContent);
    ctx.cache.delete(`file:${filePath}`);

    return { success: true, applied, risk, diff, dryRun: false };
  });
}

export interface DeleteFileArgs {
  path: string;
}

export interface DeleteFileResult {
  success: boolean;
}

/**
 * Delete a file. Captures pre-delete content as a tombstone version row so
 * `rollback_file` can resurrect deleted files. Removes from dep graph +
 * vector index + cache.
 *
 * M12.2: previously `addVersion` ran BEFORE
 * `deleteFileMetadata`, but the latter manually cascades to the versions
 * table inside the same transaction (see `database.ts:deleteFileMetadata`
 * → `deleteVersionsByPath`), so the deletion snapshot was wiped within the
 * same write batch in which it was recorded. Compounding bug: the original
 * `addVersion` call also omitted the optional `content` argument, so even
 * if the row had survived the cascade, rollback would have hit the
 * "no stored content" guard.
 *
 * Fix: capture content first → unlink + deleteFileMetadata (cascade clears
 * stale history) → addVersion(..., content) materializes the sole post-
 * delete tombstone, preserving rollback-after-delete capability.
 */
export async function deleteFile(
  ctx: HandlerContext,
  args: DeleteFileArgs
): Promise<DeleteFileResult> {
  const filePath = validatePath(ctx, args.path);

  return withAudit(ctx, "delete", filePath, async () => {
    // Capture pre-delete snapshot BEFORE any destructive op. Wrapped in
    // try/catch because either the DB metadata or the on-disk file may be
    // absent — both are non-fatal for the snapshot. The destructive ops
    // below still run and surface real errors (e.g. ENOENT on unlink for
    // a truly missing file) so the public contract is preserved.
    let preDeleteContent: string | null = null;
    let preDeleteSize = 0;
    try {
      const metadata = await ctx.db.getFileMetadata(filePath);
      preDeleteContent = await fs.readFile(filePath, "utf-8");
      preDeleteSize =
        metadata?.size ?? Buffer.byteLength(preDeleteContent, "utf-8");
    } catch {
      // Snapshot capture failed (file or metadata missing) — proceed with
      // deletion without a tombstone.
    }

    await fs.unlink(filePath);
    // `deleteFileMetadata` cascades to versions in a single transaction.
    // Tombstone MUST be added AFTER this call to survive the cascade.
    await ctx.db.deleteFileMetadata(filePath);

    if (preDeleteContent !== null) {
      await ctx.db.addVersion(
        filePath,
        hashContent(preDeleteContent),
        "system",
        "File deleted",
        preDeleteSize,
        preDeleteContent // M12.2: pass content so `rollback_file` can restore it
      );
    }

    await ctx.vectorDb.removeFile(filePath);
    await ctx.dependencyGraph.removeFile(filePath);
    ctx.cache.delete(`file:${filePath}`);

    return { success: true };
  });
}

export interface ListDirectoryArgs {
  path: string;
  includeHidden?: boolean;
}

export interface ListDirectoryEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  /** Detected language (file only) — e.g. 'typescript', 'python', 'unknown'. */
  language?: string;
  /** ISO-8601 mtime (file only). */
  modified?: string;
}

export interface ListDirectoryResult {
  entries: ListDirectoryEntry[];
}

/**
 * List directory entries. Filters out dotfiles unless `includeHidden=true`.
 * Stats every file to attach `size`, `language`, and `modified`. Directories
 * carry only `name + path + type`.
 *
 * M11-AUDIT FIX (MED-11): previously returned only `{name, path, type, size?}`
 * even though tool description advertised `language?` and `modified?` —
 * that contract drift is now resolved.
 */
export async function listDirectory(
  ctx: HandlerContext,
  args: ListDirectoryArgs
): Promise<ListDirectoryResult> {
  const dirPath = validatePath(ctx, args.path);

  return withAudit(ctx, "read", dirPath, async () => {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    // Stat all files in parallel for ~Nx speedup on directories with many entries.
    const fileStatPromises: Array<Promise<ListDirectoryEntry | null>> = [];
    const dirEntries: ListDirectoryEntry[] = [];

    for (const entry of entries) {
      if (!args.includeHidden && entry.name.startsWith(".")) {
        continue;
      }

      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        dirEntries.push({ name: entry.name, path: fullPath, type: "directory" });
      } else {
        fileStatPromises.push(
          fs.stat(fullPath).then((stats): ListDirectoryEntry => ({
            name: entry.name,
            path: fullPath,
            type: "file",
            size: stats.size,
            language: detectLanguage(entry.name),
            modified: stats.mtime.toISOString(),
          })).catch((): ListDirectoryEntry => ({
            // Stat failed (file vanished mid-listing, permission denied, etc.).
            // Fall back to minimal entry — preserve listing rather than abort.
            name: entry.name,
            path: fullPath,
            type: "file",
            language: detectLanguage(entry.name),
          }))
        );
      }
    }

    const fileEntries = await Promise.all(fileStatPromises);
    const result: ListDirectoryEntry[] = [
      ...dirEntries,
      ...fileEntries.filter((e): e is ListDirectoryEntry => e !== null),
    ];
    return { entries: result };
  });
}
