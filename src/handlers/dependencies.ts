/**
 * Dependency-graph handlers — dependents / dependencies / coherence / cycles.
 *
 * Extracted from `JcfHealthcareAgentHubServer` during M11 audit.
 * Behavior preserved verbatim.
 *
 * 4 tools:
 *   - getDependents
 *   - getDependencies
 *   - checkCoherence
 *   - detectCycles
 */

import type { CoherenceCheck } from "../types/index.js";
import type { HandlerContext } from "./context.js";
import { validatePath } from "./shared/path-guard.js";
import { withAudit } from "./shared/audit.js";
import { getCoherenceMessage } from "./shared/util.js";
// M13.2: unify path comparison with the cognitive-index
// canonical form when computing fallback edges from module imports.
import { normalizeIndexPath } from "./shared/path-normalize.js";

/**
 * M13.2 — cognitive-index fallback for dependents.
 *
 * Real-case failure: `getDependents` returned `[]` for files that
 * obviously had dependents because `DependencyGraphManager.graph.reverse`
 * is only populated when files are touched (registerFile / updateFile).
 * Files that were merely scanned during `build_cognitive_index` never
 * appeared in the dep-graph manager. Meanwhile `get_impact_analysis`
 * (which queries the NLKG built by the cognitive index) returned the
 * correct edges. The two graphs were silently divergent.
 *
 * This helper unions the dep-graph manager's reverse edges with edges
 * derived from the cognitive index's per-module `imports` list. The
 * cognitive index is consulted in O(N modules) per call — acceptable
 * since the dep-graph manager is consulted first and the fallback only
 * runs when the live graph is empty for the file. Result is deduped.
 */
function unionDependentsWithIndex(
  ctx: HandlerContext,
  filePath: string,
  fromGraph: ReadonlyArray<string>
): string[] {
  const out = new Set<string>(fromGraph);
  // The cognitive index may not be built yet; bail out gracefully.
  const modules = ctx.codeIntelligence.getModules?.() ?? [];
  if (modules.length === 0) return Array.from(out);

  const target = normalizeIndexPath(filePath);
  for (const mod of modules) {
    if (!mod.imports || mod.imports.length === 0) continue;
    for (const imp of mod.imports) {
      // ModuleContract.imports[i] is the resolved file path string in
      // the cognitive-index canonical form.
      const fromPath = typeof imp === "string" ? imp : (imp as { from?: string }).from;
      if (!fromPath) continue;
      if (normalizeIndexPath(fromPath) === target) {
        out.add(mod.filePath);
        break;
      }
    }
  }
  return Array.from(out);
}

function unionDependenciesWithIndex(
  ctx: HandlerContext,
  filePath: string,
  fromGraph: ReadonlyArray<string>
): string[] {
  const out = new Set<string>(fromGraph);
  const modules = ctx.codeIntelligence.getModules?.() ?? [];
  if (modules.length === 0) return Array.from(out);

  const target = normalizeIndexPath(filePath);
  const mod = modules.find((m) => normalizeIndexPath(m.filePath) === target);
  if (!mod || !mod.imports) return Array.from(out);
  for (const imp of mod.imports) {
    const fromPath = typeof imp === "string" ? imp : (imp as { from?: string }).from;
    if (fromPath) out.add(fromPath);
  }
  return Array.from(out);
}

export interface GetDependentsArgs {
  path: string;
  transitive?: boolean;
}

export interface GetDependentsResult {
  dependents: string[];
  transitive: boolean;
}

/**
 * Return files that import the given path.
 *
 * - `transitive=false` (default): direct dependents only.
 * - `transitive=true`: full upstream closure via `getTransitiveDependents`.
 *
 * Sorted alphabetically for deterministic output.
 */
export async function getDependents(
  ctx: HandlerContext,
  args: GetDependentsArgs
): Promise<GetDependentsResult> {
  const filePath = validatePath(ctx, args.path);
  const transitive = args.transitive === true;

  return withAudit(ctx, "read", filePath, async () => {
    const fromGraph = transitive
      ? Array.from(ctx.dependencyGraph.getTransitiveDependents(filePath))
      : ctx.dependencyGraph.getDependents(filePath);
    // M13.2: union with cognitive-index module imports so freshly-
    // indexed-but-not-yet-edited files still surface their dependents.
    // For the transitive case we still rely on the dep-graph manager's
    // closure (BFS over the index would be O(N²) for marginal gain);
    // direct queries get the full union.
    const dependents = transitive
      ? fromGraph
      : unionDependentsWithIndex(ctx, filePath, fromGraph);
    return { dependents: dependents.slice().sort(), transitive };
  });
}

export interface GetDependenciesArgs {
  path: string;
  transitive?: boolean;
}

export interface GetDependenciesResult {
  dependencies: string[];
  transitive: boolean;
}

/**
 * Return files imported by the given path.
 *
 * - `transitive=false` (default): direct dependencies only.
 * - `transitive=true`: full downstream closure via `getTransitiveDependencies`.
 *
 * Sorted alphabetically for deterministic output.
 */
export async function getDependencies(
  ctx: HandlerContext,
  args: GetDependenciesArgs
): Promise<GetDependenciesResult> {
  const filePath = validatePath(ctx, args.path);
  const transitive = args.transitive === true;

  return withAudit(ctx, "read", filePath, async () => {
    const fromGraph = transitive
      ? Array.from(ctx.dependencyGraph.getTransitiveDependencies(filePath))
      : ctx.dependencyGraph.getDependencies(filePath);
    // M13.2: union with cognitive-index forward imports for the same
    // reason as getDependents; transitive falls through to the manager.
    const dependencies = transitive
      ? fromGraph
      : unionDependenciesWithIndex(ctx, filePath, fromGraph);
    return { dependencies: dependencies.slice().sort(), transitive };
  });
}

export interface CheckCoherenceArgs {
  path: string;
}

export interface CheckCoherenceResult {
  coherence: CoherenceCheck;
}

/**
 * Compute coherence score + change risk for a file. Combines coherence
 * scoring, change-impact assessment, and dependency lists into a unified
 * `CoherenceCheck` envelope.
 */
export async function checkCoherence(
  ctx: HandlerContext,
  args: CheckCoherenceArgs
): Promise<CheckCoherenceResult> {
  const filePath = validatePath(ctx, args.path);

  return withAudit(ctx, "read", filePath, async () => {
    const score = ctx.dependencyGraph.getCoherenceScore(filePath);
    const changeImpact = ctx.dependencyGraph.assessChangeRisk(filePath);
    const impact: CoherenceCheck["impact"] =
      changeImpact.risk === "critical"
        ? "critical"
        : changeImpact.risk === "high"
        ? "high"
        : changeImpact.risk === "medium"
        ? "medium"
        : "low";

    return {
      coherence: {
        file: filePath,
        score,
        risk: changeImpact.risk,
        dependencies: ctx.dependencyGraph.getDependencies(filePath),
        dependents: ctx.dependencyGraph.getDependents(filePath),
        missing: [],
        circular: false,
        impact,
        message: getCoherenceMessage(score, changeImpact.risk),
      },
    };
  });
}

export interface DetectCyclesResult {
  cycles: string[][];
}

/**
 * Detect every cycle in the dependency graph. Returns the raw cycle
 * sequences (each is an array of file paths forming a cycle).
 */
export async function detectCycles(
  ctx: HandlerContext
): Promise<DetectCyclesResult> {
  return withAudit(ctx, "read", "system", async () => {
    const cycleResults = ctx.dependencyGraph.detectCircularDependencies();
    const cycles = cycleResults.map((cr) => cr.cycle);
    return { cycles };
  });
}
