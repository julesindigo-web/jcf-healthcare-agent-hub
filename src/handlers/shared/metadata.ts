/**
 * File-metadata helper. Extracted from `JcfHealthcareAgentHubServer.fs_getMetadata`
 * during M11 audit.
 *
 * Stats the file, reads its content (utf-8), runs language analysis, and
 * returns a fully-populated `FileMetadata`. No service deps — pure I/O over
 * the filesystem + content-analysis helpers.
 */

import fs from "fs/promises";
import type { FileMetadata } from "../../types/index.js";
import {
  analyzeFileContent,
  detectLanguage,
} from "./content-analysis.js";

/**
 * Build a `FileMetadata` from a path on disk. Reads the file twice (once
 * for the analysis content, the stat is separate) — same as the original
 * implementation.
 *
 * Throws on read failure — callers wrap in try/catch when the file may
 * not exist (e.g. `handleDeleteFile`).
 */
export async function fsGetMetadata(filePath: string): Promise<FileMetadata> {
  const stats = await fs.stat(filePath);
  const content = await fs.readFile(filePath, "utf-8");
  const analysis = analyzeFileContent(content, filePath);
  return {
    path: filePath,
    size: stats.size,
    modified: stats.mtime,
    created: stats.birthtime,
    mode: stats.mode.toString(8),
    language: detectLanguage(filePath, content),
    symbols: analysis.symbols,
    imports: analysis.imports,
    exports: analysis.exports,
    complexity: analysis.complexity,
  };
}
