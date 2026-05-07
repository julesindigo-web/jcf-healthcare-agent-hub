/**
 * JCF Healthcare Agent Hub — Install-Root Resolver (R-1)
 *
 * Single source of truth for "where does this MCP server install its data".
 *
 * BACKGROUND
 * ----------
 * Pre-R-1, nine call-sites in five files used `process.cwd()` as a path
 * anchor (version.ts, config.ts × 4, search.ts × 2, import-resolver.ts × 2,
 * cognitive-index.ts default). When the server was spawned by Claude
 * Desktop / VS Code Cline / a wrapper script with cwd ≠ install dir, this
 * caused:
 *   - `package.json` resolution to wrong file → SERVER_VERSION drift.
 *   - `mcp-fs-config.json` not found → silent default config.
 *   - `data/jcf-fs-metadata.sqlite` and `data/jcf-vector-db.sqlite` written
 *     into a stranger's directory.
 *   - `.jcf-cognitive-index.json` written/read at cwd, getting clobbered by
 *     each session's spawn cwd, and once corrupted with `.integ-*` test
 *     fixture data (the `Step Flash` symptom that triggered this audit).
 *
 * RESOLUTION ORDER (highest precedence first)
 * -------------------------------------------
 *   1. `process.env.JCF_HEALTHCARE_AGENT_HUB_HOME`  — explicit operator override.
 *      (Legacy alias `JCF_HANDLING_TOOL_HOME` still supported for backward compat).
 *   2. Anchor walk from `import.meta.url`     — finds the package.json
 *      that ships with this binary (works for src/ during tests AND
 *      dist/ at runtime, because both nest under the package root).
 *   3. `process.cwd()` LAST RESORT            — emits a warning if hit;
 *      preserves backward compat when neither env nor __dirname work
 *      (e.g. older Node, esbuild-bundled output without metadata).
 *
 * The `data/` sub-directory is reified via `getDataRoot()` so per-call
 * sites do not have to repeat the join. Both functions are memoized; the
 * resolution is performed exactly once per process lifetime.
 *
 * Tests can reset the cache via `__resetInstallRootCacheForTests()` and
 * inject a fixture root via `JCF_HEALTHCARE_AGENT_HUB_HOME`.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

let cachedInstallRoot: string | null = null;
let cachedDataRoot: string | null = null;
let resolutionSource: 'env' | 'anchor-walk' | 'cwd-fallback' | null = null;

/**
 * Walk up from `startDir` until a directory containing `package.json` (with
 * the matching `name` field) is found, or until filesystem root is reached.
 *
 * The `name` check guards against picking up an unrelated outer
 * `package.json` (e.g. when the server source lives inside a workspace
 * monorepo whose root has its own `package.json`).
 */
function findPackageRoot(startDir: string, expectedName: string): string | null {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;
  // Walk at most 10 levels — defends against path-resolution loops on
  // pathological filesystems (junctions/symlinks pointing back at parent).
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        // Read minimal JSON to inspect `name` — avoid pulling in
        // package.json reader from version.ts (would create cycle).
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const pkg = JSON.parse(
          // Use sync read to keep this function pure-sync (init-time only).
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          require('node:fs').readFileSync(candidate, 'utf-8')
        ) as { name?: string };
        if (pkg.name === expectedName) return dir;
      } catch {
        /* fall through — keep walking */
      }
    }
    if (dir === root) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Resolve the install root via precedence:
 *   1. JCF_HANDLING_TOOL_HOME env var.
 *   2. Anchor walk from this module's URL.
 *   3. process.cwd() with warning.
 *
 * Result is memoized for the process lifetime.
 */
export function getInstallRoot(): string {
  if (cachedInstallRoot !== null) return cachedInstallRoot;

  // 1. Explicit env override.
  const envRoot = process.env.JCF_HEALTHCARE_AGENT_HUB_HOME || process.env.JCF_HANDLING_TOOL_HOME;
  if (envRoot && envRoot.trim().length > 0) {
    cachedInstallRoot = path.resolve(envRoot);
    resolutionSource = 'env';
    return cachedInstallRoot;
  }

  // 2. Anchor walk from this module.
  // import.meta.url works in both ESM source (during vitest) and dist build.
  let here: string;
  try {
    here = path.dirname(fileURLToPath(import.meta.url));
  } catch {
    here = '';
  }
  if (here) {
    const found = findPackageRoot(here, 'jcf-healthcare-agent-hub');
    if (found) {
      cachedInstallRoot = found;
      resolutionSource = 'anchor-walk';
      return cachedInstallRoot;
    }
  }

  // 3. Last-resort fallback. We deliberately do NOT log here because the
  // logger module imports from us indirectly and we are init-time. Caller
  // sites that actually use the path are responsible for emitting a
  // diagnostic if they detect the cwd-fallback was used (via
  // `getInstallRootSource()`).
  cachedInstallRoot = process.cwd();
  resolutionSource = 'cwd-fallback';
  return cachedInstallRoot;
}

/**
 * Resolve the data directory. Defaults to `<install-root>/data`, override
 * via `JCF_HEALTHCARE_AGENT_HUB_DATA_DIR` env var (legacy alias
 * `JCF_HANDLING_TOOL_DATA_DIR` still supported). Memoized.
 */
export function getDataRoot(): string {
  if (cachedDataRoot !== null) return cachedDataRoot;
  const override = process.env.JCF_HEALTHCARE_AGENT_HUB_DATA_DIR || process.env.JCF_HANDLING_TOOL_DATA_DIR;
  if (override && override.trim().length > 0) {
    cachedDataRoot = path.isAbsolute(override)
      ? path.resolve(override)
      : path.resolve(getInstallRoot(), override);
  } else {
    cachedDataRoot = path.resolve(getInstallRoot(), 'data');
  }
  return cachedDataRoot;
}

/**
 * Diagnostic accessor — which precedence rule won the resolution? Used by
 * boot logging (server.ts) to surface the cwd-fallback case as a warning,
 * and by tests to assert the expected source under controlled env.
 */
export function getInstallRootSource(): 'env' | 'anchor-walk' | 'cwd-fallback' | null {
  if (resolutionSource === null) {
    // Force resolution so callers can introspect.
    void getInstallRoot();
  }
  return resolutionSource;
}

/**
 * Resolve a path relative to install root. If `p` is already absolute,
 * returned unchanged. Convenience for migrating `path.resolve(process.cwd(), x)`
 * call-sites — replace with `resolveFromInstallRoot(x)`.
 */
export function resolveFromInstallRoot(p: string): string {
  if (path.isAbsolute(p)) return p;
  return path.resolve(getInstallRoot(), p);
}

/**
 * Resolve a path relative to data root. Same semantics as
 * `resolveFromInstallRoot` but anchored at `<install-root>/data`.
 */
export function resolveFromDataRoot(p: string): string {
  if (path.isAbsolute(p)) return p;
  return path.resolve(getDataRoot(), p);
}

/**
 * Test-only: reset memoized resolution. Allows test suites to mutate
 * `process.env.JCF_HANDLING_TOOL_HOME` between cases without process
 * restart. Production code MUST NOT call this.
 *
 * Marked with `__` prefix to signal "internal" — not part of the public
 * runtime contract.
 */
export function __resetInstallRootCacheForTests(): void {
  cachedInstallRoot = null;
  cachedDataRoot = null;
  resolutionSource = null;
}
