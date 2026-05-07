/**
 * Handler context for jcf-healthcare-agent-hub.
 *
 * Carries every service + config + logger that any handler may need. Built
 * once during `JcfHealthcareAgentHubServer.initialize()` and threaded through every
 * tool call. Mirrors the M10 jcf-memory pattern: pure handler functions take a
 * typed context object instead of relying on `this`.
 *
 * Created in M11 audit as part of the server.ts decomposition.
 */

import type { ConfigManager, Config } from "../lib/config.js";
import type { Logger } from "../lib/logger.js";
import type { Database } from "../lib/database.js";
import type { Cache } from "../lib/cache.js";
import type { VectorDB } from "../lib/vector-db.js";
import type { SecurityManager } from "../lib/security.js";
import type { DependencyGraph } from "../lib/dependency-graph.js";
import type { SelfHealing } from "../lib/self-healing.js";
import type { CognitiveIndexEngine } from "../lib/cognitive-index.js";
import type { NodeLevelKnowledgeGraph } from "../lib/node-knowledge-graph.js";
import type { PatternDetector } from "../lib/pattern-detector.js";
import type { TypeFlowAnalyzer } from "../lib/type-flow-analyzer.js";
import type { CodeIntelligenceEngine } from "../lib/code-intelligence.js";
import type { EmbeddingClient } from "../lib/embedding-client.js";
import type { RateLimiter } from "../lib/rate-limiter.js";
import type { MetricsTracker } from "../lib/metrics-tracker.js";
import type { JobManager } from "../lib/job-manager.js";

/**
 * Progress reporter — minimal interface that handlers use to emit progress
 * for long-running operations. Wired by the dispatcher per-call when the
 * MCP request supplies a `_meta.progressToken`; `undefined` for synchronous
 * tests or clients that don't request progress.
 *
 * M11-AUDIT FIX (CRIT-1): long-running ops were silent before this fix.
 * Now `buildCognitiveIndex`, `semantic_search` auto-index; etc.
 * emit lifecycle progress so callers can render a status indicator.
 */
export interface ProgressChannel {
  /** Emit a progress notification (best-effort, never throws). */
  send: (params: {
    progress: number;
    total?: number;
    message?: string;
  }) => void;
}

/**
 * Bundle of every service + config + logger available to handlers.
 * Constructed once in `JcfHealthcareAgentHubServer.initialize()`.
 *
 * `selfHealing` is optional because the server marks it `?` in its own field
 * declaration (it may be deferred during early init). Every other service is
 * mandatory.
 *
 * `progress` and `metricsTracker` are populated per-call by the dispatcher
 * when the MCP transport supports them; handlers guard with optional chaining.
 */
export interface HandlerContext {
  configManager: ConfigManager;
  config: Config;
  logger: Logger;
  db: Database;
  cache: Cache;
  vectorDb: VectorDB;
  security: SecurityManager;
  dependencyGraph: DependencyGraph;
  selfHealing?: SelfHealing | undefined;
  cognitiveIndex: CognitiveIndexEngine;
  nlkg: NodeLevelKnowledgeGraph;
  patternDetector: PatternDetector;
  typeFlowAnalyzer: TypeFlowAnalyzer;
  codeIntelligence: CodeIntelligenceEngine;
  embeddingClient: EmbeddingClient;
  rateLimiter: RateLimiter;
  /** Optional JobManager for background builds (M14 2026-05-02). */
  jobManager?: JobManager | undefined;
  /** Optional metrics tracker (M11-AUDIT MED-15/16). */
  metricsTracker?: MetricsTracker | undefined;
  /** Optional progress channel (M11-AUDIT CRIT-1). Per-call wiring. */
  progress?: ProgressChannel | undefined;
}

/**
 * Pure factory — no allocations, no side-effects, just a typed bundle.
 * Kept as a function (vs object literal) so callers can validate / log if
 * needed in future revisions.
 */
export function buildHandlerContext(deps: HandlerContext): HandlerContext {
  return deps;
}

/**
 * Generic handler signature: takes the shared context plus tool-specific args
 * and returns whatever the tool produces. The `args` type is intentionally
 * `unknown` at this level; each handler narrows it via its own zod-validated
 * args type.
 */
export type ToolHandler<Args = unknown, Result = unknown> = (
  ctx: HandlerContext,
  args: Args
) => Promise<Result>;
