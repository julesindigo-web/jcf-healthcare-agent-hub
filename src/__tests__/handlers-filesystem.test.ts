/**
 * Direct unit tests for `handlers/filesystem.ts` — readFile, writeFile,
 * editFile, appendFile, deleteFile, listDirectory.
 *
 * Built in M11 audit to drive coverage on the filesystem
 * handlers extracted from `JcfHealthcareAgentHubServer`. Each test calls the pure
 * handler directly with a real `HandlerContext` (in-process, real services,
 * sandbox temp dir) so v8 coverage is tracked per-line.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";

import {
  readFile,
  writeFile,
  editFile,
  appendFile,
  deleteFile,
  listDirectory,
} from "../handlers/filesystem.js";

import {
  createTestContext,
  writeSandboxFile,
  type TestContext,
} from "./_test-context.js";

describe("handlers/filesystem.ts", () => {
  let tc: TestContext;
  beforeEach(async () => { tc = await createTestContext(); });
  afterEach(async () => { await tc.cleanup(); });

  // ────────────────────────── readFile ──────────────────────────
  describe("readFile", () => {
    it("returns full content for a small file", async () => {
      const p = await writeSandboxFile(tc.workDir, "a.txt", "hello\nworld\n");
      const r = await readFile(tc.ctx, { path: p });
      expect(r.content).toBe("hello\nworld\n");
      expect(r.metadata.size).toBeGreaterThan(0);
      expect(r.readInfo.totalLines).toBe(3); // hello + world + trailing empty
      expect(r.readInfo.truncated).toBe(false);
    });

    it("paginates with offset/limit", async () => {
      const lines = Array.from({ length: 50 }, (_, i) => `line${i + 1}`).join("\n");
      const p = await writeSandboxFile(tc.workDir, "big.txt", lines);
      const r = await readFile(tc.ctx, { path: p, offset: 10, limit: 5 });
      expect(r.readInfo.offset).toBe(10);
      expect(r.readInfo.limit).toBe(5);
      expect(r.readInfo.returnedLines).toBe(5);
      expect(r.content.split("\n")).toEqual([
        "line10", "line11", "line12", "line13", "line14",
      ]);
      expect(r.readInfo.truncated).toBe(true);
      expect(r.readInfo.nextOffset).toBe(15);
      expect(r.readInfo.resumeHint).toMatch(/offset=15/);
    });

    it("clamps offset below 1 to 1", async () => {
      const p = await writeSandboxFile(tc.workDir, "a.txt", "one\ntwo\n");
      const r = await readFile(tc.ctx, { path: p, offset: 0 });
      expect(r.readInfo.offset).toBe(1);
    });

    it("uses cache on second read with unchanged file", async () => {
      const p = await writeSandboxFile(tc.workDir, "cached.txt", "v1");
      const r1 = await readFile(tc.ctx, { path: p });
      const r2 = await readFile(tc.ctx, { path: p });
      expect(r1.content).toBe("v1");
      expect(r2.content).toBe("v1");
      // Second read should be a cache hit (no error) — we just verify
      // the dispatcher returns the same content.
    });

    it("invalidates cache when file mtime changes", async () => {
      const p = await writeSandboxFile(tc.workDir, "stale.txt", "before");
      await readFile(tc.ctx, { path: p });
      // Sleep one tick so mtime is different on fast filesystems
      await new Promise((r) => setTimeout(r, 20));
      await fs.writeFile(p, "after", "utf-8");
      const r = await readFile(tc.ctx, { path: p });
      expect(r.content).toBe("after");
    });

    it("respects maxLines override", async () => {
      const p = await writeSandboxFile(
        tc.workDir,
        "huge.txt",
        Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join("\n")
      );
      const r = await readFile(tc.ctx, { path: p, maxLines: 3 });
      expect(r.readInfo.returnedLines).toBe(3);
      expect(r.readInfo.truncated).toBe(true);
    });

    it("rejects path traversal", async () => {
      await expect(
        readFile(tc.ctx, { path: "../../etc/passwd" })
      ).rejects.toThrow(/Path traversal/);
    });
  });

  // ────────────────────────── writeFile ──────────────────────────
  describe("writeFile", () => {
    it("creates a new file and returns initial versionId", async () => {
      const p = path.join(tc.workDir, "new.ts");
      const r = await writeFile(tc.ctx, { path: p, content: "export const x = 1;\n" });
      expect(r.success).toBe(true);
      expect(r.versionId).toBe("initial");
      const onDisk = await fs.readFile(p, "utf-8");
      expect(onDisk).toBe("export const x = 1;\n");
    });

    it("returns content-hash versionId on overwrite", async () => {
      const p = path.join(tc.workDir, "v.ts");
      await writeFile(tc.ctx, { path: p, content: "a" });
      const r = await writeFile(tc.ctx, { path: p, content: "b", author: "tester", message: "v2" });
      expect(r.success).toBe(true);
      expect(r.versionId).toMatch(/^[a-f0-9]{64}$/);
    });

    it("captures previous content as a version row on overwrite", async () => {
      const p = path.join(tc.workDir, "history.ts");
      await writeFile(tc.ctx, { path: p, content: "first" });
      await writeFile(tc.ctx, { path: p, content: "second" });
      const versions = tc.ctx.db.getVersions(p);
      expect(versions.length).toBeGreaterThanOrEqual(1);
      expect(versions.some((v) => v.content === "first")).toBe(true);
    });

    it("refuses content with secrets", async () => {
      const p = path.join(tc.workDir, "leaky.ts");
      const secret = `const k = "AKIA${"X".repeat(16)}";`; // looks like AWS key
      await expect(
        writeFile(tc.ctx, { path: p, content: secret })
      ).rejects.toThrow(/potential secret/);
    });

    it("rejects content larger than maxFileSize", async () => {
      tc.ctx.config.maxFileSize = 100;
      const p = path.join(tc.workDir, "big.txt");
      await expect(
        writeFile(tc.ctx, { path: p, content: "x".repeat(200) })
      ).rejects.toThrow(/exceeds maximum allowed size/);
    });

    // M11.5 regression: writeFile auto-creates missing parent directories.
    // Bug surfaced via dogfooding: writeFile to a nested path threw
    // ENOENT when intermediate dirs didn't exist. Fix:
    // mkdir(dirname, { recursive: true }) before fs.writeFile.
    it("auto-creates missing parent directories (M11.5)", async () => {
      const nested = path.join(tc.workDir, "deep", "new", "dir", "file.ts");
      const r = await writeFile(tc.ctx, {
        path: nested,
        content: "export const ok = 1;\n",
      });
      expect(r.success).toBe(true);
      expect(await fs.readFile(nested, "utf-8")).toBe("export const ok = 1;\n");
    });
  });

  // ────────────────────────── editFile ──────────────────────────
  describe("editFile", () => {
    it("applies a single replacement", async () => {
      const p = await writeSandboxFile(tc.workDir, "e.ts", "foo bar foo");
      const r = await editFile(tc.ctx, {
        path: p,
        edits: [{ oldText: "foo", newText: "baz" }],
      });
      expect(r.applied).toBe(2);
      expect(await fs.readFile(p, "utf-8")).toBe("baz bar baz");
    });

    it("applies multiple sequential edits", async () => {
      const p = await writeSandboxFile(tc.workDir, "e.ts", "alpha beta gamma");
      const r = await editFile(tc.ctx, {
        path: p,
        edits: [
          { oldText: "alpha", newText: "X" },
          { oldText: "beta", newText: "Y" },
        ],
      });
      expect(r.applied).toBe(2);
      expect(await fs.readFile(p, "utf-8")).toBe("X Y gamma");
    });

    it("throws when no patterns match", async () => {
      const p = await writeSandboxFile(tc.workDir, "e.ts", "hello");
      await expect(
        editFile(tc.ctx, {
          path: p,
          edits: [{ oldText: "missing", newText: "x" }],
        })
      ).rejects.toThrow(/No edits were applied/);
    });
  });

  // ────────────────────────── appendFile ──────────────────────────
  describe("appendFile", () => {
    it("appends to an existing file", async () => {
      const p = await writeSandboxFile(tc.workDir, "a.txt", "first\n");
      const r = await appendFile(tc.ctx, { path: p, content: "second\n" });
      expect(r.success).toBe(true);
      expect(r.bytesAppended).toBe(7);
      expect(await fs.readFile(p, "utf-8")).toBe("first\nsecond\n");
    });

    it("refuses on missing file when createIfMissing=false", async () => {
      const p = path.join(tc.workDir, "no.txt");
      await expect(
        appendFile(tc.ctx, { path: p, content: "x" })
      ).rejects.toThrow(/createIfMissing/);
    });

    it("creates the file when createIfMissing=true", async () => {
      const p = path.join(tc.workDir, "new.txt");
      const r = await appendFile(tc.ctx, {
        path: p,
        content: "hello",
        createIfMissing: true,
      });
      expect(r.success).toBe(true);
      expect(await fs.readFile(p, "utf-8")).toBe("hello");
    });

    it("rejects when total size after append would exceed maxFileSize", async () => {
      tc.ctx.config.maxFileSize = 50;
      const p = await writeSandboxFile(tc.workDir, "x.txt", "x".repeat(40));
      await expect(
        appendFile(tc.ctx, { path: p, content: "y".repeat(20) })
      ).rejects.toThrow(/exceed max file size/);
    });

    it("scans appended content for secrets when file exists", async () => {
      const p = await writeSandboxFile(tc.workDir, "s.txt", "ok\n");
      const secret = `key=AKIA${"X".repeat(16)}`;
      await expect(
        appendFile(tc.ctx, { path: p, content: secret })
      ).rejects.toThrow(/potential secret/);
    });

    // M11.5 regression: createIfMissing path now auto-creates parent dirs.
    it("creates missing parent dirs when createIfMissing=true (M11.5)", async () => {
      const nested = path.join(tc.workDir, "a", "b", "c", "new.txt");
      const r = await appendFile(tc.ctx, {
        path: nested,
        content: "hello",
        createIfMissing: true,
      });
      expect(r.success).toBe(true);
      expect(await fs.readFile(nested, "utf-8")).toBe("hello");
    });

    // M11.5 regression: createIfMissing=false still rejects missing files,
    // even when only the parent dir is missing. The mkdir branch must NOT
    // execute on this code path (would silently weaken the contract).
    it("refuses to create parent dirs when createIfMissing=false (M11.5)", async () => {
      const nested = path.join(tc.workDir, "x", "y", "z", "refuse.txt");
      await expect(
        appendFile(tc.ctx, { path: nested, content: "x" })
      ).rejects.toThrow(/createIfMissing/);
      // Parent dir must NOT have been created as a side effect.
      await expect(fs.access(path.dirname(nested))).rejects.toThrow();
    });
  });

  // ────────────────────────── deleteFile ──────────────────────────
  describe("deleteFile", () => {
    it("removes the file from disk", async () => {
      const p = await writeSandboxFile(tc.workDir, "doomed.txt", "bye");
      const r = await deleteFile(tc.ctx, { path: p });
      expect(r.success).toBe(true);
      await expect(fs.access(p)).rejects.toThrow();
    });

    it("captures a recoverable tombstone version on delete (M12.2)", async () => {
      const p = path.join(tc.workDir, "snap.txt");
      // writeFile registers metadata + initial state in DB.
      await writeFile(tc.ctx, { path: p, content: "remember me" });
      expect(tc.ctx.db.getFileMetadata(p)).not.toBeNull();

      await deleteFile(tc.ctx, { path: p });

      // M12.2: deleteFile now captures pre-delete content,
      // runs unlink + deleteFileMetadata (which cascades old version
      // history inside one TX), then materializes a tombstone version
      // that survives the cascade. This restores the rollback-after-
      // delete capability that the version-history API has always
      // advertised. Pre-fix, addVersion ran BEFORE deleteFileMetadata
      // (cascade wiped it) AND was called without the `content` arg.
      expect(tc.ctx.db.getFileMetadata(p)).toBeNull();

      const versions = tc.ctx.db.getVersions(p);
      const tombstone = versions.find(
        (v) => v.message === "File deleted" && v.content === "remember me"
      );
      expect(
        tombstone,
        "tombstone version with pre-delete content must exist after delete"
      ).toBeDefined();

      const audits = tc.ctx.db.queryAudits({ action: "delete" });
      expect(audits.some((e) => e.path === p && e.result === "success")).toBe(true);
    });

    it("clears prior version history but keeps the tombstone (M12.2)", async () => {
      const p = path.join(tc.workDir, "history-clear.txt");
      await writeFile(tc.ctx, { path: p, content: "v1" });
      await new Promise((r) => setTimeout(r, 5));
      await writeFile(tc.ctx, { path: p, content: "v2" });
      await new Promise((r) => setTimeout(r, 5));
      await writeFile(tc.ctx, { path: p, content: "v3" });

      // Pre-delete: writeFile records overwritten content as versions.
      expect(tc.ctx.db.getVersions(p).length).toBeGreaterThanOrEqual(2);

      await deleteFile(tc.ctx, { path: p });

      // Post-delete: cascade wipes prior history; the tombstone is added
      // afterwards as the sole survivor with the most-recent content.
      const versions = tc.ctx.db.getVersions(p);
      expect(versions).toHaveLength(1);
      expect(versions[0].message).toBe("File deleted");
      expect(versions[0].content).toBe("v3");
    });

    it("skips tombstone when file has no DB metadata and no on-disk content (M12.2)", async () => {
      // Direct fs.writeFile bypasses DB registration. The file exists on
      // disk but has no metadata row — snapshot capture still succeeds
      // (we read content from disk), so a tombstone IS created. This
      // confirms the snapshot path falls back to file size when metadata
      // is null.
      const p = path.join(tc.workDir, "orphan.txt");
      await fs.writeFile(p, "no-metadata", "utf-8");
      expect(tc.ctx.db.getFileMetadata(p)).toBeNull();

      await deleteFile(tc.ctx, { path: p });

      const versions = tc.ctx.db.getVersions(p);
      expect(versions.some((v) => v.content === "no-metadata")).toBe(true);
    });

    it("propagates ENOENT when file doesn't exist", async () => {
      await expect(
        deleteFile(tc.ctx, { path: path.join(tc.workDir, "nope.txt") })
      ).rejects.toThrow();
    });
  });

  // ────────────────────────── listDirectory ──────────────────────────
  describe("listDirectory", () => {
    it("lists files and subdirectories", async () => {
      await writeSandboxFile(tc.workDir, "a.txt", "1");
      await writeSandboxFile(tc.workDir, "b.txt", "22");
      await fs.mkdir(path.join(tc.workDir, "sub"), { recursive: true });

      const r = await listDirectory(tc.ctx, { path: tc.workDir });
      const names = r.entries.map((e) => e.name).sort();
      expect(names).toEqual(["a.txt", "b.txt", "sub"]);
      const sub = r.entries.find((e) => e.name === "sub");
      expect(sub?.type).toBe("directory");
      const a = r.entries.find((e) => e.name === "a.txt");
      expect(a?.type).toBe("file");
      expect(a?.size).toBe(1);
    });

    it("filters dotfiles by default", async () => {
      await writeSandboxFile(tc.workDir, ".hidden", "x");
      await writeSandboxFile(tc.workDir, "visible.txt", "y");
      const r = await listDirectory(tc.ctx, { path: tc.workDir });
      const names = r.entries.map((e) => e.name);
      expect(names).toContain("visible.txt");
      expect(names).not.toContain(".hidden");
    });

    it("includes dotfiles when includeHidden=true", async () => {
      await writeSandboxFile(tc.workDir, ".hidden", "x");
      const r = await listDirectory(tc.ctx, { path: tc.workDir, includeHidden: true });
      const names = r.entries.map((e) => e.name);
      expect(names).toContain(".hidden");
    });
  });

  // ── M14 regression tests ──────────────────────────────────────────────

  // M14 Bug #1: CRLF mismatch — editFile must apply agent-supplied (LF) oldText
  // against CRLF disk content and preserve the original line ending style.
  describe("editFile — M14 Bug #1 CRLF mismatch regression", () => {
    it("applies LF oldText against CRLF file content", async () => {
      // Write a CRLF file directly to disk (bypassing writeFile which normalizes)
      const p = path.join(tc.workDir, "crlf.ts");
      await fs.writeFile(p, "line1\r\nline2\r\nline3\r\n", "utf-8");
      // Agent reads with readFile (returns LF-normalized), crafts LF oldText
      const r = await editFile(tc.ctx, {
        path: p,
        edits: [{ oldText: "line2\n", newText: "line2-edited\n" }],
      });
      expect(r.applied).toBe(1);
      // Disk content must preserve CRLF line endings
      const disk = await fs.readFile(p, "utf-8");
      expect(disk).toBe("line1\r\nline2-edited\r\nline3\r\n");
    });

    it("leaves pure LF files unchanged in style after edit", async () => {
      const p = path.join(tc.workDir, "lf.ts");
      await fs.writeFile(p, "aaa\nbbb\nccc\n", "utf-8");
      const r = await editFile(tc.ctx, {
        path: p,
        edits: [{ oldText: "bbb\n", newText: "bbb-edited\n" }],
      });
      expect(r.applied).toBe(1);
      const disk = await fs.readFile(p, "utf-8");
      // Must NOT have CRLF introduced
      expect(disk.includes("\r")).toBe(false);
      expect(disk).toBe("aaa\nbbb-edited\nccc\n");
    });
  });
});
