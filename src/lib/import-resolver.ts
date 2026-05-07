/**
 * JCF Healthcare Agent Hub — Import Resolver (Phase E3)
 *
 * Replaces the old `resolveImport()` in `dependency-graph.ts` that only
 * handled relative imports (95%+ of real imports were ignored: node_modules,
 * tsconfig path aliases `@/x`, pnpm workspace protocols, package.json
 * `exports` conditions).
 *
 * Built on `enhanced-resolve` — the same resolver webpack / vite / esbuild
 * use — so it honours:
 *   - `tsconfig.json` `paths` + `baseUrl`
 *   - `package.json` `exports` + `main` + `module` + `types`
 *   - `node_modules` lookup (including nested)
 *   - pnpm / yarn / npm workspace layouts
 *   - conditional exports (`node`, `import`, `require`, `types`)
 *
 * Falls back to a best-effort path.resolve() for unresolvable imports so
 * the dependency graph always has *something*, even if approximate.
 */

import path from 'path';
import fs from 'fs';
import enhancedResolve from 'enhanced-resolve';
import type { Logger } from './logger.js';
import { getInstallRoot } from './install-root.js';

// ═══════════════════════════════════════════════════════════════════════════
// ── Types ──
// ═══════════════════════════════════════════════════════════════════════════

export interface ResolveConfig {
  logger: Logger;
  /**
   * Project root for tsconfig lookup.
   * Defaults to JCF install-root (R-1) — previously
   * defaulted to `process.cwd()` which produced wrong path-alias
   * resolution when MCP was spawned from a foreign cwd. Set explicitly
   * when indexing a target project distinct from JCF itself.
   */
  projectRoot?: string;
  /** Explicit tsconfig path. Auto-detected if omitted. */
  tsConfigPath?: string;
  /** File extensions to resolve. Reasonable defaults provided. */
  extensions?: string[];
  /** Condition names for package.json `exports`. */
  conditionNames?: string[];
}

export interface ResolveResult {
  /** Absolute path to resolved file, or null if not found. */
  resolved: string | null;
  /** How the import was resolved (for diagnostics). */
  kind: 'relative' | 'tsconfig-path' | 'node-module' | 'builtin' | 'fallback' | 'unresolved';
  /** If unresolved, why. */
  reason?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Built-ins (never need resolving) ──
// ═══════════════════════════════════════════════════════════════════════════

const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console',
  'constants', 'crypto', 'dgram', 'dns', 'domain', 'events', 'fs', 'http',
  'http2', 'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks',
  'process', 'punycode', 'querystring', 'readline', 'repl', 'stream',
  'string_decoder', 'sys', 'timers', 'tls', 'trace_events', 'tty', 'url',
  'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
]);

function isBuiltin(spec: string): boolean {
  const bare = spec.startsWith('node:') ? spec.slice(5) : spec;
  return NODE_BUILTINS.has(bare);
}

// ═══════════════════════════════════════════════════════════════════════════
// ── tsconfig.json path lookup (minimal) ──
// ═══════════════════════════════════════════════════════════════════════════

interface TsConfigPaths {
  baseUrl: string;
  paths: Record<string, string[]>;
  configPath: string;
}

function loadTsConfigPaths(configPath: string): TsConfigPaths | null {
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    // Strip JSON comments (tsconfig allows them)
    const stripped = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/.*$/gm, '$1');
    const parsed = JSON.parse(stripped);
    const opts = parsed.compilerOptions ?? {};
    const baseUrl = path.resolve(path.dirname(configPath), opts.baseUrl ?? '.');
    const paths: Record<string, string[]> = opts.paths ?? {};
    return { baseUrl, paths, configPath };
  } catch {
    return null;
  }
}

function findTsConfig(startDir: string): string | null {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;
  while (true) {
    const candidate = path.join(dir, 'tsconfig.json');
    if (fs.existsSync(candidate)) return candidate;
    if (dir === root) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Resolve an import through tsconfig `paths`. Returns first matching file or null. */
function resolveTsConfigPath(
  spec: string,
  tsConfig: TsConfigPaths,
  syncResolve: enhancedResolve.ResolveFunction
): string | null {
  for (const [pattern, targets] of Object.entries(tsConfig.paths)) {
    const prefix = pattern.replace(/\*$/, '');
    if (!spec.startsWith(prefix)) continue;
    const remainder = spec.slice(prefix.length);
    for (const target of targets) {
      const candidate = path.resolve(tsConfig.baseUrl, target.replace(/\*$/, '') + remainder);
      // Try resolving candidate via enhanced-resolve (adds extensions/index)
      try {
        const result = syncResolve(tsConfig.baseUrl, candidate);
        if (typeof result === 'string') return result;
      } catch {
        /* keep trying */
      }
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Resolver ──
// ═══════════════════════════════════════════════════════════════════════════

export class ImportResolver {
  private readonly logger: Logger;
  private readonly syncResolve: enhancedResolve.ResolveFunction;
  private readonly tsConfig: TsConfigPaths | null;

  constructor(config: ResolveConfig) {
    this.logger = config.logger;

    // Find tsconfig (auto or explicit).
    // R-1: install-root fallback eliminates cwd-drift bug where the
    // resolver picked up an unrelated tsconfig from the spawn cwd.
    const projectRoot = config.projectRoot ?? getInstallRoot();
    const tsConfigPath = config.tsConfigPath ?? findTsConfig(projectRoot);
    this.tsConfig = tsConfigPath ? loadTsConfigPaths(tsConfigPath) : null;
    if (this.tsConfig) {
      this.logger.info('ImportResolver: tsconfig.json loaded', {
        configPath: this.tsConfig.configPath,
        pathAliases: Object.keys(this.tsConfig.paths).length,
      });
    } else {
      this.logger.debug('ImportResolver: no tsconfig.json found', { searchedFrom: projectRoot });
    }

    this.syncResolve = enhancedResolve.create.sync({
      extensions: config.extensions ?? [
        '.ts', '.tsx', '.mts', '.cts',
        '.js', '.jsx', '.mjs', '.cjs',
        '.json',
      ],
      mainFields: ['exports', 'module', 'main'],
      conditionNames: config.conditionNames ?? ['node', 'import', 'require', 'default'],
      preferRelative: false,
      symlinks: true,
    });
  }

  /**
   * Resolve an import specifier from a file location.
   *
   * @param specifier the `from` string (e.g. `./foo`, `@modelcontextprotocol/sdk`)
   * @param fromFile  absolute path of the file that contains the import
   * @returns absolute path, or null if unresolvable
   */
  resolve(specifier: string, fromFile: string): ResolveResult {
    // Empty / sentinel
    if (!specifier) return { resolved: null, kind: 'unresolved', reason: 'empty specifier' };

    // Built-ins (node:fs, node:path, fs, path, crypto, ...)
    if (isBuiltin(specifier)) {
      return { resolved: null, kind: 'builtin' };
    }

    const fromDir = path.dirname(path.resolve(fromFile));

    // Try enhanced-resolve first (handles relative + node_modules + exports)
    try {
      const resolved = this.syncResolve(fromDir, specifier);
      if (typeof resolved === 'string') {
        const kind: ResolveResult['kind'] = specifier.startsWith('.')
          ? 'relative'
          : 'node-module';
        return { resolved, kind };
      }
    } catch {
      /* enhanced-resolve throws on failure — try tsconfig paths next */
    }

    // tsconfig path alias: @/foo, ~/bar, etc.
    if (this.tsConfig && !specifier.startsWith('.')) {
      const tsResolved = resolveTsConfigPath(specifier, this.tsConfig, this.syncResolve);
      if (tsResolved) return { resolved: tsResolved, kind: 'tsconfig-path' };
    }

    // Fallback: best-effort for relative paths even if target doesn't exist
    // (e.g. import of a file that will be generated / not yet written).
    if (specifier.startsWith('.')) {
      const candidate = path.resolve(fromDir, specifier);
      return { resolved: candidate, kind: 'fallback', reason: 'file not found, using path.resolve' };
    }

    return {
      resolved: null,
      kind: 'unresolved',
      reason: `no resolver strategy matched for '${specifier}'`,
    };
  }

  /** Convenience: return the path only (null if unresolved) */
  resolvePath(specifier: string, fromFile: string): string | null {
    return this.resolve(specifier, fromFile).resolved;
  }

  /** Snapshot current config for health-check / diagnostics */
  getConfigSnapshot(): {
    tsConfigPath: string | null;
    pathAliases: Record<string, string[]>;
    baseUrl: string | null;
  } {
    return {
      tsConfigPath: this.tsConfig?.configPath ?? null,
      pathAliases: this.tsConfig?.paths ?? {},
      baseUrl: this.tsConfig?.baseUrl ?? null,
    };
  }
}
