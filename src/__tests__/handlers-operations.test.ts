/**
 * Direct unit tests for `handlers/operations.ts` —
 * batchOperations / healthCheck / getEnabledFeatures / getAuditLog.
 *
 * Built in M11 audit. Each test calls the pure handler with
 * a real `HandlerContext` (in-process, sandbox temp dir).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";

import {
  batchOperations,
  healthCheck,
  getEnabledFeatures,
  getAuditLog,
} from "../handlers/operations.js";
import { writeFile } from "../handlers/filesystem.js";

import {
  createTestContext,
  writeSandboxFile,
  type TestContext,
} from "./_test-context.js";

describe("handlers/operations.ts", () => {
  let tc: TestContext;
  beforeEach(async () => { tc = await createTestContext(); });
  afterEach(async () => { await tc.cleanup(); });

  // ────────────────────── batchOperations ──────────────────────
  describe("batchOperations", () => {
    it("executes a sequence of read operations", async () => {
      const a = await writeSandboxFile(tc.workDir, "a.txt", "A");
      const b = await writeSandboxFile(tc.workDir, "b.txt", "B");
      const r = await batchOperations(tc.ctx, {
        operations: [
          { type: "read", path: a },
          { type: "read", path: b },
        ],
      });
      expect(r.results).toHaveLength(2);
      expect(r.results.every((res) => res.success)).toBe(true);
      expect(r.results.every((res) => res.rollbackAvailable === false)).toBe(true);
    });

    it("executes a write operation and reports rollbackAvailable=true", async () => {
      const p = path.join(tc.workDir, "w.txt");
      const r = await batchOperations(tc.ctx, {
        operations: [{ type: "write", path: p, content: "hello" }],
      });
      expect(r.results[0].success).toBe(true);
      expect(r.results[0].rollbackAvailable).toBe(true);
    });

    it("captures per-op failures without aborting the batch", async () => {
      const p = path.join(tc.workDir, "w.txt");
      const r = await batchOperations(tc.ctx, {
        operations: [
          { type: "write", path: p, content: "ok" }, // succeeds
          { type: "write", path: p }, // fails: missing content
          { type: "delete", path: path.join(tc.workDir, "no-such.txt") }, // fails
        ],
      });
      expect(r.results).toHaveLength(3);
      expect(r.results[0].success).toBe(true);
      expect(r.results[1].success).toBe(false);
      expect(r.results[1].error).toMatch(/content/i);
      expect(r.results[2].success).toBe(false);
    });

    it("rejects when total ops exceed batchOperationLimit", async () => {
      tc.ctx.config.batchOperationLimit = 2;
      const ops = Array.from({ length: 3 }, () => ({
        type: "read" as const,
        path: tc.workDir,
      }));
      await expect(
        batchOperations(tc.ctx, { operations: ops })
      ).rejects.toThrow(/exceeds limit/);
    });

    it("supports edit operation", async () => {
      const p = await writeSandboxFile(tc.workDir, "e.txt", "alpha beta");
      const r = await batchOperations(tc.ctx, {
        operations: [
          {
            type: "edit",
            path: p,
            edits: [{ oldText: "alpha", newText: "X" }],
          },
        ],
      });
      expect(r.results[0].success).toBe(true);
    });

    it("rejects edit op without edits[] payload", async () => {
      const p = await writeSandboxFile(tc.workDir, "e.txt", "abc");
      const r = await batchOperations(tc.ctx, {
        operations: [{ type: "edit", path: p }],
      });
      expect(r.results[0].success).toBe(false);
      expect(r.results[0].error).toMatch(/edits/i);
    });

    it("supports delete operation", async () => {
      const p = await writeSandboxFile(tc.workDir, "d.txt", "x");
      const r = await batchOperations(tc.ctx, {
        operations: [{ type: "delete", path: p }],
      });
      expect(r.results[0].success).toBe(true);
      expect(r.results[0].rollbackAvailable).toBe(true);
    });
  });

  // ────────────────────── healthCheck ──────────────────────
  describe("healthCheck", () => {
    it("returns a populated HealthCheck envelope", async () => {
      const r = await healthCheck(tc.ctx);
      expect(r.status === "healthy" || r.status === "degraded").toBe(true);
      expect(typeof r.uptime).toBe("number");
      expect(typeof r.timestamp).toBe("string");
      expect(r.cache).toBeDefined();
      expect(r.database).toBeDefined();
      expect(r.vectorDb).toBeDefined();
      expect(r.security).toBeDefined();
      expect(r.metrics).toBeDefined();
    });

    it("self-healing.totalFixAttempts=0 → still considered healthy if other checks pass", async () => {
      const r = await healthCheck(tc.ctx);
      // Cache available + security policies > 0 (defaults loaded) → healthy
      expect(r.status).toBe("healthy");
    });

    it("returns warnings array in health check output", async () => {
      const r = await healthCheck(tc.ctx);
      expect(Array.isArray(r.warnings)).toBe(true);
    });

    it("includes embedding service warning when enabled but not available", async () => {
      const r = await healthCheck(tc.ctx);
      // Default test context has embedding enabled but service not running
      const embeddingWarning = (r.warnings ?? []).find((w: string) => w.includes("Embedding"));
      if (r.vectorDb?.embedding?.enabled && r.vectorDb?.embedding?.available !== true) {
        expect(embeddingWarning).toBeDefined();
        expect(embeddingWarning).toMatch(/tf-idf fallback/);
      }
    });
  });

  // ────────────────────── getEnabledFeatures ──────────────────────
  describe("getEnabledFeatures", () => {
    it("returns the configManager's feature list as a string array", async () => {
      const r = await getEnabledFeatures(tc.ctx);
      expect(Array.isArray(r.features)).toBe(true);
      // Default configManager enables several flags
      expect(r.features.length).toBeGreaterThan(0);
    });
  });

  // ────────────────────── getAuditLog ──────────────────────
  describe("getAuditLog", () => {
    it("returns recent audit events", async () => {
      const p = path.join(tc.workDir, "x.txt");
      await writeFile(tc.ctx, { path: p, content: "hi" });
      const r = await getAuditLog(tc.ctx, {});
      expect(Array.isArray(r.events)).toBe(true);
      expect(r.events.length).toBeGreaterThan(0);
    });

    it("filters by action type", async () => {
      const p = path.join(tc.workDir, "x.txt");
      await writeFile(tc.ctx, { path: p, content: "hi" });
      const r = await getAuditLog(tc.ctx, { action: "write" });
      expect(r.events.every((e) => e.action === "write")).toBe(true);
    });

    it("filters by result", async () => {
      const p = path.join(tc.workDir, "ok.txt");
      await writeFile(tc.ctx, { path: p, content: "ok" });
      const r = await getAuditLog(tc.ctx, { result: "success" });
      expect(r.events.every((e) => e.result === "success")).toBe(true);
    });

    it("respects the limit parameter", async () => {
      // Generate >5 audits
      for (let i = 0; i < 5; i++) {
        await writeFile(tc.ctx, {
          path: path.join(tc.workDir, `f${i}.txt`),
          content: "x",
        });
      }
      const r = await getAuditLog(tc.ctx, { limit: 2 });
      expect(r.events.length).toBeLessThanOrEqual(2);
    });

    it("filters by userId when provided", async () => {
      const p = path.join(tc.workDir, "u.txt");
      await writeFile(tc.ctx, { path: p, content: "x" });
      // userId in audit log is whatever getCurrentUser returned
      const r = await getAuditLog(tc.ctx, { userId: "default-user" });
      // Any matching events have the right user
      for (const e of r.events) {
        expect(e.userId).toBe("default-user");
      }
    });
  });
});
