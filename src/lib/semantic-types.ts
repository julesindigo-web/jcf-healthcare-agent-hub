/**
 * Shared Semantic Search Types — JCF Healthcare Agent Hub
 * 
 * Standardized interfaces to align with jcf-memory's FTS5 BM25 implementation.
 * Part of Task 15: Standardize semantic search interfaces.
 */

export interface SemanticSearchResult {
  path: string;
  score: number;
  snippet: string;
  highlights?: string[];
}

export interface SemanticSearchOptions {
  query: string;
  limit?: number;          // Default: 10
  threshold?: number;      // Default: 0.1
  rootPath?: string;       // Scope to directory
  autoIndex?: boolean;      // Auto-index if DB empty (default: true)
}

export interface SemanticIndexOptions {
  rootPath: string;
  maxFiles?: number;       // Default: 500
  maxFileBytes?: number;    // Default: 2MB
  onProgress?: (current: number, total: number, message?: string) => void;
}

export interface SemanticSearchResponse {
  results: SemanticSearchResult[];
  autoIndexed?: boolean;
  indexedDocuments?: number;
  note?: string;
}

// Default values
export const DEFAULT_SEMANTIC_LIMIT = 10;
export const DEFAULT_SEMANTIC_THRESHOLD = 0.1;
export const DEFAULT_AUTO_INDEX = true;
export const DEFAULT_MAX_FILES = 500;
export const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024; // 2MB
