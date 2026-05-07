/**
 * Pure content-analysis helpers. Extracted from `JcfHealthcareAgentHubServer`
 * during M11 audit.
 *
 * Every function here is stateless — no service deps, no I/O. Inputs in,
 * outputs out. Easy to test in isolation with no fixtures.
 *
 * Behavior preserved byte-for-byte from the original methods:
 *   - analyzeFileContent  (extension-based dispatcher)
 *   - analyzeJavaScript   (regex-based imports/exports/complexity)
 *   - analyzePython       (regex-based imports/complexity)
 *   - analyzeJava         (regex-based imports/complexity)
 *   - detectLanguage      (extension → language map)
 */

import path from "path";

/**
 * Result shape returned by every per-language analyzer. Fields are optional
 * because some languages don't surface every dimension (e.g. Python doesn't
 * expose explicit exports here).
 */
export interface ContentAnalysis {
  symbols?: unknown[];
  imports?: string[];
  exports?: string[];
  complexity?: number;
}

/**
 * Dispatch to the appropriate per-language analyzer based on file extension.
 * Unknown extensions return an empty analysis ({}).
 */
export function analyzeFileContent(
  content: string,
  filePath: string
): ContentAnalysis {
  const extension = path.extname(filePath).toLowerCase();

  switch (extension) {
    case ".js":
    case ".ts":
    case ".jsx":
    case ".tsx":
      return analyzeJavaScript(content);
    case ".py":
      return analyzePython(content);
    case ".java":
      return analyzeJava(content);
    default:
      return {};
  }
}

/**
 * Regex-based JS / TS / JSX / TSX analysis.
 * Approximate (not AST-backed) — same as the original method.
 */
export function analyzeJavaScript(content: string): ContentAnalysis {
  const imports: string[] = [];
  const exportsList: string[] = [];
  const lines = content.split("\n");
  let complexity = 1;

  const importRegex =
    /import\s+(?:{[^}]+}|\*\s+as\s+\w+|\w+)\s+from\s+['"]([^'"]+)['"]/g;
  let match;
  while ((match = importRegex.exec(content)) !== null) {
    imports.push(match[1]);
  }

  const exportRegex =
    /export\s+(?:default\s+)?(?:class|function|const|let|var)\s+(\w+)/g;
  while ((match = exportRegex.exec(content)) !== null) {
    exportsList.push(match[1]);
  }

  for (const line of lines) {
    if (/\b(if|else|for|while|switch|case|catch)\b/.test(line)) {
      complexity++;
    }
  }

  return { imports, exports: exportsList, complexity };
}

/**
 * Regex-based Python analysis. Imports + cyclomatic complexity only.
 */
export function analyzePython(content: string): ContentAnalysis {
  const imports: string[] = [];
  const lines = content.split("\n");
  let complexity = 1;

  const importRegex = /(?:from\s+([.\w]+)\s+import|import\s+([.\w]+))/g;
  let match;
  while ((match = importRegex.exec(content)) !== null) {
    imports.push(match[1] || match[2]);
  }

  for (const line of lines) {
    if (/\b(if|elif|else|for|while|with|try|except|finally)\b/.test(line)) {
      complexity++;
    }
  }

  return { imports, complexity };
}

/**
 * Regex-based Java analysis. Imports + cyclomatic complexity only.
 */
export function analyzeJava(content: string): ContentAnalysis {
  const imports: string[] = [];
  const lines = content.split("\n");
  let complexity = 1;

  const importRegex = /import\s+([^;]+);/g;
  let match;
  while ((match = importRegex.exec(content)) !== null) {
    imports.push(match[1].trim());
  }

  for (const line of lines) {
    if (/\b(if|else|for|while|switch|case|catch|try|finally)\b/.test(line)) {
      complexity++;
    }
  }

  return { imports, complexity };
}

/**
 * Map a file path's extension to a language identifier. Returns `"unknown"`
 * for unmapped extensions. The unused `_content` param is preserved from the
 * original signature for API compatibility (some languages may eventually
 * need content sniffing).
 */
export function detectLanguage(
  filePath: string,
  _content: string = ""
): string {
  const extension = path.extname(filePath).toLowerCase();
  const langMap: Record<string, string> = {
    ".js": "javascript",
    ".ts": "typescript",
    ".jsx": "jsx",
    ".tsx": "tsx",
    ".py": "python",
    ".java": "java",
    ".c": "c",
    ".cpp": "cpp",
    ".h": "c",
    ".hpp": "cpp",
    ".rs": "rust",
    ".go": "go",
    ".rb": "ruby",
    ".php": "php",
    ".swift": "swift",
    ".kt": "kotlin",
    ".scala": "scala",
    ".cs": "csharp",
    ".fs": "fsharp",
    ".vb": "visualbasic",
    ".xml": "xml",
    ".html": "html",
    ".css": "css",
    ".scss": "scss",
    ".sass": "sass",
    ".less": "less",
    ".json": "json",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".toml": "toml",
    ".md": "markdown",
    ".sh": "bash",
    ".bash": "bash",
    ".zsh": "zsh",
    ".fish": "fish",
    ".ps1": "powershell",
    ".bat": "batch",
    ".cmd": "batch",
    ".sql": "sql",
    ".graphql": "graphql",
    ".gql": "graphql",
  };

  return langMap[extension] || "unknown";
}
