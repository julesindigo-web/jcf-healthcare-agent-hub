import { Logger } from './logger.js';
import { Database } from './database.js';
import { ImportResolver } from './import-resolver.js';
import type { FileMetadata } from '../types/index.js';
import path from 'path';

export class DependencyGraphManager {
  private graph: {
    nodes: Map<string, Set<string>>;
    reverse: Map<string, Set<string>>;
  };
  private logger: Logger;
  private db: Database;
  // Phase E3: proper import resolver with tsconfig + node_modules
  private resolver: ImportResolver;

  constructor(config: { db: Database; logger: Logger; projectRoot?: string }) {
    this.db = config.db;
    this.logger = config.logger;
    this.graph = {
      nodes: new Map(),
      reverse: new Map(),
    };
    const resolverConfig: { logger: Logger; projectRoot?: string } = { logger: config.logger };
    if (config.projectRoot !== undefined) resolverConfig.projectRoot = config.projectRoot;
    this.resolver = new ImportResolver(resolverConfig);
  }

  async initialize(): Promise<void> {
    this.logger.info("Initializing dependency graph");
    // Load existing dependencies from database metadata
    const allFiles = this.db.getAllFiles();
    for (const filePath of allFiles) {
      const metadata = this.db.getFileMetadata(filePath);
      if (metadata?.imports) {
        await this.registerFile(filePath, metadata);
      }
    }
    this.logger.info("Dependency graph loaded", { fileCount: allFiles.length });
  }

  async registerFile(filePath: string, metadata: FileMetadata): Promise<void> {
    // Clean up old reverse graph entries for this file's previous dependencies
    const oldDeps = this.graph.nodes.get(filePath);
    if (oldDeps) {
      for (const dep of oldDeps) {
        const dependents = this.graph.reverse.get(dep);
        if (dependents) {
          dependents.delete(filePath);
        }
      }
    }

    // Clear existing forward entries
    if (this.graph.nodes.has(filePath)) {
      this.graph.nodes.get(filePath)?.clear();
    }

    // Add dependencies from imports
    const deps = metadata.imports || [];
    const fileDeps = new Set<string>();

    for (const importPath of deps) {
      // Resolve relative imports
      const resolved = this.resolveImport(importPath, filePath);
      if (resolved) {
        fileDeps.add(resolved);
        // Add to forward graph
        this.graph.nodes.set(filePath, fileDeps);
        // Add to reverse graph (who depends on this)
        if (!this.graph.reverse.has(resolved)) {
          this.graph.reverse.set(resolved, new Set());
        }
        this.graph.reverse.get(resolved)!.add(filePath);
      }
    }

    this.logger.debug("Registered file dependencies", {
      file: filePath,
      dependencies: fileDeps.size,
    });
  }

  async updateFile(filePath: string, content: string): Promise<void> {
    // Re-analyze content to extract imports
    const metadata = await this.analyzeContent(content, filePath);
    await this.registerFile(filePath, metadata);
  }

  async removeFile(filePath: string): Promise<void> {
    // Remove from forward graph
    const dependencies = this.graph.nodes.get(filePath);
    if (dependencies) {
      for (const dep of dependencies) {
        const dependents = this.graph.reverse.get(dep);
        if (dependents) {
          dependents.delete(filePath);
        }
      }
    }

    // Remove from reverse graph
    const dependents = this.graph.reverse.get(filePath);
    if (dependents) {
      for (const dep of dependents) {
        const deps = this.graph.nodes.get(dep);
        if (deps) {
          deps.delete(filePath);
        }
      }
    }

    this.graph.nodes.delete(filePath);
    this.graph.reverse.delete(filePath);
  }

  getDependencies(filePath: string): string[] {
    const deps = this.graph.nodes.get(filePath);
    return deps ? Array.from(deps) : [];
  }

  getDependents(filePath: string): string[] {
    const deps = this.graph.reverse.get(filePath);
    return deps ? Array.from(deps) : [];
  }

  getTransitiveDependencies(filePath: string): Set<string> {
    const visited = new Set<string>();
    const result = new Set<string>();

    const traverse = (current: string) => {
      if (visited.has(current)) return;
      visited.add(current);

      const deps = this.graph.nodes.get(current);
      if (deps) {
        for (const dep of deps) {
          result.add(dep);
          traverse(dep);
        }
      }
    };

    traverse(filePath);
    return result;
  }

  getTransitiveDependents(filePath: string): Set<string> {
    const visited = new Set<string>();
    const result = new Set<string>();

    const traverse = (current: string) => {
      if (visited.has(current)) return;
      visited.add(current);

      const deps = this.graph.reverse.get(current);
      if (deps) {
        for (const dep of deps) {
          result.add(dep);
          traverse(dep);
        }
      }
    };

    traverse(filePath);
    return result;
  }

  detectCycles(): Array<{ cycle: string[]; length: number }> {
    const cycles: Array<{ cycle: string[]; length: number }> = [];
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const path: string[] = [];

    const dfs = (node: string): void => {
      if (recursionStack.has(node)) {
        // Found a cycle
        const cycleStart = path.indexOf(node);
        const cycle = [...path.slice(cycleStart), node];
        cycles.push({ cycle, length: cycle.length });
        return;
      }

      if (visited.has(node)) return;

      visited.add(node);
      recursionStack.add(node);
      path.push(node);

      const neighbors = this.graph.nodes.get(node);
      if (neighbors) {
        for (const neighbor of neighbors) {
          dfs(neighbor);
        }
      }

      recursionStack.delete(node);
      path.pop();
    };

    for (const node of this.graph.nodes.keys()) {
      if (!visited.has(node)) {
        dfs(node);
      }
    }

    return cycles;
  }

  calculateCoherenceScore(filePath: string): number {
    const deps = this.getDependencies(filePath);
    const dependents = this.getDependents(filePath);

    if (deps.length === 0 && dependents.length === 0) {
      return 1.0; // Isolated file = perfect coherence
    }

    // Coherence = 1 - (coupling / total files)
    // Lower coupling = higher coherence
    const totalConnections = deps.length + dependents.length;
    const totalFiles = this.graph.nodes.size;

    if (totalFiles <= 1) return 1.0;

    const coupling = totalConnections / (totalFiles - 1);
    return Math.max(0, 1 - coupling);
  }

  analyzeChangeImpact(filePath: string): {
    score: number;
    affectedFiles: string[];
    risk: 'low' | 'medium' | 'high' | 'critical';
  } {
    const transitiveDeps = this.getTransitiveDependencies(filePath);
    const transitiveDependents = this.getTransitiveDependents(filePath);
    const allAffected = new Set([...transitiveDeps, ...transitiveDependents]);

    const totalFiles = this.graph.nodes.size;
    const impactRatio = allAffected.size / Math.max(1, totalFiles - 1);

    let risk: 'low' | 'medium' | 'high' | 'critical';
    if (impactRatio < 0.1) risk = 'low';
    else if (impactRatio < 0.3) risk = 'medium';
    else if (impactRatio < 0.6) risk = 'high';
    else risk = 'critical';

    return {
      score: 1 - impactRatio,
      affectedFiles: Array.from(allAffected),
      risk,
    };
  }

  getStats(): {
    nodeCount: number;
    edgeCount: number;
    avgDegree: number;
    cycleCount: number;
  } {
    let edgeCount = 0;
    for (const deps of this.graph.nodes.values()) {
      edgeCount += deps.size;
    }

    const nodeCount = this.graph.nodes.size;
    const avgDegree = nodeCount > 0 ? edgeCount / nodeCount : 0;
    const cycleCount = this.detectCycles().length;

    return {
      nodeCount,
      edgeCount,
      avgDegree,
      cycleCount,
    };
  }

  export(): { nodes: Record<string, string[]>; reverse: Record<string, string[]> } {
    const nodes: Record<string, string[]> = {};
    const reverse: Record<string, string[]> = {};

    for (const [file, deps] of this.graph.nodes) {
      nodes[file] = Array.from(deps);
    }
    for (const [file, deps] of this.graph.reverse) {
      reverse[file] = Array.from(deps);
    }

    return { nodes, reverse };
  }

  import(data: { nodes: Record<string, string[]>; reverse: Record<string, string[]> }): void {
    this.graph.nodes.clear();
    this.graph.reverse.clear();

    for (const [file, deps] of Object.entries(data.nodes)) {
      this.graph.nodes.set(file, new Set(deps));
    }
    for (const [file, deps] of Object.entries(data.reverse)) {
      this.graph.reverse.set(file, new Set(deps));
    }
  }

  // Wrapper methods for server compatibility
  getCoherenceScore(filePath: string): number {
    return this.calculateCoherenceScore(filePath);
  }

  assessChangeRisk(filePath: string): { score: number; affectedFiles: string[]; risk: 'low' | 'medium' | 'high' | 'critical' } {
    return this.analyzeChangeImpact(filePath);
  }

  detectCircularDependencies(): Array<{ cycle: string[]; length: number }> {
    return this.detectCycles();
  }

  // Helper method to analyze content and extract metadata
  private async analyzeContent(content: string, filePath: string): Promise<FileMetadata> {
    const extension = path.extname(filePath).toLowerCase();
    let imports: string[] = [];

    switch (extension) {
      case '.js':
      case '.ts':
      case '.jsx':
      case '.tsx':
        imports = this.extractJavaScriptImports(content);
        break;
      case '.py':
        imports = this.extractPythonImports(content);
        break;
      case '.java':
        imports = this.extractJavaImports(content);
        break;
    }

    return {
      path: filePath,
      size: content.length,
      modified: new Date(),
      created: new Date(),
      mode: '100644',
      imports,
    };
  }

  private extractJavaScriptImports(content: string): string[] {
    const imports: string[] = [];
    const regex = /import\s+(?:{[^}]+}|\*\s+as\s+\w+|\w+)\s+from\s+['"]([^'"]+)['"]/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
      imports.push(match[1]);
    }
    return imports;
  }

  private extractPythonImports(content: string): string[] {
    const imports: string[] = [];
    const regex = /(?:from\s+([.\w]+)\s+import|import\s+([.\w]+))/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
      imports.push(match[1] || match[2]);
    }
    return imports;
  }

  private extractJavaImports(content: string): string[] {
    const imports: string[] = [];
    const regex = /import\s+([^;]+);/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
      imports.push(match[1].trim());
    }
    return imports;
  }

  /**
   * Phase E3: Resolve import via enhanced-resolve.
   * Handles: relative paths, node_modules, tsconfig path aliases, workspace
   * protocols, package.json `exports` conditions. Falls back to best-effort
   * `path.resolve` for relative imports whose target file doesn't exist yet
   * (e.g. file being generated by a later pipeline step).
   *
   * Returns null for:
   *  - Node built-ins (fs, path, crypto, node:...) — not tracked in project graph
   *  - External modules whose source isn't reachable from this workspace
   */
  private resolveImport(importPath: string, fromFile: string): string | null {
    // Unused param kept for legacy symmetry; path helper retained for type check
    void path;
    const result = this.resolver.resolve(importPath, fromFile);
    if (result.resolved) return result.resolved;
    // Log unresolved imports at debug level (noise at info/warn)
    this.logger.debug('Import unresolved', { importPath, fromFile, reason: result.reason, kind: result.kind });
    return null;
  }

  /** Phase E3: Expose resolver snapshot for health-check reporting */
  getResolverInfo(): { tsConfigPath: string | null; pathAliases: number; baseUrl: string | null } {
    const snap = this.resolver.getConfigSnapshot();
    return {
      tsConfigPath: snap.tsConfigPath,
      pathAliases: Object.keys(snap.pathAliases).length,
      baseUrl: snap.baseUrl,
    };
  }
}

export { DependencyGraphManager as DependencyGraph };
