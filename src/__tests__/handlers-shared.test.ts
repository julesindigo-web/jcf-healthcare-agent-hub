/**
 * Direct unit tests for `handlers/shared/*` — pure functions, no services.
 *
 * These exercise:
 *   - `validatePath` (path-guard.ts)
 *   - `getCurrentUser`, `withAudit` (audit.ts)
 *   - `hashContent`, `patternToRegex`, `getCoherenceMessage` (util.ts)
 *   - `analyzeFileContent`, language analyzers, `detectLanguage` (content-analysis.ts)
 *   - `fsGetMetadata` (metadata.ts)
 *
 * Created in M11 audit to drive coverage on the shared infra
 * extracted from `JcfHealthcareAgentHubServer`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";

// Mock auth-tokens before any imports that use it
vi.mock('../lib/auth-tokens.js', () => ({
  validateToken: vi.fn(),
}));

import { validatePath } from "../handlers/shared/path-guard.js";
import { withAudit, getCurrentUser } from "../handlers/shared/audit.js";
import {
  hashContent,
  patternToRegex,
  getCoherenceMessage,
} from "../handlers/shared/util.js";
import {
  analyzeFileContent,
  analyzeJavaScript,
  analyzePython,
  analyzeJava,
  detectLanguage,
} from "../handlers/shared/content-analysis.js";
import { fsGetMetadata } from "../handlers/shared/metadata.js";
import { validateToken } from '../lib/auth-tokens.js';

import { createTestContext, type TestContext } from "./_test-context.js";

describe("handlers/shared/path-guard.ts — validatePath", () => {
  let tc: TestContext;
  beforeEach(async () => { tc = await createTestContext(); });
  afterEach(async () => { await tc.cleanup(); });

  it("accepts paths inside the allowed directory", () => {
    const ok = validatePath(tc.ctx, path.join(tc.workDir, "ok.txt"));
    expect(path.normalize(ok)).toBe(path.normalize(path.join(tc.workDir, "ok.txt")));
  });

  it("rejects paths containing traversal segments", () => {
    expect(() => validatePath(tc.ctx, "../../etc/passwd")).toThrow(/Path traversal/);
  });

  it("rejects paths outside the allowed directory", () => {
    const outside = path.join(os.tmpdir(), "totally-different-dir", "x.txt");
    expect(() => validatePath(tc.ctx, outside)).toThrow(/not within allowed/);
  });

  it("treats the allowed directory itself as allowed", () => {
    const ok = validatePath(tc.ctx, tc.workDir);
    expect(path.normalize(ok)).toBe(path.normalize(tc.workDir));
  });

  it("rejects forbidden subpaths even when inside allowed dir", () => {
    const forbidden = path.join(tc.workDir, "blocked");
    tc.ctx.config.forbiddenPaths = [forbidden];
    const target = path.join(forbidden, "secret.txt");
    expect(() => validatePath(tc.ctx, target)).toThrow(/forbidden path/);
  });

  it("falls through to forbidden-only checks when allowedDirectories is empty", () => {
    tc.ctx.config.allowedDirectories = [];
    tc.ctx.config.forbiddenPaths = [path.join(tc.workDir, "deny")];
    const okPath = validatePath(tc.ctx, path.join(tc.workDir, "free.txt"));
    expect(typeof okPath).toBe("string");
    expect(() =>
      validatePath(tc.ctx, path.join(tc.workDir, "deny", "x.txt"))
    ).toThrow(/forbidden path/);
  });
});

describe("handlers/shared/audit.ts", () => {
  let tc: TestContext;
  beforeEach(async () => { tc = await createTestContext(); });
  afterEach(async () => { await tc.cleanup(); });

  describe("getCurrentUser", () => {
    const orig = { id: process.env.MCP_FS_USER_ID, role: process.env.MCP_FS_USER_ROLE, token: process.env.MCP_FS_AUTH_TOKEN };
    afterEach(() => {
      if (orig.id === undefined) delete process.env.MCP_FS_USER_ID;
      else process.env.MCP_FS_USER_ID = orig.id;
      if (orig.role === undefined) delete process.env.MCP_FS_USER_ROLE;
      else process.env.MCP_FS_USER_ROLE = orig.role;
      if (orig.token === undefined) delete process.env.MCP_FS_AUTH_TOKEN;
      else process.env.MCP_FS_AUTH_TOKEN = orig.token;
    });

    it("defaults to 'default-user' / 'user' when no env vars are set", async () => {
      delete process.env.MCP_FS_USER_ID;
      delete process.env.MCP_FS_USER_ROLE;
      const u = await getCurrentUser();
      expect(u).toEqual({ id: "default-user", role: "user" });
    });

    it("derives 'admin' role when user id == 'admin' and role is unset", async () => {
      process.env.MCP_FS_USER_ID = "admin";
      delete process.env.MCP_FS_USER_ROLE;
      const u = await getCurrentUser();
      expect(u).toEqual({ id: "admin", role: "admin" });
    });

    it("respects explicit role override", async () => {
      process.env.MCP_FS_USER_ID = "alice";
      process.env.MCP_FS_USER_ROLE = "auditor";
      const u = await getCurrentUser();
      expect(u).toEqual({ id: "alice", role: "auditor" });
    });

    it("validates token and returns identity when MCP_FS_AUTH_TOKEN is set and valid", async () => {
      process.env.MCP_FS_AUTH_TOKEN = 'test-token';
      const mockIdentity = { id: 'token-user', role: 'admin', label: 'Test Admin' };
      (validateToken as any).mockReturnValue(mockIdentity);
      const u = await getCurrentUser(tc.ctx);
      expect(u).toEqual(mockIdentity);
      expect(validateToken).toHaveBeenCalledWith(tc.ctx.db, 'test-token');
    });

    it("throws error when MCP_FS_AUTH_TOKEN is set but validation fails", async () => {
      process.env.MCP_FS_AUTH_TOKEN = 'bad-token';
      (validateToken as any).mockReturnValue(null);
      await expect(getCurrentUser(tc.ctx)).rejects.toThrow(/failed validation/);
    });
  });

  describe("withAudit", () => {
    it("records success on resolve and returns the value", async () => {
      const res = await withAudit(tc.ctx, "read", "/sandbox/x.txt", async () => 42);
      expect(res).toBe(42);
      const events = tc.ctx.db.queryAudits({});
      expect(events.some((e) => e.result === "success" && e.action === "read")).toBe(true);
    });

    it("records failure and rethrows on reject", async () => {
      await expect(
        withAudit(tc.ctx, "read", "/sandbox/x.txt", async () => {
          throw new Error("boom");
        })
      ).rejects.toThrow(/boom/);
      const events = tc.ctx.db.queryAudits({});
      expect(events.some((e) => e.result === "failure" && /boom/.test(e.reason ?? ""))).toBe(true);
    });

    it("skips RBAC enforcement for read action (preserved behavior)", async () => {
      // Explicitly run as a non-admin role to confirm read still passes
      process.env.MCP_FS_USER_ID = "guest";
      process.env.MCP_FS_USER_ROLE = "guest";
      const res = await withAudit(tc.ctx, "read", "/sandbox/x.txt", async () => "ok");
      expect(res).toBe("ok");
    });
  });
});

describe("handlers/shared/util.ts", () => {
  describe("hashContent", () => {
    it("returns 64-char hex SHA-256", () => {
      const h = hashContent("hello");
      expect(h).toMatch(/^[a-f0-9]{64}$/);
    });

    it("is deterministic", () => {
      expect(hashContent("abc")).toBe(hashContent("abc"));
    });

    it("differs for different inputs", () => {
      expect(hashContent("a")).not.toBe(hashContent("b"));
    });
  });

  describe("patternToRegex", () => {
    it("matches `*` against any sequence", () => {
      const re = patternToRegex("*.ts");
      expect(re.test("foo.ts")).toBe(true);
      expect(re.test("nested/foo.ts")).toBe(true);
      expect(re.test("foo.js")).toBe(false);
    });

    it("matches `?` against exactly one char (M12.1 fix)", () => {
      // M12.1: `?` previously got escaped to `\?` then mangled
      // to `\.` (literal dot match) by the subsequent glob-expansion step.
      // Fixed in util.ts by removing `?` from the metacharacter-escape
      // class so `.replace(/\?/g, ".")` now lands on the unescaped `?` and
      // produces `.` (any single char), matching the documented contract.
      const re = patternToRegex("a?c");
      expect(re.test("abc")).toBe(true);   // any single char in the middle
      expect(re.test("aXc")).toBe(true);
      expect(re.test("a.c")).toBe(true);   // dot is just one char to `?`
      expect(re.test("a c")).toBe(true);   // whitespace too
      expect(re.test("ac")).toBe(false);   // zero chars — `?` requires exactly one
      expect(re.test("abbc")).toBe(false); // two chars — `?` requires exactly one
    });

    it("combines `*` and `?` glob wildcards correctly (M12.1)", () => {
      const re = patternToRegex("*.t?");
      expect(re.test("foo.ts")).toBe(true);
      expect(re.test("bar.tx")).toBe(true);
      expect(re.test("nested/file.ts")).toBe(true); // `*` spans separators too
      expect(re.test("README.md")).toBe(false);     // wrong extension
      expect(re.test("foo.t")).toBe(false);         // missing the `?` char
      expect(re.test("foo.tsx")).toBe(false);       // `?` is exactly one, not one-or-more
    });

    it("is case-insensitive", () => {
      expect(patternToRegex("FOO*").test("foo.bar")).toBe(true);
    });

    it("escapes regex metacharacters", () => {
      const re = patternToRegex("a.b");
      expect(re.test("a.b")).toBe(true);
      expect(re.test("aXb")).toBe(false);
    });
  });

  describe("getCoherenceMessage", () => {
    it("returns 'high coherence' for score > 0.8", () => {
      expect(getCoherenceMessage(0.9, "low")).toMatch(/high coherence/i);
    });

    it("returns 'moderate coupling' for 0.5 < score <= 0.8", () => {
      expect(getCoherenceMessage(0.6, "medium")).toMatch(/moderate coupling/i);
    });

    it("returns 'highly coupled' for score <= 0.5", () => {
      expect(getCoherenceMessage(0.3, "high")).toMatch(/highly coupled/i);
    });

    it("boundary: score == 0.8 falls into moderate", () => {
      expect(getCoherenceMessage(0.8, "low")).toMatch(/moderate coupling/i);
    });

    it("boundary: score == 0.5 falls into highly coupled", () => {
      expect(getCoherenceMessage(0.5, "low")).toMatch(/highly coupled/i);
    });
  });
});

describe("handlers/shared/content-analysis.ts", () => {
  describe("detectLanguage", () => {
    const cases: Array<[string, string]> = [
      ["a.ts", "typescript"],
      ["a.tsx", "tsx"],
      ["a.js", "javascript"],
      ["a.jsx", "jsx"],
      ["a.py", "python"],
      ["a.java", "java"],
      ["a.c", "c"],
      ["a.cpp", "cpp"],
      ["a.h", "c"],
      ["a.hpp", "cpp"],
      ["a.rs", "rust"],
      ["a.go", "go"],
      ["a.rb", "ruby"],
      ["a.php", "php"],
      ["a.swift", "swift"],
      ["a.kt", "kotlin"],
      ["a.scala", "scala"],
      ["a.cs", "csharp"],
      ["a.json", "json"],
      ["a.yaml", "yaml"],
      ["a.yml", "yaml"],
      ["a.md", "markdown"],
      ["a.sh", "bash"],
      ["a.unknown", "unknown"],
      ["a", "unknown"],
    ];
    for (const [file, lang] of cases) {
      it(`maps ${file} → ${lang}`, () => {
        expect(detectLanguage(file)).toBe(lang);
      });
    }
  });

  describe("analyzeJavaScript", () => {
    it("extracts imports, exports, complexity from TS/JS", () => {
      const src = `import { x } from './mod';
import * as y from 'libb';
export const a = 1;
export default function foo() {}
if (true) {}
for (const i of x) {}
while (x) {}
switch (1) { case 1: break; }
try {} catch (e) {}`;
      const r = analyzeJavaScript(src);
      expect(r.imports).toEqual(expect.arrayContaining(["./mod", "libb"]));
      expect(r.exports).toEqual(expect.arrayContaining(["a", "foo"]));
      expect((r.complexity ?? 0)).toBeGreaterThan(1);
    });

    it("returns complexity=1 for empty content", () => {
      expect(analyzeJavaScript("").complexity).toBe(1);
    });
  });

  describe("analyzePython", () => {
    it("extracts imports + complexity", () => {
      const src = `from os import path
import sys
if x:
  pass
elif y:
  pass
for i in range(10):
  pass
try:
  pass
except Exception:
  pass`;
      const r = analyzePython(src);
      expect(r.imports).toEqual(expect.arrayContaining(["os", "sys"]));
      expect((r.complexity ?? 0)).toBeGreaterThan(1);
    });
  });

  describe("analyzeJava", () => {
    it("extracts imports + complexity", () => {
      const src = `import java.util.List;
import java.io.IOException;
class A {
  void f() {
    if (x) {} else {}
    for (int i = 0; i < 10; i++) {}
    try {} catch (Exception e) {} finally {}
  }
}`;
      const r = analyzeJava(src);
      expect(r.imports).toEqual(expect.arrayContaining(["java.util.List", "java.io.IOException"]));
      expect((r.complexity ?? 0)).toBeGreaterThan(1);
    });
  });

  describe("analyzeFileContent (dispatcher)", () => {
    it("dispatches .ts to JS analyzer", () => {
      const r = analyzeFileContent("import x from 'm';", "/x.ts");
      expect(r.imports).toContain("m");
    });

    it("dispatches .py to Python analyzer", () => {
      const r = analyzeFileContent("import sys", "/x.py");
      expect(r.imports).toContain("sys");
    });

    it("dispatches .java to Java analyzer", () => {
      const r = analyzeFileContent("import java.util.List;", "/x.java");
      expect(r.imports).toContain("java.util.List");
    });

    it("returns empty {} for unknown extension", () => {
      const r = analyzeFileContent("anything", "/x.xyz");
      expect(r).toEqual({});
    });
  });
});

describe("handlers/shared/metadata.ts — fsGetMetadata", () => {
  let tc: TestContext;
  beforeEach(async () => { tc = await createTestContext(); });
  afterEach(async () => { await tc.cleanup(); });

  it("returns full metadata bundle for a real file", async () => {
    const p = path.join(tc.workDir, "file.ts");
    await fs.writeFile(p, "export const x = 1;\n", "utf-8");
    const m = await fsGetMetadata(p);
    expect(m.path).toBe(p);
    expect(m.size).toBeGreaterThan(0);
    expect(m.modified instanceof Date).toBe(true);
    expect(m.created instanceof Date).toBe(true);
    expect(m.language).toBe("typescript");
    expect(m.exports).toContain("x");
  });

  it("propagates errors when file does not exist", async () => {
    await expect(fsGetMetadata(path.join(tc.workDir, "nope.txt"))).rejects.toThrow();
  });
});
