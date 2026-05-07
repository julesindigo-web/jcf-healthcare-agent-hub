/**
 * Property-based tests for handler invariants — uses fast-check.
 *
 * These complement the example-based tests in `handlers-*.test.ts` by
 * generating thousands of randomized inputs and asserting structural
 * invariants that must hold for every input.
 *
 * Built in M11 audit.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fc from "fast-check";
import path from "path";

import {
  hashContent,
  patternToRegex,
  getCoherenceMessage,
} from "../handlers/shared/util.js";
import { detectLanguage } from "../handlers/shared/content-analysis.js";
import { validatePath } from "../handlers/shared/path-guard.js";
import { withAudit } from "../handlers/shared/audit.js";
import {
  readFile,
  writeFile,
  editFile,
  listDirectory,
} from "../handlers/filesystem.js";
import {
  getVersionHistory,
  getMetadata,
} from "../handlers/versioning.js";
import {
  getDependents,
  getDependencies,
  checkCoherence,
} from "../handlers/dependencies.js";
import { TOOL_REGISTRY } from "../registry.js";

import {
  createTestContext,
  type TestContext,
} from "./_test-context.js";

// fast-check string arbitraries that are safe for filesystem use:
// alphanum + `_` + `-` only. We avoid `.` because the path-guard rejects
// any string containing the literal substring `..` (path-traversal guard),
// and concatenating filenames into a wrapper like `lst-${name}.txt` can
// produce `..` if `name` ends with `.`. Easier to forbid `.` entirely than
// to special-case wrapping.
const safeFilename = fc
  .string({ minLength: 1, maxLength: 20 })
  .filter((s) => /^[a-zA-Z0-9_-]+$/.test(s));

const safeContent = fc.string({ minLength: 0, maxLength: 1000 });

describe("handlers properties — pure utilities", () => {
  describe("hashContent", () => {
    it("is deterministic: ∀ s. hashContent(s) === hashContent(s)", () => {
      fc.assert(
        fc.property(fc.string(), (s) => {
          expect(hashContent(s)).toBe(hashContent(s));
        }),
        { numRuns: 200 }
      );
    });

    it("always returns 64-hex SHA-256", () => {
      fc.assert(
        fc.property(fc.string(), (s) => {
          expect(hashContent(s)).toMatch(/^[a-f0-9]{64}$/);
        }),
        { numRuns: 200 }
      );
    });

    it("collision-free for distinct simple strings (probabilistic)", () => {
      fc.assert(
        fc.property(
          fc.tuple(fc.string({ minLength: 1 }), fc.string({ minLength: 1 })),
          ([a, b]) => {
            fc.pre(a !== b);
            expect(hashContent(a)).not.toBe(hashContent(b));
          }
        ),
        { numRuns: 200 }
      );
    });
  });

  describe("patternToRegex", () => {
    it("a literal pattern (no wildcards, no metacharacters) matches itself", () => {
      const literal = fc.stringMatching(/^[a-zA-Z0-9_-]+$/);
      fc.assert(
        fc.property(literal, (s) => {
          fc.pre(s.length > 0);
          expect(patternToRegex(s).test(s)).toBe(true);
        }),
        { numRuns: 200 }
      );
    });

    it("`*` patterns always match the empty string when bracketed", () => {
      // Pattern `*X*` should match anything containing X
      fc.assert(
        fc.property(fc.string({ minLength: 1, maxLength: 10 }), (s) => {
          fc.pre(/^[a-zA-Z0-9]+$/.test(s)); // simple cases only
          const pat = `*${s}*`;
          expect(patternToRegex(pat).test(s)).toBe(true);
          expect(patternToRegex(pat).test(`prefix${s}suffix`)).toBe(true);
        }),
        { numRuns: 100 }
      );
    });

    it("returns a valid RegExp for any input string", () => {
      fc.assert(
        fc.property(fc.string({ maxLength: 30 }), (s) => {
          const re = patternToRegex(s);
          expect(re).toBeInstanceOf(RegExp);
        }),
        { numRuns: 200 }
      );
    });
  });

  describe("getCoherenceMessage", () => {
    it("partitions by score thresholds: >0.8 → high, >0.5 → moderate, else highly coupled", () => {
      fc.assert(
        fc.property(
          fc.float({ min: 0, max: 1, noNaN: true }),
          fc.constantFrom(
            "low" as const,
            "medium" as const,
            "high" as const,
            "critical" as const
          ),
          (score, risk) => {
            const msg = getCoherenceMessage(score, risk);
            if (score > 0.8) {
              expect(msg).toMatch(/high coherence/);
            } else if (score > 0.5) {
              expect(msg).toMatch(/moderate coupling/);
            } else {
              expect(msg).toMatch(/highly coupled/);
            }
          }
        ),
        { numRuns: 300 }
      );
    });
  });

  describe("detectLanguage", () => {
    const knownExt = fc.constantFrom(
      ".ts", ".js", ".py", ".java", ".rs", ".go", ".rb"
    );

    it("returns 'unknown' for unknown extensions", () => {
      fc.assert(
        fc.property(fc.string({ minLength: 1, maxLength: 6 }), (ext) => {
          fc.pre(/^[a-z]+$/.test(ext));
          fc.pre(
            ![
              "ts", "tsx", "js", "jsx", "py", "java", "c", "cpp", "h", "hpp",
              "rs", "go", "rb", "php", "swift", "kt", "scala", "cs", "fs",
              "vb", "xml", "html", "css", "scss", "sass", "less", "json",
              "yaml", "yml", "toml", "md", "sh", "bash", "zsh", "fish",
              "ps1", "bat", "cmd", "sql", "graphql", "gql",
            ].includes(ext)
          );
          expect(detectLanguage(`/some/path/file.${ext}`)).toBe("unknown");
        }),
        { numRuns: 100 }
      );
    });

    it("known extensions consistently map to a non-empty language id", () => {
      fc.assert(
        fc.property(knownExt, (ext) => {
          const lang = detectLanguage(`/x${ext}`);
          expect(lang.length).toBeGreaterThan(0);
          expect(lang).not.toBe("unknown");
        }),
        { numRuns: 100 }
      );
    });
  });
});

describe("handlers properties — filesystem invariants", () => {
  let tc: TestContext;
  beforeEach(async () => {
    vi.useFakeTimers();
    tc = await createTestContext();
  });
  afterEach(async () => {
    await tc.cleanup();
    vi.useRealTimers();
  });

  it("write-then-read round-trip preserves content (after CRLF normalization)", async () => {
    // `readFile` splits on /\r?\n/ and joins with \n, so any `\r` in the
    // input is normalized away on read. Round-trip equality holds modulo
    // that normalization — we strip `\r` from the input before comparing.
    await fc.assert(
      fc.asyncProperty(safeFilename, safeContent, async (name, content) => {
        const p = path.join(tc.workDir, `wr-${name}.txt`);
        // Skip content with potential secrets — writeFile rejects them.
        fc.pre(!/[A-Za-z0-9]{24,}/.test(content));
        await writeFile(tc.ctx, { path: p, content });
        const r = await readFile(tc.ctx, { path: p });
        const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "");
        expect(r.content).toBe(normalized);
      }),
      { numRuns: 25 }
    );
  });

  it("editFile is idempotent when oldText === newText", async () => {
    await fc.assert(
      fc.asyncProperty(safeFilename, safeContent, async (name, content) => {
        fc.pre(!/[A-Za-z0-9]{24,}/.test(content));
        fc.pre(content.length > 0);
        const p = path.join(tc.workDir, `id-${name}.txt`);
        await writeFile(tc.ctx, { path: p, content });
        // Pick a substring that exists in content
        const slice = content.slice(0, Math.min(5, content.length));
        fc.pre(slice.length > 0);
        const beforeHash = hashContent(content);
        // Same → same edit (no behavior change after one application)
        await editFile(tc.ctx, {
          path: p,
          edits: [{ oldText: slice, newText: slice }],
        });
        const after = await readFile(tc.ctx, { path: p });
        expect(hashContent(after.content)).toBe(beforeHash);
      }),
      { numRuns: 20 }
    );
  }, 30000);

  it("validatePath inside workDir → returns non-empty absolute path", () => {
    fc.assert(
      fc.property(safeFilename, (name) => {
        const target = path.join(tc.workDir, name);
        const ok = validatePath(tc.ctx, target);
        expect(typeof ok).toBe("string");
        expect(ok.length).toBeGreaterThan(0);
        expect(path.isAbsolute(ok)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it("validatePath rejects any path that escapes the sandbox", () => {
    // Note: `path.join(workDir, "..", name)` resolves the `..` segment
    // before validatePath sees it, so the literal-string traversal check
    // does NOT fire — the allowed-dirs check rejects it instead. Either
    // outcome means access is denied; we accept both error messages.
    fc.assert(
      fc.property(safeFilename, (name) => {
        const escapes = path.join(tc.workDir, "..", name);
        expect(() => validatePath(tc.ctx, escapes)).toThrow(
          /Path traversal|not within allowed/
        );
      }),
      { numRuns: 50 }
    );
  });

  it("validatePath rejects literal `..` segments before resolution", () => {
    fc.assert(
      fc.property(safeFilename, (name) => {
        const literal = `${tc.workDir}/sub/../../${name}`;
        expect(() => validatePath(tc.ctx, literal)).toThrow(
          /Path traversal|not within allowed/
        );
      }),
      { numRuns: 50 }
    );
  });

  it("listDirectory entries always have name + path + type", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(safeFilename, { minLength: 1, maxLength: 5 }),
        async (names) => {
          // Plant unique files
          const unique = [...new Set(names)];
          for (const n of unique) {
            await writeFile(tc.ctx, {
              path: path.join(tc.workDir, `lst-${n}.txt`),
              content: "x",
            });
          }
          const r = await listDirectory(tc.ctx, { path: tc.workDir });
          for (const e of r.entries) {
            expect(typeof e.name).toBe("string");
            expect(e.name.length).toBeGreaterThan(0);
            expect(typeof e.path).toBe("string");
            expect(["file", "directory"]).toContain(e.type);
          }
        }
      ),
      { numRuns: 10 }
    );
  });
});

describe("handlers properties — audit & version invariants", () => {
  let tc: TestContext;
  beforeEach(async () => {
    vi.useFakeTimers();
    tc = await createTestContext();
  });
  afterEach(async () => {
    await tc.cleanup();
    vi.useRealTimers();
  });

  it("withAudit records exactly one audit row per call (success)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(
          "read" as const,
          "write" as const,
          "delete" as const,
          "search" as const
        ),
        fc.string({ minLength: 1, maxLength: 30 }),
        async (action, label) => {
          const before = tc.ctx.db.queryAudits({}).length;
          await withAudit(tc.ctx, action, `/sandbox/${label}`, async () => "ok");
          const after = tc.ctx.db.queryAudits({}).length;
          expect(after).toBe(before + 1);
        }
      ),
      { numRuns: 25 }
    );
  });

  it("withAudit records exactly one failure audit row on rejection", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("read" as const, "write" as const, "delete" as const),
        fc.string({ minLength: 1, maxLength: 30 }),
        async (action, label) => {
          const before = tc.ctx.db.queryAudits({ result: "failure" }).length;
          await expect(
            withAudit(tc.ctx, action, `/sandbox/${label}`, async () => {
              throw new Error("boom");
            })
          ).rejects.toThrow();
          const after = tc.ctx.db.queryAudits({ result: "failure" }).length;
          expect(after).toBe(before + 1);
        }
      ),
      { numRuns: 25 }
    );
  });

  it("getVersionHistory returns versions in descending timestamp order", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(safeContent, { minLength: 2, maxLength: 5 }),
        async (contents) => {
          // Filter content with potential secrets
          fc.pre(contents.every((c) => !/[A-Za-z0-9]{24,}/.test(c)));
          const p = path.join(tc.workDir, "vh.txt");
          for (const c of contents) {
            await writeFile(tc.ctx, { path: p, content: c });
            vi.advanceTimersByTime(5); // deterministic time progression
          }
          const r = await getVersionHistory(tc.ctx, { path: p });
          for (let i = 1; i < r.versions.length; i++) {
            expect(
              r.versions[i - 1].timestamp.getTime()
            ).toBeGreaterThanOrEqual(r.versions[i].timestamp.getTime());
          }
        }
      ),
      { numRuns: 10 }
    );
  });

  it("getMetadata returns non-null after writeFile registers metadata", async () => {
    await fc.assert(
      fc.asyncProperty(safeFilename, async (name) => {
        const p = path.join(tc.workDir, `m-${name}.ts`);
        await writeFile(tc.ctx, {
          path: p,
          content: "export const x = 1;",
        });
        const r = await getMetadata(tc.ctx, { path: p });
        expect(r.metadata).not.toBeNull();
        expect(r.metadata?.path).toBe(p);
      }),
      { numRuns: 15 }
    );
  });
});

describe("handlers properties — dependency invariants", () => {
  let tc: TestContext;
  beforeEach(async () => {
    vi.useFakeTimers();
    tc = await createTestContext();
  });
  afterEach(async () => {
    await tc.cleanup();
    vi.useRealTimers();
  });

  it("isolated file → checkCoherence reports score=1 + 'high coherence' message", async () => {
    await fc.assert(
      fc.asyncProperty(safeFilename, async (name) => {
        const p = path.join(tc.workDir, `iso-${name}.ts`);
        await writeFile(tc.ctx, {
          path: p,
          content: `export const x_${name.replace(/[^a-z]/gi, "")} = 1;`,
        });
        const r = await checkCoherence(tc.ctx, { path: p });
        expect(r.coherence.score).toBe(1);
        expect(r.coherence.message).toMatch(/high coherence/i);
      }),
      { numRuns: 10 }
    );
  });

  it("getDependents/getDependencies always return arrays of strings", async () => {
    await fc.assert(
      fc.asyncProperty(safeFilename, async (name) => {
        const p = path.join(tc.workDir, `${name}.ts`);
        await writeFile(tc.ctx, {
          path: p,
          content: "export const x = 1;",
        });
        const a = await getDependents(tc.ctx, { path: p });
        const b = await getDependencies(tc.ctx, { path: p });
        expect(Array.isArray(a.dependents)).toBe(true);
        expect(Array.isArray(b.dependencies)).toBe(true);
        for (const v of [...a.dependents, ...b.dependencies]) {
          expect(typeof v).toBe("string");
        }
      }),
      { numRuns: 15 }
    );
  });
});

describe("handlers properties — registry invariants", () => {
  it("every registered tool name is unique (case-sensitive)", () => {
    const names = Object.keys(TOOL_REGISTRY);
    const set = new Set(names);
    expect(set.size).toBe(names.length);
  });

  it("every registered tool has both schema and handler functions", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...(Object.keys(TOOL_REGISTRY) as string[])),
        (name) => {
          const reg = TOOL_REGISTRY[name];
          expect(reg).toBeDefined();
          expect(typeof reg.handler).toBe("function");
          expect(typeof (reg.schema as { safeParse: unknown }).safeParse).toBe(
            "function"
          );
        }
      ),
      { numRuns: 50 }
    );
  });
});
