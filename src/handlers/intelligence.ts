/**
 * Cognitive intelligence handlers — 10 tools that operate on the
 * `CodeIntelligenceEngine` + `NodeLevelKnowledgeGraph` + `PatternDetector`
 * + `TypeFlowAnalyzer`.
 *
 * M11-AUDIT FIX (CRIT-2): handlers now return RAW data objects — the
 * dispatcher in `server.ts` is the single MCP-envelope wrap point. The
 * previous design double-wrapped (handler returned an inner envelope,
 * dispatcher wrapped it again) which forced every client to JSON.parse
 * twice for these 10 tools but once for the other 22 (3 diagnostics +
 * 19 non-intelligence). Contract is now uniform across all 32 tools
 * (R-3 — was "29" before diagnostics fold-in).
 *
 * M11-AUDIT FIX (CRIT-1): `buildCognitiveIndex` and any other
 * long-running op now emit MCP `notifications/progress` via
 * `ctx.progress?.send(...)`. (best-effort — channel is `undefined` when
 * the client doesn't request progress, in which case the call is a no-op).
 *
 * M14 (2026-05-02): `buildCognitiveIndex` now supports
 * background execution via `JobManager`. When `background: true` (default),
 * the build runs asynchronously and returns a `job_id` immediately,
 * preventing MCP client timeout (60s). Use `getBuildStatus` to poll.
 *
 * 11 tools:
 *   - buildCognitiveIndex
 *   - getBuildStatus  <-- NEW
 *   - getProjectSkeleton
 *   - getModuleContracts
 *   - getUnitFingerprints
 *   - queryCodeIntelligence
 *   - getImpactAnalysis
 *   - getTypeFlow
 *   - detectPatterns
 *   - getKnowledgeSubgraph
 *   - getIntelligenceStats
 */

import type { IntelligenceQuery } from "../types/index.js";
import type { HandlerContext } from "./context.js";
import { validatePath } from "./shared/path-guard.js";
// M13.2: unify path comparison with the cognitive-index
// canonical form (forward slashes, lowercase Windows drive letter).
// Real-case repro: `mcp1_get_module_contracts({filePaths: [winpath]})`
// returned `{modules: []}` because the index stored
// `c:/users/...` while callers passed `c:\\Users\\...`.
import { pathSetIncludes } from "./shared/path-normalize.js";

export interface BuildCognitiveIndexArgs {
  rootPath: string;
  /** When true, run in background and return job_id immediately. Default: true */
  background?: boolean;
}

export interface BuildCognitiveIndexResult {
  status: "built" | "queued";
  duration?: number;
  modules?: number;
  units?: number;
  patterns?: number;
  typeFlows?: number;
  pipelines?: number;
  estimatedTokens?: number;
  /** Present when status = "queued" */
  jobId?: string;
}

/**
 * Build the 3-layer cognitive index (Skeleton → Contracts → Fingerprints)
 * + node-level knowledge graph + pattern detection + type flow.
 *
 * M14 (2026-05-02): Background execution to prevent
 * MCP client timeout (60s). When `background: true` (default),
 * returns `{ status: "queued", jobId }` immediately and runs the
 * build asynchronously. Poll `getBuildStatus({ jobId })` for progress.
 */
export async function buildCognitiveIndex(
  ctx: HandlerContext,
  args: BuildCognitiveIndexArgs
): Promise<BuildCognitiveIndexResult> {
  // M14 (Bug #2 — P1 Security): validate rootPath against allowedDirectories
  // to prevent arbitrary filesystem traversal via cognitive index build.
  const rootPath = validatePath(ctx, args.rootPath);

  // M14 (2026-05-02): Background execution to prevent MCP client timeout.
  // When jobManager is available, run build asynchronously and return job_id immediately.
  const useBackground = args.background !== false && ctx.jobManager;

  if (useBackground) {
    const jobId = ctx.jobManager!.create('build_cognitive_index');

    // Fire-and-forget: run build in background, update job status
    void Promise.resolve().then(async () => {
      try {
        ctx.jobManager!.updateProgress(jobId, 0, 5, `Starting cognitive index build for ${rootPath}…`);

        const result = await ctx.codeIntelligence.buildFullIntelligence(
          rootPath,
          (event) => {
            ctx.jobManager!.updateProgress(jobId, event.progress, event.total, event.message);
          }
        );

        ctx.jobManager!.complete(jobId, {
          status: "built",
          duration: result.duration,
          modules: result.index.stats.totalModules,
          units: result.index.stats.totalUnits,
          patterns: result.patternResult.patterns.length,
          typeFlows: result.typeFlows.length,
          pipelines: result.pipelines.length,
          estimatedTokens: result.index.stats.estimatedTokenCost.total,
        });
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        ctx.jobManager!.fail(jobId, err.message);
      }
    });

    return {
      status: "queued",
      jobId,
      message: `Build queued. Poll getBuildStatus with jobId=${jobId} to check progress.`,
    } as any;
  }

  // Fallback: synchronous execution (when jobManager not available or background: false)
  ctx.progress?.send({
    progress: 0,
    total: 5,
    message: `Starting cognitive index build for ${rootPath}…`,
  });

  const result = await ctx.codeIntelligence.buildFullIntelligence(
    rootPath,
    (event) => {
      ctx.progress?.send(event);
    }
  );

  ctx.progress?.send({
    progress: 5,
    total: 5,
    message: `Build complete: ${result.index.stats.totalModules} modules, ${result.index.stats.totalUnits} units, ${result.patternResult.patterns.length} patterns in ${result.duration}ms`,
  });

  return {
    status: "built",
    duration: result.duration,
    modules: result.index.stats.totalModules,
    units: result.index.stats.totalUnits,
    patterns: result.patternResult.patterns.length,
    typeFlows: result.typeFlows.length,
    pipelines: result.pipelines.length,
    estimatedTokens: result.index.stats.estimatedTokenCost.total,
  };
}

export interface GetProjectSkeletonResult {
  /** `null` when the cognitive index hasn't been built yet. */
  skeleton:
    | ReturnType<HandlerContext["codeIntelligence"]["getSkeleton"]>
    | null;
  /** Human-readable hint when the index is empty. */
  message?: string;
}

/**
 * Layer 1 of the cognitive index — project skeleton (directory tree, tech
 * stack, architecture patterns, language distribution).
 *
 * M11-AUDIT FIX (CRIT-2): no more text-only error envelope; the result is
 * a typed object whose `skeleton` field is `null` when the index hasn't
 * been built yet, with a `message` hint. Callers parse one shape, always.
 */
export async function getProjectSkeleton(
  ctx: HandlerContext,
  _args: Record<string, never>
): Promise<GetProjectSkeletonResult> {
  const skeleton = ctx.codeIntelligence.getSkeleton();
  if (!skeleton) {
    return {
      skeleton: null,
      message:
        "No cognitive index built yet. Call build_cognitive_index first.",
    };
  }
  return { skeleton };
}

export interface GetModuleContractsArgs {
  filePaths?: string[];
}

export interface GetModuleContractsResult {
  modules: ReturnType<HandlerContext["codeIntelligence"]["getModules"]>;
}

/**
 * Layer 2 — per-file exports / imports / defined types / pattern
 * classification. Optional `filePaths` filter.
 */
export async function getModuleContracts(
  ctx: HandlerContext,
  args: GetModuleContractsArgs
): Promise<GetModuleContractsResult> {
  // M14 (Bug #2 — P1 Security): guard filter paths for basic safety.
  // NOTE: These filePaths are filter values against the in-memory cognitive
  // index — NOT filesystem access operations. Full validatePath (allow-list)
  // would reject legitimate queries about paths that were previously indexed
  // from an allowed directory but are now being queried by relative name.
  // Security boundary: buildCognitiveIndex already validates rootPath, so
  // the index only contains paths from allowed directories.
  if (args.filePaths) {
    for (const fp of args.filePaths) {
      if (typeof fp !== 'string' || fp.includes('\0')) {
        throw new Error('Access denied: invalid filter path');
      }
    }
  }

  let modules = ctx.codeIntelligence.getModules();
  if (args.filePaths && args.filePaths.length > 0) {
    // M13.2: platform-tolerant path membership (forward/back slash,
    // Windows drive-letter casing). Replaces the strict `Array.includes`
    // which silently dropped valid matches when callers used a different
    // path form than the cognitive index.
    modules = modules.filter((m) => pathSetIncludes(args.filePaths!, m.filePath));
  }
  return { modules };
}

export interface GetUnitFingerprintsArgs {
  filePaths?: string[];
  patternTypes?: string[];
  maxComplexity?: number;
}

export interface GetUnitFingerprintsResult {
  units: ReturnType<HandlerContext["codeIntelligence"]["getUnits"]>;
}

/**
 * Layer 3 — per-function / class fingerprints. All filters are optional;
 * applied as logical AND when present.
 */
export async function getUnitFingerprints(
  ctx: HandlerContext,
  args: GetUnitFingerprintsArgs
): Promise<GetUnitFingerprintsResult> {
  // M14 (Bug #2 — P1 Security): guard filter paths for basic safety.
  // See getModuleContracts for rationale — filter-only, no fs access.
  if (args.filePaths) {
    for (const fp of args.filePaths) {
      if (typeof fp !== 'string' || fp.includes('\0')) {
        throw new Error('Access denied: invalid filter path');
      }
    }
  }

  let units = ctx.codeIntelligence.getUnits();
  if (args.filePaths && args.filePaths.length > 0) {
    // M13.2: platform-tolerant path membership; see getModuleContracts.
    units = units.filter((u) => pathSetIncludes(args.filePaths!, u.filePath));
  }
  if (args.patternTypes && args.patternTypes.length > 0) {
    units = units.filter((u) => args.patternTypes!.includes(u.patternType));
  }
  if (args.maxComplexity !== undefined) {
    units = units.filter((u) => u.complexity <= args.maxComplexity!);
  }
  return { units };
}

export interface QueryCodeIntelligenceArgs {
  type:
    | "skeleton"
    | "contracts"
    | "fingerprints"
    | "impact"
    | "flow"
    | "patterns"
    | "subgraph"
    | "full_context";
  target?: string;
  depth?: number;
  filePaths?: string[];
  languages?: string[];
  patternTypes?: string[];
  maxComplexity?: number;
}

/**
 * Unified query interface across all cognitive layers. The 8 query types
 * dispatch internally inside `codeIntelligence.query`; this handler builds
 * the typed query envelope from individual args.
 */
export async function queryCodeIntelligence(
  ctx: HandlerContext,
  args: QueryCodeIntelligenceArgs
): Promise<Awaited<ReturnType<HandlerContext["codeIntelligence"]["query"]>>> {
  // M14 (Bug #2 — P1 Security): guard filter paths for basic safety.
  // See getModuleContracts for rationale — filter-only, no fs access.
  if (args.filePaths) {
    for (const fp of args.filePaths) {
      if (typeof fp !== 'string' || fp.includes('\0')) {
        throw new Error('Access denied: invalid filter path');
      }
    }
  }

  const filters: {
    filePaths?: string[];
    languages?: string[];
    patternTypes?: string[];
    maxComplexity?: number;
  } = {};
  if (args.filePaths) filters.filePaths = args.filePaths;
  if (args.languages) filters.languages = args.languages;
  if (args.patternTypes) filters.patternTypes = args.patternTypes;
  if (args.maxComplexity !== undefined) filters.maxComplexity = args.maxComplexity;
  const query: {
    type: IntelligenceQuery["type"];
    target?: string;
    depth?: number;
    filters?: typeof filters;
  } = {
    type: args.type,
    filters,
  };
  if (args.target) query.target = args.target;
  if (args.depth !== undefined) query.depth = args.depth;
  return ctx.codeIntelligence.query(query);
}

export interface GetImpactAnalysisArgs {
  nodeId: string;
  depth?: number;
}

export interface GetImpactAnalysisResult {
  impact: ReturnType<HandlerContext["nlkg"]["getImpactSet"]>;
  subgraph: ReturnType<HandlerContext["nlkg"]["extractSubgraph"]>;
}

/**
 * Forward + reverse impact set for a node. `depth` defaults to 2.
 */
export async function getImpactAnalysis(
  ctx: HandlerContext,
  args: GetImpactAnalysisArgs
): Promise<GetImpactAnalysisResult> {
  const impact = ctx.nlkg.getImpactSet(args.nodeId);
  const subgraph = ctx.nlkg.extractSubgraph(
    args.nodeId,
    args.depth || 2,
    "reverse"
  );
  return { impact, subgraph };
}

export interface GetTypeFlowArgs {
  typeName: string;
}

export interface GetTypeFlowResult {
  /** `undefined` if the type is not tracked. */
  typeFlow?: ReturnType<HandlerContext["typeFlowAnalyzer"]["getTypeFlow"]>;
  consumers: string[];
  producers: string[];
}

/**
 * Trace a type through the codebase: definition → producers → transformers
 * → validators → consumers.
 */
export async function getTypeFlow(
  ctx: HandlerContext,
  args: GetTypeFlowArgs
): Promise<GetTypeFlowResult> {
  const typeFlow = ctx.typeFlowAnalyzer.getTypeFlow(args.typeName);
  const consumers = ctx.typeFlowAnalyzer.getTypeConsumers(args.typeName);
  const producers = ctx.typeFlowAnalyzer.getTypeProducers(args.typeName);
  const result: GetTypeFlowResult = { consumers, producers };
  if (typeFlow !== undefined) result.typeFlow = typeFlow;
  return result;
}

export interface DetectPatternsResult {
  patterns: Array<{
    name: string;
    category: string;
    instances: number;
    template: string;
    tokenSavings: number;
  }>;
  overallCompressionRatio: number;
  estimatedTokenSavings: number;
}

/**
 * Detect 11 code-pattern categories across the indexed units. Returns a
 * compressed summary with token-savings estimates.
 */
export async function detectPatterns(
  ctx: HandlerContext,
  _args: Record<string, never>
): Promise<DetectPatternsResult> {
  const units = ctx.codeIntelligence.getUnits();
  const result = ctx.patternDetector.detectPatterns(units);
  return {
    patterns: result.patterns.map((p) => ({
      name: p.name,
      category: p.category,
      instances: p.instances.length,
      template: p.templateSignature,
      tokenSavings: p.tokenSavings,
    })),
    overallCompressionRatio: result.overallCompressionRatio,
    estimatedTokenSavings: result.estimatedTokenSavings,
  };
}

export interface GetKnowledgeSubgraphArgs {
  nodeId: string;
  depth?: number;
}

/**
 * Bidirectional depth-limited subgraph around a node. Default `depth` = 2.
 */
export async function getKnowledgeSubgraph(
  ctx: HandlerContext,
  args: GetKnowledgeSubgraphArgs
): Promise<ReturnType<HandlerContext["nlkg"]["extractSubgraph"]>> {
  return ctx.nlkg.extractSubgraph(args.nodeId, args.depth || 2);
}

export interface GetBuildStatusArgs {
  jobId: string;
}

export interface GetBuildStatusResult {
  jobId: string;
  status: "queued" | "running" | "completed" | "failed";
  progress: number;
  total: number;
  message: string;
  result?: BuildCognitiveIndexResult;
  error?: string;
  durationMs?: number;
}

/**
 * Query the status of a background build job.
 * Returns current progress or final result when completed.
 */
export async function getBuildStatus(
  ctx: HandlerContext,
  args: GetBuildStatusArgs
): Promise<GetBuildStatusResult> {
  if (!ctx.jobManager) {
    throw new Error('JobManager not initialized');
  }
  const job = ctx.jobManager.get(args.jobId);
  if (!job) {
    throw new Error(`Job not found: ${args.jobId}`);
  }
  const result: GetBuildStatusResult = {
    jobId: job.jobId,
    status: job.status,
    progress: job.progress,
    total: job.total,
    message: job.message,
  };
  if (job.durationMs !== undefined) {
    result.durationMs = job.durationMs;
  }
  if (job.status === 'completed' && job.result) {
    result.result = job.result;
  }
  if (job.status === 'failed' && job.error) {
    result.error = job.error;
  }
  return result;
}

/**
 * Aggregated stats across HCI / NLKG / patterns / type flows / build time.
 */
export async function getIntelligenceStats(
  ctx: HandlerContext,
  _args: Record<string, never>
): Promise<ReturnType<HandlerContext["codeIntelligence"]["getStats"]>> {
  return ctx.codeIntelligence.getStats();
}
