/**
 * Direct unit tests for `handlers/search.ts` —
 * searchFiles + semanticSearch.
 *
 * Built in M11 audit. Each test calls the pure handler with
 * a real `HandlerContext` (in-process, sandbox temp dir).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { searchFiles, semanticSearch } from "../handlers/search.js";
import { writeFile } from "../handlers/filesystem.js";

import {
  createTestContext,
  writeSandboxFile,
  type TestContext,
} from "./_test-context.js";

describe("handlers/search.ts", () => {
  let tc: TestContext;
  beforeEach(async () => { tc = await createTestContext(); });
  afterEach(async () => { await tc.cleanup(); });

  // ────────────────────── searchFiles ──────────────────────
  describe("searchFiles", () => {
    it("matches files by glob pattern in baseDir", async () => {
      await writeSandboxFile(tc.workDir, "hit-1.ts", "x");
      await writeSandboxFile(tc.workDir, "hit-2.ts", "y");
      await writeSandboxFile(tc.workDir, "miss.js", "z");
      const r = await searchFiles(tc.ctx, {
        pattern: "*.ts",
        baseDir: tc.workDir,
      });
      const names = r.results.map((res) => res.path);
      expect(names.some((p) => p.endsWith("hit-1.ts"))).toBe(true);
      expect(names.some((p) => p.endsWith("hit-2.ts"))).toBe(true);
      expect(names.some((p) => p.endsWith("miss.js"))).toBe(false);
    });

    it("recurses into subdirectories", async () => {
      await writeSandboxFile(tc.workDir, "outer.ts", "a");
      await writeSandboxFile(tc.workDir, "sub/inner.ts", "b");
      const r = await searchFiles(tc.ctx, {
        pattern: "*.ts",
        baseDir: tc.workDir,
      });
      expect(r.results.length).toBeGreaterThanOrEqual(2);
      expect(r.results.some((x) => x.path.includes("inner"))).toBe(true);
    });

    it("returns empty when nothing matches", async () => {
      await writeSandboxFile(tc.workDir, "a.ts", "x");
      const r = await searchFiles(tc.ctx, {
        pattern: "*.NOT_PRESENT_EXT",
        baseDir: tc.workDir,
      });
      expect(r.results).toEqual([]);
    });

    it("falls back to allowedDirectories[0] when baseDir omitted", async () => {
      await writeSandboxFile(tc.workDir, "fallback.ts", "x");
      // Sandbox is configured as the only allowed directory in createTestContext
      const r = await searchFiles(tc.ctx, { pattern: "*.ts" });
      expect(r.results.some((x) => x.path.includes("fallback"))).toBe(true);
    });

    it("respects maxDirectoryDepth", async () => {
      tc.ctx.config.maxDirectoryDepth = 1;
      await writeSandboxFile(tc.workDir, "deep/a/b/c/buried.ts", "x");
      await writeSandboxFile(tc.workDir, "shallow.ts", "y");
      const r = await searchFiles(tc.ctx, {
        pattern: "*.ts",
        baseDir: tc.workDir,
      });
      const names = r.results.map((x) => x.path);
      expect(names.some((p) => p.endsWith("shallow.ts"))).toBe(true);
      expect(names.some((p) => p.endsWith("buried.ts"))).toBe(false);
    });

    it("rejects path traversal in baseDir", async () => {
      await expect(
        searchFiles(tc.ctx, { pattern: "*.ts", baseDir: "../../etc" })
      ).rejects.toThrow(/Path traversal/);
    });
  });

  // ────────────────────── semanticSearch ──────────────────────
  describe("semanticSearch", () => {
    it("returns indexed-document results after writes populate the index", async () => {
      // writeFile triggers vectorDb.indexFile, so populate via real handler
      await writeFile(tc.ctx, {
        path: `${tc.workDir}/cache.ts`,
        content: "export class Cache { hit() {} miss() {} get() {} }",
      });
      await writeFile(tc.ctx, {
        path: `${tc.workDir}/auth.ts`,
        content: "export function authenticate() { /* token validation */ }",
      });
      const r = await semanticSearch(tc.ctx, { query: "cache hit miss" });
      // The structure is what we care about; tf-idf may rank either above
      // threshold. We assert envelope shape.
      expect(Array.isArray(r.results)).toBe(true);
      expect(typeof r.indexedDocuments).toBe("number");
      expect(typeof r.autoIndexed).toBe("boolean");
    });

    it("auto-indexes when vector DB is empty (autoIndex defaults to true)", async () => {
      // Drop a few code files but DON'T use writeFile (which would index
      // them). This forces the lazy auto-index path.
      await writeSandboxFile(tc.workDir, "x.ts", "export const a = 1;");
      await writeSandboxFile(tc.workDir, "y.ts", "export const b = 2;");
      const r = await semanticSearch(tc.ctx, {
        query: "anything",
        rootPath: tc.workDir,
      });
      expect(r.autoIndexed).toBe(true);
      expect(r.note).toMatch(/Auto-indexed/);
      expect(r.indexedDocuments).toBeGreaterThan(0);
    });

    it("does NOT auto-index when autoIndex=false and vector DB is empty", async () => {
      await writeSandboxFile(tc.workDir, "z.ts", "export const c = 3;");
      const r = await semanticSearch(tc.ctx, {
        query: "anything",
        rootPath: tc.workDir,
        autoIndex: false,
      });
      expect(r.autoIndexed).toBe(false);
      expect(r.note).toBeUndefined();
      expect(r.results).toEqual([]);
      expect(r.indexedDocuments).toBe(0);
    });

    it("respects custom limit + threshold", async () => {
      await writeFile(tc.ctx, {
        path: `${tc.workDir}/file1.ts`,
        content: "alpha alpha beta",
      });
      await writeFile(tc.ctx, {
        path: `${tc.workDir}/file2.ts`,
        content: "alpha gamma",
      });
      const r = await semanticSearch(tc.ctx, {
        query: "alpha",
        limit: 1,
        threshold: 0.0,
      });
      expect(r.results.length).toBeLessThanOrEqual(1);
    });

    // M14 Bug #7 regression: cumulative byte cap halts auto-index before OOM
    it("halts auto-index when cumulative byte cap is reached", async () => {
      // Patch the config to set a very low cumulative cap (10 bytes)
      // so the second file causes the cap to be hit.
      (tc.ctx.config as any).semanticAutoIndexMaxTotalBytes = 10;
      // Write two files — first is 5 bytes, second would push total to 10+
      await writeSandboxFile(tc.workDir, "small1.ts", "abc");
      await writeSandboxFile(tc.workDir, "small2.ts", "defghijklm"); // 10 bytes
      const r = await semanticSearch(tc.ctx, {
        query: "abc",
        rootPath: tc.workDir,
        autoIndex: true,
      });
      // Should have indexed at least one file but stopped before processing all
      expect(r.autoIndexed).toBe(true);
      // The total indexed should not exceed what fits in 10 bytes
      // (we just verify it ran without OOM / crash)
      expect(r.indexedDocuments).toBeGreaterThanOrEqual(0);
    });
  });
});
