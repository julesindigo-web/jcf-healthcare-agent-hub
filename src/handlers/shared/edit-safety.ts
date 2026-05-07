/**
 * Edit-safety helpers — pre-flight risk scan + post-edit integrity validation.
 *
 * M13.2: added in response to a real-case failure during the
 * jcf-memory remediation pass. An MCP edit_file call wrote a file where
 * `newText` contained backticks inside a SQL comment that lived inside a
 * JS/TS template literal. The split/join applied the substitution
 * faithfully, but the resulting source no longer parsed: the embedded
 * backtick had closed the outer template literal early, producing 13
 * cascading TS1005 errors. The file was committed to disk (with full
 * version history) before any caller noticed. The handler returned
 * `{success: true, applied: 1}` in good faith.
 *
 * This module hardens the edit pipeline at two boundaries:
 *
 *   1. PRE-FLIGHT (`assessEditRisk`)
 *      Scan every (oldText, newText) pair and look for patterns that are
 *      empirically dangerous for the target file's language. Currently
 *      detects:
 *        - Backticks inside `newText` when the target is JS/TS and the
 *          existing file uses template literals.
 *        - Unbalanced delimiter counts inside `newText` (backticks /
 *          braces / brackets / parens) — a strong leading indicator that
 *          a delimiter pair will fall out of balance after substitution.
 *      The output is a structured risk report: callers may continue
 *      anyway (the agent often knows more than the heuristic) but the
 *      report is included in the response envelope so a downstream
 *      reviewer can inspect the decision.
 *
 *   2. POST-EDIT (`verifyPostEditIntegrity`)
 *      After applying edits in-memory but BEFORE writing to disk, run a
 *      lightweight integrity check against the candidate content:
 *        - JSON files: JSON.parse must succeed.
 *        - JS/TS files: delimiter counts (backticks / braces / brackets /
 *          parens) must be globally balanced AND the delta vs the prior
 *          content must be net-zero (an edit should not introduce a new
 *          imbalance unless the prior content was also imbalanced — which
 *          is occasionally legitimate, e.g. partial-file edits in larger
 *          unbalanced contexts).
 *        - Markdown / text / unknown extensions: skip.
 *      A failure aborts the write, leaves the original file untouched on
 *      disk, and surfaces a structured `IntegrityViolation` to the caller.
 *
 * Design rationale:
 *   - We do NOT spin up the full TypeScript compiler for post-edit checks.
 *     That would add ~100ms per edit and pull `ts-morph` into the hot
 *     path. The delimiter-balance heuristic catches the failure mode that
 *     bit us in M13 without that overhead.
 *   - We do NOT auto-escape backticks in `newText`. Auto-escaping would
 *     paper over agent mistakes and produce surprising results when the
 *     agent legitimately wants to insert a backtick (e.g. inserting a
 *     code-block fence into Markdown, or inserting a real template
 *     literal into a `.ts` file). The risk report is the safer interface.
 *   - Both helpers are pure: no I/O, no logging side effects.
 */

export type EditRiskLevel = "low" | "medium" | "high";

export interface EditRiskReport {
  level: EditRiskLevel;
  /** Human-readable findings. Empty when level === 'low'. */
  warnings: string[];
}

export interface IntegrityViolation {
  /** Stable code suitable for switch/case in callers. */
  code:
    | "JSON_PARSE_FAILED"
    | "BACKTICK_IMBALANCE"
    | "BRACE_IMBALANCE"
    | "BRACKET_IMBALANCE"
    | "PAREN_IMBALANCE";
  /** Human-readable detail. */
  message: string;
  /** Counts captured for the candidate content. */
  candidateCount: number;
  /** Counts captured for the original (pre-edit) content for comparison. */
  priorCount: number;
}

const JS_LIKE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

const JSON_EXTENSIONS = new Set([".json"]);

function getExtension(filePath: string): string {
  const idx = filePath.lastIndexOf(".");
  return idx === -1 ? "" : filePath.slice(idx).toLowerCase();
}

function looksJsLike(filePath: string): boolean {
  return JS_LIKE_EXTENSIONS.has(getExtension(filePath));
}

function looksJson(filePath: string): boolean {
  return JSON_EXTENSIONS.has(getExtension(filePath));
}

/**
 * Count occurrences of `needle` in `haystack`. Stripping nothing — this
 * is a raw character count, NOT a tokenizer-aware count. Good enough for
 * the imbalance heuristic which only cares about deltas.
 */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

/**
 * Pre-flight risk assessment. Receives the prior file content (so we can
 * tell whether template literals are even in play) and every edit pair.
 * Returns a single rolled-up report so the handler can stash it on the
 * result envelope without having to iterate.
 */
export function assessEditRisk(
  filePath: string,
  priorContent: string,
  edits: ReadonlyArray<{ oldText: string; newText: string }>
): EditRiskReport {
  const warnings: string[] = [];
  const isJsLike = looksJsLike(filePath);

  if (isJsLike) {
    const priorBackticks = countOccurrences(priorContent, "`");
    const priorHasTemplateLiterals = priorBackticks > 0;

    for (let i = 0; i < edits.length; i++) {
      const edit = edits[i]!;
      const newBackticks = countOccurrences(edit.newText, "`");
      if (newBackticks === 0) continue;

      // The dangerous case: file uses template literals AND newText
      // injects raw backticks. The substitution may close the enclosing
      // template literal early.
      if (priorHasTemplateLiterals) {
        warnings.push(
          `edit[${i}]: newText contains ${newBackticks} backtick(s); target is a JS/TS file with ${priorBackticks} pre-existing backtick(s). Risk: backtick may close an enclosing template literal. If the substitution is intentional, set unsafe=true.`
        );
      }
    }
  }

  // Generic delimiter-imbalance heuristic across all source edits.
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i]!;
    const oldOpens = countOccurrences(edit.oldText, "{");
    const oldCloses = countOccurrences(edit.oldText, "}");
    const newOpens = countOccurrences(edit.newText, "{");
    const newCloses = countOccurrences(edit.newText, "}");

    const oldBraceDelta = oldOpens - oldCloses;
    const newBraceDelta = newOpens - newCloses;

    if (oldBraceDelta !== newBraceDelta) {
      warnings.push(
        `edit[${i}]: brace delta drift (oldText balanced=${oldBraceDelta}, newText balanced=${newBraceDelta}). The substitution shifts net brace count, which can break syntax for JS/TS/JSON files.`
      );
    }
  }

  let level: EditRiskLevel = "low";
  if (warnings.length > 0) level = "medium";
  if (warnings.length >= 3) level = "high";

  return { level, warnings };
}

/**
 * Post-edit integrity check. Compares delimiter counts in the candidate
 * content against the prior content; for `.json` targets, additionally
 * runs `JSON.parse`. Returns `null` when the candidate is acceptable, or
 * a structured violation otherwise.
 *
 * The function is intentionally permissive about pre-existing imbalance
 * — many legitimate files (Markdown with raw code samples, partial
 * fixtures used in tests) carry persistent delimiter mismatches. We
 * only flag a violation when the EDIT itself shifts the count, which is
 * what indicates the substitution corrupted the structure.
 */
export function verifyPostEditIntegrity(
  filePath: string,
  priorContent: string,
  candidateContent: string
): IntegrityViolation | null {
  if (looksJson(filePath)) {
    try {
      JSON.parse(candidateContent);
    } catch (err) {
      return {
        code: "JSON_PARSE_FAILED",
        message: `Post-edit JSON.parse failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        candidateCount: 0,
        priorCount: 0,
      };
    }
    return null;
  }

  if (!looksJsLike(filePath)) {
    // Markdown, plain text, .py, .go, etc. — out of scope for this
    // heuristic. The pre-flight risk report already warned the caller
    // when applicable.
    return null;
  }

  // JS/TS family: check 4 delimiter classes for *delta drift*.
  const checks: Array<[IntegrityViolation["code"], string]> = [
    ["BACKTICK_IMBALANCE", "`"],
    ["BRACE_IMBALANCE", "{"],
    ["BRACKET_IMBALANCE", "["],
    ["PAREN_IMBALANCE", "("],
  ];
  const closers: Record<string, string> = {
    "{": "}",
    "[": "]",
    "(": ")",
    "`": "`", // backticks are self-closing; counts must be even
  };

  for (const [code, opener] of checks) {
    const closer = closers[opener]!;
    const priorOpen = countOccurrences(priorContent, opener);
    const priorClose =
      opener === closer ? 0 : countOccurrences(priorContent, closer);
    const candOpen = countOccurrences(candidateContent, opener);
    const candClose =
      opener === closer ? 0 : countOccurrences(candidateContent, closer);

    if (opener === closer) {
      // Backticks: count must be even AND parity must match the prior.
      const priorEven = priorOpen % 2 === 0;
      const candEven = candOpen % 2 === 0;
      if (priorEven && !candEven) {
        return {
          code,
          message: `Edit corrupted backtick parity: prior had ${priorOpen} (even, balanced), candidate has ${candOpen} (odd, unbalanced).`,
          candidateCount: candOpen,
          priorCount: priorOpen,
        };
      }
      continue;
    }

    const priorDelta = priorOpen - priorClose;
    const candDelta = candOpen - candClose;
    if (priorDelta !== candDelta) {
      return {
        code,
        message: `Edit shifted ${opener}/${closer} balance: prior delta=${priorDelta} (open-close), candidate delta=${candDelta}.`,
        candidateCount: candOpen - candClose,
        priorCount: priorOpen - priorClose,
      };
    }
  }

  return null;
}

/**
 * Compute a small, structured diff summary for inclusion in edit
 * responses. Not a full unified diff — that would explode response
 * sizes for large files. We emit per-edit metrics: lines added,
 * lines removed, byte delta, line numbers of the first changed
 * line in the *prior* content.
 *
 * Useful for downstream agent self-verification ("did my edit do
 * roughly what I intended?") without requiring a follow-up read_file
 * call. M13.2 god-mode enhancement.
 */
export interface EditDiffSummary {
  totalEdits: number;
  totalApplied: number;
  byteDelta: number;
  firstChangedLine: number | null;
  lastChangedLine: number | null;
  linesAdded: number;
  linesRemoved: number;
}

export function summarizeEditDiff(
  priorContent: string,
  candidateContent: string,
  totalEdits: number,
  totalApplied: number
): EditDiffSummary {
  const priorLines = priorContent.split("\n");
  const candidateLines = candidateContent.split("\n");

  // Find first and last differing line indices (1-based for human
  // consumption). Linear scan from the front and back. For very large
  // files this is O(n+m) once each — fine for edits up to a few MB.
  let firstChangedLine: number | null = null;
  for (
    let i = 0;
    i < Math.min(priorLines.length, candidateLines.length);
    i++
  ) {
    if (priorLines[i] !== candidateLines[i]) {
      firstChangedLine = i + 1;
      break;
    }
  }
  if (firstChangedLine === null && priorLines.length !== candidateLines.length) {
    firstChangedLine = Math.min(priorLines.length, candidateLines.length) + 1;
  }

  let lastChangedLine: number | null = null;
  if (firstChangedLine !== null) {
    let pi = priorLines.length - 1;
    let ci = candidateLines.length - 1;
    while (pi >= 0 && ci >= 0 && priorLines[pi] === candidateLines[ci]) {
      pi--;
      ci--;
    }
    lastChangedLine = ci + 1;
    // Map to candidate-line numbering, clamp to >= firstChangedLine.
    if (lastChangedLine < firstChangedLine) lastChangedLine = firstChangedLine;
  }

  return {
    totalEdits,
    totalApplied,
    byteDelta:
      Buffer.byteLength(candidateContent, "utf-8") -
      Buffer.byteLength(priorContent, "utf-8"),
    firstChangedLine,
    lastChangedLine,
    linesAdded: Math.max(0, candidateLines.length - priorLines.length),
    linesRemoved: Math.max(0, priorLines.length - candidateLines.length),
  };
}
