/**
 * Direct unit tests for `handlers/versioning.ts` —
 * getVersionHistory / rollbackFile / getMetadata.
 *
 * Built in M11 audit. Each test calls the pure handler directly with a
 * real `HandlerContext` (in-process, sandbox temp dir).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";

import {
  getVersionHistory,
  rollbackFile,
  getMetadata,
} from "../handlers/versioning.js";
import { writeFile, deleteFile } from "../handlers/filesystem.js";

import {
  createTestContext,
  writeSandboxFile,
  type TestContext,
} from "./_test-context.js";

describe("handlers/versioning.ts", () => {
  let tc: TestContext;
  beforeEach(async () => {
    vi.useFakeTimers();
    tc = await createTestContext();
  });
  afterEach(async () => {
    await tc.cleanup();
    vi.useRealTimers();
  });

  // ────────────────────── getVersionHistory ──────────────────────
  describe("getVersionHistory", () => {
    it("returns empty array when file has no history", async () => {
      const p = await writeSandboxFile(tc.workDir, "no-history.txt", "x");
      const r = await getVersionHistory(tc.ctx, { path: p });
      expect(r.versions).toEqual([]);
    });

    it("returns history sorted newest-first after multiple writes", async () => {
      const p = path.join(tc.workDir, "v.txt");
      await writeFile(tc.ctx, { path: p, content: "v1" });
      // Force separate timestamps on fast filesystems (deterministic)
      vi.advanceTimersByTime(10);
      await writeFile(tc.ctx, { path: p, content: "v2" });
      vi.advanceTimersByTime(10);
      await writeFile(tc.ctx, { path: p, content: "v3" });

      const r = await getVersionHistory(tc.ctx, { path: p });
      expect(r.versions.length).toBeGreaterThanOrEqual(2);
      // Newest first
      for (let i = 1; i < r.versions.length; i++) {
        expect(
          r.versions[i - 1].timestamp.getTime() >=
            r.versions[i].timestamp.getTime()
        ).toBe(true);
      }
    });

    it("respects the limit parameter", async () => {
      const p = path.join(tc.workDir, "v.txt");
      await writeFile(tc.ctx, { path: p, content: "v1" });
      vi.advanceTimersByTime(5);
      await writeFile(tc.ctx, { path: p, content: "v2" });
      vi.advanceTimersByTime(5);
      await writeFile(tc.ctx, { path: p, content: "v3" });

      const r = await getVersionHistory(tc.ctx, { path: p, limit: 1 });
      expect(r.versions.length).toBe(1);
    });

    it("rejects path traversal", async () => {
      await expect(
        getVersionHistory(tc.ctx, { path: "../../etc/passwd" })
      ).rejects.toThrow(/Path traversal/);
    });
  });

  // ────────────────────── rollbackFile ──────────────────────
  describe("rollbackFile", () => {
    it("restores file content from a stored version", async () => {
      const p = path.join(tc.workDir, "rollback.txt");
      await writeFile(tc.ctx, { path: p, content: "original" });
      await writeFile(tc.ctx, { path: p, content: "modified" });

      const versions = tc.ctx.db.getVersions(p);
      // Find the version that has stored content "original"
      const target = versions.find((v) => v.content === "original");
      expect(target, "expected v1 to be stored as a version").toBeDefined();

      const r = await rollbackFile(tc.ctx, { path: p, versionId: target!.id });
      expect(r.success).toBe(true);
      expect(await fs.readFile(p, "utf-8")).toBe("original");
    });

    it("snapshots current content before overwriting", async () => {
      const p = path.join(tc.workDir, "rb.txt");
      await writeFile(tc.ctx, { path: p, content: "v1" });
      await writeFile(tc.ctx, { path: p, content: "v2" });

      const versions = tc.ctx.db.getVersions(p);
      const target = versions.find((v) => v.content === "v1");
      expect(target).toBeDefined();

      await rollbackFile(tc.ctx, { path: p, versionId: target!.id });

      const after = tc.ctx.db.getVersions(p);
      // A pre-rollback snapshot of "v2" should be added
      expect(after.some((v) => v.content === "v2" && /Pre-rollback/.test(v.message))).toBe(true);
    });

    it("throws when versionId does not exist", async () => {
      const p = path.join(tc.workDir, "missing.txt");
      await writeFile(tc.ctx, { path: p, content: "x" });
      await expect(
        rollbackFile(tc.ctx, { path: p, versionId: "no-such-version" })
      ).rejects.toThrow(/not found/);
    });

    it("throws when target version has no stored content", async () => {
      const p = path.join(tc.workDir, "empty-version.txt");
      await writeFile(tc.ctx, { path: p, content: "x" });
      // Manually inject a content-less version row
      await tc.ctx.db.addVersion(p, "deadbeef", "system", "no content", 0);
      const versions = tc.ctx.db.getVersions(p);
      const empty = versions.find((v) => !v.content);
      expect(empty).toBeDefined();

      await expect(
        rollbackFile(tc.ctx, { path: p, versionId: empty!.id })
      ).rejects.toThrow(/no stored content/);
    });

    // M11.5 regression: rollbackFile recreates parent dir if it was removed
    // since the version was captured (e.g. directory rename + cleanup).
    // Without the defensive mkdir, the fs.writeFile would throw ENOENT.
    it("recreates parent dir when it was removed since version capture (M11.5)", async () => {
      const nested = path.join(tc.workDir, "ephemeral", "snap.txt");
      await writeFile(tc.ctx, { path: nested, content: "v1" });
      await writeFile(tc.ctx, { path: nested, content: "v2" });

      const versions = tc.ctx.db.getVersions(nested);
      const target = versions.find((v) => v.content === "v1");
      expect(target).toBeDefined();

      // Simulate a directory cleanup between version capture and rollback.
      await fs.rm(path.dirname(nested), { recursive: true, force: true });
      await expect(fs.access(path.dirname(nested))).rejects.toThrow();

      const r = await rollbackFile(tc.ctx, {
        path: nested,
        versionId: target!.id,
      });
      expect(r.success).toBe(true);
      expect(await fs.readFile(nested, "utf-8")).toBe("v1");
    });

    // M12.2 regression: rollback_file can resurrect a deleted file from
    // its tombstone version. Pairs with the deleteFile fix in
    // filesystem.ts that captures content + reorders addVersion to
    // survive the deleteFileMetadata cascade.
    it("restores a deleted file from its tombstone version (M12.2)", async () => {
      const p = path.join(tc.workDir, "resurrect.txt");
      await writeFile(tc.ctx, { path: p, content: "to be restored" });

      await deleteFile(tc.ctx, { path: p });
      await expect(fs.access(p)).rejects.toThrow();

      const versions = tc.ctx.db.getVersions(p);
      const tombstone = versions.find((v) => v.message === "File deleted");
      expect(tombstone, "deletion tombstone must exist").toBeDefined();
      expect(tombstone!.content).toBe("to be restored");

      const r = await rollbackFile(tc.ctx, {
        path: p,
        versionId: tombstone!.id,
      });
      expect(r.success).toBe(true);
      expect(await fs.readFile(p, "utf-8")).toBe("to be restored");
    });
  });

  // ────────────────────── getMetadata ──────────────────────
  describe("getMetadata", () => {
    it("returns null for a file with no DB metadata", async () => {
      const p = await writeSandboxFile(tc.workDir, "raw.txt", "x");
      const r = await getMetadata(tc.ctx, { path: p });
      expect(r.metadata).toBeNull();
    });

    it("returns the cached metadata after writeFile registers it", async () => {
      const p = path.join(tc.workDir, "meta.ts");
      await writeFile(tc.ctx, { path: p, content: "export const x = 1;" });
      const r = await getMetadata(tc.ctx, { path: p });
      expect(r.metadata).not.toBeNull();
      expect(r.metadata?.path).toBe(p);
      expect(r.metadata?.language).toBe("typescript");
    });
  });
});
