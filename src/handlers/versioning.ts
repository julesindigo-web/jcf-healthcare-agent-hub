/**
 * Versioning handlers — version history + rollback + current metadata.
 *
 * Extracted from `JcfHealthcareAgentHubServer` during M11 audit.
 * Behavior preserved verbatim.
 *
 * 3 tools:
 *   - getVersionHistory
 *   - rollbackFile
 *   - getMetadata
 */

import fs from "fs/promises";
import path from "path";
import type { FileMetadata, VersionInfo } from "../types/index.js";
import type { HandlerContext } from "./context.js";
import { validatePath } from "./shared/path-guard.js";
import { withAudit } from "./shared/audit.js";
import { fsGetMetadata } from "./shared/metadata.js";
import { hashContent } from "./shared/util.js";

export interface GetVersionHistoryArgs {
  path: string;
  limit?: number;
}

export interface GetVersionHistoryResult {
  versions: VersionInfo[];
}

/**
 * Return version history sorted newest-first. Optional `limit` truncates
 * the result.
 */
export async function getVersionHistory(
  ctx: HandlerContext,
  args: GetVersionHistoryArgs
): Promise<GetVersionHistoryResult> {
  const filePath = validatePath(ctx, args.path);

  return withAudit(ctx, "read", filePath, async () => {
    const versions = ctx.db.getVersions(filePath);
    const sorted = versions.sort(
      (a, b) => b.timestamp.getTime() - a.timestamp.getTime()
    );
    return {
      versions: args.limit ? sorted.slice(0, args.limit) : sorted,
    };
  });
}

export interface RollbackFileArgs {
  path: string;
  versionId: string;
}

export interface RollbackFileResult {
  success: boolean;
}

/**
 * Restore a file to a previous version. Captures a pre-rollback snapshot
 * of the current content (best-effort) before overwriting. Throws if the
 * target version doesn't exist or has no stored content.
 */
export async function rollbackFile(
  ctx: HandlerContext,
  args: RollbackFileArgs
): Promise<RollbackFileResult> {
  const filePath = validatePath(ctx, args.path);

  return withAudit(ctx, "write", filePath, async () => {
    const versions = ctx.db.getVersions(filePath);
    const targetVersion = versions.find((v) => v.id === args.versionId);

    if (!targetVersion) {
      throw new Error(`Version ${args.versionId} not found`);
    }

    if (!targetVersion.content) {
      throw new Error(
        `Version ${args.versionId} has no stored content — rollback not possible (version created before content storage was implemented)`
      );
    }

    // Save current state as a version before rollback
    try {
      const currentContent = await fs.readFile(filePath, "utf-8");
      const currentHash = hashContent(currentContent);
      await ctx.db.addVersion(
        filePath,
        currentHash,
        "system",
        `Pre-rollback snapshot (before restoring ${args.versionId})`,
        Buffer.byteLength(currentContent, "utf-8"),
        currentContent
      );
    } catch {
      // File may not exist yet, skip pre-rollback snapshot
    }

    // M11.5: defensive mkdir — version content may pre-date a directory
    // restructure (e.g. rename), so the parent dir might not exist anymore.
    // validatePath already confirmed filePath is inside allowedDirectories,
    // so this stays inside the sandbox. No-op when the dir already exists.
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    // Restore the target version's content
    await fs.writeFile(filePath, targetVersion.content, "utf-8");

    const metadata = await fsGetMetadata(filePath);
    await ctx.db.setFileMetadata(metadata);
    await ctx.dependencyGraph.updateFile(filePath, targetVersion.content);
    await ctx.vectorDb.indexFile(filePath, targetVersion.content);
    ctx.cache.delete(`file:${filePath}`);

    ctx.logger.info("File rolled back successfully", {
      path: filePath,
      versionId: args.versionId,
    });
    return { success: true };
  });
}

export interface GetMetadataArgs {
  path: string;
}

export interface GetMetadataResult {
  metadata: FileMetadata | null;
}

/**
 * Return cached file metadata from the DB. Does NOT re-read the file from
 * disk — use `readFile` if you need fresh content + metadata together.
 */
export async function getMetadata(
  ctx: HandlerContext,
  args: GetMetadataArgs
): Promise<GetMetadataResult> {
  const filePath = validatePath(ctx, args.path);

  return withAudit(ctx, "read", filePath, async () => {
    const metadata = ctx.db.getFileMetadata(filePath);
    return { metadata };
  });
}
