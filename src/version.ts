/**
 * JCF Healthcare Agent Hub — Version Single-Source-of-Truth
 *
 * Reads package.json at runtime to guarantee ONE canonical version string
 * across the entire server (config defaults, server init, tools/resources metadata).
 *
 * Resolves version drift (previous bug: package.json=2.0.0, config=3.0.0, server=2.0.0, tests=2.0.0).
 *
 * Build path: dist/version.js  →  dist/../package.json  →  package.json
 * Source path: src/version.ts  →  src/../package.json  →  package.json
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { resolveFromInstallRoot } from './lib/install-root.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface PackageJson {
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
}

/**
 * Load `package.json` by trying candidate paths in order.
 *
 * Exported with optional `candidates` parameter for test coverage of fallback
 * paths and traversal logic. Production callers should consume the `PACKAGE_*`
 * constants below; this function is exposed for unit tests only.
 *
 * @param candidates Optional override search paths (default: src/dist/cwd triad).
 */
export function loadPackageJson(candidates?: string[]): PackageJson {
  // Try candidate locations: anchored relative to this module (works for
  // src/ during tests AND dist/ at runtime), then install-root anchor
  // (env var or anchor walk; never raw cwd) as ultimate fallback.
  // R-1: replaced `process.cwd()` fallback with
  // `resolveFromInstallRoot('package.json')` to eliminate cwd-drift.
  const searchPaths = candidates ?? [
    join(__dirname, '..', 'package.json'),        // dist/../package.json
    join(__dirname, '..', '..', 'package.json'),  // dist/lib/../../package.json (safety)
    resolveFromInstallRoot('package.json'),       // fallback: install-root
  ];

  for (const candidate of searchPaths) {
    try {
      const raw = readFileSync(candidate, 'utf-8');
      return JSON.parse(raw) as PackageJson;
    } catch {
      continue;
    }
  }

  // Ultimate fallback — should never hit in practice
  return {
    name: 'jcf-healthcare-agent-hub',
    version: '0.0.0-UNKNOWN',
    description: 'JCF Healthcare Agent Hub',
  };
}

/**
 * Coerce optional string field to non-null string (empty fallback).
 *
 * Exported for branch-coverage tests of the null-coalescing fallback.
 */
export function safeString(value: string | undefined | null): string {
  return value ?? '';
}

const pkg = loadPackageJson();

/** Canonical package name from package.json */
export const PACKAGE_NAME: string = pkg.name;

/** Canonical version from package.json — SINGLE source of truth */
export const SERVER_VERSION: string = pkg.version;

/** Canonical server display name (human-readable) */
export const SERVER_NAME: string = 'JCF Healthcare Agent Hub MCP';

/** Canonical description from package.json */
export const PACKAGE_DESCRIPTION: string = safeString(pkg.description);

/** Canonical author from package.json */
export const PACKAGE_AUTHOR: string = safeString(pkg.author);

/** Canonical license from package.json */
export const PACKAGE_LICENSE: string = safeString(pkg.license);

/** Full version metadata bundle */
export const VERSION_METADATA = Object.freeze({
  name: PACKAGE_NAME,
  displayName: SERVER_NAME,
  version: SERVER_VERSION,
  description: PACKAGE_DESCRIPTION,
  author: PACKAGE_AUTHOR,
  license: PACKAGE_LICENSE,
});
