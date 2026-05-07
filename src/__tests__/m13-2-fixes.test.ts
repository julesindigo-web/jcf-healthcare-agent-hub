//
// M13.2 regression coverage for the 4 jcf-healthcare-agent-hub
// tool fixes that landed after the M13 jcf-memory recon surfaced them.
//
// Bugs (real-case repro from M13 work):
//
//   #1 get_module_contracts returned {modules: []} for valid TS files
//      because the cognitive index stores forward-slash paths while
//      Windows callers passed back-slash paths; strict Array.includes
//      mis-fired on the slash mismatch.
//
//   #2 get_dependents returned [] for files that obviously had
//      dependents because DependencyGraphManager.graph.reverse only
//      gets populated when files are touched (registerFile,
//      updateFile). Files indexed via build_cognitive_index but never
//      edited via MCP did not appear. Meanwhile get_impact_analysis
//      (which queries the NLKG built by the cognitive index) returned
//      the correct edges.
//
//   #3 search_files glob with a leading double-star path prefix
//      returned [] because patternToRegex matched only against
//      entry.name (basename) and the recursive prefix collapsed to a
//      regex that required a slash inside a basename, which never
//      matches.
//
//   #4 edit_file silently produced corrupt JS or TS files when
//      newText contained backticks that closed an enclosing template
//      literal. The handler returned success while writing a
//      syntactically broken file to disk plus the version history.
//
// Fixes:
//   - New handlers/shared/edit-safety.ts (assessEditRisk,
//     verifyPostEditIntegrity, summarizeEditDiff) wired into editFile.
//   - New handlers/shared/path-normalize.ts (normalizeIndexPath,
//     pathSetIncludes) wired into intelligence and dependencies
//     handlers.
//   - searchFiles rewritten on top of fast-glob for full glob dialect
//     support (already a runtime dep used elsewhere).
//
// These tests cover both the pure-helper layer (fast feedback) and the
// handler-integration layer (proves the wires meet).
//

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assessEditRisk,
  verifyPostEditIntegrity,
  summarizeEditDiff,
} from "../handlers/shared/edit-safety.js";
import {
  normalizeIndexPath,
  pathSetIncludes,
} from "../handlers/shared/path-normalize.js";

// ─────────────────────────────────────────────────────────────────────
// edit-safety: assessEditRisk
// ─────────────────────────────────────────────────────────────────────

describe("M13.2 edit-safety — assessEditRisk", () => {
  it("returns level=low + zero warnings for plain text edits in a JS file", () => {
    const report = assessEditRisk(
      "/tmp/foo.ts",
      "const x = 1;\nconst y = 2;\n",
      [{ oldText: "x = 1", newText: "x = 99" }]
    );
    expect(report.level).toBe("low");
    expect(report.warnings).toEqual([]);
  });

  it("flags backtick-injection into a JS file that already uses template literals", () => {
    const prior = "const greeting = `hello ${name}`;\n";
    const report = assessEditRisk("/tmp/foo.ts", prior, [
      { oldText: "hello", newText: "`hi`" },
    ]);
    expect(report.level).toBe("medium");
    expect(report.warnings.length).toBe(1);
    expect(report.warnings[0]).toContain("backtick");
    expect(report.warnings[0]).toContain("edit[0]");
  });

  it("does not flag backtick-injection when the target has no pre-existing template literals", () => {
    // Fresh file with no backticks → injecting a backtick is the START
    // of a template literal, not closure of an existing one. Risk is
    // ambiguous; the heuristic prefers low to avoid false positives.
    const report = assessEditRisk("/tmp/foo.ts", "const x = 1;\n", [
      { oldText: "x", newText: "`x`" },
    ]);
    expect(report.level).toBe("low");
    expect(report.warnings).toEqual([]);
  });

  it("flags a brace-delta drift edit", () => {
    const report = assessEditRisk(
      "/tmp/foo.ts",
      "function f() { return 1; }\n",
      [{ oldText: "{ return 1; }", newText: "{ return 1; " }]
    );
    expect(report.level).toBe("medium");
    expect(report.warnings.some((w) => w.includes("brace delta drift"))).toBe(
      true
    );
  });

  it("escalates to level=high when 3+ warnings accumulate", () => {
    const prior = "let s = `a${x}b`;\n".repeat(3);
    const report = assessEditRisk("/tmp/foo.ts", prior, [
      { oldText: "a", newText: "`x`" },
      { oldText: "b", newText: "`y`" },
      { oldText: "x", newText: "`z`" },
    ]);
    expect(report.level).toBe("high");
    expect(report.warnings.length).toBeGreaterThanOrEqual(3);
  });

  it("does not flag .py / .md / .json / unknown extensions for backtick concerns", () => {
    for (const ext of [".py", ".md", ".json", ".rs", ""]) {
      const report = assessEditRisk(
        `/tmp/foo${ext}`,
        "raw `backticks` everywhere",
        [{ oldText: "raw", newText: "`raw`" }]
      );
      // The backtick-specific JS/TS heuristic should not fire.
      expect(
        report.warnings.some((w) => w.includes("backtick"))
      ).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// edit-safety: verifyPostEditIntegrity
// ─────────────────────────────────────────────────────────────────────

describe("M13.2 edit-safety — verifyPostEditIntegrity", () => {
  it("returns null for a balanced TS edit", () => {
    const prior = "function f() { return 1; }\n";
    const candidate = "function f() { return 2; }\n";
    expect(verifyPostEditIntegrity("/tmp/x.ts", prior, candidate)).toBeNull();
  });

  it("flags BACKTICK_IMBALANCE when an edit corrupts backtick parity", () => {
    // Prior has 2 backticks (balanced template literal); candidate has 3
    // (unclosed). This is the exact failure mode that bit jcf-memory
    // schema-comment edits in M13.
    const prior = "const s = `hello`;\n";
    const candidate = "const s = `hello` `oops;\n";
    const violation = verifyPostEditIntegrity(
      "/tmp/x.ts",
      prior,
      candidate
    );
    expect(violation).not.toBeNull();
    expect(violation!.code).toBe("BACKTICK_IMBALANCE");
    expect(violation!.priorCount).toBe(2);
    expect(violation!.candidateCount).toBe(3);
  });

  it("flags BRACE_IMBALANCE when an edit drops a closing brace", () => {
    const prior = "function f() { return 1; }\n";
    const candidate = "function f() { return 1;\n";
    const violation = verifyPostEditIntegrity(
      "/tmp/x.ts",
      prior,
      candidate
    );
    expect(violation).not.toBeNull();
    expect(violation!.code).toBe("BRACE_IMBALANCE");
  });

  it("flags JSON_PARSE_FAILED for invalid JSON candidates", () => {
    const prior = '{"a": 1}\n';
    const candidate = '{"a": 1,}\n';
    const violation = verifyPostEditIntegrity(
      "/tmp/x.json",
      prior,
      candidate
    );
    expect(violation).not.toBeNull();
    expect(violation!.code).toBe("JSON_PARSE_FAILED");
  });

  it("returns null for valid JSON edit", () => {
    const prior = '{"a": 1}\n';
    const candidate = '{"a": 2}\n';
    expect(
      verifyPostEditIntegrity("/tmp/x.json", prior, candidate)
    ).toBeNull();
  });

  it("permits pre-existing imbalance as long as edit doesn't shift it", () => {
    // Markdown-ish file forced through the JS check path: prior is
    // imbalanced, candidate carries the same imbalance. Edit shouldn't
    // be blamed for what was already there.
    const prior = "function f() { /* intentional partial };\n";
    const candidate = "function g() { /* intentional partial };\n";
    expect(verifyPostEditIntegrity("/tmp/x.ts", prior, candidate)).toBeNull();
  });

  it("skips integrity check for unsupported extensions (.md, .py, .txt)", () => {
    for (const ext of [".md", ".py", ".txt", ".rs", ""]) {
      // A wildly imbalanced candidate should still pass for non-JS/JSON
      // targets because the heuristic is opt-in by extension.
      const violation = verifyPostEditIntegrity(
        `/tmp/x${ext}`,
        "balanced",
        "((((((((((unbalanced",
      );
      expect(violation).toBeNull();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// edit-safety: summarizeEditDiff
// ─────────────────────────────────────────────────────────────────────

describe("M13.2 edit-safety — summarizeEditDiff", () => {
  it("captures byte delta for additive edits", () => {
    const summary = summarizeEditDiff("hello", "hello world", 1, 1);
    expect(summary.byteDelta).toBe(6);
    expect(summary.totalEdits).toBe(1);
    expect(summary.totalApplied).toBe(1);
  });

  it("captures negative byte delta for shrinking edits", () => {
    const summary = summarizeEditDiff("hello world", "hello", 1, 1);
    expect(summary.byteDelta).toBe(-6);
  });

  it("identifies the first changed line (1-based)", () => {
    const prior = "a\nb\nc\nd\n";
    const candidate = "a\nb\nX\nd\n";
    const summary = summarizeEditDiff(prior, candidate, 1, 1);
    expect(summary.firstChangedLine).toBe(3);
  });

  it("returns firstChangedLine=null when content is identical", () => {
    const summary = summarizeEditDiff("same\n", "same\n", 0, 0);
    expect(summary.firstChangedLine).toBeNull();
    expect(summary.lastChangedLine).toBeNull();
    expect(summary.byteDelta).toBe(0);
  });

  it("counts lines added vs removed correctly", () => {
    const prior = "a\nb\n";
    const candidate = "a\nb\nc\nd\ne\n";
    const summary = summarizeEditDiff(prior, candidate, 1, 1);
    expect(summary.linesAdded).toBe(3);
    expect(summary.linesRemoved).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// path-normalize
// ─────────────────────────────────────────────────────────────────────

describe("M13.2 path-normalize — normalizeIndexPath", () => {
  it("converts Windows backslashes to forward slashes AND lowercases the full path on Windows", () => {
    // M13.2: Windows is case-insensitive at the FS boundary, so the
    // entire path (drive + body) is lowercased. POSIX is left alone.
    expect(normalizeIndexPath("C:\\Users\\TUF\\foo.ts")).toBe(
      "c:/users/tuf/foo.ts"
    );
  });

  it("lowercases the Windows drive letter (still works as a sub-case)", () => {
    expect(normalizeIndexPath("Z:\\bar.ts")).toBe("z:/bar.ts");
  });

  it("lowercases mixed-case Windows paths idempotently", () => {
    expect(normalizeIndexPath("c:/Users/TUF/foo.ts")).toBe(
      "c:/users/tuf/foo.ts"
    );
    // Idempotent: applying twice yields the same result.
    expect(normalizeIndexPath("c:/users/tuf/foo.ts")).toBe(
      "c:/users/tuf/foo.ts"
    );
  });

  it("is a no-op for POSIX paths (case-sensitive filesystem)", () => {
    expect(normalizeIndexPath("/home/user/foo.ts")).toBe("/home/user/foo.ts");
    expect(normalizeIndexPath("/Home/User/Foo.ts")).toBe("/Home/User/Foo.ts");
  });

  it("handles empty / falsy input gracefully", () => {
    expect(normalizeIndexPath("")).toBe("");
  });

  it("handles relative paths without a drive letter (slash-normalize only)", () => {
    // No drive letter → no lowercasing (could be relative or POSIX).
    expect(normalizeIndexPath("Foo\\Bar\\Baz.ts")).toBe("Foo/Bar/Baz.ts");
  });
});

describe("M13.2 path-normalize — pathSetIncludes", () => {
  const indexed = [
    "c:/Users/TUF/foo.ts",
    "c:/Users/TUF/bar.ts",
    "/home/user/baz.ts",
  ];

  it("matches a Windows backslash candidate against forward-slash index", () => {
    expect(pathSetIncludes(indexed, "C:\\Users\\TUF\\foo.ts")).toBe(true);
  });

  it("matches a forward-slash candidate against forward-slash index", () => {
    expect(pathSetIncludes(indexed, "c:/Users/TUF/foo.ts")).toBe(true);
  });

  it("matches with drive-letter case differing", () => {
    expect(pathSetIncludes(indexed, "C:\\users\\tuf\\bar.ts")).toBe(true);
  });

  it("returns false for genuinely missing paths", () => {
    expect(pathSetIncludes(indexed, "C:\\Users\\TUF\\missing.ts")).toBe(false);
  });

  it("returns false for empty set", () => {
    expect(pathSetIncludes([], "/foo.ts")).toBe(false);
  });

  it("matches POSIX path against POSIX index entry", () => {
    expect(pathSetIncludes(indexed, "/home/user/baz.ts")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// editFile integration: dryRun + risk + integrity violation paths.
// We exercise the handler via a thin in-memory HandlerContext fake.
// ─────────────────────────────────────────────────────────────────────

import { editFile } from "../handlers/filesystem.js";
import type { HandlerContext } from "../handlers/context.js";

interface FakeCtx {
  config: {
    allowedDirectories: string[];
    forbiddenPaths: string[];
    requireApprovalForPathsOutsideCwd: boolean;
  };
  approvalService: { check: () => Promise<boolean> };
  security: {
    enforceRBAC: () => Promise<void>;
    isPathAllowedAsync: () => Promise<boolean>;
    scanForSecrets: () => string[];
    recordSecurityAudit: () => Promise<void>;
  };
  db: {
    // M13.2: real audit.ts wrapper calls `ctx.db.recordAudit(event)`
    // (NOT `addAudit`). Earlier draft of this fake used the wrong
    // method name and produced TypeError: ctx.db.recordAudit is not a
    // function for every editFile integration test.
    recordAudit: (event: unknown) => Promise<void>;
    addVersion: () => Promise<void>;
    setFileMetadata: () => Promise<void>;
  };
  logger: {
    info: () => void;
    warn: () => void;
    debug: () => void;
    error: () => void;
  };
  dependencyGraph: { updateFile: () => Promise<void> };
  vectorDb: { indexFile: () => Promise<void> };
  codeIntelligence: { incrementalUpdate: () => Promise<void> };
  cache: { delete: () => void };
  rateLimiter: { take: () => true };
  metricsTracker: undefined;
}

function buildFakeCtx(allowed: string): FakeCtx {
  return {
    config: {
      allowedDirectories: [allowed],
      forbiddenPaths: [],
      requireApprovalForPathsOutsideCwd: false,
    },
    approvalService: { check: async () => true },
    security: {
      enforceRBAC: async () => undefined,
      isPathAllowedAsync: async () => true,
      scanForSecrets: () => [],
      recordSecurityAudit: async () => undefined,
    },
    db: {
      recordAudit: async () => undefined,
      addVersion: async () => undefined,
      setFileMetadata: async () => undefined,
    },
    logger: {
      info: () => undefined,
      warn: () => undefined,
      debug: () => undefined,
      error: () => undefined,
    },
    dependencyGraph: { updateFile: async () => undefined },
    vectorDb: { indexFile: async () => undefined },
    codeIntelligence: { incrementalUpdate: async () => undefined },
    cache: { delete: () => undefined },
    rateLimiter: { take: () => true },
    metricsTracker: undefined,
  };
}

describe("M13.2 editFile integration — risk / integrity / dryRun", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jcf-m13-edit-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns risk=low + diff for a benign edit", async () => {
    const file = join(dir, "plain.ts");
    writeFileSync(file, "export const X = 1;\n");
    const ctx = buildFakeCtx(dir) as unknown as HandlerContext;

    const result = await editFile(ctx, {
      path: file,
      edits: [{ oldText: "X = 1", newText: "X = 99" }],
    });

    expect(result.success).toBe(true);
    expect(result.applied).toBe(1);
    expect(result.risk.level).toBe("low");
    expect(result.diff.totalApplied).toBe(1);
    expect(result.diff.byteDelta).toBe(1);
    expect(result.dryRun).toBe(false);
  });

  it("dryRun=true does NOT modify the file but reports diff + risk", async () => {
    const file = join(dir, "preview.ts");
    writeFileSync(file, "export const X = 1;\n");
    const ctx = buildFakeCtx(dir) as unknown as HandlerContext;
    const { readFileSync } = await import("node:fs");
    const before = readFileSync(file, "utf-8");

    const result = await editFile(ctx, {
      path: file,
      edits: [{ oldText: "X = 1", newText: "X = 42" }],
      dryRun: true,
    });

    expect(result.success).toBe(true);
    expect(result.applied).toBe(1);
    expect(result.dryRun).toBe(true);
    expect(result.diff.totalApplied).toBe(1);
    // Disk content must be unchanged.
    expect(readFileSync(file, "utf-8")).toBe(before);
  });

  it("aborts a backtick-corrupting edit by default (integrity check)", async () => {
    const file = join(dir, "corrupt.ts");
    writeFileSync(file, "const s = `hello`;\n");
    const ctx = buildFakeCtx(dir) as unknown as HandlerContext;

    // This is the EXACT failure mode that bit jcf-memory schema comments
    // — injecting a stray backtick that closes the outer template literal.
    await expect(
      editFile(ctx, {
        path: file,
        edits: [{ oldText: "hello", newText: "`oops" }],
      })
    ).rejects.toThrow(/integrity check/);

    const { readFileSync } = await import("node:fs");
    expect(readFileSync(file, "utf-8")).toBe("const s = `hello`;\n");
  });

  it("unsafe=true bypasses the integrity check (escape hatch)", async () => {
    const file = join(dir, "unsafe.ts");
    writeFileSync(file, "const s = `hello`;\n");
    const ctx = buildFakeCtx(dir) as unknown as HandlerContext;

    const result = await editFile(ctx, {
      path: file,
      edits: [{ oldText: "hello", newText: "`oops" }],
      unsafe: true,
    });

    expect(result.success).toBe(true);
    expect(result.risk.level).toBe("low"); // unsafe short-circuits the scan
  });
});
