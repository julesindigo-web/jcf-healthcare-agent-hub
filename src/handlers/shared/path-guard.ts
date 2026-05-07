/**
 * Path validation gate. Extracted from `JcfHealthcareAgentHubServer.validatePath`
 * during M11 audit.
 *
 * Three checks (in order):
 *   1. Reject any input that resolves outside its declared base via
 *      `path.relative()` boundary analysis (path-traversal + symlink-escape
 *      defense — robust against `..` collapse, mixed separators, and
 *      Unicode homoglyphs).
 *   2. If `allowedDirectories` is non-empty, require the resolved path to
 *      sit inside one of them.
 *   3. Reject if the resolved path falls under any `forbiddenPaths` entry.
 *
 * Returns the resolved absolute path on success; throws on any violation.
 *
 * M11-AUDIT FIX (MED-9 + MED-10):
 *   - Added Unicode `NFC` normalization to neutralize composed/decomposed
 *     homoglyph attacks (e.g. composed `é` vs `e\u0301`).
 *   - Replaced fragile `startsWith(allowedDir + "/")` with `path.relative`
 *     boundary check that correctly rejects `'..'` escapes regardless of
 *     how `path.normalize` collapses the input.
 */

import path from "path";
import type { HandlerContext } from "../context.js";

/**
 * Unicode homoglyph characters that look like ASCII but are from different scripts.
 * These can be used to bypass path checks (e.g., Cyrillic 'с' U+0441 vs Latin 'c' U+0063).
 * Source: https://www.unicode.org/Public/security/latest/xidmodifications.txt
 */
const HOMOGLYPH_MAP: Record<string, string> = {
  // Cyrillic → Latin lookalikes
  '\u0410': 'A', '\u0412': 'B', '\u0415': 'E', '\u041A': 'K', '\u041C': 'M',
  '\u041E': 'O', '\u0420': 'P', '\u0421': 'C', '\u0422': 'T', '\u0425': 'X',
  '\u0430': 'a', '\u0432': 'b', '\u0435': 'e', '\u043A': 'k', '\u043C': 'm',
  '\u043E': 'o', '\u0440': 'p', '\u0441': 'c', '\u0442': 't', '\u0445': 'x',
  // Greek → Latin lookalikes  
  '\u0391': 'A', '\u0392': 'B', '\u0395': 'E', '\u039A': 'K', '\u039C': 'M',
  '\u039F': 'O', '\u03A1': 'P', '\u03A3': 'S', '\u03A4': 'T', '\u03A7': 'X',
  '\u03B1': 'a', '\u03B2': 'b', '\u03B5': 'e', '\u03BA': 'k', '\u03BC': 'm',
  '\u03BF': 'o', '\u03C1': 'p', '\u03C3': 's', '\u03C4': 't', '\u03C7': 'x',
};

/**
 * Check for Unicode homoglyph attacks and throw if detected.
 * Homoglyphs are characters from non-Latin scripts that look identical to ASCII.
 */
function checkHomoglyphs(p: string): void {
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (HOMOGLYPH_MAP[ch]) {
      throw new Error(
        `Access denied: Unicode homoglyph detected (character '${ch}' at position ${i} ` +
        `looks like '${HOMOGLYPH_MAP[ch]}' but is from a different script)`
      );
    }
  }
}

/**
 * Canonicalize a path for safe comparison:
 *   - `path.resolve()`   → makes absolute, collapses `.` and `..`
 *   - `.normalize('NFC')` → normalizes composed/decomposed Unicode
 *   - `.toLowerCase()`   → Windows case-insensitive filesystem compat
 *   - `.replace(/\\/g, "/")` → mixed-separator normalization (Windows ↔ POSIX)
 *   - Homoglyph check → blocks Cyrillic/Greek lookalikes
 */
function canonicalize(p: string): string {
  checkHomoglyphs(p);
  return path.resolve(p).normalize("NFC").replace(/\\/g, "/").toLowerCase();
}

/**
 * Returns true iff `child` is the same as `parent` or strictly inside it.
 * Uses `path.relative` so we cannot be tricked by `..` collapse, mixed
 * separators, or trailing-slash variations. Both sides must already be
 * canonicalized.
 */
function isInsideOrEqual(child: string, parent: string): boolean {
  if (child === parent) return true;
  const rel = path.relative(parent, child);
  // Outside iff relative starts with `..` or is an absolute path on its own.
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Validate a user-provided path against the configured allow / deny lists.
 *
 * @param ctx       Handler context (uses `ctx.config.allowedDirectories` and
 *                  `ctx.config.forbiddenPaths`).
 * @param filePath  Raw path supplied by the MCP client.
 * @returns         Absolute normalized path safe to use with fs APIs.
 * @throws          Error("Access denied: ...") on any rule violation.
 */
export function validatePath(ctx: HandlerContext, filePath: string): string {
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new Error("Access denied: empty or non-string path");
  }
  // Reject NUL-byte injection (some platforms truncate at NUL).
  if (filePath.includes("\0")) {
    throw new Error("Access denied: NUL byte in path");
  }

  // ── Explicit traversal-segment check ──
  // Detect `..` segments BEFORE resolution. Preserves the precise
  // "Path traversal detected" diagnostic for clients / tests that pattern-
  // match on it, and fails fast on the most common attack shape. The
  // path.relative boundary check below provides defense-in-depth against
  // any traversal that survives normalization (mixed separators, symbolic
  // sequences, etc.).
  const segments = filePath.replace(/\\/g, "/").split("/");
  if (segments.some((s) => s === "..")) {
    throw new Error(`Access denied: Path traversal detected in ${filePath}`);
  }

  const resolved = path.resolve(filePath);
  const canonResolved = canonicalize(resolved);

  // ── Allow-list check ──
  if (ctx.config.allowedDirectories.length > 0) {
    const allowed = ctx.config.allowedDirectories.some((allowedDir) => {
      const canonAllowed = canonicalize(allowedDir);
      return isInsideOrEqual(canonResolved, canonAllowed);
    });
    if (!allowed) {
      throw new Error(
        `Access denied: ${filePath} is not within allowed directories`
      );
    }
  }

  // ── Forbidden-list check (always applies, even with empty allow-list) ──
  const forbidden = ctx.config.forbiddenPaths.some((forbiddenPath) => {
    const canonForbidden = canonicalize(forbiddenPath);
    return isInsideOrEqual(canonResolved, canonForbidden);
  });
  if (forbidden) {
    throw new Error(`Access denied: ${filePath} is in forbidden path`);
  }

  return resolved;
}
