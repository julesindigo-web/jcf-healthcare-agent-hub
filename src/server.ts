/**
 * JCF Healthcare Agent Hub — thin MCP server orchestrator.
 *
 * Decomposed during M11 audit. The previous monolithic 1403-line
 * version embedded every tool's logic inline; this version is purely an
 * orchestration layer:
 *
 *   1. `initialize()` boots every service and builds a {@link HandlerContext}.
 *   2. `setupTools()` iterates the {@link TOOL_REGISTRY} and wires each
 *      `name → { schema, handler }` entry into the MCP server.
 *   3. The dispatcher closure applies rate limiting → invokes the pure
 *      handler → wraps the result into the standard MCP envelope.
 *
 * All actual tool logic lives under `handlers/*` as pure async functions
 * that take `(ctx, args)` and return their result. Audit + RBAC + path
 * validation are handled inside those modules via the shared helpers in
 * `handlers/shared/`.
 *
 * Adding a new tool: implement the handler, add a registry entry,
 * add a description. No change here.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { Logger } from "./lib/logger.js";
import { ConfigManager, initializeConfig } from "./lib/config.js";
import type { Config } from "./lib/config.js";
import { Database } from "./lib/database.js";
import { Cache } from "./lib/cache.js";
import { VectorDB } from "./lib/vector-db.js";
import { SecurityManager } from "./lib/security.js";
import { DependencyGraph } from "./lib/dependency-graph.js";
import { SelfHealing } from "./lib/self-healing.js";
import { CognitiveIndexEngine } from "./lib/cognitive-index.js";
import { NodeLevelKnowledgeGraph } from "./lib/node-knowledge-graph.js";
import { PatternDetector } from "./lib/pattern-detector.js";
import { TypeFlowAnalyzer } from "./lib/type-flow-analyzer.js";
import { CodeIntelligenceEngine } from "./lib/code-intelligence.js";
import { RateLimiter, RateLimitExceededError } from "./lib/rate-limiter.js";
import { EmbeddingClient } from "./lib/embedding-client.js";
import { MetricsTracker } from "./lib/metrics-tracker.js";
import { JobManager } from "./lib/job-manager.js";

import { PACKAGE_NAME, SERVER_VERSION } from "./version.js";
import { getToolDescription } from "./tool-descriptions.js";

import type { HandlerContext, ProgressChannel } from "./handlers/context.js";
import { buildHandlerContext } from "./handlers/context.js";
import { TOOL_REGISTRY } from "./registry.js";

/**
 * Top-level MCP server. Owns every service lifecycle (boot + shutdown) and
 * delegates all tool calls to handlers via the {@link TOOL_REGISTRY}.
 */
export class JcfHealthcareAgentHubServer {
  private server: McpServer;

  // ── Service members. Populated by `initialize()`. ──
  private configManager!: ConfigManager;
  private config!: Config;
  private logger!: Logger;
  private db!: Database;
  private cache!: Cache;
  private vectorDb!: VectorDB;
  private security!: SecurityManager;
  private dependencyGraph!: DependencyGraph;
  private selfHealing?: SelfHealing;
  private cognitiveIndex!: CognitiveIndexEngine;
  private nlkg!: NodeLevelKnowledgeGraph;
  private patternDetector!: PatternDetector;
  private typeFlowAnalyzer!: TypeFlowAnalyzer;
  private codeIntelligence!: CodeIntelligenceEngine;
  private embeddingClient!: EmbeddingClient;
  private rateLimiter!: RateLimiter;
  private metricsTracker!: MetricsTracker;
  private jobManager!: JobManager;

  /**
   * Bundle injected into every handler. Built once during `initialize()`,
   * reused for every tool call. Exposed as a private member so subclasses
   * (e.g. test harnesses) can inspect it; internal handlers always receive
   * it via parameter passing.
   */
  private ctx!: HandlerContext;

  constructor() {
    this.server = new McpServer(
      { name: PACKAGE_NAME, version: SERVER_VERSION },
      { capabilities: { tools: {} } }
    );
  }

  /**
   * Boot every service in order. Failure at any stage propagates as a
   * thrown error and is logged + caught by `index.ts main()`.
   */
  async initialize(): Promise<void> {
    this.configManager = await initializeConfig();
    this.config = this.configManager.getConfig();
    this.logger = this.configManager.logger;
    this.db = new Database(this.configManager.getDatabasePath(), this.logger);
    await this.db.initialize();

    this.cache = new Cache({
      maxSize: this.config.cacheMaxSize,
      ttl: this.config.cacheTTL,
      logger: this.logger,
    });
    await this.cache.initialize();

    // ADR-006 (M12) — wire the new chunking + warmup
    // budgets through to the EmbeddingClient. Defaults remain the
    // historical 30s/100/60s tuple; ops override via mcp-fs-config.json
    // or MCP_FS_EMBEDDING* env vars.
    this.embeddingClient = new EmbeddingClient({
      url: this.config.embeddingUrl,
      timeoutMs: this.config.embeddingTimeoutMs,
      reprobeMs: this.config.embeddingReprobeMs,
      enabled: this.config.embeddingEnabled,
      logger: this.logger,
      defaultInstruct: this.config.embeddingInstructFile,
      batchChunkSize: this.config.embeddingBatchChunkSize,
      warmupTimeoutMs: this.config.embeddingWarmupTimeoutMs,
    });

    this.vectorDb = new VectorDB({
      path: this.config.vectorDbPath,
      dimension: this.config.vectorDimension,
      logger: this.logger,
      embeddingClient: this.embeddingClient,
      // ADR-006 — drive boot-time dim validation off the config-declared
      // producer dim. When the embedder upgrades model rev (e.g. 0.6B →
      // 1.5B with a different dim), bump this and stale rows get nuked
      // automatically on the next MCP boot.
      expectedQwen3Dim: this.config.embeddingDims,
    });
    await this.vectorDb.initialize();

    // ADR-006 (M12) — fire-and-forget pre-warm. Amortises the ~7.3 s
    // safetensors cold-load before the first real embed. Best-effort:
    // any failure (404 on legacy server, network down, timeout) is
    // swallowed by `preWarm` itself — the bridge falls back to the
    // standard lazy-load path on the next embed call. Wrapped in
    // `void` so initialize() doesn't await it; the worst case is a
    // few seconds of degraded search at boot which is preferable to
    // blocking the whole MCP startup on the embedder.
    void this.embeddingClient
      .preWarm()
      .then((duration) => {
        if (duration !== undefined) {
          this.logger.info("Embedder pre-warm complete", { durationMs: duration });
        }
      })
      .catch(() => {
        /* preWarm already logs; never propagate */
      });

    this.security = new SecurityManager({
      policiesPath: this.config.policiesPath,
      logger: this.logger,
      allowedDirectories: this.config.allowedDirectories,
      forbiddenPaths: this.config.forbiddenPaths,
      db: this.db,
      enableRBAC: this.config.enableRBAC,
      enableSecretsScan: this.config.enableSecretsScan,
      enableAuditLog: this.config.enableAuditLog,
    });
    await this.security.loadPolicies();

    this.dependencyGraph = new DependencyGraph({
      db: this.db,
      logger: this.logger,
    });
    await this.dependencyGraph.initialize();

    this.selfHealing = new SelfHealing({
      logger: this.logger,
      cache: this.cache,
      db: this.db,
    });

    // R-1: pass cognitiveIndexPath explicitly. The
    // engine's constructor anchors relative paths via install-root, so
    // even with the default '.jcf-cognitive-index.json' the file lands
    // in <install-root> rather than <process.cwd()>. This eliminates the
    // `Step Flash` symptom where `.integ-*` test fixtures clobbered the
    // workspace-root index.
    this.cognitiveIndex = new CognitiveIndexEngine({
      logger: this.logger,
      indexPath: this.config.cognitiveIndexPath,
    });
    await this.cognitiveIndex.initialize();

    this.nlkg = new NodeLevelKnowledgeGraph({ logger: this.logger });
    await this.nlkg.initialize();

    this.patternDetector = new PatternDetector({ logger: this.logger });
    await this.patternDetector.initialize();

    this.typeFlowAnalyzer = new TypeFlowAnalyzer({ logger: this.logger });
    await this.typeFlowAnalyzer.initialize();

    this.codeIntelligence = new CodeIntelligenceEngine({
      logger: this.logger,
      db: this.db,
      cognitiveIndex: this.cognitiveIndex,
      nlkg: this.nlkg,
      patternDetector: this.patternDetector,
      typeFlowAnalyzer: this.typeFlowAnalyzer,
    });
    await this.codeIntelligence.initialize();

    // Phase C3: generous rate-limiter — neither too restrictive nor too permissive.
    // Normal interactive workflows never hit these ceilings; only pathological loops get throttled.
    this.rateLimiter = new RateLimiter({ logger: this.logger });

    // M11-AUDIT FIX (MED-15 + MED-16): real per-tool metrics tracker.
    this.metricsTracker = new MetricsTracker({ logger: this.logger });

    // M14 (2026-05-02): JobManager for background builds.
    this.jobManager = new JobManager({ logger: this.logger });

    // Build the base handler context. The dispatcher clones this per-call
    // to attach a per-request `progress` channel (when the MCP transport
    // supports notifications); metricsTracker stays shared.
    this.ctx = buildHandlerContext({
      configManager: this.configManager,
      config: this.config,
      logger: this.logger,
      db: this.db,
      cache: this.cache,
      vectorDb: this.vectorDb,
      security: this.security,
      dependencyGraph: this.dependencyGraph,
      selfHealing: this.selfHealing,
      cognitiveIndex: this.cognitiveIndex,
      nlkg: this.nlkg,
      patternDetector: this.patternDetector,
      typeFlowAnalyzer: this.typeFlowAnalyzer,
      codeIntelligence: this.codeIntelligence,
      embeddingClient: this.embeddingClient,
      rateLimiter: this.rateLimiter,
      metricsTracker: this.metricsTracker,
      jobManager: this.jobManager,
    });

    this.setupTools();

    this.logger.info("JCF Healthcare Agent Hub server initialized", {
      features: this.configManager.getEnabledFeatures(),
    });
  }

  /**
   * Wire every entry in {@link TOOL_REGISTRY} into the MCP server.
   * Each tool's dispatcher closure applies rate limiting first, then
   * invokes the pure handler with the shared context, then wraps the
   * result into the standard MCP `{ content: [{ type, text }] }` envelope.
   */
  private setupTools(): void {
    for (const [name, registration] of Object.entries(TOOL_REGISTRY)) {
      this.registerOne(name, registration.schema, registration.handler);
    }
  }

  /**
   * Per-tool registration helper.
   *
   * M11-AUDIT WIRING:
   *   - **CRIT-1 (progress)**: extracts `_meta.progressToken` from MCP
   *     `extra`, builds a per-call `ProgressChannel` that emits
   *     `notifications/progress` when the client requested progress.
   *     When no token is provided, the channel is `undefined` and handlers
   *     guard with optional chaining — zero overhead path.
   *   - **MED-14 (self-healing)**: handler errors now flow through
   *     `selfHealing.healError()` before rethrow. Healing is best-effort:
   *     when it succeeds, the original error is swallowed and a
   *     "self-healed" envelope is returned. Otherwise the original error
   *     is rethrown unchanged.
   *   - **MED-15/16 (metrics)**: every dispatch is bracketed by
   *     `metricsTracker.markStart` / `markEnd` so `health_check` returns
   *     real per-tool latency / count / error totals.
   *
   * The schema and callback signatures are erased to `any` because the
   * MCP SDK's `registerTool` uses dependent generics that don't unify
   * across heterogeneous schemas — runtime validation still applies.
   */
  private registerOne(
    name: string,
    schema: unknown,
    handler: (ctx: HandlerContext, args: unknown) => Promise<unknown>
  ): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const server = this.server as any;
    server.registerTool(
      name,
      {
        description: getToolDescription(name),
        inputSchema: schema,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (args: unknown, extra?: any): Promise<unknown> => {
        // Phase C3: rate-limit gate (fail-fast BEFORE handler work).
        const decision = this.rateLimiter.check(name);
        if (!decision.allowed) {
          const err = new RateLimitExceededError(name, decision);
          this.logger.warn("Rate limit exceeded", {
            tool: name,
            blockedBy: decision.blockedBy,
            retryAfterMs: decision.retryAfterMs,
            remaining: decision.remaining,
          });
          throw err;
        }

        // M11-AUDIT (CRIT-1): build per-call progress channel when the
        // client supplies a progressToken. Best-effort: any send() failure
        // is swallowed — progress must NEVER break tool execution.
        const progressToken: string | number | undefined =
          extra?._meta?.progressToken ?? extra?.params?._meta?.progressToken;
        const sendNotification = extra?.sendNotification;
        const progress: ProgressChannel | undefined =
          progressToken !== undefined && typeof sendNotification === "function"
            ? {
                send: (params) => {
                  try {
                    void sendNotification({
                      method: "notifications/progress",
                      params: {
                        progressToken,
                        progress: params.progress,
                        ...(params.total !== undefined ? { total: params.total } : {}),
                        ...(params.message !== undefined ? { message: params.message } : {}),
                      },
                    });
                  } catch {
                    /* never break the tool because progress failed */
                  }
                },
              }
            : undefined;

        // Per-call context: shared services + per-call progress channel.
        const callCtx: HandlerContext = progress
          ? { ...this.ctx, progress }
          : this.ctx;

        // M11-AUDIT (MED-15/16): metric brackets.
        const metricToken = this.metricsTracker.markStart(name);
        let errored = false;
        try {
          const result = await handler(callCtx, args);

          // M11-AUDIT (CRIT-2): intelligence handlers now return raw data
          // like every other handler. The dispatcher is the SOLE
          // wrap-point for the MCP envelope. Previously intelligence
          // handlers returned a pre-wrapped envelope and the dispatcher
          // wrapped it AGAIN — clients had to JSON.parse twice. The
          // contract is now uniform across all 32 tools (R-3 — was
          // "29" before diagnostics fold-in).
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
          };
        } catch (error) {
          errored = true;
          const err = error instanceof Error ? error : new Error(String(error));

          this.logger.error("Tool handler error", err, { tool: name });

          // M11-AUDIT (MED-14): try self-healing before propagating.
          // Skip for rate-limit errors (those are intentional throttling,
          // not bugs) and for any error during healing itself.
          if (
            this.selfHealing &&
            !(err instanceof RateLimitExceededError)
          ) {
            try {
              const healed = await this.selfHealing.healError(err, {
                tool: name,
                args,
                operation: name,
              });
              if (healed.healed) {
                this.logger.info("Self-healing recovered tool error", {
                  tool: name,
                  fix: healed.fixApplied,
                  durationMs: healed.duration,
                });
                // Return a healing envelope so client knows the call
                // succeeded via recovery rather than direct execution.
                return {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({
                        status: "self-healed",
                        tool: name,
                        fixApplied: healed.fixApplied,
                        message: healed.message,
                        originalError: err.message,
                      }),
                    },
                  ],
                };
              }
            } catch (healErr) {
              this.logger.warn("Self-healing attempt threw", {
                tool: name,
                error: String(healErr),
              });
            }
          }
          throw err;
        } finally {
          this.metricsTracker.markEnd(metricToken, errored);
        }
      }
    );
  }

  /**
   * Active feature flags. Public — callers use this to introspect which
   * optional features (e.g. embedding, vector search) are enabled.
   */
  public getEnabledFeatures(): string[] {
    return this.configManager.getEnabledFeatures();
  }

  /**
   * Connect the MCP server to a transport. Defaults to stdio for
   * production use (called by `index.ts` after `initialize()` succeeds);
   * tests pass an `InMemoryTransport` to exercise the server in-process
   * for v8 coverage.
   *
   * M12.3: made transport injectable so server.ts gets v8
   * coverage from in-process tests instead of the subprocess-only path.
   * The default branch preserves the original stdio behavior — no caller
   * change required.
   */
  async connect(transport?: Transport): Promise<void> {
    const t = transport ?? new StdioServerTransport();
    await this.server.connect(t);
  }

  /**
   * Phase F1 (M-10) — graceful shutdown. Idempotent;
   * called by SIGTERM / SIGINT handlers in `index.ts`.
   *
   * Order of operations:
   *   1. Stop self-healing periodic timers (so process can exit).
   *   2. Flush pending DB writes + close SQLite (WAL checkpoint).
   *   3. Close MCP transport last.
   *
   * Each step is best-effort: errors are logged but do not block subsequent
   * steps — partial shutdown is better than wedged.
   */
  private closed = false;
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.logger?.info("Shutting down JCF Healthcare Agent Hub server");

    // Stop any periodic timers so process can exit cleanly.
    try {
      this.selfHealing?.stopHealthMonitoring();
    } catch {
      /* best-effort */
    }

    // Flush any pending writes + close SQLite.
    try {
      await this.db?.save();
    } catch (e) {
      this.logger?.warn("Save during shutdown failed", { error: String(e) });
    }
    try {
      this.db?.close();
    } catch (e) {
      this.logger?.warn("DB close failed", { error: String(e) });
    }

    // ADR-006 (M12) — release the VectorDB SQLite connection. Required
    // on Windows because the WAL `-shm` / `-wal` companion files hold
    // OS-level locks that prevent later cleanup until close. Idempotent
    // — VectorStorage.close() is safe to call repeatedly.
    try {
      this.vectorDb?.close();
    } catch (e) {
      this.logger?.warn("VectorDB close failed", { error: String(e) });
    }

    // Close MCP transport last.
    try {
      await this.server.close?.();
    } catch {
      /* best-effort */
    }

    this.logger?.info("Shutdown complete");
  }
}
