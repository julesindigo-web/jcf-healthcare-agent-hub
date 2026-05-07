/**
 * Audit + RBAC wrapper. Extracted from `JcfHealthcareAgentHubServer.withAudit` and
 * `getCurrentUser` during M11 audit.
 *
 * `withAudit` wraps a handler body with:
 *   - RBAC check (skipped for `read` action — preserves original behavior).
 *   - Successful audit log on completion.
 *   - Failure audit log + rethrow on error.
 *
 * `getCurrentUser` resolves the current user via two paths in priority order:
 *   1. (T3.2 RBAC) `MCP_FS_AUTH_TOKEN` env — validated against the
 *      `auth_tokens` DB store. Identity is `{ id, role, label }` from the
 *      validated token. An invalid token THROWS rather than silently
 *      falling back, so misconfiguration fails loud.
 *   2. (Legacy) `MCP_FS_USER_ID` / `MCP_FS_USER_ROLE` env — kept for
 *      backward compatibility with single-tenant local agents that
 *      pre-date the token store.
 */

import type { AuditEvent } from "../../types/index.js";
import type { HandlerContext } from "../context.js";
import { validateToken } from "../../lib/auth-tokens.js";

/**
 * RBAC + audit envelope around a handler body. Behavior preserved verbatim
 * from the original `withAudit` method on `JcfHealthcareAgentHubServer`.
 *
 * - `read` actions skip RBAC enforcement (matches original behavior).
 * - All other actions resolve the current user via {@link getCurrentUser},
 *   then enforce RBAC via `ctx.security.enforceRBAC` BEFORE invoking `fn`.
 * - Success path records a `result: "success"` audit event with duration.
 * - Failure path records `result: "failure"` with the error message,
 *   then rethrows the original error.
 */
export async function withAudit<T>(
  ctx: HandlerContext,
  action: AuditEvent["action"],
  filePath: string,
  fn: () => Promise<T>
): Promise<T> {
  const startTime = Date.now();
  let userId = "anonymous";

  try {
    const userContext = await getCurrentUser(ctx);
    userId = userContext.id;
    await ctx.security.enforceRBAC(userContext.role, action, filePath);

    const result = await fn();

    await ctx.db.recordAudit({
      userId,
      action,
      path: filePath,
      result: "success",
      metadata: { duration: Date.now() - startTime },
    });

    return result;
  } catch (error) {
    await ctx.db.recordAudit({
      userId,
      action,
      path: filePath,
      result: "failure",
      reason: error instanceof Error ? error.message : String(error),
      metadata: { duration: Date.now() - startTime },
    });

    throw error;
  }
}

/**
 * Resolve the current user.
 *
 * Priority:
 *   1. `MCP_FS_AUTH_TOKEN` env (T3.2) → validate against `auth_tokens`
 *      DB store. On hit: returns the validated identity. On miss / expired
 *      / revoked / malformed: THROWS so misconfiguration fails loud.
 *   2. `MCP_FS_USER_ID` / `MCP_FS_USER_ROLE` env (legacy) → returns the
 *      env-supplied identity. Default `id="default-user"`, role inferred
 *      from id ("admin" maps to admin, anything else to user).
 *
 * The `ctx` parameter is required for path 1; if the `MCP_FS_AUTH_TOKEN`
 * env is unset, `ctx` is unused and the legacy env-only path runs.
 */
export async function getCurrentUser(
  ctx?: HandlerContext
): Promise<{ id: string; role: string; label?: string }> {
  // Path 1 — token-based RBAC (T3.2). Only attempted when env is set
  // AND a HandlerContext (carrying the DB) is available. Tests / CLI
  // tooling that call getCurrentUser() without a context fall through
  // to the legacy env path even if MCP_FS_AUTH_TOKEN happens to be set.
  const tokenEnv = process.env.MCP_FS_AUTH_TOKEN;
  if (tokenEnv && tokenEnv.length > 0 && ctx) {
    const validated = validateToken(ctx.db, tokenEnv);
    if (!validated) {
      throw new Error(
        "MCP_FS_AUTH_TOKEN is set but failed validation " +
          "(token unknown / revoked / expired / malformed). " +
          "Identity refuses to silently downgrade to legacy env path " +
          "when an explicit token is configured."
      );
    }
    return { id: validated.id, role: validated.role, label: validated.label };
  }

  // Path 2 — legacy env-based identity (single-tenant backward compat).
  const userId = process.env.MCP_FS_USER_ID || "default-user";
  const role =
    process.env.MCP_FS_USER_ROLE ||
    (userId === "admin" ? "admin" : "user");
  return { id: userId, role };
}
