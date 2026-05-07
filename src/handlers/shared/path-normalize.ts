/**
 * Path normalization for cognitive-index lookups.
 *
 * M13.2: the cognitive index uses forward-slash absolute
 * paths internally (e.g. `c:/Users/TUF/...`) regardless of OS, but
 * Windows callers commonly pass `c:\\Users\\TUF\\...` to the handlers.
 * Strict `Array.includes` filters then mis-fire and return empty
 * results for valid file paths. Real-case repro during M13 jcf-memory
 * recon: `mcp1_get_module_contracts({filePaths: [windows-style-path]})`
 * returned `{modules: []}` even though the index had the file.
 *
 * `normalizeIndexPath` produces the canonical form used by the index
 * (forward slashes, lowercased Windows drive letter). `pathSetIncludes`
 * is a small helper that does the membership check correctly across
 * platforms without forcing every call site to call `normalizeIndexPath`
 * on both sides.
 */

/**
 * Convert a possibly-Windows path to the cognitive-index canonical form:
 *   - All backslashes → forward slashes
 *   - Drive letter lowercased (Windows is case-insensitive at the FS
 *     boundary; the index normalizes to lowercase to keep lookups O(1)).
 *   - No-op on POSIX paths.
 */
export function normalizeIndexPath(p: string): string {
  if (!p) return p;
  // Replace ALL backslashes with forward slashes — `split/join` is fine
  // here because the haystack is a path (no JS/TS substitution
  // semantics).
  let out = p.split("\\").join("/");
  // Windows-style path detection: any path that starts with a drive
  // letter (`X:`) is fully lowercased. Windows filesystems are
  // case-insensitive at the kernel boundary, so two strings that
  // differ only in path-component casing refer to the same file. The
  // cognitive index might capture mixed-case paths from ts-morph; the
  // dep graph might capture lowercased paths after fs.realpath. To
  // make membership symmetric across both sources we normalize the
  // ENTIRE path to lowercase when a drive letter is present. POSIX
  // paths are left unchanged because POSIX is case-sensitive at the
  // kernel boundary (modulo some macOS configurations).
  //
  // M13.2: expanded from "lowercase drive letter only"
  // to "lowercase entire path on Windows" after the path-normalize
  // unit tests surfaced that drive-letter-only canonicalization left
  // case-mismatch dependents invisible. Real-case repro from M13
  // jcf-memory recon: cognitive index stored `c:/Users/TUF/...` while
  // a Windows caller passed `C:\\users\\tuf\\...`. Strict membership
  // mis-fired even with the previous drive-letter-only normalization.
  if (out.length >= 2 && out[1] === ":") {
    out = out.toLowerCase();
  }
  return out;
}

/**
 * Membership test that tolerates platform-style differences. Returns
 * true when `candidate` matches any entry of `set` after normalization.
 * Linear scan — fine for the small filter arrays we use (typically
 * ≤ 100 entries; the cost is dwarfed by the surrounding I/O).
 */
export function pathSetIncludes(
  set: ReadonlyArray<string>,
  candidate: string
): boolean {
  if (!set || set.length === 0) return false;
  const normalizedCandidate = normalizeIndexPath(candidate);
  for (const entry of set) {
    if (normalizeIndexPath(entry) === normalizedCandidate) return true;
  }
  return false;
}
