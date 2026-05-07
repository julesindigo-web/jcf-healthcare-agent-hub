/**
 * Pure utility helpers. Extracted from `JcfHealthcareAgentHubServer` during M11
 * audit.
 *
 * No service deps. No I/O. Stateless. Behavior preserved verbatim.
 */

import crypto from "crypto";

/**
 * SHA-256 hash of UTF-8 content. Used for version IDs and content-equality
 * checks (write skips version snapshot if hash matches existing).
 */
export function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content, "utf-8").digest("hex");
}

/**
 * Convert a glob-style pattern (with `*` and `?` wildcards) to a
 * case-insensitive anchored RegExp. Used by `search_files`.
 *
 * - `*` matches any sequence of chars (including empty)
 * - `?` matches exactly one char
 * - All other regex metacharacters are escaped
 *
 * M12.1: `?` was previously included in the metacharacter-
 * escape set, getting rewritten to `\?` and then mangled to `\.` (literal
 * dot) by the subsequent glob-expansion step. Removed from the escape
 * class so the `.replace(/\?/g, ".")` step now lands on the unescaped
 * character and produces the documented single-char wildcard. `*` was
 * already excluded from the escape set for the same reason.
 */
export function patternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regexPattern =
    "^" + escaped.replace(/\*/g, ".*").replace(/\?/g, ".") + "$";
  return new RegExp(regexPattern, "i");
}

/**
 * Human-readable summary of a coherence score. The `_risk` parameter is
 * preserved from the original method for API stability — risk is currently
 * communicated separately in the `CoherenceCheck` envelope, but a future
 * revision may incorporate it into the message text.
 */
export function getCoherenceMessage(
  score: number,
  _risk: "low" | "medium" | "high" | "critical"
): string {
  if (score > 0.8) return "File has high coherence (well-isolated)";
  if (score > 0.5) return "File has moderate coupling";
  return "File is highly coupled - consider refactoring";
}
