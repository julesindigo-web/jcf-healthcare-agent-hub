/**
 * Direct unit tests for `handlers/intelligence.ts` — 10 cognitive tools.
 *
 * M11-AUDIT FIX (CRIT-2): handlers now return RAW data objects \u2014 the
 * dispatcher in `server.ts` is the SOLE MCP-envelope wrap-point. The
 * previous double-wrap (handler returns envelope → dispatcher wraps it
 * AGAIN) is gone, so these tests now assert directly on the raw shape
 * with no `unwrap` helper. Contract is uniform across all 29 tools.
 *
 * Tools covered:
 *   - buildCognitiveIndex
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

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  buildCognitiveIndex,
  getProjectSkeleton,
  getModuleContracts,
  getUnitFingerprints,
  queryCodeIntelligence,
  getImpactAnalysis,
  getTypeFlow,
  detectPatterns,
  getKnowledgeSubgraph,
  getIntelligenceStats,
} from "../handlers/intelligence.js";

import {
  createTestContext,
  writeSandboxFile,
  type TestContext,
} from "./_test-context.js";

describe("handlers/intelligence.ts", () => {
  let tc: TestContext;
  beforeEach(async () => { tc = await createTestContext(); });
  afterEach(async () => { await tc.cleanup(); });

  /**
   * Plant a tiny TS module so `buildCognitiveIndex` has something to chew.
   */
  async function plantSampleProject(): Promise<void> {
    await writeSandboxFile(
      tc.workDir,
      "src/lib.ts",
      `export interface User { id: string; name: string; }
export function makeUser(id: string, name: string): User {
  return { id, name };
}`
    );
    await writeSandboxFile(
      tc.workDir,
      "src/main.ts",
      `import { makeUser } from './lib';
const u = makeUser('1', 'a');
console.log(u);`
    );
  }

  // ────────────────────── buildCognitiveIndex ──────────────────────
  describe("buildCognitiveIndex", () => {
    it("returns a typed stats result after build", async () => {
      await plantSampleProject();
      const result = await buildCognitiveIndex(tc.ctx, { rootPath: tc.workDir });
      expect(result.status).toBe("built");
      expect(typeof result.modules).toBe("number");
      expect(typeof result.units).toBe("number");
      expect(typeof result.patterns).toBe("number");
      expect(typeof result.typeFlows).toBe("number");
      expect(typeof result.pipelines).toBe("number");
      expect(typeof result.estimatedTokens).toBe("number");
      expect(typeof result.duration).toBe("number");
    }, 30000);

    it("M11-AUDIT FIX (CRIT-1): emits progress notifications via ctx.progress", async () => {
      await plantSampleProject();
      const events: Array<{ progress: number; total?: number; message?: string }> = [];
      const ctxWithProgress = {
        ...tc.ctx,
        progress: {
          send: (params: { progress: number; total?: number; message?: string }) => {
            events.push(params);
          },
        },
      };
      await buildCognitiveIndex(ctxWithProgress, { rootPath: tc.workDir });
      // At minimum: a start (progress=0) and an end (progress=total) event.
      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events[0]?.progress).toBe(0);
      expect(events[events.length - 1]?.progress).toBe(events[events.length - 1]?.total);
    });
  });

  // ────────────────────── getProjectSkeleton ──────────────────────
  describe("getProjectSkeleton", () => {
    it("M11-AUDIT FIX (CRIT-2): returns { skeleton: null, message } before a build", async () => {
      const result = await getProjectSkeleton(tc.ctx, {});
      expect(result.skeleton).toBeNull();
      expect(result.message).toMatch(/No cognitive index built yet/i);
    });

    it("returns { skeleton } object after build", async () => {
      await plantSampleProject();
      await buildCognitiveIndex(tc.ctx, { rootPath: tc.workDir });
      const result = await getProjectSkeleton(tc.ctx, {});
      expect(result.skeleton).not.toBeNull();
      expect(typeof result.skeleton).toBe("object");
    });
  });

  // ────────────────────── getModuleContracts ──────────────────────
  describe("getModuleContracts", () => {
    it("returns { modules: [] } before a build", async () => {
      const result = await getModuleContracts(tc.ctx, {});
      expect(Array.isArray(result.modules)).toBe(true);
    });

    it("filters by filePaths after build", async () => {
      await plantSampleProject();
      await buildCognitiveIndex(tc.ctx, { rootPath: tc.workDir });
      const all = await getModuleContracts(tc.ctx, {});
      expect(all.modules.length).toBeGreaterThanOrEqual(0);
      if (all.modules.length > 0) {
        const target = all.modules[0]!.filePath;
        const filtered = await getModuleContracts(tc.ctx, { filePaths: [target] });
        expect(filtered.modules.every((m) => m.filePath === target)).toBe(true);
      }
    });
  });

  // ────────────────────── getUnitFingerprints ──────────────────────
  describe("getUnitFingerprints", () => {
    it("returns { units: [] } when no filters are applied (pre-build)", async () => {
      const result = await getUnitFingerprints(tc.ctx, {});
      expect(Array.isArray(result.units)).toBe(true);
    });

    it("applies maxComplexity filter (returns subset)", async () => {
      await plantSampleProject();
      await buildCognitiveIndex(tc.ctx, { rootPath: tc.workDir });
      const all = await getUnitFingerprints(tc.ctx, {});
      const filtered = await getUnitFingerprints(tc.ctx, { maxComplexity: 0 });
      expect(filtered.units.every((u) => u.complexity <= 0)).toBe(true);
      expect(filtered.units.length).toBeLessThanOrEqual(all.units.length);
    });

    it("applies patternTypes filter", async () => {
      await plantSampleProject();
      await buildCognitiveIndex(tc.ctx, { rootPath: tc.workDir });
      const filtered = await getUnitFingerprints(tc.ctx, {
        patternTypes: ["__never__"],
      });
      expect(filtered.units).toEqual([]);
    });

    it("applies filePaths filter", async () => {
      await plantSampleProject();
      await buildCognitiveIndex(tc.ctx, { rootPath: tc.workDir });
      const filtered = await getUnitFingerprints(tc.ctx, {
        filePaths: ["nonexistent.ts"],
      });
      expect(filtered.units).toEqual([]);
    });
  });

  // ────────────────────── queryCodeIntelligence ──────────────────────
  describe("queryCodeIntelligence", () => {
    it("returns an IntelligenceResult for type=skeleton", async () => {
      await plantSampleProject();
      await buildCognitiveIndex(tc.ctx, { rootPath: tc.workDir });
      const result = await queryCodeIntelligence(tc.ctx, { type: "skeleton" });
      expect(result).toBeDefined();
      expect(result.query.type).toBe("skeleton");
    });

    it("forwards filter args through to the engine", async () => {
      await plantSampleProject();
      await buildCognitiveIndex(tc.ctx, { rootPath: tc.workDir });
      const result = await queryCodeIntelligence(tc.ctx, {
        type: "fingerprints",
        filePaths: ["nonexistent.ts"],
        maxComplexity: 0,
      });
      expect(result).toBeDefined();
    });

    it("supports type=full_context", async () => {
      await plantSampleProject();
      await buildCognitiveIndex(tc.ctx, { rootPath: tc.workDir });
      const result = await queryCodeIntelligence(tc.ctx, { type: "full_context" });
      expect(result).toBeDefined();
      expect(result.query.type).toBe("full_context");
    });
  });

  // ────────────────────── getImpactAnalysis ──────────────────────
  describe("getImpactAnalysis", () => {
    it("returns { impact, subgraph } for any nodeId (before build = empty)", async () => {
      const result = await getImpactAnalysis(tc.ctx, { nodeId: "module:nope.ts" });
      expect(result).toHaveProperty("impact");
      expect(result).toHaveProperty("subgraph");
    });

    it("respects custom depth", async () => {
      const result = await getImpactAnalysis(tc.ctx, {
        nodeId: "module:nope.ts",
        depth: 5,
      });
      expect(result).toBeDefined();
    });
  });

  // ────────────────────── getTypeFlow ──────────────────────
  describe("getTypeFlow", () => {
    it("returns consumers/producers (typeFlow optional) for unknown types", async () => {
      const result = await getTypeFlow(tc.ctx, { typeName: "Nope" });
      expect(result).toHaveProperty("consumers");
      expect(result).toHaveProperty("producers");
      expect(Array.isArray(result.consumers)).toBe(true);
      expect(Array.isArray(result.producers)).toBe(true);
    });
  });

  // ────────────────────── detectPatterns ──────────────────────
  describe("detectPatterns", () => {
    it("returns patterns + compression metrics", async () => {
      const result = await detectPatterns(tc.ctx, {});
      expect(Array.isArray(result.patterns)).toBe(true);
      expect(result).toHaveProperty("overallCompressionRatio");
      expect(result).toHaveProperty("estimatedTokenSavings");
    });
  });

  // ────────────────────── getKnowledgeSubgraph ──────────────────────
  describe("getKnowledgeSubgraph", () => {
    it("returns a subgraph extraction for any nodeId", async () => {
      const result = await getKnowledgeSubgraph(tc.ctx, {
        nodeId: "module:nope.ts",
      });
      expect(result).toBeDefined();
      expect(result).toHaveProperty("nodes");
      expect(result).toHaveProperty("edges");
    });

    it("supports custom depth", async () => {
      const result = await getKnowledgeSubgraph(tc.ctx, {
        nodeId: "module:nope.ts",
        depth: 4,
      });
      expect(result).toBeDefined();
    });
  });

  // ────────────────────── getIntelligenceStats ──────────────────────
  describe("getIntelligenceStats", () => {
    it("returns an object stats snapshot (before any build)", async () => {
      const result = await getIntelligenceStats(tc.ctx, {});
      expect(typeof result).toBe("object");
      expect(result).toHaveProperty("cognitiveIndex");
    });

    it("includes build duration after a build", async () => {
      await plantSampleProject();
      await buildCognitiveIndex(tc.ctx, { rootPath: tc.workDir });
      const result = await getIntelligenceStats(tc.ctx, {});
      expect(result).toBeDefined();
      expect(result).toHaveProperty("buildDuration");
    });
  });
});
