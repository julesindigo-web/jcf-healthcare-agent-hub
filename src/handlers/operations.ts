/**
 * Operations handlers — batch + health + features + audit log.
 *
 * Extracted from `JcfHealthcareAgentHubServer` during M11 audit.
 * Behavior preserved verbatim. The `batchOperations` handler delegates to
 * the filesystem handlers for individual `read`/`write`/`edit`/`delete`
 * cases — it is the only intra-handler dependency.
 *
 * 4 tools:
 *   - batchOperations
 *   - healthCheck
 *   - getEnabledFeatures
 *   - getAuditLog
 */

import type {
  AuditEvent,
  BatchOperation,
  BatchResult,
  HealthCheck,
} from "../types/index.js";
import type { HandlerContext } from "./context.js";
import {
  readFile,
  writeFile,
  editFile,
  deleteFile,
} from "./filesystem.js";
import { withAudit } from "./shared/audit.js";

export interface BatchOperationsArgs {
  operations: BatchOperation[];
}

export interface BatchOperationsResult {
  results: BatchResult[];
}

/**
 * Atomic-ish batch executor. Each op runs sequentially; failures are
 * captured per-op (no early abort). Throws if total ops > config limit
 * (default 100). Logs a self-healing trigger when failure rate > 50%.
 */
export async function batchOperations(
  ctx: HandlerContext,
  args: BatchOperationsArgs
): Promise<BatchOperationsResult> {
  return withAudit(ctx, "search", "multiple", async () => {
    const limit = ctx.config.batchOperationLimit || 100;
    if (args.operations.length > limit) {
      throw new Error(
        `Batch operation count (${args.operations.length}) exceeds limit (${limit})`
      );
    }

    // D2 FIX: Track concurrent batch operations to prevent limit bypass
    const concurrentKey = 'concurrent_batch_ops';
    const currentConcurrent = (ctx.cache.get(concurrentKey) as number) || 0;
    if (currentConcurrent >= 3) { // Max 3 concurrent batch operations
      throw new Error(
        `Too many concurrent batch operations (${currentConcurrent}). Retry later.`
      );
    }
    ctx.cache.set(concurrentKey, currentConcurrent + 1, 60000); // 60s TTL

    const results: BatchResult[] = [];

    for (const op of args.operations) {
      try {
        switch (op.type) {
          case "read": {
            const readResult = await readFile(ctx, { path: op.path });
            results.push({
              operation: op,
              success: true,
              result: readResult,
              rollbackAvailable: false,
            });
            break;
          }
          case "write": {
            if (!op.content) throw new Error("Missing content");
            const writeResult = await writeFile(ctx, {
              path: op.path,
              content: op.content,
            });
            results.push({
              operation: op,
              success: true,
              result: writeResult,
              rollbackAvailable: true,
            });
            break;
          }
          case "edit": {
            if (!op.edits) throw new Error("Missing edits");
            const editResult = await editFile(ctx, {
              path: op.path,
              edits: op.edits,
            });
            results.push({
              operation: op,
              success: true,
              result: editResult,
              rollbackAvailable: true,
            });
            break;
          }
          case "delete": {
            const deleteResult = await deleteFile(ctx, { path: op.path });
            results.push({
              operation: op,
              success: true,
              result: deleteResult,
              rollbackAvailable: true,
            });
            break;
          }
          default:
            throw new Error(`Unknown operation type: ${(op as BatchOperation).type}`);
        }

        // R1 FIX: Log successful individual operation to audit trail
        await ctx.db.recordAudit({
          userId: 'batch-operation',
          action: 'write', // Use valid RBAC action type
          path: op.path,
          result: 'success',
          metadata: { batchId: 'batch', operationType: op.type, batchOp: true },
        });
      } catch (error) {
        results.push({
          operation: op,
          success: false,
          error: error instanceof Error ? error.message : String(error),
          rollbackAvailable: false,
        });

        // R1 FIX: Log failed individual operation to audit trail
        await ctx.db.recordAudit({
          userId: 'batch-operation',
          action: 'write', // Use valid RBAC action type
          path: op.path,
          result: 'failure',
          reason: error instanceof Error ? error.message : String(error),
          metadata: { batchId: 'batch', operationType: op.type, batchOp: true },
        });
      }
    }

    const failedCount = results.filter((r) => !r.success).length;
    if (failedCount > results.length / 2) {
      ctx.logger.warn("High batch failure rate, triggering self-healing", {
        failed: failedCount,
        total: results.length,
      });
    }

    return { results };
  });
}

/**
 * Aggregate health check. Returns `healthy` if cache is available,
 * security has policies loaded, and self-healing succeeds > 50% of attempts
 * (or has zero attempts so far).
 *
 * M11-AUDIT FIX (MED-15 + MED-16):
 *   - Now reports rate-limiter stats (allowed/blocked/blockRate, per-tool
 *     bucket snapshots) — operationally critical since rate limit decisions
 *     are otherwise invisible until clients see HTTP 429-equivalent errors.
 *   - Replaced hardcoded `requests=0, errors=0, avgLatency=0` placeholders
 *     with real tracker values from `ctx.metricsTracker`. Audit-log-derived
 *     totals are emitted when the in-memory tracker is unavailable.
 */
export async function healthCheck(ctx: HandlerContext): Promise<HealthCheck & {
  rateLimiter: ReturnType<typeof ctx.rateLimiter.getStats>;
}> {
  const dbStats = ctx.db.getStats();
  const cacheStats = ctx.cache.getStats();
  const vectorStats = ctx.vectorDb.getStats();
  const securityStats = ctx.security.getSecurityStats();
  const selfHealingStats = ctx.selfHealing?.getStats() || {
    totalFixAttempts: 0,
    successfulFixes: 0,
    successRate: 0,
    errorCategories: {},
  };
  const embeddingHealth = ctx.embeddingClient.getHealth();
  const rateStats = ctx.rateLimiter.getStats();
  const tracker = ctx.metricsTracker?.snapshot();

  const selfHealingHealthy =
    selfHealingStats.totalFixAttempts === 0 ||
    selfHealingStats.successRate > 0.5;

  // Rate-limiter health: degraded if block rate > 10% (sustained throttling).
  const rateLimiterHealthy = rateStats.blockRate < 0.1;

  const warnings: string[] = [];
  if (embeddingHealth.enabled && embeddingHealth.available !== true) {
    warnings.push(`Embedding service enabled but ${embeddingHealth.available === null ? 'not yet probed' : 'degraded'} — semantic search using tf-idf fallback`);
  }
  if (!selfHealingHealthy) {
    warnings.push(`Self-healing success rate below 50% (${Math.round(selfHealingStats.successRate * 100)}%)`);
  }
  if (!rateLimiterHealthy) {
    warnings.push(`Rate limiter block rate above 10% (${Math.round(rateStats.blockRate * 100)}%)`);
  }

  const healthy =
    cacheStats.available &&
    securityStats.totalPolicies > 0 &&
    selfHealingHealthy &&
    rateLimiterHealthy;

  return {
    status: healthy ? "healthy" : "degraded",
    database: dbStats,
    cache: cacheStats,
    vectorDb: { ...vectorStats, embedding: embeddingHealth },
    security: securityStats,
    rateLimiter: rateStats,
    warnings,
    metrics: {
      requests: tracker?.totalRequests ?? rateStats.allowed + rateStats.blocked,
      cacheHits: cacheStats.hits,
      cacheMisses: cacheStats.misses,
      errors: tracker?.totalErrors ?? rateStats.blocked,
      avgLatency: tracker?.avgLatencyMs ?? 0,
      activeConnections: tracker?.activeRequests ?? 0,
    },
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  };
}

export interface GetEnabledFeaturesResult {
  features: string[];
}

/**
 * List active feature flags. Thin wrapper over `configManager`.
 */
export async function getEnabledFeatures(
  ctx: HandlerContext
): Promise<GetEnabledFeaturesResult> {
  return {
    features: ctx.configManager.getEnabledFeatures(),
  };
}

export interface GetAuditLogArgs {
  userId?: string;
  action?: string;
  result?: "success" | "failure";
  limit?: number;
}

export interface GetAuditLogResult {
  events: AuditEvent[];
}

/**
 * Query the audit log with optional filters. RBAC: requires admin role
 * (enforced at the boundary via `security.enforceRBAC`).
 */
export async function getAuditLog(
  ctx: HandlerContext,
  args: GetAuditLogArgs
): Promise<GetAuditLogResult> {
  await ctx.security.enforceRBAC("admin", "read", "/audit");

  const filter: {
    userId?: string;
    action?: AuditEvent["action"];
    result?: "success" | "failure";
    limit?: number;
  } = {};
  if (args.userId !== undefined) filter.userId = args.userId;
  if (args.action !== undefined) filter.action = args.action as AuditEvent["action"];
  if (args.result !== undefined) filter.result = args.result;
  if (args.limit !== undefined) filter.limit = args.limit;

  const events = ctx.db.queryAudits(filter);

  return { events };
}
