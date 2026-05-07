/**
 * Diagnostic handlers for JCF Healthcare Agent Hub.
 *
 * ADR-H001: Constitutional enforcement removed from healthcare hub.
 * This module provides only `ping` — a pure health check with no
 * JCF §0 enforcement dependency. Healthcare domain users have no need
 * for constitutional binding gates.
 *
 * Tools:
 *   - `ping` — health check + DB stats
 */

import type { HandlerContext } from "../handlers/context.js";

/**
 * Map of diagnostic tool name → handler implementation.
 * Merged into TOOL_REGISTRY in registry.ts.
 */
export const diagnosticsHandlers: Record<string, (ctx: HandlerContext, args: any) => Promise<any>> = {

  // ────────────────────────────────────────────────────────
  // PING — health check + DB stats
  // ────────────────────────────────────────────────────────
  ping: async (ctx: HandlerContext, _args: any) => {
    const stats = ctx.db.getStats();
    return {
      status: "online",
      server: "jcf-healthcare-agent-hub",
      version: ctx.config.serverVersion,
      db_path: ctx.config.databasePath,
      stats: {
        files: stats.fileCount,
        versions: stats.versionCount,
        audits: stats.auditCount,
        size_bytes: stats.sizeBytes,
      },
      timestamp: new Date().toISOString(),
    };
  },
};
