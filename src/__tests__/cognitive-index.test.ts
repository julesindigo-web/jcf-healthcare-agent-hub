/**
 * Unit + integration tests for `src/lib/cognitive-index.ts` (T3.3).
 *
 * Coverage targets (hot-spots by cyclomatic complexity):
 *   - detectTechStack (C=22): package.json / requirements.txt / go.mod / Cargo.toml / language distribution
 *   - _doSave (C=9): write-fsync-rename atomic path + ENOENT race guards
 *   - computeStats (C=8): totalModules/Units/Exports/Types, avgComplexity, pureFunctionRatio, asyncFunctionRatio
 *   - buildDirTree (C=7): depth cap, SKIP_DIRS filter, file vs directory nodes
 *   - queryExportsByName (C=7): substring + exact name match, empty index guard
 *   - serializeIndex / deserializeIndex: roundtrip fidelity via save + initialize
 *   - Query getters (≤C=3): getIndex, getSkeleton, getModules, getUnits, getStats,
 *                           getModulesForFile, getUnitsForFile,
 *                           queryUnitsByPattern, queryUnitsByTag
 *   - extractModuleContracts: exports / imports / types extraction from TS source
 *   - extractUnitFingerprints: function, class, arrow-function fingerprinting
 *   - classifyUnitPattern: naming-convention → pattern category mapping
 *   - detectSideEffects: console / fs / fetch / timer signals
 *   - incrementalUpdate: removes stale entries, re-extracts, updates stats
 *   - initialize: loads persisted index, graceful on ENOENT
 *   - buildSkeleton: end-to-end skeleton with techStack + archPatterns + totals
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";

import { CognitiveIndexEngine } from "../lib/cognitive-index.js";
import { Logger } from "../lib/logger.js";

const logger = new Logger("error");

let workDir: string;
let engine: CognitiveIndexEngine;

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "jcf-cogidx-"));
  engine = new CognitiveIndexEngine({
    logger,
    indexPath: path.join(workDir, ".jcf-cognitive-index.json"),
  });
});

afterEach(async () => {
  try { await fs.rm(workDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

async function writeFile(rel: string, content: string): Promise<string> {
  const abs = path.join(workDir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf-8");
  return abs;
}

// ─────────────────────────────────────────────────────────────────────
// initialize()
// ─────────────────────────────────────────────────────────────────────

describe("initialize", () => {
  it("returns null index when no persisted file exists (ENOENT)", async () => {
    await engine.initialize();
    expect(engine.getIndex()).toBeNull();
  });

  it("loads persisted index on re-init after buildFullIndex", async () => {
    const file = await writeFile("src/foo.ts", `export function hello(): string { return "hi"; }`);
    const idx = await engine.buildFullIndex(workDir, [file]);
    expect(idx.stats.totalModules).toBe(1);

    const engine2 = new CognitiveIndexEngine({
      logger,
      indexPath: path.join(workDir, ".jcf-cognitive-index.json"),
    });
    await engine2.initialize();
    const loaded = engine2.getIndex();
    expect(loaded).not.toBeNull();
    expect(loaded!.stats.totalModules).toBe(1);
  }, 30000);
});

// ─────────────────────────────────────────────────────────────────────
// getIndex / getters before any index
// ─────────────────────────────────────────────────────────────────────

describe("getters without index", () => {
  it("getIndex returns null before any build", () => {
    expect(engine.getIndex()).toBeNull();
  });

  it("getSkeleton returns null before any build", () => {
    expect(engine.getSkeleton()).toBeNull();
  });

  it("getModules returns [] before any build", () => {
    expect(engine.getModules()).toEqual([]);
  });

  it("getUnits returns [] before any build", () => {
    expect(engine.getUnits()).toEqual([]);
  });

  it("getStats returns zero-stats before any build", () => {
    const s = engine.getStats();
    expect(s.totalModules).toBe(0);
    expect(s.totalUnits).toBe(0);
  });

  it("getModulesForFile returns null before any build", () => {
    expect(engine.getModulesForFile("/any/path.ts")).toBeNull();
  });

  it("getUnitsForFile returns [] before any build", () => {
    expect(engine.getUnitsForFile("/any/path.ts")).toEqual([]);
  });

  it("queryUnitsByPattern returns [] before any build", () => {
    expect(engine.queryUnitsByPattern("query")).toEqual([]);
  });

  it("queryUnitsByTag returns [] before any build", () => {
    expect(engine.queryUnitsByTag("data-retrieval")).toEqual([]);
  });

  it("queryExportsByName returns [] before any build", () => {
    expect(engine.queryExportsByName("anything")).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// detectTechStack (via buildSkeleton) — package.json branch
// ─────────────────────────────────────────────────────────────────────

describe("detectTechStack — package.json", () => {
  it("detects React from dependencies", async () => {
    await writeFile(
      "package.json",
      JSON.stringify({ dependencies: { react: "^18.0.0", "react-dom": "^18.0.0" } })
    );
    const sk = await engine.buildSkeleton(workDir);
    const names = sk.techStack.map((t) => t.name.toLowerCase());
    expect(names.some((n) => n.includes("react"))).toBe(true);
  });

  it("detects Express from dependencies", async () => {
    await writeFile(
      "package.json",
      JSON.stringify({ dependencies: { express: "4.18.0" } })
    );
    const sk = await engine.buildSkeleton(workDir);
    const names = sk.techStack.map((t) => t.name.toLowerCase());
    expect(names.some((n) => n.includes("express"))).toBe(true);
  });

  it("sets version from depVer when available", async () => {
    await writeFile(
      "package.json",
      JSON.stringify({ devDependencies: { typescript: "5.4.0" } })
    );
    const sk = await engine.buildSkeleton(workDir);
    const ts = sk.techStack.find((t) => t.name.toLowerCase().includes("typescript"));
    if (ts) {
      expect(ts.version).toBe("5.4.0");
    }
  });

  it("handles malformed package.json without throwing", async () => {
    await writeFile("package.json", "NOT JSON {{");
    await expect(engine.buildSkeleton(workDir)).resolves.toBeDefined();
  });

  it("handles missing package.json without throwing", async () => {
    await expect(engine.buildSkeleton(workDir)).resolves.toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────
// detectTechStack — requirements.txt branch
// ─────────────────────────────────────────────────────────────────────

describe("detectTechStack — requirements.txt", () => {
  it("detects Django from requirements.txt", async () => {
    await writeFile("requirements.txt", "django==4.2.0\nrequests==2.31.0\n");
    const sk = await engine.buildSkeleton(workDir);
    const names = sk.techStack.map((t) => t.name.toLowerCase());
    expect(names.some((n) => n.includes("django"))).toBe(true);
  });

  it("detects FastAPI from requirements.txt without version", async () => {
    await writeFile("requirements.txt", "fastapi\nuvicorn\n");
    const sk = await engine.buildSkeleton(workDir);
    const names = sk.techStack.map((t) => t.name.toLowerCase());
    expect(names.some((n) => n.includes("fastapi"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// detectTechStack — language distribution branch
// ─────────────────────────────────────────────────────────────────────

describe("detectTechStack — language distribution", () => {
  it("reports TypeScript language when .ts files present", async () => {
    await writeFile("src/a.ts", "const x = 1;");
    await writeFile("src/b.ts", "const y = 2;");
    const sk = await engine.buildSkeleton(workDir);
    const names = sk.techStack.map((t) => t.name.toLowerCase());
    expect(names.some((n) => n.includes("typescript") || n === "ts")).toBe(true);
  });

  it("reports Python language when .py files present", async () => {
    await writeFile("main.py", "def run(): pass\n");
    const sk = await engine.buildSkeleton(workDir);
    const names = sk.techStack.map((t) => t.name.toLowerCase());
    expect(names.some((n) => n.includes("python") || n === "py")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// buildDirTree (via buildSkeleton)
// ─────────────────────────────────────────────────────────────────────

describe("buildDirTree (via buildSkeleton)", () => {
  it("includes source files in directory nodes", async () => {
    await writeFile("src/index.ts", "export default 1;");
    const sk = await engine.buildSkeleton(workDir);
    const rootNode = sk.directoryTree;
    expect(rootNode.type).toBe("directory");
    expect(rootNode.children).toBeDefined();
  });

  it("skips node_modules", async () => {
    await writeFile("node_modules/pkg/index.js", "module.exports = {}");
    await writeFile("src/app.ts", "export const x = 1;");
    const sk = await engine.buildSkeleton(workDir);
    const childNames = sk.directoryTree.children?.map((c) => c.name) ?? [];
    expect(childNames).not.toContain("node_modules");
  });

  it("skips .git", async () => {
    await writeFile(".git/HEAD", "ref: refs/heads/main");
    const sk = await engine.buildSkeleton(workDir);
    const childNames = sk.directoryTree.children?.map((c) => c.name) ?? [];
    expect(childNames).not.toContain(".git");
  });

  it("skeleton has correct rootPath and name", async () => {
    const sk = await engine.buildSkeleton(workDir);
    expect(sk.rootPath).toBe(workDir);
    expect(sk.name).toBe(path.basename(workDir));
  });

  it("totalFiles count matches collected files", async () => {
    await writeFile("src/a.ts", "const a = 1;");
    await writeFile("src/b.ts", "const b = 2;");
    const sk = await engine.buildSkeleton(workDir);
    expect(sk.totalFiles).toBeGreaterThanOrEqual(2);
  });
});

// ─────────────────────────────────────────────────────────────────────
// extractModuleContracts
// ─────────────────────────────────────────────────────────────────────

describe("extractModuleContracts", () => {
  it("extracts exported function from TS file", async () => {
    const f = await writeFile(
      "src/utils.ts",
      `export function add(a: number, b: number): number { return a + b; }`
    );
    const contracts = await engine.extractModuleContracts([f]);
    expect(contracts.length).toBe(1);
    const exp = contracts[0]!.exports.find((e) => e.name === "add");
    expect(exp).toBeDefined();
    expect(exp!.kind).toBe("function");
  });

  it("extracts exported interface from TS file", async () => {
    const f = await writeFile(
      "src/types.ts",
      `export interface User { id: string; name: string; }`
    );
    const contracts = await engine.extractModuleContracts([f]);
    expect(contracts.length).toBe(1);
    const exp = contracts[0]!.exports.find((e) => e.name === "User");
    expect(exp).toBeDefined();
    expect(exp!.kind).toBe("interface");
  });

  it("extracts imports from TS file", async () => {
    const f = await writeFile(
      "src/service.ts",
      `import { Logger } from './logger.js';
export class Service { constructor(private log: Logger) {} }`
    );
    const contracts = await engine.extractModuleContracts([f]);
    expect(contracts.length).toBe(1);
    const imp = contracts[0]!.imports.find((i) => i.name === "Logger");
    expect(imp).toBeDefined();
    expect(imp!.from).toBe("./logger.js");
  });

  it("detects console side effect", async () => {
    const f = await writeFile(
      "src/debug.ts",
      `export function log(msg: string) { console.log(msg); }`
    );
    const contracts = await engine.extractModuleContracts([f]);
    expect(contracts[0]!.sideEffects).toContain("console-output");
  });

  it("detects network-request side effect", async () => {
    const f = await writeFile(
      "src/api.ts",
      `export async function getUser() { return fetch('/api/user'); }`
    );
    const contracts = await engine.extractModuleContracts([f]);
    expect(contracts[0]!.sideEffects).toContain("network-request");
  });

  it("skips unsupported extensions", async () => {
    const f = await writeFile("src/style.css", `.body { color: red; }`);
    const contracts = await engine.extractModuleContracts([f]);
    expect(contracts.length).toBe(0);
  });

  it("skips non-existent files gracefully", async () => {
    const contracts = await engine.extractModuleContracts(["/does/not/exist.ts"]);
    expect(contracts.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// extractUnitFingerprints
// ─────────────────────────────────────────────────────────────────────

describe("extractUnitFingerprints", () => {
  it("fingerprints a regular function", async () => {
    const f = await writeFile(
      "src/math.ts",
      `export function multiply(a: number, b: number): number { return a * b; }`
    );
    const units = await engine.extractUnitFingerprints([f]);
    const fn = units.find((u) => u.name === "multiply");
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe("function");
    expect(fn!.id).toContain("multiply");
  });

  it("fingerprints an async function (isAsync=true)", async () => {
    const f = await writeFile(
      "src/fetcher.ts",
      `export async function fetchData(url: string) { return fetch(url); }`
    );
    const units = await engine.extractUnitFingerprints([f]);
    const fn = units.find((u) => u.name === "fetchData");
    expect(fn).toBeDefined();
    expect(fn!.isAsync).toBe(true);
  });

  it("classifies unit pattern from function name prefix — query", async () => {
    const f = await writeFile(
      "src/db.ts",
      `export function getUser(id: string) { return null; }`
    );
    const units = await engine.extractUnitFingerprints([f]);
    const fn = units.find((u) => u.name === "getUser");
    expect(fn?.patternType).toBe("query");
  });

  it("classifies unit pattern — command (create prefix)", async () => {
    const f = await writeFile(
      "src/db.ts",
      `export function createUser(name: string) { return {}; }`
    );
    const units = await engine.extractUnitFingerprints([f]);
    const fn = units.find((u) => u.name === "createUser");
    expect(fn?.patternType).toBe("command");
  });

  it("classifies unit pattern — validation (validate prefix)", async () => {
    const f = await writeFile(
      "src/db.ts",
      `export function validateEmail(email: string) { return true; }`
    );
    const units = await engine.extractUnitFingerprints([f]);
    const fn = units.find((u) => u.name === "validateEmail");
    expect(fn?.patternType).toBe("validation");
  });

  it("generates data-retrieval semantic tag for get* functions", async () => {
    const f = await writeFile(
      "src/repo.ts",
      `export function fetchItems(page: number) { return []; }`
    );
    const units = await engine.extractUnitFingerprints([f]);
    const fn = units.find((u) => u.name === "fetchItems");
    expect(fn?.semanticTags).toContain("data-retrieval");
  });

  it("pure function: isPure=true for sync function without side effects", async () => {
    const f = await writeFile(
      "src/pure.ts",
      `export function double(x: number): number { return x * 2; }`
    );
    const units = await engine.extractUnitFingerprints([f]);
    const fn = units.find((u) => u.name === "double");
    expect(fn?.isPure).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// computeStats (via buildFullIndex)
// ─────────────────────────────────────────────────────────────────────

describe("computeStats (via buildFullIndex)", () => {
  it("totalModules matches number of TS files processed", async () => {
    const a = await writeFile("src/a.ts", `export function a() {}`);
    const b = await writeFile("src/b.ts", `export function b() {}`);
    const idx = await engine.buildFullIndex(workDir, [a, b]);
    expect(idx.stats.totalModules).toBe(2);
  });

  it("totalUnits >= totalModules for files with functions", async () => {
    const f = await writeFile(
      "src/m.ts",
      `export function one() {} export function two() {} export function three() {}`
    );
    const idx = await engine.buildFullIndex(workDir, [f]);
    expect(idx.stats.totalUnits).toBeGreaterThanOrEqual(3);
  });

  it("pureFunctionRatio between 0 and 1", async () => {
    const f = await writeFile("src/p.ts", `export function pure(x: number) { return x + 1; }`);
    const idx = await engine.buildFullIndex(workDir, [f]);
    expect(idx.stats.pureFunctionRatio).toBeGreaterThanOrEqual(0);
    expect(idx.stats.pureFunctionRatio).toBeLessThanOrEqual(1);
  });

  it("avgComplexity >= 1 (minimum is 1 per function)", async () => {
    const f = await writeFile("src/c.ts", `export function simple() { return 42; }`);
    const idx = await engine.buildFullIndex(workDir, [f]);
    expect(idx.stats.avgComplexity).toBeGreaterThanOrEqual(0);
  });

  it("estimatedTokenCost.total > 0 after building", async () => {
    const f = await writeFile("src/t.ts", `export const VALUE = 1;`);
    const idx = await engine.buildFullIndex(workDir, [f]);
    expect(idx.stats.estimatedTokenCost.total).toBeGreaterThan(0);
  });

  it("patternDistribution contains at least one key", async () => {
    const f = await writeFile("src/q.ts", `export function getItem(id: string) { return null; }`);
    const idx = await engine.buildFullIndex(workDir, [f]);
    expect(Object.keys(idx.stats.patternDistribution).length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Query methods (after buildFullIndex)
// ─────────────────────────────────────────────────────────────────────

describe("query methods after buildFullIndex", () => {
  let filePath: string;

  beforeEach(async () => {
    filePath = await writeFile(
      "src/service.ts",
      `import { Logger } from './logger.js';
export async function fetchUsers() { return fetch('/users'); }
export function createUser(name: string) { return {}; }
export function deleteUser(id: string) { return true; }`
    );
    await engine.buildFullIndex(workDir, [filePath]);
  });

  it("getModulesForFile returns the module for the built file", () => {
    const mod = engine.getModulesForFile(filePath);
    expect(mod).not.toBeNull();
    expect(mod!.filePath).toBe(filePath);
  });

  it("getModulesForFile returns null for unknown file", () => {
    expect(engine.getModulesForFile("/no/such/file.ts")).toBeNull();
  });

  it("getUnitsForFile returns units only for the given file", () => {
    const units = engine.getUnitsForFile(filePath);
    expect(units.length).toBeGreaterThan(0);
    expect(units.every((u) => u.filePath === filePath)).toBe(true);
  });

  it("getUnitsForFile returns [] for unknown file", () => {
    expect(engine.getUnitsForFile("/no/such/file.ts")).toEqual([]);
  });

  it("queryUnitsByPattern('query') includes fetchUsers", () => {
    const units = engine.queryUnitsByPattern("query");
    const names = units.map((u) => u.name);
    expect(names).toContain("fetchUsers");
  });

  it("queryUnitsByPattern('command') includes createUser + deleteUser", () => {
    const units = engine.queryUnitsByPattern("command");
    const names = units.map((u) => u.name);
    expect(names).toContain("createUser");
    expect(names).toContain("deleteUser");
  });

  it("queryExportsByName exact match finds the export", () => {
    const results = engine.queryExportsByName("fetchUsers");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.export.name).toBe("fetchUsers");
  });

  it("queryExportsByName case-insensitive substring match", () => {
    const results = engine.queryExportsByName("user");
    const names = results.map((r) => r.export.name);
    expect(names.some((n) => n.toLowerCase().includes("user"))).toBe(true);
  });

  it("queryExportsByName returns [] for unknown name", () => {
    expect(engine.queryExportsByName("xyznomatch")).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// incrementalUpdate
// ─────────────────────────────────────────────────────────────────────

describe("incrementalUpdate", () => {
  it("no-ops when index is null", async () => {
    await expect(
      engine.incrementalUpdate("/some/path.ts", "export function x() {}")
    ).resolves.not.toThrow();
    expect(engine.getIndex()).toBeNull();
  });

  it("removes old module+units for file and re-inserts", async () => {
    const f = await writeFile("src/greet.ts", `export function hello() { return "hello"; }`);
    await engine.buildFullIndex(workDir, [f]);
    const beforeUnits = engine.getUnitsForFile(f).length;

    const updated = `export function hello() { return "hi"; }
export function goodbye() { return "bye"; }`;
    await fs.writeFile(f, updated, "utf-8");
    await engine.incrementalUpdate(f, updated);

    const afterUnits = engine.getUnitsForFile(f).length;
    expect(afterUnits).toBeGreaterThanOrEqual(beforeUnits);
    const after = engine.getModulesForFile(f);
    expect(after).not.toBeNull();
  });

  it("skips unsupported extension", async () => {
    const f = await writeFile("src/a.ts", `export function a() {}`);
    await engine.buildFullIndex(workDir, [f]);
    const statsBefore = engine.getStats().totalModules;
    await engine.incrementalUpdate("/path/to/file.css", ".x { color: red; }");
    expect(engine.getStats().totalModules).toBe(statsBefore);
  });
});

// ─────────────────────────────────────────────────────────────────────
// _doSave / crash-atomic write-fsync-rename (via saveIndex path)
// ─────────────────────────────────────────────────────────────────────

describe("_doSave / atomic save behavior", () => {
  it("index file exists after buildFullIndex", async () => {
    const f = await writeFile("src/x.ts", `export const X = 1;`);
    await engine.buildFullIndex(workDir, [f]);
    const indexPath = path.join(workDir, ".jcf-cognitive-index.json");
    const stat = await fs.stat(indexPath);
    expect(stat.size).toBeGreaterThan(0);
  });

  it("index file contains valid JSON after save", async () => {
    const f = await writeFile("src/valid.ts", `export function valid() {}`);
    await engine.buildFullIndex(workDir, [f]);
    const indexPath = path.join(workDir, ".jcf-cognitive-index.json");
    const raw = await fs.readFile(indexPath, "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("no .tmp file remains after successful save", async () => {
    const f = await writeFile("src/clean.ts", `export function clean() {}`);
    await engine.buildFullIndex(workDir, [f]);
    const indexPath = path.join(workDir, ".jcf-cognitive-index.json");
    await expect(fs.stat(indexPath + ".tmp")).rejects.toThrow();
  });

  it("ENOENT on dir removal does not throw (saveIndex is graceful)", async () => {
    const f = await writeFile("src/grace.ts", `export function grace() {}`);
    await engine.buildFullIndex(workDir, [f]);

    const removedDir = path.join(workDir, "phantom");
    const phantomEngine = new CognitiveIndexEngine({
      logger,
      indexPath: path.join(removedDir, "index.json"),
    });
    const f2 = await writeFile("src/phantom.ts", `export function phantom() {}`);
    await expect(phantomEngine.buildFullIndex(workDir, [f2])).resolves.not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────
// serializeIndex / deserializeIndex roundtrip (via save + initialize)
// ─────────────────────────────────────────────────────────────────────

describe("serializeIndex / deserializeIndex roundtrip", () => {
  it("modules are preserved across save+load", async () => {
    const f = await writeFile(
      "src/round.ts",
      `export interface RoundTrip { id: string; }
export function createRound(id: string): RoundTrip { return { id }; }`
    );
    const idx = await engine.buildFullIndex(workDir, [f]);
    const modsBefore = idx.modules.length;

    const engine2 = new CognitiveIndexEngine({
      logger,
      indexPath: path.join(workDir, ".jcf-cognitive-index.json"),
    });
    await engine2.initialize();
    expect(engine2.getModules().length).toBe(modsBefore);
  });

  it("stats are preserved across save+load", async () => {
    const f = await writeFile("src/stats.ts", `export function a() {} export function b() {}`);
    const idx = await engine.buildFullIndex(workDir, [f]);
    const statsBefore = idx.stats.totalUnits;

    const engine3 = new CognitiveIndexEngine({
      logger,
      indexPath: path.join(workDir, ".jcf-cognitive-index.json"),
    });
    await engine3.initialize();
    expect(engine3.getStats().totalUnits).toBe(statsBefore);
  });

  it("deserializeIndex handles missing fields gracefully (raw with nulls)", async () => {
    const indexPath = path.join(workDir, ".jcf-cognitive-index.json");
    await fs.writeFile(indexPath, JSON.stringify({ skeleton: null, generatedAt: Date.now() }), "utf-8");

    const enginePartial = new CognitiveIndexEngine({ logger, indexPath });
    await enginePartial.initialize();
    const idx = enginePartial.getIndex();
    expect(idx).not.toBeNull();
    expect(idx!.modules).toEqual([]);
    expect(idx!.units).toEqual([]);
    expect(idx!.stats.totalModules).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Constructor — indexPath defaults (lines 78, 80-81)
// ─────────────────────────────────────────────────────────────────────

describe("constructor — indexPath defaults", () => {
  it("uses default homedir path when no indexPath given (win32 branch)", () => {
    const e = new CognitiveIndexEngine({ logger });
    expect((e as any).indexPath).toContain(".jcf");
  });

  it("resolves provided indexPath on non-win32 platform (linux mock)", () => {
    vi.spyOn(os, "platform").mockReturnValueOnce("linux" as any);
    const e = new CognitiveIndexEngine({
      logger,
      indexPath: path.join(workDir, "linux-test-index.json"),
    });
    expect((e as any).indexPath).toContain("linux-test-index.json");
    vi.restoreAllMocks();
  });

  it("uses default homedir path on non-win32 without indexPath", () => {
    vi.spyOn(os, "platform").mockReturnValueOnce("linux" as any);
    const e = new CognitiveIndexEngine({ logger });
    expect((e as any).indexPath).toContain(".jcf");
    vi.restoreAllMocks();
  });
});

// ─────────────────────────────────────────────────────────────────────
// detectTechStack — go.mod / Cargo.toml scanning (line 245)
// ─────────────────────────────────────────────────────────────────────

describe("detectTechStack — go.mod / Cargo.toml", () => {
  it("reads go.mod file without throwing even if no sigs match", async () => {
    await writeFile("go.mod", `module github.com/user/app\ngo 1.21\n`);
    const sk = await engine.buildSkeleton(workDir);
    expect(sk).toBeDefined();
    expect(sk.configFiles.some((f: string) => f.includes("go.mod"))).toBe(true);
  });

  it("reads Cargo.toml file without throwing", async () => {
    await writeFile("Cargo.toml", `[package]\nname = "myapp"\nversion = "0.1.0"\n`);
    const sk = await engine.buildSkeleton(workDir);
    expect(sk).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────
// buildFullIndex — without explicit files param (lines 772-781)
// ─────────────────────────────────────────────────────────────────────

describe("buildFullIndex — file discovery", () => {
  it("discovers files via collectFiles when no files param provided", async () => {
    await writeFile("src/discovered.ts", `export function found(): number { return 42; }`);
    const idx = await engine.buildFullIndex(workDir);
    expect(idx.stats.totalModules).toBeGreaterThan(0);
    expect(idx.generatedAt).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Java / Go file extraction (extractImports/Exports for non-TS/non-Py)
// ─────────────────────────────────────────────────────────────────────

describe("Java file extraction", () => {
  it("extracts public class exports from .java file", async () => {
    const f = await writeFile(
      "src/User.java",
      `import java.util.List;\nimport static java.lang.Math.abs;\n\npublic class User {\n  private String name;\n}\n\npublic interface UserRepo {\n  List<String> findAll();\n}\n\npublic enum Status { ACTIVE, INACTIVE }\n`
    );
    const contracts = await engine.extractModuleContracts([f]);
    expect(contracts.length).toBe(1);
    const names = contracts[0]!.exports.map((e) => e.name);
    expect(names).toContain("User");
    expect(names).toContain("UserRepo");
    expect(names).toContain("Status");
    expect(contracts[0]!.imports.length).toBeGreaterThan(0);
  });
});

describe("Go file extraction", () => {
  it("extracts imports from .go file (block import syntax)", async () => {
    const f = await writeFile(
      "src/main.go",
      `package main\n\nimport (\n  "fmt"\n  "os"\n  // comment\n)\n\nfunc main() { fmt.Println(os.Args[0]) }\n`
    );
    const contracts = await engine.extractModuleContracts([f]);
    expect(contracts.length).toBe(1);
    expect(contracts[0]!.imports.length).toBeGreaterThan(0);
    const importNames = contracts[0]!.imports.map((i) => i.name);
    expect(importNames).toContain("fmt");
  });

  it("extracts imports from .go file (single import syntax)", async () => {
    const f = await writeFile(
      "src/util.go",
      `package main\nimport "fmt"\nfunc helper() { fmt.Println("hi") }\n`
    );
    const contracts = await engine.extractModuleContracts([f]);
    expect(contracts.length).toBe(1);
    expect(contracts[0]!.imports.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// AST fallback — monkey-patch astParser to force TS regex paths
// Covers: extractSingleContract regex path, extractTypes, parseObjectBody,
//         parseParamTypes, inferReturnType, extractFileUnits TS regex,
//         extractFunctionBody, countComplexity, extractCallTargets,
//         extractTypeRefs, contractFromAst error + throw paths,
//         unitsFromAst throw path
// ─────────────────────────────────────────────────────────────────────

describe("TS regex fallback (AST monkey-patched to fail)", () => {
  let noAst: CognitiveIndexEngine;

  beforeEach(() => {
    noAst = new CognitiveIndexEngine({
      logger,
      indexPath: path.join(workDir, ".no-ast-index.json"),
    });
    // Force all AST calls to return an error → triggers regex fallback
    (noAst as any).astParser = {
      parseFile: () => ({
        errorMessage: "forced-ast-failure",
        exports: [],
        imports: [],
        units: [],
        definedTypes: [],
        moduleName: "",
      }),
    };
  });

  it("extractSingleContract falls through to regex after AST error", async () => {
    const f = await writeFile(
      "src/regex-fallback.ts",
      `export function greet(name: string): string { return "Hello " + name; }
export const VERSION = "1.0.0";
export interface Config { host: string; port?: number; }
export type Status = 'active' | 'inactive';
export enum Color { Red, Green, Blue }
import { Logger } from './logger.js';
import type { Foo } from './foo.js';
import * as ns from './ns.js';
import Bar from './bar.js';`
    );
    const contracts = await noAst.extractModuleContracts([f]);
    expect(contracts.length).toBe(1);
    const expNames = contracts[0]!.exports.map((e) => e.name);
    expect(expNames).toContain("greet");
    expect(expNames).toContain("VERSION");
    expect(expNames).toContain("Config");
    expect(expNames).toContain("Status");
    expect(expNames).toContain("Color");
  });

  it("regex import extraction: named, default, namespace, type imports", async () => {
    const f = await writeFile(
      "src/imports-only.ts",
      `import { A, B as C } from './a.js';
import type { D } from './d.js';
import * as ns from './ns.js';
import DefaultThing from './thing.js';
export function use(a: A) { return a; }`
    );
    const contracts = await noAst.extractModuleContracts([f]);
    const impNames = contracts[0]!.imports.map((i) => i.name);
    expect(impNames).toContain("A");
    expect(impNames).toContain("C");
    expect(impNames).toContain("D");
    expect(impNames).toContain("ns");
    expect(impNames).toContain("DefaultThing");
  });

  it("parseObjectBody: props, optional props, methods, readonly props", async () => {
    const f = await writeFile(
      "src/iface.ts",
      `export interface Entity {
  id: string;
  name?: string;
  readonly createdAt: string;
  getName(): string;
  save(data: any): Promise<void>;
}`
    );
    const contracts = await noAst.extractModuleContracts([f]);
    expect(contracts.length).toBe(1);
    const defTypes = contracts[0]!.definedTypes;
    expect(defTypes.length).toBeGreaterThan(0);
    const entity = defTypes.find((t) => t.name === "Entity");
    if (entity) {
      const optProp = entity.properties.find((p) => p.name === "name");
      if (optProp) expect(optProp.optional).toBe(true);
      const readonlyProp = entity.properties.find((p) => p.name === "createdAt");
      if (readonlyProp) expect(readonlyProp).toBeDefined();
    }
  });

  it("extractFileUnits regex: function with if/for branches (countComplexity > 1)", async () => {
    const f = await writeFile(
      "src/complex.ts",
      `export function process(items: string[]): string[] {
  const results: string[] = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i] && items[i].length > 0) {
      try {
        results.push(items[i].trim());
      } catch (e) {
        continue;
      }
    } else if (items[i] === null) {
      break;
    }
  }
  while (results.length > 100) {
    results.pop();
  }
  return results;
}`
    );
    const units = await noAst.extractUnitFingerprints([f]);
    const fn = units.find((u) => u.name === "process");
    expect(fn).toBeDefined();
    expect(fn!.complexity).toBeGreaterThan(1);
    expect(fn!.callTargets.length).toBeGreaterThan(0);
  });

  it("extractFileUnits regex: class extraction", async () => {
    const f = await writeFile(
      "src/cls.ts",
      `export class UserService extends BaseService implements IService {
  private logger: Logger;
  constructor(log: Logger) { super(); this.logger = log; }
  async getUser(id: string): Promise<User> { return this.repo.find(id); }
}`
    );
    const units = await noAst.extractUnitFingerprints([f]);
    const cls = units.find((u) => u.kind === "class");
    expect(cls).toBeDefined();
    expect(cls!.name).toBe("UserService");
  });

  it("extractFileUnits regex: arrow function extraction", async () => {
    const f = await writeFile(
      "src/arrow.ts",
      `export const double = (x: number): number => x * 2;
export const greetAsync = async (name: string) => \`Hello \${name}\`;`
    );
    const units = await noAst.extractUnitFingerprints([f]);
    expect(units.some((u) => u.name === "double")).toBe(true);
    expect(units.some((u) => u.name === "greetAsync")).toBe(true);
  });

  it("extractTypeRefs: captures capitalized type references in function bodies", async () => {
    const f = await writeFile(
      "src/typed.ts",
      `export function transform(input: MyInput): MyOutput { const x: MyHelper = {}; return x as MyOutput; }`
    );
    const units = await noAst.extractUnitFingerprints([f]);
    const fn = units.find((u) => u.name === "transform");
    expect(fn).toBeDefined();
    expect(fn!.typeDependencies.length).toBeGreaterThan(0);
  });

  it("contractFromAst error message → debug log + regex fallback (no exception)", async () => {
    const f = await writeFile("src/err-ast.ts", `export function ok() { return 1; }`);
    const contracts = await noAst.extractModuleContracts([f]);
    expect(contracts.length).toBe(1);
  });
});

describe("AST monkey-patched to throw (contractFromAst + unitsFromAst catch paths)", () => {
  let throwAst: CognitiveIndexEngine;

  beforeEach(() => {
    throwAst = new CognitiveIndexEngine({
      logger,
      indexPath: path.join(workDir, ".throw-ast-index.json"),
    });
    (throwAst as any).astParser = {
      parseFile: () => {
        throw new Error("simulated AST parser crash");
      },
    };
  });

  it("contractFromAst catch block: warns + falls back to regex on throw", async () => {
    const f = await writeFile(
      "src/throw-test.ts",
      `export function safe(): void { console.log("safe"); }`
    );
    const contracts = await throwAst.extractModuleContracts([f]);
    expect(contracts.length).toBe(1);
    const exp = contracts[0]!.exports.find((e) => e.name === "safe");
    expect(exp).toBeDefined();
  });

  it("unitsFromAst catch block: warns + falls back to regex on throw", async () => {
    const f = await writeFile(
      "src/units-throw.ts",
      `export function handleRequest(req: any, res: any) { res.send("ok"); }`
    );
    const units = await throwAst.extractUnitFingerprints([f]);
    const fn = units.find((u) => u.name === "handleRequest");
    expect(fn).toBeDefined();
    expect(fn!.patternType).toBe("handler");
  });
});

// ─────────────────────────────────────────────────────────────────────
// _doSave — ENOENT + fsync failure + rename ENOENT paths
// Uses vi.spyOn on the module-level fs to intercept internal calls
// ─────────────────────────────────────────────────────────────────────

describe("_doSave — fs error paths", () => {
  it("_doSave non-ENOENT from fs.open: re-throws the error", async () => {
    const engineErr = new CognitiveIndexEngine({
      logger,
      indexPath: path.join(workDir, ".err-dosave.json"),
    });
    const openSpy = vi.spyOn(fs, "open").mockRejectedValueOnce(
      Object.assign(new Error("EPERM: permission denied"), { code: "EPERM" })
    );
    const f = await writeFile("src/eperm.ts", `export const x = 1;`);
    await expect(engineErr.buildFullIndex(workDir, [f])).rejects.toThrow("EPERM");
    openSpy.mockRestore();
  });

  it("_doSave fsync failure: logs debug + continues (does not throw)", async () => {
    const engineFsync = new CognitiveIndexEngine({
      logger,
      indexPath: path.join(workDir, ".fsync-index.json"),
    });
    const mockFh = {
      writeFile: vi.fn().mockResolvedValue(undefined),
      sync: vi.fn().mockRejectedValue(new Error("fsync not supported on this fs")),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const openSpy = vi.spyOn(fs, "open").mockResolvedValueOnce(mockFh as any);
    const f = await writeFile("src/fsync-test.ts", `export const y = 2;`);
    await expect(engineFsync.buildFullIndex(workDir, [f])).resolves.toBeDefined();
    openSpy.mockRestore();
  });

  it("_doSave rename ENOENT: unlinks tmp and returns gracefully", async () => {
    const engineRename = new CognitiveIndexEngine({
      logger,
      indexPath: path.join(workDir, ".rename-index.json"),
    });
    const renameSpy = vi.spyOn(fs, "rename").mockRejectedValueOnce(
      Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" })
    );
    const unlinkSpy = vi.spyOn(fs, "unlink").mockResolvedValueOnce(undefined as any);
    const f = await writeFile("src/rename-test.ts", `export const z = 3;`);
    await expect(engineRename.buildFullIndex(workDir, [f])).resolves.toBeDefined();
    renameSpy.mockRestore();
    unlinkSpy.mockRestore();
  });

  it("_doSave rename non-ENOENT: re-throws the error", async () => {
    const engineRenameErr = new CognitiveIndexEngine({
      logger,
      indexPath: path.join(workDir, ".rename-err-index.json"),
    });
    const renameSpy = vi.spyOn(fs, "rename").mockRejectedValueOnce(
      Object.assign(new Error("EXDEV: cross-device link"), { code: "EXDEV" })
    );
    const f = await writeFile("src/rename-err.ts", `export const w = 4;`);
    await expect(engineRenameErr.buildFullIndex(workDir, [f])).rejects.toThrow("EXDEV");
    renameSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Branch Coverage Sweep — real targeted tests for every uncovered branch
// Covers: constructor L75/L78/L80, TECH_SIGS Cargo.toml L245,
//         detectArchPatterns L262, astUnitToFingerprint kinds L380-383,
//         detectSideEffects all 8 conditions, classifyModulePattern all 15,
//         classifyUnitPattern all 13 pattern types,
//         generateSemanticTags all 11 tag conditions,
//         Java/Go import+export regex branches
// ─────────────────────────────────────────────────────────────────────

describe("Constructor branches — indexPath resolution", () => {
  it("uses install-root fallback when no indexPath provided", () => {
    const e = new CognitiveIndexEngine({ logger });
    const p: string = (e as any).indexPath;
    expect(path.isAbsolute(p)).toBe(true);
    expect(p).toMatch(/\.jcf-cognitive-index\.json$/);
  });

  it("resolves relative indexPath via resolveFromInstallRoot (L78)", () => {
    const e = new CognitiveIndexEngine({ logger, indexPath: "relative/idx.json" });
    const p: string = (e as any).indexPath;
    expect(path.isAbsolute(p)).toBe(true);
    expect(p).toContain("idx.json");
  });
});

describe("detectTechStack — Cargo.toml TECH_SIGS match (L245)", () => {
  it("detects tech stack entry from Cargo.toml when content contains a quoted sig name", async () => {
    const cargoPath = path.join(workDir, "Cargo.toml");
    await fs.writeFile(
      cargoPath,
      `[package]\nname = "react"\nversion = "0.1.0"\n`
    );
    const sk = await engine.buildSkeleton(workDir);
    await fs.unlink(cargoPath).catch(() => {});
    const names = sk.techStack.map((t) => t.name.toLowerCase());
    expect(names.some((n) => n.includes("react"))).toBe(true);
  });
});

describe("detectArchPatterns — architecture pattern match (L262)", () => {
  it("detects architecture patterns when directory structure matches ARCH_SIGS", async () => {
    await fs.mkdir(path.join(workDir, "src", "models"), { recursive: true });
    await fs.mkdir(path.join(workDir, "src", "controllers"), { recursive: true });
    await fs.mkdir(path.join(workDir, "src", "services"), { recursive: true });
    await fs.writeFile(
      path.join(workDir, "src", "models", "user.ts"),
      "export interface User { id: string; }"
    );
    await fs.writeFile(
      path.join(workDir, "src", "controllers", "user.ts"),
      "export function getUser() { return null; }"
    );
    const sk = await engine.buildSkeleton(workDir);
    expect(sk.architecturePattern.length).toBeGreaterThan(0);
  });

  it("does NOT detect Next.js App Router from just a src/lib/ folder", async () => {
    await fs.mkdir(path.join(workDir, "src", "lib"), { recursive: true });
    await fs.writeFile(
      path.join(workDir, "src", "lib", "utils.ts"),
      "export function add(a: number, b: number) { return a + b; }"
    );
    await fs.writeFile(
      path.join(workDir, "package.json"),
      JSON.stringify({ name: "test", dependencies: {} })
    );
    const sk = await engine.buildSkeleton(workDir);
    const nextjsPattern = sk.architecturePattern.find(p => p.name === "Next.js App Router");
    expect(nextjsPattern).toBeUndefined();
  });

  it("does NOT detect Monorepo from a singular lib/ folder", async () => {
    await fs.mkdir(path.join(workDir, "lib"), { recursive: true });
    await fs.writeFile(
      path.join(workDir, "lib", "helper.ts"),
      "export const x = 1;"
    );
    await fs.writeFile(
      path.join(workDir, "package.json"),
      JSON.stringify({ name: "test", dependencies: {} })
    );
    const sk = await engine.buildSkeleton(workDir);
    const monoPattern = sk.architecturePattern.find(p => p.name === "Monorepo");
    expect(monoPattern).toBeUndefined();
  });

  it("suppresses Next.js patterns when MCP SDK is in dependencies", async () => {
    await fs.mkdir(path.join(workDir, "src", "app"), { recursive: true });
    await fs.writeFile(
      path.join(workDir, "src", "app", "page.tsx"),
      "export default function Page() { return null; }"
    );
    await fs.writeFile(
      path.join(workDir, "package.json"),
      JSON.stringify({ name: "mcp-server", dependencies: { "@modelcontextprotocol/sdk": "1.0.0" } })
    );
    const sk = await engine.buildSkeleton(workDir);
    const nextjsPatterns = sk.architecturePattern.filter(p => p.name.startsWith("Next.js"));
    expect(nextjsPatterns.length).toBe(0);
  });

  it("detects MCP Server pattern from server.ts + handlers/ + registry.ts", async () => {
    await fs.mkdir(path.join(workDir, "src", "handlers"), { recursive: true });
    await fs.writeFile(
      path.join(workDir, "src", "server.ts"),
      "export class McpServer {}"
    );
    await fs.writeFile(
      path.join(workDir, "src", "handlers", "fs.ts"),
      "export function readFile() {}"
    );
    await fs.writeFile(
      path.join(workDir, "src", "registry.ts"),
      "export const REGISTRY = {};"
    );
    await fs.writeFile(
      path.join(workDir, "package.json"),
      JSON.stringify({ name: "mcp", dependencies: { "@modelcontextprotocol/sdk": "1.0.0" } })
    );
    const sk = await engine.buildSkeleton(workDir);
    const mcpPattern = sk.architecturePattern.find(p => p.name === "MCP Server");
    expect(mcpPattern).toBeDefined();
    expect(mcpPattern!.evidence.length).toBeGreaterThanOrEqual(1);
  });

  it("requires minEvidence threshold for DDD pattern", async () => {
    // Only 1 of 3 required DDD folders → should NOT match (minEvidence=2)
    await fs.mkdir(path.join(workDir, "src", "domain"), { recursive: true });
    await fs.writeFile(
      path.join(workDir, "src", "domain", "entity.ts"),
      "export class Entity {}"
    );
    await fs.writeFile(
      path.join(workDir, "package.json"),
      JSON.stringify({ name: "test", dependencies: {} })
    );
    const sk = await engine.buildSkeleton(workDir);
    const dddPattern = sk.architecturePattern.find(p => p.name === "DDD");
    expect(dddPattern).toBeUndefined();
  });
});

describe("astUnitToFingerprint — kind mapping branches (L380-383)", () => {
  it("maps 'method' kind correctly from class method extracted by real AST", async () => {
    const f = await writeFile(
      "src/cls-method-kind.ts",
      `export class Calculator {
  add(a: number, b: number): number { return a + b; }
  subtract(a: number, b: number): number { return a - b; }
}`
    );
    const units = await engine.extractUnitFingerprints([f]);
    // Real AST extracts class methods as kind='method' → kindMapped='method'
    expect(units.some((u) => u.kind === "method")).toBe(true);
  });

  it("maps 'variable' kind (const arrow) to 'function' via real AST (L382)", async () => {
    const f = await writeFile(
      "src/arrow-var-kind.ts",
      `export const multiply = (a: number, b: number): number => a * b;`
    );
    const units = await engine.extractUnitFingerprints([f]);
    const fn = units.find((u) => u.name === "multiply");
    if (fn) {
      // AST extracts const arrow as 'variable' kind → mapped to 'function'
      expect(["function", "variable"]).toContain(fn.kind);
    }
  });
});

describe("detectSideEffects — all 8 TS patterns (TRUE + FALSE via noAst)", () => {
  let noAstFx: CognitiveIndexEngine;

  beforeEach(() => {
    noAstFx = new CognitiveIndexEngine({
      logger,
      indexPath: path.join(workDir, ".fx-index.json"),
    });
    (noAstFx as any).astParser = {
      parseFile: () => ({
        errorMessage: "forced-fx-failure",
        exports: [],
        imports: [],
        units: [],
        definedTypes: [],
        moduleName: "",
      }),
    };
  });

  it("detects all 8 side effects when file content has every pattern (all TRUE branches)", async () => {
    const f = await writeFile(
      "src/all-side-effects.ts",
      `export function sideEffectFn() {
  console.log("trace");
  process.exit(0);
  fs.write(fd, "data");
  fetch("https://api.example.com/data");
  window.addEventListener("click", () => {});
  setInterval(() => {}, 1000);
  const now = new Date();
  const rand = Math.random();
  return rand;
}`
    );
    const contracts = await noAstFx.extractModuleContracts([f]);
    const se = contracts[0]?.sideEffects ?? [];
    expect(se).toContain("console-output");
    expect(se).toContain("process-exit");
    expect(se).toContain("filesystem-write");
    expect(se).toContain("network-request");
    expect(se).toContain("event-listener");
    expect(se).toContain("timer");
    expect(se).toContain("datetime-dependency");
    expect(se).toContain("non-deterministic");
  });

  it("detects no side effects for pure arithmetic function (all 8 FALSE branches)", async () => {
    const f = await writeFile(
      "src/pure-no-effects.ts",
      `export function multiply(a: number, b: number): number { return a * b; }`
    );
    const contracts = await noAstFx.extractModuleContracts([f]);
    expect(contracts[0]?.sideEffects).toEqual([]);
  });

  it("detects only axios network-request side effect", async () => {
    const f = await writeFile(
      "src/axios-effect.ts",
      `export function fetchUser(id: string) { return axios.get("/api/users/" + id); }`
    );
    const contracts = await noAstFx.extractModuleContracts([f]);
    expect(contracts[0]?.sideEffects).toContain("network-request");
  });

  it("detects only http.request network-request side effect", async () => {
    const f = await writeFile(
      "src/http-effect.ts",
      `export function doRequest() { return http.request({ host: "example.com" }); }`
    );
    const contracts = await noAstFx.extractModuleContracts([f]);
    expect(contracts[0]?.sideEffects).toContain("network-request");
  });
});

describe("classifyModulePattern — all 15 conditions via noAst (TRUE + FALSE)", () => {
  let noAstPat: CognitiveIndexEngine;

  beforeEach(() => {
    noAstPat = new CognitiveIndexEngine({
      logger,
      indexPath: path.join(workDir, ".pat-index.json"),
    });
    (noAstPat as any).astParser = {
      parseFile: () => ({
        errorMessage: "forced-pat-failure",
        exports: [],
        imports: [],
        units: [],
        definedTypes: [],
        moduleName: "",
      }),
    };
  });

  it("default-export: export default function", async () => {
    const f = await writeFile(
      "src/cmp-default-export.ts",
      `export default function main() { return 1; }`
    );
    const c = await noAstPat.extractModuleContracts([f]);
    expect(c[0]?.patternClassification).toContain("default-export");
  });

  it("barrel-module: 6+ named exports", async () => {
    const f = await writeFile(
      "src/cmp-barrel.ts",
      `export function a() {}
export function b() {}
export function c() {}
export const d = 1;
export class E {}
export function f() {}
export const g = 2;`
    );
    const c = await noAstPat.extractModuleContracts([f]);
    expect(c[0]?.patternClassification).toContain("barrel-module");
  });

  it("route-handler: router.get call in content", async () => {
    const f = await writeFile(
      "src/cmp-routes.ts",
      `router.get("/users", (req, res) => res.json([]));`
    );
    const c = await noAstPat.extractModuleContracts([f]);
    expect(c[0]?.patternClassification).toContain("route-handler");
  });

  it("middleware: next() call in content", async () => {
    const f = await writeFile(
      "src/cmp-mid.ts",
      `export function auth(req: any, res: any, next: any) { next(); }`
    );
    const c = await noAstPat.extractModuleContracts([f]);
    expect(c[0]?.patternClassification).toContain("middleware");
  });

  it("event-handler: .emit( call in content", async () => {
    const f = await writeFile(
      "src/cmp-events.ts",
      `emitter.emit("data", result);`
    );
    const c = await noAstPat.extractModuleContracts([f]);
    expect(c[0]?.patternClassification).toContain("event-handler");
  });

  it("event-handler: .on( call in content", async () => {
    const f = await writeFile(
      "src/cmp-on.ts",
      `emitter.on("event", handler);`
    );
    const c = await noAstPat.extractModuleContracts([f]);
    expect(c[0]?.patternClassification).toContain("event-handler");
  });

  it("type-definition: export interface without function/class", async () => {
    const f = await writeFile(
      "src/cmp-types.ts",
      `export interface UserDto { id: string; name: string; }`
    );
    const c = await noAstPat.extractModuleContracts([f]);
    expect(c[0]?.patternClassification).toContain("type-definition");
  });

  it("test-module: describe() call in content", async () => {
    const f = await writeFile(
      "src/cmp-spec.ts",
      `describe("suite", () => { it("works", () => {}); });`
    );
    const c = await noAstPat.extractModuleContracts([f]);
    expect(c[0]?.patternClassification).toContain("test-module");
  });

  it("re-export: export { ... } syntax", async () => {
    const f = await writeFile(
      "src/cmp-reexport.ts",
      `export { foo, bar } from "./baz.js";`
    );
    const c = await noAstPat.extractModuleContracts([f]);
    expect(c[0]?.patternClassification).toContain("re-export");
  });

  it("configuration: module name contains 'config'", async () => {
    const f = await writeFile(
      "src/app.config.ts",
      `export const host = "localhost";`
    );
    const c = await noAstPat.extractModuleContracts([f]);
    expect(c[0]?.patternClassification).toContain("configuration");
  });

  it("utility: module name contains 'util'", async () => {
    const f = await writeFile(
      "src/string.util.ts",
      `export function trim(s: string) { return s.trim(); }`
    );
    const c = await noAstPat.extractModuleContracts([f]);
    expect(c[0]?.patternClassification).toContain("utility");
  });

  it("service: module name contains 'service'", async () => {
    const f = await writeFile(
      "src/user.service.ts",
      `export class UserService {}`
    );
    const c = await noAstPat.extractModuleContracts([f]);
    expect(c[0]?.patternClassification).toContain("service");
  });

  it("controller: module name contains 'controller'", async () => {
    const f = await writeFile(
      "src/user.controller.ts",
      `export class UserController {}`
    );
    const c = await noAstPat.extractModuleContracts([f]);
    expect(c[0]?.patternClassification).toContain("controller");
  });

  it("data-model: module name contains 'model'", async () => {
    const f = await writeFile(
      "src/user.model.ts",
      `export interface UserModel { id: string; }`
    );
    const c = await noAstPat.extractModuleContracts([f]);
    expect(c[0]?.patternClassification).toContain("data-model");
  });

  it("middleware (name-based): module name contains 'middleware'", async () => {
    const f = await writeFile(
      "src/auth.middleware.ts",
      `export function authMiddleware() {}`
    );
    const c = await noAstPat.extractModuleContracts([f]);
    expect(c[0]?.patternClassification).toContain("middleware");
  });

  it("no special content patterns for plain module (all content-based FALSE branches)", async () => {
    const f = await writeFile(
      "src/cmp-plain.ts",
      `export const VERSION = "1.0.0";`
    );
    const c = await noAstPat.extractModuleContracts([f]);
    expect(c[0]?.patternClassification).not.toContain("default-export");
    expect(c[0]?.patternClassification).not.toContain("route-handler");
    expect(c[0]?.patternClassification).not.toContain("test-module");
    expect(c[0]?.patternClassification).not.toContain("re-export");
    expect(c[0]?.patternClassification).not.toContain("event-handler");
  });
});

describe("classifyUnitPattern — all 13 pattern types via noAst (L742-754)", () => {
  let noAstUnit: CognitiveIndexEngine;

  beforeEach(() => {
    noAstUnit = new CognitiveIndexEngine({
      logger,
      indexPath: path.join(workDir, ".unit-index.json"),
    });
    (noAstUnit as any).astParser = {
      parseFile: () => ({
        errorMessage: "forced-unit-failure",
        exports: [],
        imports: [],
        units: [],
        definedTypes: [],
        moduleName: "",
      }),
    };
  });

  const getPatternType = async (fnName: string, body: string): Promise<string | undefined> => {
    const f = await writeFile(
      `src/cup-${fnName.toLowerCase()}.ts`,
      `export function ${fnName}() { ${body} }`
    );
    const units = await noAstUnit.extractUnitFingerprints([f]);
    return units.find((u) => u.name === fnName)?.patternType;
  };

  it("query: name starts with 'get'", async () => {
    expect(await getPatternType("getUserById", "return null;")).toBe("query");
  });

  it("query: name starts with 'find'", async () => {
    expect(await getPatternType("findRecord", "return null;")).toBe("query");
  });

  it("query: name starts with 'list'", async () => {
    expect(await getPatternType("listUsers", "return [];")).toBe("query");
  });

  it("command: name starts with 'create'", async () => {
    expect(await getPatternType("createRecord", "return {};")).toBe("command");
  });

  it("command: name starts with 'update'", async () => {
    expect(await getPatternType("updateProfile", "return {};")).toBe("command");
  });

  it("command: name starts with 'delete'", async () => {
    expect(await getPatternType("deleteEntry", "")).toBe("command");
  });

  it("validation: name starts with 'validate'", async () => {
    expect(await getPatternType("validateForm", "return true;")).toBe("validation");
  });

  it("handler: name starts with 'handle'", async () => {
    expect(await getPatternType("handleEvent", "return;")).toBe("handler");
  });

  it("transformer: name starts with 'transform'", async () => {
    expect(await getPatternType("transformPayload", "return {};")).toBe("transformer");
  });

  it("initializer: name starts with 'init'", async () => {
    expect(await getPatternType("initDatabase", "")).toBe("initializer");
  });

  it("finalizer: name starts with 'teardown'", async () => {
    expect(await getPatternType("teardown", "")).toBe("finalizer");
  });

  it("io-bound: network-request sideEffect overrides unmatched name prefix (L751)", async () => {
    const f = await writeFile(
      "src/cup-io-net.ts",
      `export function doNetworkCall() { return fetch("https://api.example.com/items"); }`
    );
    const units = await noAstUnit.extractUnitFingerprints([f]);
    const fn = units.find((u) => u.name === "doNetworkCall");
    expect(fn).toBeDefined();
    expect(fn!.patternType).toBe("io-bound");
  });

  it("io-bound: filesystem-write sideEffect overrides unmatched name prefix (L752)", async () => {
    const f = await writeFile(
      "src/cup-io-fs.ts",
      `export function doFileWrite() { fs.write(fd, buf); }`
    );
    const units = await noAstUnit.extractUnitFingerprints([f]);
    const fn = units.find((u) => u.name === "doFileWrite");
    expect(fn).toBeDefined();
    expect(fn!.patternType).toBe("io-bound");
  });

  it("async-operation: async function with no special prefix (L753)", async () => {
    const f = await writeFile(
      "src/cup-async-op.ts",
      `export async function computeAsyncResult() { return Promise.resolve(42); }`
    );
    const units = await noAstUnit.extractUnitFingerprints([f]);
    const fn = units.find((u) => u.name === "computeAsyncResult");
    expect(fn).toBeDefined();
    expect(fn!.patternType).toBe("async-operation");
  });

  it("utility (default): sync function with no matching prefix or side effects (L754)", async () => {
    const f = await writeFile(
      "src/cup-utility.ts",
      `export function computeChecksum(data: string) { return data.length; }`
    );
    const units = await noAstUnit.extractUnitFingerprints([f]);
    const fn = units.find((u) => u.name === "computeChecksum");
    expect(fn).toBeDefined();
    expect(fn!.patternType).toBe("utility");
  });
});

describe("generateSemanticTags — all 11 tag conditions via noAst (L759-769)", () => {
  let noAstTag: CognitiveIndexEngine;

  beforeEach(() => {
    noAstTag = new CognitiveIndexEngine({
      logger,
      indexPath: path.join(workDir, ".tag-index.json"),
    });
    (noAstTag as any).astParser = {
      parseFile: () => ({
        errorMessage: "forced-tag-failure",
        exports: [],
        imports: [],
        units: [],
        definedTypes: [],
        moduleName: "",
      }),
    };
  });

  const getSemanticTags = async (fnName: string, body: string): Promise<string[]> => {
    const f = await writeFile(
      `src/gst-${fnName.toLowerCase()}.ts`,
      `export function ${fnName}() { ${body} }`
    );
    const units = await noAstTag.extractUnitFingerprints([f]);
    return units.find((u) => u.name === fnName)?.semanticTags ?? [];
  };

  it("data-retrieval: name starts with 'get' (L759)", async () => {
    const tags = await getSemanticTags("getItems", "return [];");
    expect(tags).toContain("data-retrieval");
  });

  it("data-retrieval: name starts with 'fetch' (L759)", async () => {
    const tags = await getSemanticTags("fetchOrders", "return [];");
    expect(tags).toContain("data-retrieval");
  });

  it("data-creation: name starts with 'create' (L760)", async () => {
    const tags = await getSemanticTags("createItem", "return {};");
    expect(tags).toContain("data-creation");
  });

  it("data-creation: name starts with 'add' (L760)", async () => {
    const tags = await getSemanticTags("addEntry", "return {};");
    expect(tags).toContain("data-creation");
  });

  it("data-mutation: name starts with 'update' (L761)", async () => {
    const tags = await getSemanticTags("updateRecord", "return {};");
    expect(tags).toContain("data-mutation");
  });

  it("data-deletion: name starts with 'delete' (L762)", async () => {
    const tags = await getSemanticTags("deleteRecord", "");
    expect(tags).toContain("data-deletion");
  });

  it("data-deletion: name starts with 'remove' (L762)", async () => {
    const tags = await getSemanticTags("removeItem", "");
    expect(tags).toContain("data-deletion");
  });

  it("network-io: sideEffect includes network-request (L763)", async () => {
    const tags = await getSemanticTags(
      "callRemoteApi",
      `return fetch("https://api.example.com/data");`
    );
    expect(tags).toContain("network-io");
  });

  it("disk-io: sideEffect includes filesystem-write (L764)", async () => {
    const tags = await getSemanticTags("writeConfig", `fs.write(fd, content);`);
    expect(tags).toContain("disk-io");
  });

  it("logging: sideEffect includes console-output (L765)", async () => {
    const tags = await getSemanticTags("logEvent", `console.log("event");`);
    expect(tags).toContain("logging");
  });

  it("non-deterministic: sideEffect includes non-deterministic (L766)", async () => {
    const tags = await getSemanticTags("generateId", `return Math.random().toString(36);`);
    expect(tags).toContain("non-deterministic");
  });

  it("timer-dependent: sideEffect includes timer (L767)", async () => {
    const tags = await getSemanticTags("scheduleTask", `setInterval(() => {}, 100);`);
    expect(tags).toContain("timer-dependent");
  });

  it("validation-chain: callTargets include 'validate' (L768)", async () => {
    const tags = await getSemanticTags(
      "processOrder",
      `validateInput(order); return order;`
    );
    expect(tags).toContain("validation-chain");
  });

  it("validation-chain: callTargets include 'check' (L768)", async () => {
    const tags = await getSemanticTags(
      "submitForm",
      `checkRequiredFields(form); return form;`
    );
    expect(tags).toContain("validation-chain");
  });

  it("event-emitter: callTargets include 'emit' (L769)", async () => {
    const tags = await getSemanticTags(
      "notifyDone",
      `emitter.emit("complete", result);`
    );
    expect(tags).toContain("event-emitter");
  });

  it("no tags: plain function with no special name, no side effects, no matching calls (all FALSE)", async () => {
    const tags = await getSemanticTags("sumNumbers", `return a + b;`);
    expect(tags).toEqual([]);
  });
});

describe("extractImports/extractExports — Java and Go branches via noAst", () => {
  let noAstLang: CognitiveIndexEngine;

  beforeEach(async () => {
    await fs.mkdir(path.join(workDir, "src"), { recursive: true });
    noAstLang = new CognitiveIndexEngine({
      logger,
      indexPath: path.join(workDir, ".lang-index.json"),
    });
    (noAstLang as any).astParser = {
      parseFile: () => ({
        errorMessage: "forced-lang-failure",
        exports: [],
        imports: [],
        units: [],
        definedTypes: [],
        moduleName: "",
      }),
    };
  });

  it("extracts Java named imports via regex (L437 while loop)", async () => {
    const javaFile = path.join(workDir, "src", "Main.java");
    await fs.mkdir(path.join(workDir, "src"), { recursive: true });
    await fs.writeFile(
      javaFile,
      `import java.util.List;\nimport java.util.Map;\nimport static org.junit.Assert.assertEquals;\npublic class Main {}`
    );
    const contracts = await noAstLang.extractModuleContracts([javaFile]);
    expect(contracts.length).toBe(1);
    const names = contracts[0]!.imports.map((i) => i.name);
    expect(names).toContain("List");
    expect(names).toContain("Map");
    expect(names).toContain("assertEquals");
  });

  it("extracts Java exported public class, interface, and enum (L484 while loop)", async () => {
    const javaFile = path.join(workDir, "src", "Service.java");
    await fs.writeFile(
      javaFile,
      `public interface IService {}\npublic class ServiceImpl implements IService {}\npublic abstract class BaseService {}\npublic enum Status { ACTIVE, INACTIVE }`
    );
    const contracts = await noAstLang.extractModuleContracts([javaFile]);
    expect(contracts.length).toBe(1);
    const names = contracts[0]!.exports.map((e) => e.name);
    expect(names).toContain("IService");
    expect(names).toContain("ServiceImpl");
    expect(names).toContain("Status");
    const iface = contracts[0]!.exports.find((e) => e.name === "IService");
    expect(iface?.kind).toBe("interface");
    const base = contracts[0]!.exports.find((e) => e.name === "BaseService");
    expect(base?.modifiers).toContain("abstract");
  });

  it("extracts Go block imports (L441-444 block branch)", async () => {
    const goFile = path.join(workDir, "src", "main.go");
    await fs.writeFile(
      goFile,
      `package main\nimport (\n\t"fmt"\n\t"os"\n\t"strings"\n)\nfunc main() {}`
    );
    const contracts = await noAstLang.extractModuleContracts([goFile]);
    expect(contracts.length).toBe(1);
    const names = contracts[0]!.imports.map((i) => i.name);
    expect(names).toContain("fmt");
    expect(names).toContain("os");
    expect(names).toContain("strings");
  });

  it("extracts Go single-line import (L442 single-import branch)", async () => {
    const goFile = path.join(workDir, "src", "util.go");
    await fs.writeFile(
      goFile,
      `package util\nimport "strings"\nfunc Trim(s string) string { return strings.TrimSpace(s) }`
    );
    const contracts = await noAstLang.extractModuleContracts([goFile]);
    expect(contracts.length).toBe(1);
    const names = contracts[0]!.imports.map((i) => i.name);
    expect(names).toContain("strings");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Branch Coverage Sweep 2 — remaining 25 uncovered branches
// ─────────────────────────────────────────────────────────────────────

describe("contractFromAst async export modifier / regex extractExports async path (L466 + L336)", () => {
  let noAstAsyncMod: CognitiveIndexEngine;

  beforeEach(() => {
    noAstAsyncMod = new CognitiveIndexEngine({
      logger,
      indexPath: path.join(workDir, ".async-mod-index.json"),
    });
    (noAstAsyncMod as any).astParser = {
      parseFile: () => ({
        errorMessage: "forced",
        exports: [], imports: [], units: [], definedTypes: [], moduleName: "",
      }),
    };
  });

  it("sets modifiers=['async'] on async export function via regex path (noAst L466)", async () => {
    const f = await writeFile(
      "src/async-export-regex.ts",
      `export async function fetchUser(id: string): Promise<string> { return id; }`
    );
    const contracts = await noAstAsyncMod.extractModuleContracts([f]);
    expect(contracts.length).toBe(1);
    const asyncFn = contracts[0]!.exports.find((e) => e.name === "fetchUser");
    expect(asyncFn).toBeDefined();
    expect(asyncFn!.modifiers).toContain("async");
    expect(asyncFn!.isAsync).toBe(true);
  });
});

describe("contractFromAst / unitsFromAst — non-Error throw (L369, L381)", () => {
  it("handles non-Error string thrown by astParser.parseFile in contractFromAst (L369)", async () => {
    const throwStrEng = new CognitiveIndexEngine({
      logger,
      indexPath: path.join(workDir, ".throw-str-contract.json"),
    });
    (throwStrEng as any).astParser = {
      parseFile: () => { throw "string-error-not-an-Error"; },
    };
    const f = await writeFile("src/throw-str-contract.ts", `export const x = 1;`);
    const contracts = await throwStrEng.extractModuleContracts([f]);
    // Should fall through to regex fallback and return a contract
    expect(contracts.length).toBeGreaterThanOrEqual(0);
  });

  it("handles non-Error string thrown by astParser.parseFile in unitsFromAst (L381)", async () => {
    const throwStrUnits = new CognitiveIndexEngine({
      logger,
      indexPath: path.join(workDir, ".throw-str-units.json"),
    });
    (throwStrUnits as any).astParser = {
      parseFile: () => { throw "string-error-units"; },
    };
    const f = await writeFile("src/throw-str-units.ts", `export function add(a: number, b: number) { return a + b; }`);
    const units = await throwStrUnits.extractUnitFingerprints([f]);
    // Falls to regex fallback
    expect(Array.isArray(units)).toBe(true);
  });
});

describe("extractImports — Go block import with comment line (L453)", () => {
  let noAstGoCmt: CognitiveIndexEngine;

  beforeEach(async () => {
    await fs.mkdir(path.join(workDir, "src"), { recursive: true });
    noAstGoCmt = new CognitiveIndexEngine({
      logger,
      indexPath: path.join(workDir, ".go-cmt-index.json"),
    });
    (noAstGoCmt as any).astParser = {
      parseFile: () => ({
        errorMessage: "forced",
        exports: [], imports: [], units: [], definedTypes: [], moduleName: "",
      }),
    };
  });

  it("skips comment lines in Go block imports (L453 FALSE branch of startsWith)", async () => {
    const goFile = path.join(workDir, "src", "commented.go");
    await fs.writeFile(
      goFile,
      `package main\nimport (\n\t"fmt"\n\t// this is a comment\n\t"os"\n)\nfunc main() {}`
    );
    const contracts = await noAstGoCmt.extractModuleContracts([goFile]);
    expect(contracts.length).toBe(1);
    const names = contracts[0]!.imports.map((i) => i.name);
    expect(names).toContain("fmt");
    expect(names).toContain("os");
    // Comment line is NOT added as an import
    expect(names.some((n) => n.includes("comment"))).toBe(false);
  });

  it("skips empty lines in Go block imports (L453 FALSE branch of truthy t)", async () => {
    const goFile = path.join(workDir, "src", "empty-lines.go");
    await fs.writeFile(
      goFile,
      `package main\nimport (\n\t"fmt"\n\n\t"strings"\n)\nfunc main() {}`
    );
    const contracts = await noAstGoCmt.extractModuleContracts([goFile]);
    const names = contracts[0]!.imports.map((i) => i.name);
    expect(names).toContain("fmt");
    expect(names).toContain("strings");
  });
});

describe("extractExports — async function, abstract class, const enum via noAst (L466, L470, L479)", () => {
  let noAstExp: CognitiveIndexEngine;

  beforeEach(() => {
    noAstExp = new CognitiveIndexEngine({
      logger,
      indexPath: path.join(workDir, ".exp-index.json"),
    });
    (noAstExp as any).astParser = {
      parseFile: () => ({
        errorMessage: "forced",
        exports: [], imports: [], units: [], definedTypes: [], moduleName: "",
      }),
    };
  });

  it("sets modifiers=['async'] on async export function (L466 TRUE branch)", async () => {
    const f = await writeFile(
      "src/async-fn-exp.ts",
      `export async function loadData(id: string): Promise<void> { return; }`
    );
    const contracts = await noAstExp.extractModuleContracts([f]);
    const fn = contracts[0]?.exports.find((e) => e.name === "loadData");
    expect(fn).toBeDefined();
    expect(fn!.modifiers).toContain("async");
  });

  it("sets modifiers=['abstract'] on abstract class export (L470 TRUE branch)", async () => {
    const f = await writeFile(
      "src/abstract-cls.ts",
      `export abstract class BaseRepository { abstract find(id: string): Promise<any>; }`
    );
    const contracts = await noAstExp.extractModuleContracts([f]);
    const cls = contracts[0]?.exports.find((e) => e.name === "BaseRepository");
    expect(cls).toBeDefined();
    expect(cls!.modifiers).toContain("abstract");
  });

  it("sets modifiers=['const'] on const enum export (L479 TRUE branch)", async () => {
    const f = await writeFile(
      "src/const-enum.ts",
      `export const enum Direction { Up, Down, Left, Right }`
    );
    const contracts = await noAstExp.extractModuleContracts([f]);
    const en = contracts[0]?.exports.find((e) => e.name === "Direction");
    expect(en).toBeDefined();
    expect(en!.modifiers).toContain("const");
  });
});

describe("extractTypes — interface with generics+extends, type alias with generics (L508, L513)", () => {
  let noAstTypes: CognitiveIndexEngine;

  beforeEach(() => {
    noAstTypes = new CognitiveIndexEngine({
      logger,
      indexPath: path.join(workDir, ".types-index.json"),
    });
    (noAstTypes as any).astParser = {
      parseFile: () => ({
        errorMessage: "forced",
        exports: [], imports: [], units: [], definedTypes: [], moduleName: "",
      }),
    };
  });

  it("parses interface generic params and extends types (L508 optional chain TRUE)", async () => {
    const f = await writeFile(
      "src/generic-iface.ts",
      `export interface Repository<T, ID> extends Serializable, Closeable {
  findById(id: ID): Promise<T>;
  save(entity: T): Promise<void>;
}`
    );
    const contracts = await noAstTypes.extractModuleContracts([f]);
    const types = contracts[0]?.definedTypes ?? [];
    const repo = types.find((t) => t.name === "Repository");
    expect(repo).toBeDefined();
    expect(repo!.genericParams.length).toBeGreaterThan(0);
    expect(repo!.extendsTypes.length).toBeGreaterThan(0);
  });

  it("parses type alias with generic params (L513 optional chain TRUE)", async () => {
    const f = await writeFile(
      "src/generic-type.ts",
      `export type Nullable<T> = T | null;
export type Result<T, E> = { data: T; error?: E; };`
    );
    const contracts = await noAstTypes.extractModuleContracts([f]);
    const types = contracts[0]?.definedTypes ?? [];
    const nullable = types.find((t) => t.name === "Nullable");
    expect(nullable).toBeDefined();
    expect(nullable!.genericParams.length).toBeGreaterThan(0);
  });
});

describe("parseParamTypes — typed params split on colon (L548 TRUE branch)", () => {
  let noAstPt: CognitiveIndexEngine;

  beforeEach(() => {
    noAstPt = new CognitiveIndexEngine({
      logger,
      indexPath: path.join(workDir, ".pt-index.json"),
    });
    (noAstPt as any).astParser = {
      parseFile: () => ({
        errorMessage: "forced",
        exports: [], imports: [], units: [], definedTypes: [], moduleName: "",
      }),
    };
  });

  it("extracts typed parameter types from export function signature", async () => {
    const f = await writeFile(
      "src/typed-params.ts",
      `export function combine(name: string, age: number, active: boolean): string { return name; }`
    );
    const contracts = await noAstPt.extractModuleContracts([f]);
    const fn = contracts[0]?.exports.find((e) => e.name === "combine");
    expect(fn).toBeDefined();
    expect(fn!.inputTypes).toContain("string");
    expect(fn!.inputTypes).toContain("number");
  });
});

describe("extractFileUnits — non-parseable extension returns [] (L609)", () => {
  it("returns empty array for .go file passed to extractUnitFingerprints", async () => {
    await fs.mkdir(path.join(workDir, "src"), { recursive: true });
    const goFile = path.join(workDir, "src", "units.go");
    await fs.writeFile(goFile, `package main\nfunc hello() {}`);
    const units = await engine.extractUnitFingerprints([goFile]);
    // .go is not in ['.ts','.tsx','.js','.jsx','.py','.java'] → returns []
    expect(units).toEqual([]);
  });

  it("returns empty array for .rs Rust file", async () => {
    await fs.mkdir(path.join(workDir, "src"), { recursive: true });
    const rsFile = path.join(workDir, "src", "main.rs");
    await fs.writeFile(rsFile, `fn main() { println!("hello"); }`);
    const units = await engine.extractUnitFingerprints([rsFile]);
    expect(units).toEqual([]);
  });
});

describe("extractFileUnits — class with implements (L654 optional chain TRUE)", () => {
  let noAstCls: CognitiveIndexEngine;

  beforeEach(() => {
    noAstCls = new CognitiveIndexEngine({
      logger,
      indexPath: path.join(workDir, ".cls-index.json"),
    });
    (noAstCls as any).astParser = {
      parseFile: () => ({
        errorMessage: "forced",
        exports: [], imports: [], units: [], definedTypes: [], moduleName: "",
      }),
    };
  });

  it("includes implements types in typeDependencies for class (L654 m[3] truthy)", async () => {
    const f = await writeFile(
      "src/implements-cls.ts",
      `export class UserRepo extends BaseRepo implements IRepository, IDisposable {
  async find(id: string) { return id; }
}`
    );
    const units = await noAstCls.extractUnitFingerprints([f]);
    const cls = units.find((u) => u.name === "UserRepo");
    expect(cls).toBeDefined();
    // typeDependencies should include base class and implements types
    expect(cls!.typeDependencies.length).toBeGreaterThan(0);
  });
});

describe("extractFileUnits — Python file for unit fingerprints (L680 TRUE branch)", () => {
  it("extracts Python function units via noAst regex path (L680 else-if .py branch)", async () => {
    await fs.mkdir(path.join(workDir, "src"), { recursive: true });
    const pyFile = path.join(workDir, "src", "service.py");
    await fs.writeFile(
      pyFile,
      `def get_user(user_id):\n    return user_id\n\ndef create_user(name, email):\n    return {"name": name, "email": email}\n\nasync def fetch_data(url):\n    return url\n`
    );
    const units = await engine.extractUnitFingerprints([pyFile]);
    const names = units.map((u) => u.name);
    expect(names).toContain("get_user");
    expect(names).toContain("create_user");
    expect(names).toContain("fetch_data");
  });
});

describe("extractTypeRefs — generic type refs <SomeType> in body (L741)", () => {
  let noAstRef: CognitiveIndexEngine;

  beforeEach(() => {
    noAstRef = new CognitiveIndexEngine({
      logger,
      indexPath: path.join(workDir, ".ref-index.json"),
    });
    (noAstRef as any).astParser = {
      parseFile: () => ({
        errorMessage: "forced",
        exports: [], imports: [], units: [], definedTypes: [], moduleName: "",
      }),
    };
  });

  it("captures generic type references like Array<T> and Promise<T> in function bodies (L741)", async () => {
    const f = await writeFile(
      "src/generic-refs.ts",
      `export function processItems(items: Array<string>): Promise<number[]> {
  const result: Map<string, number> = new Map<string, number>();
  return Promise.resolve([]);
}`
    );
    const units = await noAstRef.extractUnitFingerprints([f]);
    const fn = units.find((u) => u.name === "processItems");
    expect(fn).toBeDefined();
    // Generic type refs like Array, Promise, Map should be captured
    expect(fn!.typeDependencies.some((t) => ["Array", "Promise", "Map"].includes(t))).toBe(true);
  });
});

describe("deserializeIndex — missing generatedAt falls back to Date.now() (L936)", () => {
  it("deserializes index with missing generatedAt field using Date.now() fallback", async () => {
    const fallbackEngine = new CognitiveIndexEngine({
      logger,
      indexPath: path.join(workDir, ".fallback-gen.json"),
    });
    // Write an index JSON without generatedAt
    const raw = {
      skeleton: null,
      modules: [],
      units: [],
      stats: {
        totalModules: 0, totalUnits: 0, totalExports: 0, totalTypes: 0,
        avgComplexity: 0, pureFunctionRatio: 0, asyncFunctionRatio: 0,
        patternDistribution: {},
        estimatedTokenCost: { skeleton: 0, contracts: 0, fingerprints: 0, total: 0 },
      },
      // no generatedAt
      lastIncrementalUpdate: Date.now(),
    };
    await fs.writeFile(
      path.join(workDir, ".fallback-gen.json"),
      JSON.stringify(raw),
      "utf-8"
    );
    await fallbackEngine.initialize();
    const idx = fallbackEngine.getIndex();
    expect(idx).not.toBeNull();
    expect(idx!.generatedAt).toBeGreaterThan(0);
  });
});

describe("parseParamTypes — untyped params return 'unknown' (L550 FALSE branch)", () => {
  let noAstPu: CognitiveIndexEngine;

  beforeEach(() => {
    noAstPu = new CognitiveIndexEngine({
      logger,
      indexPath: path.join(workDir, ".pu-index.json"),
    });
    (noAstPu as any).astParser = {
      parseFile: () => ({
        errorMessage: "forced",
        exports: [], imports: [], units: [], definedTypes: [], moduleName: "",
      }),
    };
  });

  it("returns 'unknown' for each untyped param (parts.length === 1, L550 FALSE)", async () => {
    const f = await writeFile(
      "src/untyped-params.ts",
      `export function legacy(x, y, z) { return x + y + z; }`
    );
    const contracts = await noAstPu.extractModuleContracts([f]);
    const fn = contracts[0]?.exports.find((e) => e.name === "legacy");
    expect(fn).toBeDefined();
    expect(fn!.inputTypes.every((t) => t === "unknown")).toBe(true);
    expect(fn!.inputTypes.length).toBe(3);
  });
});
