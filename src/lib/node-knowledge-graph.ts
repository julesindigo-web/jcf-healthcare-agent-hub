import { Logger } from './logger.js';
import type {
  GraphNode, GraphEdge, EdgeKind, SubgraphExtraction,
  UnitFingerprint, ModuleContract,
} from '../types/index.js';

export class NodeLevelKnowledgeGraph {
  private nodes: Map<string, GraphNode> = new Map();
  private edges: GraphEdge[] = [];
  private forwardIndex: Map<string, GraphEdge[]> = new Map();
  private reverseIndex: Map<string, GraphEdge[]> = new Map();
  private logger: Logger;

  constructor(config: { logger: Logger }) {
    this.logger = config.logger;
  }

  async initialize(): Promise<void> {
    this.logger.info('Initializing Node-Level Knowledge Graph');
  }

  addNode(node: GraphNode): void {
    this.nodes.set(node.id, node);
    if (!this.forwardIndex.has(node.id)) this.forwardIndex.set(node.id, []);
    if (!this.reverseIndex.has(node.id)) this.reverseIndex.set(node.id, []);
  }

  removeNode(nodeId: string): void {
    this.nodes.delete(nodeId);
    this.edges = this.edges.filter(e => e.from !== nodeId && e.to !== nodeId);
    this.rebuildIndexes();
  }

  getNode(nodeId: string): GraphNode | undefined { return this.nodes.get(nodeId); }
  getAllNodes(): GraphNode[] { return [...this.nodes.values()]; }

  addEdge(edge: GraphEdge): void {
    const exists = this.edges.some(e => e.from === edge.from && e.to === edge.to && e.kind === edge.kind);
    if (exists) return;
    this.edges.push(edge);
    const fwd = this.forwardIndex.get(edge.from) || [];
    fwd.push(edge);
    this.forwardIndex.set(edge.from, fwd);
    const rev = this.reverseIndex.get(edge.to) || [];
    rev.push(edge);
    this.reverseIndex.set(edge.to, rev);
  }

  removeEdge(from: string, to: string, kind: EdgeKind): void {
    this.edges = this.edges.filter(e => !(e.from === from && e.to === to && e.kind === kind));
    this.rebuildIndexes();
  }

  getOutgoingEdges(nodeId: string): GraphEdge[] { return this.forwardIndex.get(nodeId) || []; }
  getIncomingEdges(nodeId: string): GraphEdge[] { return this.reverseIndex.get(nodeId) || []; }

  buildFromCognitiveIndex(modules: ModuleContract[], units: UnitFingerprint[]): void {
    this.logger.info('Building NLKG from cognitive index', { modules: modules.length, units: units.length });
    this.clear();

    for (const mod of modules) {
      this.addNode({
        id: `module:${mod.filePath}`,
        filePath: mod.filePath,
        name: mod.moduleName,
        kind: 'module',
        signature: `module ${mod.moduleName}`,
        metadata: { exportCount: mod.exports.length, importCount: mod.imports.length, patterns: mod.patternClassification },
      });
    }

    for (const unit of units) {
      this.addNode({
        id: unit.id,
        filePath: unit.filePath,
        name: unit.name,
        kind: unit.kind,
        signature: unit.signature,
        metadata: { isPure: unit.isPure, isAsync: unit.isAsync, complexity: unit.complexity, patternType: unit.patternType, semanticTags: unit.semanticTags },
      });

      this.addEdge({
        from: `module:${unit.filePath}`,
        to: unit.id,
        kind: 'contains',
        weight: 1,
        metadata: {},
      });
    }

    for (const unit of units) {
      for (const target of unit.callTargets) {
        const targetNodeId = this.resolveCallTarget(target, units);
        if (targetNodeId) {
          this.addEdge({ from: unit.id, to: targetNodeId, kind: 'calls', weight: 1, metadata: { rawTarget: target } });
        }
      }

      for (const typeDep of unit.typeDependencies) {
        const typeNodeId = this.resolveTypeRef(typeDep, units);
        if (typeNodeId) {
          this.addEdge({ from: unit.id, to: typeNodeId, kind: 'uses-type', weight: 0.8, metadata: { typeName: typeDep } });
        }
      }
    }

    for (const mod of modules) {
      for (const imp of mod.imports) {
        const sourceModuleId = this.resolveImportToModule(imp.from, modules);
        if (sourceModuleId) {
          this.addEdge({ from: `module:${mod.filePath}`, to: sourceModuleId, kind: 'references', weight: 0.5, metadata: { importName: imp.name, isType: imp.isType } });
        }
      }

      for (const tc of mod.definedTypes) {
        for (const ext of tc.extendsTypes) {
          const extNodeId = this.resolveTypeRef(ext, units);
          if (extNodeId) {
            const typeNodeId = `${mod.filePath}::${tc.name}`;
            if (this.nodes.has(typeNodeId)) {
              this.addEdge({ from: typeNodeId, to: extNodeId, kind: tc.kind === 'interface' ? 'extends' : 'implements', weight: 1, metadata: { typeName: tc.name, extendsType: ext } });
            }
          }
        }
      }
    }

    this.logger.info('NLKG built', { nodes: this.nodes.size, edges: this.edges.length });
  }

  private resolveCallTarget(target: string, units: UnitFingerprint[]): string | null {
    const directMatch = units.find(u => u.name === target);
    if (directMatch) return directMatch.id;
    if (target.includes('.')) {
      const [obj, method] = target.split('.');
      const classMatch = units.find(u => u.kind === 'class' && u.name.toLowerCase() === obj?.toLowerCase());
      if (classMatch) {
        const methodMatch = units.find(u => u.filePath === classMatch.filePath && u.name === method && u.kind === 'method');
        if (methodMatch) return methodMatch.id;
        return classMatch.id;
      }
    }
    return null;
  }

  private resolveTypeRef(typeName: string, units: UnitFingerprint[]): string | null {
    const match = units.find(u => (u.kind === 'interface' || u.kind === 'type' || u.kind === 'class' || u.kind === 'enum') && u.name === typeName);
    return match?.id ?? null;
  }

  private resolveImportToModule(importPath: string, modules: ModuleContract[]): string | null {
    // M11-AUDIT FIX (MED-20): Previous regex `..\\` matched "any char +
    // backslash" (no escapes) — silently mishandled Windows-style relative
    // imports. Now we strip both `..\` and `..//\\` plus `./` and `../`
    // properly via per-platform-aware normalization.
    const normalizedImport = importPath
      .replace(/\.js$/, '.ts')           // module specifier `.js` → on-disk `.ts`
      .replace(/\\/g, '/')                // collapse Windows separators
      .replace(/(?:^|\/)(?:\.\.?\/)+/g, '/') // strip leading `./`, `../` chunks
      .replace(/^\/+/, '');               // trim leading slashes
    for (const mod of modules) {
      const normalizedPath = mod.filePath.replace(/\\/g, '/');
      if (
        normalizedPath.endsWith(normalizedImport) ||
        normalizedPath.endsWith(normalizedImport + '.ts') ||
        normalizedPath.endsWith(normalizedImport + '/index.ts')
      ) {
        return `module:${mod.filePath}`;
      }
    }
    return null;
  }

  private rebuildIndexes(): void {
    this.forwardIndex.clear();
    this.reverseIndex.clear();
    for (const edge of this.edges) {
      const fwd = this.forwardIndex.get(edge.from) || [];
      fwd.push(edge);
      this.forwardIndex.set(edge.from, fwd);
      const rev = this.reverseIndex.get(edge.to) || [];
      rev.push(edge);
      this.reverseIndex.set(edge.to, rev);
    }
  }

  clear(): void {
    this.nodes.clear();
    this.edges = [];
    this.forwardIndex.clear();
    this.reverseIndex.clear();
  }

  extractSubgraph(nodeId: string, depth: number = 2, direction: 'both' | 'forward' | 'reverse' = 'both'): SubgraphExtraction {
    const visited = new Set<string>();
    const resultNodes: GraphNode[] = [];
    const resultEdges: GraphEdge[] = [];
    const entryPoints: string[] = [nodeId];
    const boundaryNodes: string[] = [];

    const traverse = (currentId: string, currentDepth: number) => {
      if (visited.has(currentId) || currentDepth > depth) {
        if (!visited.has(currentId)) boundaryNodes.push(currentId);
        return;
      }
      visited.add(currentId);
      const node = this.nodes.get(currentId);
      if (node) resultNodes.push(node);

      const edgesToFollow: GraphEdge[] = [];
      if (direction === 'both' || direction === 'forward') edgesToFollow.push(...(this.forwardIndex.get(currentId) || []));
      if (direction === 'both' || direction === 'reverse') edgesToFollow.push(...(this.reverseIndex.get(currentId) || []));

      for (const edge of edgesToFollow) {
        if (!resultEdges.some(e => e.from === edge.from && e.to === edge.to && e.kind === edge.kind)) resultEdges.push(edge);
        const nextId = edge.from === currentId ? edge.to : edge.from;
        traverse(nextId, currentDepth + 1);
      }
    };

    traverse(nodeId, 0);
    return { nodes: resultNodes, edges: resultEdges, entryPoints, boundaryNodes, stats: { nodeCount: resultNodes.length, edgeCount: resultEdges.length, depth } };
  }

  getImpactSet(nodeId: string): { direct: string[]; transitive: string[]; totalAffected: number } {
    const direct = new Set<string>();
    const transitive = new Set<string>();

    for (const edge of this.reverseIndex.get(nodeId) || []) {
      const depId = edge.from === nodeId ? edge.to : edge.from;
      direct.add(depId);
    }

    const visited = new Set<string>();
    const traverse = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);
      for (const edge of this.reverseIndex.get(id) || []) {
        const depId = edge.from === id ? edge.to : edge.from;
        if (!direct.has(depId)) transitive.add(depId);
        traverse(depId);
      }
    };
    for (const d of direct) traverse(d);

    return { direct: [...direct], transitive: [...transitive], totalAffected: direct.size + transitive.size };
  }

  getTypeConsumers(typeName: string): string[] {
    const consumers: string[] = [];
    for (const edge of this.edges) {
      if (edge.kind === 'uses-type' && edge.metadata?.typeName === typeName) consumers.push(edge.from);
    }
    return consumers;
  }

  getDataFlowChain(fromNodeId: string, toNodeId: string): GraphEdge[] {
    const visited = new Set<string>();
    const resultPath: GraphEdge[] = [];

    const dfs = (currentId: string): boolean => {
      if (currentId === toNodeId) return true;
      if (visited.has(currentId)) return false;
      visited.add(currentId);

      for (const edge of this.forwardIndex.get(currentId) || []) {
        if (edge.kind === 'calls' || edge.kind === 'data-flows-to') {
          resultPath.push(edge);
          if (dfs(edge.to)) return true;
          resultPath.pop();
        }
      }
      return false;
    };

    dfs(fromNodeId);
    return resultPath;
  }

  detectCycles(): Array<{ cycle: string[]; edgeKinds: EdgeKind[] }> {
    const cycles: Array<{ cycle: string[]; edgeKinds: EdgeKind[] }> = [];
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const path: string[] = [];
    const pathEdges: EdgeKind[] = [];

    const dfs = (nodeId: string) => {
      if (recursionStack.has(nodeId)) {
        const cycleStart = path.indexOf(nodeId);
        if (cycleStart >= 0) {
          cycles.push({ cycle: [...path.slice(cycleStart), nodeId], edgeKinds: [...pathEdges.slice(cycleStart)] });
        }
        return;
      }
      if (visited.has(nodeId)) return;
      visited.add(nodeId);
      recursionStack.add(nodeId);
      path.push(nodeId);

      for (const edge of this.forwardIndex.get(nodeId) || []) {
        pathEdges.push(edge.kind);
        dfs(edge.to);
        pathEdges.pop();
      }

      recursionStack.delete(nodeId);
      path.pop();
    };

    for (const nodeId of this.nodes.keys()) {
      if (!visited.has(nodeId)) dfs(nodeId);
    }
    return cycles;
  }

  getStats(): { nodeCount: number; edgeCount: number; edgeKindDistribution: Record<string, number>; avgDegree: number } {
    const kindDist: Record<string, number> = {};
    for (const edge of this.edges) kindDist[edge.kind] = (kindDist[edge.kind] || 0) + 1;
    const nodeCount = this.nodes.size;
    return { nodeCount, edgeCount: this.edges.length, edgeKindDistribution: kindDist, avgDegree: nodeCount > 0 ? this.edges.length / nodeCount : 0 };
  }

  serialize(): { nodes: Array<{ id: string; node: GraphNode }>; edges: GraphEdge[] } {
    const serializedNodes: Array<{ id: string; node: GraphNode }> = [];
    for (const [id, node] of this.nodes) serializedNodes.push({ id, node });
    return { nodes: serializedNodes, edges: this.edges };
  }

  deserialize(data: { nodes: Array<{ id: string; node: GraphNode }>; edges: GraphEdge[] }): void {
    this.clear();
    for (const item of data.nodes) this.nodes.set(item.id, item.node);
    this.edges = data.edges;
    this.rebuildIndexes();
  }
}
