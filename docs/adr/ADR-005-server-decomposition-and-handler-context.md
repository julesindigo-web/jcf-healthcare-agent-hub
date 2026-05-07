# ADR-005: Decomposition of `server.ts` into pure handlers + `HandlerContext`

**Status:** ACCEPTED
**Date:** 2026-04-26
**Audit cycle:** M11 — `jcf-healthcare-agent-hub` hardening
**Supersedes:** —
**Related:** ADR-004 (`jcf-memory` handler decomposition)

---

## Context

`src/server.ts` was a single 1403-line file containing:

- The `JcfHandlingToolServer` class
- All 29 tool handlers as `private async handleX(args)` methods
- The dispatcher closure (rate-limit → handler → MCP envelope)
- 7 helper methods (`validatePath`, `withAudit`, `getCurrentUser`,
  `fs_getMetadata`, `analyzeFileContent`, `analyzeJavaScript`,
  `analyzePython`, `analyzeJava`, `detectLanguage`, `hashContent`,
  `patternToRegex`, `getCoherenceMessage`, `autoIndexDirectory`)

Cyclomatic complexity for the file: **102**. Direct unit-test coverage of
`server.ts`: **0% lines** — all coverage came indirectly via
`integration.test.ts`, which spawns a child process and therefore is
invisible to v8 coverage.

This shape was inherited from the same monolithic pattern that
`jcf-memory` had before the M10 audit. M10 successfully decomposed
`jcf-memory/src/tools/handlers.ts` (987 → ~80 lines + category modules)
and unlocked direct unit testing + coverage. M11 replicates the same
move on `jcf-healthcare-agent-hub`.

### Forces

| Concern | Pressure |
|---|---|
| Test coverage | `server.ts` was untestable directly: every handler required spinning the full MCP server, eliminating v8 line-level visibility. |
| Cognitive load | A 1403-line file with 39 `private` methods exceeds the file-concept guideline (≤7 per §83.CL2). |
| Behavior preservation | All 457 baseline tests + the integration suite must continue to pass. Audit semantics, RBAC checks, secrets scanning, version capture — all must be byte-for-byte identical. |
| Tool registration parity | The 29 registered tool names and their zod schemas are part of the public MCP contract; no rename, no shape drift. |
| Future extensibility | Adding a new tool currently requires editing `server.ts` in three places (`setupTools`, `handleX` method, and supporting helpers). Should reduce to a single registry entry plus a pure handler. |

### Considered Alternatives

1. **Status-quo + targeted tests through MCP client** — would not improve
   coverage tracking (still subprocess-bounded) and would not reduce
   file complexity.
2. **Class-per-category** (e.g. `class FilesystemHandlers extends Base`) —
   inheritance buys nothing here; handlers are stateless w.r.t. each
   other, only sharing the service bundle. Composition via a context
   object is simpler.
3. **Pure-function modules + `HandlerContext`** (chosen) — mirrors the
   M10 pattern proven on `jcf-memory`. Each handler is a top-level
   `async function` taking `(ctx, args)`; the registry maps name to
   `{schema, handler}`; `server.ts` becomes a thin orchestrator.

---

## Decision

Decompose `server.ts` into:

```
src/
├── handlers/
│   ├── context.ts            # HandlerContext interface + buildHandlerContext
│   ├── shared/
│   │   ├── audit.ts          # withAudit + getCurrentUser
│   │   ├── path-guard.ts     # validatePath
│   │   ├── metadata.ts       # fsGetMetadata
│   │   ├── content-analysis.ts # analyzeFileContent + per-language + detectLanguage
│   │   └── util.ts           # hashContent + patternToRegex + getCoherenceMessage
│   ├── filesystem.ts         # 6 tools: read, write, edit, append, delete, list
│   ├── search.ts             # 2 tools: searchFiles, semanticSearch
│   ├── versioning.ts         # 3 tools: history, rollback, getMetadata
│   ├── dependencies.ts       # 4 tools: deps, dependents, coherence, cycles
│   ├── operations.ts         # 4 tools: batch, health, features, audit
│   └── intelligence.ts       # 10 cognitive tools
├── registry.ts               # name → { schema, handler } map
└── server.ts                 # thin MCP orchestrator (~318 lines)
```

### Contract

```ts
// handlers/context.ts
export interface HandlerContext {
  configManager, config, logger,
  db, cache, vectorDb, security, dependencyGraph, selfHealing?,
  cognitiveIndex, nlkg, patternDetector, typeFlowAnalyzer,
  codeIntelligence, embeddingClient, rateLimiter,
}

export type ToolHandler<Args = unknown, Result = unknown> = (
  ctx: HandlerContext, args: Args,
) => Promise<Result>;

// registry.ts
export const TOOL_REGISTRY: Record<string, {
  schema: z.ZodTypeAny;
  handler: ToolHandler<unknown, unknown>;
}> = { /* 29 entries */ };

// server.ts (excerpt)
private setupTools(): void {
  for (const [name, registration] of Object.entries(TOOL_REGISTRY)) {
    this.registerOne(name, registration.schema, registration.handler);
  }
}
```

### Behavior preservation guarantees

The refactor is **mechanical**. For every original `handleX` method:

1. The body is copied byte-for-byte into the corresponding category
   module's exported `async function` of the same logical name.
2. Every `this.X` is rewritten to `ctx.X` (where `X` is a service member).
3. Every helper call (`this.validatePath`, `this.withAudit`, etc.) is
   rewritten to import the function from `handlers/shared/*`.
4. No early-return, no logging, no error-path is reordered.

The MCP envelope wrap (`{ content: [{ type: "text", text: JSON.stringify(result) }] }`)
remains in the dispatcher loop — handlers return their raw result and
let the dispatcher wrap. Intelligence handlers preserve their inner-
envelope shape (the dispatcher then wraps the inner envelope, exactly
as before).

---

## Consequences

### Positive

- **Direct testability:** every handler can now be called as
  `readFile(ctx, args)` from a unit test. Coverage is tracked per line
  by v8.
- **Coverage uplift:** new direct tests achieve **98.68% lines** on
  `handlers/`, **100%** on `shared/` (line + function), and **100%** on
  `registry.ts`. `server.ts` remains 0% on v8 (subprocess-bounded
  integration coverage), but the surface that needs tracking shrunk
  from 1403 lines to 327 thin orchestration lines.
- **Cognitive load:** average file size is now 100–280 lines; each file
  has a single concern. The new `server.ts` no longer contains any
  business logic — it boots services, builds the context, and
  iterates the registry.
- **Adding a new tool** requires: implement handler → add registry entry
  → add description. Three lines of mechanical wiring vs. three
  scattered edits in a 1403-line file.
- **Test infrastructure dividend:** `_test-context.ts` is reusable for
  any future handler test and keeps Windows file-handle races out of
  the assertion path (drains debounced VectorDB saves before sandbox
  rm).

### Negative / cost

- **One indirection added:** the dispatcher now goes through a registry
  lookup rather than a direct method call. Cost is one Map-style
  property access per call — negligible vs. the network/IO cost of any
  real handler.
- **Unused-arg suppression:** intelligence handlers that accept
  `_args: Record<string, never>` reflect the original handler shape;
  unchanged but visible in the new module surface.
- **Documented preserved bugs:** the refactor surfaced two latent bugs
  that were preserved verbatim under the M11 mandate:
  1. `patternToRegex("a?c")` produces `/^a\.c$/i` because `?` is
     escaped before the glob conversion (test documents this).
  2. `deleteFile` adds a version row, then `deleteFileMetadata`
     cascades-delete it in the same transaction (test asserts the
     observable: metadata gone + delete-audit row present, not the
     version row).
  These are out of scope for M11 — fixing them would be a separate ADR.

### Neutral

- **Public API unchanged:** `JcfHandlingToolServer` retains its
  constructor, `initialize()`, `connect()`, `close()`, and
  `getEnabledFeatures()` methods. `index.ts` requires zero change.

---

## Validation evidence

- Build: `npx tsc -p tsconfig.json` — **clean** (zero errors, strict mode).
- Test suite: **666 passing** / 0 failing across 28 files.
  - 457 baseline tests preserved (zero regression).
  - 209 new tests:
    - `handlers-shared.test.ts` — 59
    - `handlers-filesystem.test.ts` — 26
    - `handlers-versioning.test.ts` — 10
    - `handlers-dependencies.test.ts` — 7
    - `handlers-operations.test.ts` — 15
    - `handlers-search.test.ts` — 10
    - `handlers-intelligence.test.ts` — 20
    - `registry.test.ts` — 39
    - `handlers-properties.test.ts` — 23 (fast-check)
- Coverage on the new surface (v8 / lines):
  - `registry.ts`: **100%**
  - `handlers/context.ts`: **100%**
  - `handlers/shared/*`: **100%** (96.49% branches)
  - `handlers/*` aggregate: **98.68%** (87.00% branches)
- Integration test: `integration.test.ts` (32 tests, end-to-end MCP
  client → spawned subprocess → all 29 M11-baseline tools) still green.
  *(Note: total registry surface is now 33 after the diagnostics fold-in —
  `ping`, `estatus`, `verify` are covered by direct unit tests in
  `diagnostics.test.ts` rather than the integration subprocess. ADR-005's
  M11 scope is preserved; the 33-tool count appears in `registry.ts` and
  `README.md`.)*

---

## Follow-up work

- M12 candidate: fix the two latent bugs preserved in M11
  (patternToRegex `?` escape, deleteFile version cascade).
- M12 candidate: server.ts in-process integration test that bypasses
  the subprocess boundary so v8 can track its lines.
- M12 candidate: handler hot-path benchmarks to confirm registry
  indirection is in the noise.
