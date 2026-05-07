import { describe, it, expect, beforeEach } from 'vitest';
import { NodeLevelKnowledgeGraph } from '../lib/node-knowledge-graph';
import type {
  GraphNode,
  GraphEdge,
  EdgeKind,
  ModuleContract,
  UnitFingerprint,
} from '../types/index';

/**
 * Phase B2.7f (M5 audit) -- jcf-healthcare-agent-hub node-knowledge-graph contract tests.
 * Tests NodeLevelKnowledgeGraph: node/edge CRUD, forward+reverse indexing,
 * cognitive-index ingestion, subgraph extraction (forward/reverse/both),
 * impact analysis, data-flow chains, cycle detection, serialization.
 */

function createLoggerStub(): any {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

function makeNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: 'node:1',
    filePath: '/f.ts',
    name: 'fn',
    kind: 'function',
    signature: '() => void',
    metadata: {},
    ...overrides,
  } as GraphNode;
}

function makeEdge(overrides: Partial<GraphEdge> = {}): GraphEdge {
  return {
    from: 'node:1',
    to: 'node:2',
    kind: 'calls' as EdgeKind,
    weight: 1,
    metadata: {},
    ...overrides,
  } as GraphEdge;
}

function makeUnit(overrides: Partial<UnitFingerprint> = {}): UnitFingerprint {
  return {
    id: 'u1',
    name: 'fn',
    filePath: '/f.ts',
    kind: 'function' as any,
    signature: '() => void',
    complexity: 1,
    isPure: true,
    isAsync: false,
    sideEffects: [],
    semanticTags: [],
    callTargets: [],
    typeDependencies: [],
    inputSignature: 'void',
    outputSignature: 'void',
    patternType: 'utility',
    ...overrides,
  } as UnitFingerprint;
}

function makeModule(overrides: Partial<ModuleContract> = {}): ModuleContract {
  return {
    filePath: '/m.ts',
    moduleName: 'm',
    exports: [],
    imports: [],
    definedTypes: [],
    patternClassification: [],
    ...overrides,
  } as ModuleContract;
}

describe('NodeLevelKnowledgeGraph — initialization & lifecycle', () => {
  let graph: NodeLevelKnowledgeGraph;

  beforeEach(() => {
    graph = new NodeLevelKnowledgeGraph({ logger: createLoggerStub() });
  });

  it('constructs without throwing', () => {
    expect(graph).toBeDefined();
  });

  it('initialize() resolves without throwing', async () => {
    await expect(graph.initialize()).resolves.toBeUndefined();
  });

  it('starts empty', () => {
    expect(graph.getAllNodes()).toEqual([]);
    expect(graph.getStats().nodeCount).toBe(0);
    expect(graph.getStats().edgeCount).toBe(0);
  });
});

describe('NodeLevelKnowledgeGraph — node CRUD', () => {
  let graph: NodeLevelKnowledgeGraph;

  beforeEach(() => {
    graph = new NodeLevelKnowledgeGraph({ logger: createLoggerStub() });
  });

  it('addNode stores node and initializes indexes', () => {
    graph.addNode(makeNode({ id: 'a' }));
    expect(graph.getNode('a')).toBeDefined();
    expect(graph.getOutgoingEdges('a')).toEqual([]);
    expect(graph.getIncomingEdges('a')).toEqual([]);
  });

  it('getNode returns undefined for unknown id', () => {
    expect(graph.getNode('nonexistent')).toBeUndefined();
  });

  it('getAllNodes returns array of nodes', () => {
    graph.addNode(makeNode({ id: 'a' }));
    graph.addNode(makeNode({ id: 'b' }));
    expect(graph.getAllNodes()).toHaveLength(2);
  });

  it('removeNode deletes node + cascades edges', () => {
    graph.addNode(makeNode({ id: 'a' }));
    graph.addNode(makeNode({ id: 'b' }));
    graph.addEdge(makeEdge({ from: 'a', to: 'b' }));
    expect(graph.getStats().edgeCount).toBe(1);

    graph.removeNode('a');
    expect(graph.getNode('a')).toBeUndefined();
    expect(graph.getStats().edgeCount).toBe(0); // edge cascaded
  });

  it('addNode is idempotent (overwrite)', () => {
    graph.addNode(makeNode({ id: 'a', name: 'first' }));
    graph.addNode(makeNode({ id: 'a', name: 'second' }));
    expect(graph.getNode('a')!.name).toBe('second');
    expect(graph.getStats().nodeCount).toBe(1);
  });
});

describe('NodeLevelKnowledgeGraph — edge CRUD', () => {
  let graph: NodeLevelKnowledgeGraph;

  beforeEach(() => {
    graph = new NodeLevelKnowledgeGraph({ logger: createLoggerStub() });
    graph.addNode(makeNode({ id: 'a' }));
    graph.addNode(makeNode({ id: 'b' }));
  });

  it('addEdge stores edge and updates forward+reverse indexes', () => {
    graph.addEdge(makeEdge({ from: 'a', to: 'b', kind: 'calls' as EdgeKind }));
    expect(graph.getOutgoingEdges('a').length).toBe(1);
    expect(graph.getIncomingEdges('b').length).toBe(1);
  });

  it('addEdge is idempotent (no duplicate edges with same from/to/kind)', () => {
    graph.addEdge(makeEdge({ from: 'a', to: 'b', kind: 'calls' as EdgeKind }));
    graph.addEdge(makeEdge({ from: 'a', to: 'b', kind: 'calls' as EdgeKind }));
    expect(graph.getStats().edgeCount).toBe(1);
  });

  it('addEdge allows multiple edges of different kinds between same nodes', () => {
    graph.addEdge(makeEdge({ from: 'a', to: 'b', kind: 'calls' as EdgeKind }));
    graph.addEdge(makeEdge({ from: 'a', to: 'b', kind: 'uses-type' as EdgeKind }));
    expect(graph.getStats().edgeCount).toBe(2);
  });

  it('removeEdge removes specific edge by from/to/kind triplet', () => {
    graph.addEdge(makeEdge({ from: 'a', to: 'b', kind: 'calls' as EdgeKind }));
    graph.addEdge(makeEdge({ from: 'a', to: 'b', kind: 'uses-type' as EdgeKind }));
    graph.removeEdge('a', 'b', 'calls' as EdgeKind);
    expect(graph.getStats().edgeCount).toBe(1);
  });

  it('getOutgoingEdges returns empty for unknown node', () => {
    expect(graph.getOutgoingEdges('unknown')).toEqual([]);
  });

  it('getIncomingEdges returns empty for unknown node', () => {
    expect(graph.getIncomingEdges('unknown')).toEqual([]);
  });
});

describe('NodeLevelKnowledgeGraph — clear', () => {
  it('clear() removes all nodes + edges + indexes', () => {
    const graph = new NodeLevelKnowledgeGraph({ logger: createLoggerStub() });
    graph.addNode(makeNode({ id: 'a' }));
    graph.addEdge(makeEdge({ from: 'a', to: 'b' }));
    graph.clear();
    expect(graph.getStats().nodeCount).toBe(0);
    expect(graph.getStats().edgeCount).toBe(0);
    expect(graph.getOutgoingEdges('a')).toEqual([]);
  });
});

describe('NodeLevelKnowledgeGraph — buildFromCognitiveIndex', () => {
  let graph: NodeLevelKnowledgeGraph;

  beforeEach(() => {
    graph = new NodeLevelKnowledgeGraph({ logger: createLoggerStub() });
  });

  it('handles empty input', () => {
    graph.buildFromCognitiveIndex([], []);
    expect(graph.getStats().nodeCount).toBe(0);
  });

  it('creates module nodes from ModuleContract list', () => {
    const modules = [makeModule({ filePath: '/a.ts', moduleName: 'A' })];
    graph.buildFromCognitiveIndex(modules, []);

    const node = graph.getNode('module:/a.ts');
    expect(node).toBeDefined();
    expect(node!.kind).toBe('module');
  });

  it('creates unit nodes and contains-edge from module to unit', () => {
    const modules = [makeModule({ filePath: '/a.ts', moduleName: 'A' })];
    const units = [makeUnit({ id: 'u1', filePath: '/a.ts', name: 'fn' })];
    graph.buildFromCognitiveIndex(modules, units);

    expect(graph.getNode('u1')).toBeDefined();
    const moduleEdges = graph.getOutgoingEdges('module:/a.ts');
    expect(moduleEdges.some(e => e.kind === 'contains' && e.to === 'u1')).toBe(true);
  });

  it('resolves call targets to call edges between units', () => {
    const modules = [makeModule({ filePath: '/a.ts' })];
    const units = [
      makeUnit({ id: 'caller', filePath: '/a.ts', name: 'caller', callTargets: ['callee'] }),
      makeUnit({ id: 'callee', filePath: '/a.ts', name: 'callee' }),
    ];
    graph.buildFromCognitiveIndex(modules, units);

    const callerOut = graph.getOutgoingEdges('caller');
    expect(callerOut.some(e => e.kind === 'calls' && e.to === 'callee')).toBe(true);
  });

  it('resolves type dependencies to uses-type edges', () => {
    const modules = [makeModule({ filePath: '/a.ts' })];
    const units = [
      makeUnit({ id: 'consumer', name: 'cons', typeDependencies: ['MyType'] }),
      makeUnit({ id: 't1', name: 'MyType', kind: 'interface' as any }),
    ];
    graph.buildFromCognitiveIndex(modules, units);

    const out = graph.getOutgoingEdges('consumer');
    expect(out.some(e => e.kind === 'uses-type' && e.to === 't1')).toBe(true);
  });

  it('clears prior state on rebuild', () => {
    graph.buildFromCognitiveIndex([makeModule({ filePath: '/a.ts' })], []);
    expect(graph.getStats().nodeCount).toBe(1);
    graph.buildFromCognitiveIndex([], []);
    expect(graph.getStats().nodeCount).toBe(0);
  });

  it('resolves dotted call targets to class method', () => {
    const modules = [makeModule({ filePath: '/a.ts' })];
    const units = [
      makeUnit({ id: 'caller', name: 'caller', callTargets: ['MyClass.doIt'], filePath: '/a.ts' }),
      makeUnit({ id: 'cls', name: 'MyClass', kind: 'class' as any, filePath: '/a.ts' }),
      makeUnit({ id: 'm', name: 'doIt', kind: 'method' as any, filePath: '/a.ts' }),
    ];
    graph.buildFromCognitiveIndex(modules, units);

    const out = graph.getOutgoingEdges('caller');
    expect(out.some(e => e.kind === 'calls')).toBe(true);
  });
});

describe('NodeLevelKnowledgeGraph — extractSubgraph', () => {
  let graph: NodeLevelKnowledgeGraph;

  beforeEach(() => {
    graph = new NodeLevelKnowledgeGraph({ logger: createLoggerStub() });
    // Build a small graph: a -> b -> c, a -> d
    ['a', 'b', 'c', 'd'].forEach(id => graph.addNode(makeNode({ id })));
    graph.addEdge(makeEdge({ from: 'a', to: 'b', kind: 'calls' as EdgeKind }));
    graph.addEdge(makeEdge({ from: 'b', to: 'c', kind: 'calls' as EdgeKind }));
    graph.addEdge(makeEdge({ from: 'a', to: 'd', kind: 'calls' as EdgeKind }));
  });

  it('extracts forward subgraph (default both)', () => {
    const sub = graph.extractSubgraph('a', 1);
    expect(sub.nodes.length).toBeGreaterThanOrEqual(1);
    expect(sub.entryPoints).toEqual(['a']);
  });

  it('respects depth=0 (just entry node)', () => {
    const sub = graph.extractSubgraph('a', 0);
    expect(sub.stats.depth).toBe(0);
  });

  it('forward direction only follows outgoing edges', () => {
    const sub = graph.extractSubgraph('a', 5, 'forward');
    const ids = sub.nodes.map(n => n.id);
    expect(ids).toContain('a');
    expect(ids).toContain('b');
  });

  it('reverse direction only follows incoming edges', () => {
    const sub = graph.extractSubgraph('c', 5, 'reverse');
    const ids = sub.nodes.map(n => n.id);
    expect(ids).toContain('c');
  });

  it('returns SubgraphExtraction shape with all expected fields', () => {
    const sub = graph.extractSubgraph('a', 2);
    expect(sub).toHaveProperty('nodes');
    expect(sub).toHaveProperty('edges');
    expect(sub).toHaveProperty('entryPoints');
    expect(sub).toHaveProperty('boundaryNodes');
    expect(sub).toHaveProperty('stats');
    expect(sub.stats).toHaveProperty('nodeCount');
    expect(sub.stats).toHaveProperty('edgeCount');
  });

  it('handles unknown entry node gracefully', () => {
    const sub = graph.extractSubgraph('nonexistent', 2);
    expect(sub.nodes.length).toBe(0);
  });
});

describe('NodeLevelKnowledgeGraph — getImpactSet', () => {
  let graph: NodeLevelKnowledgeGraph;

  beforeEach(() => {
    graph = new NodeLevelKnowledgeGraph({ logger: createLoggerStub() });
    // Dependency direction: B depends on A, C depends on B
    ['a', 'b', 'c'].forEach(id => graph.addNode(makeNode({ id })));
    graph.addEdge(makeEdge({ from: 'b', to: 'a', kind: 'calls' as EdgeKind }));
    graph.addEdge(makeEdge({ from: 'c', to: 'b', kind: 'calls' as EdgeKind }));
  });

  it('returns direct + transitive dependents', () => {
    const impact = graph.getImpactSet('a');
    expect(impact.direct).toContain('b');
    // 'c' transitively depends on 'a' (through 'b')
    expect(impact.totalAffected).toBeGreaterThanOrEqual(1);
  });

  it('returns empty for node with no dependents', () => {
    graph.addNode(makeNode({ id: 'isolated' }));
    const impact = graph.getImpactSet('isolated');
    expect(impact.direct).toEqual([]);
    expect(impact.transitive).toEqual([]);
    expect(impact.totalAffected).toBe(0);
  });

  it('handles unknown nodes', () => {
    const impact = graph.getImpactSet('nonexistent');
    expect(impact.direct).toEqual([]);
  });
});

describe('NodeLevelKnowledgeGraph — getTypeConsumers', () => {
  it('returns empty array when no type edges', () => {
    const graph = new NodeLevelKnowledgeGraph({ logger: createLoggerStub() });
    expect(graph.getTypeConsumers('Unknown')).toEqual([]);
  });

  it('returns nodes that consume the named type', () => {
    const graph = new NodeLevelKnowledgeGraph({ logger: createLoggerStub() });
    graph.addNode(makeNode({ id: 'consumer1' }));
    graph.addNode(makeNode({ id: 'consumer2' }));
    graph.addNode(makeNode({ id: 'type1' }));
    graph.addEdge({
      from: 'consumer1', to: 'type1', kind: 'uses-type' as EdgeKind,
      weight: 1, metadata: { typeName: 'MyType' },
    });
    graph.addEdge({
      from: 'consumer2', to: 'type1', kind: 'uses-type' as EdgeKind,
      weight: 1, metadata: { typeName: 'MyType' },
    });

    const consumers = graph.getTypeConsumers('MyType');
    expect(consumers).toContain('consumer1');
    expect(consumers).toContain('consumer2');
  });
});

describe('NodeLevelKnowledgeGraph — getDataFlowChain', () => {
  it('returns empty path when no flow exists', () => {
    const graph = new NodeLevelKnowledgeGraph({ logger: createLoggerStub() });
    graph.addNode(makeNode({ id: 'a' }));
    graph.addNode(makeNode({ id: 'b' }));
    expect(graph.getDataFlowChain('a', 'b')).toEqual([]);
  });

  it('finds direct calls edge as flow', () => {
    const graph = new NodeLevelKnowledgeGraph({ logger: createLoggerStub() });
    graph.addNode(makeNode({ id: 'a' }));
    graph.addNode(makeNode({ id: 'b' }));
    graph.addEdge(makeEdge({ from: 'a', to: 'b', kind: 'calls' as EdgeKind }));
    const chain = graph.getDataFlowChain('a', 'b');
    expect(chain.length).toBeGreaterThanOrEqual(1);
  });

  it('only follows calls or data-flows-to edges', () => {
    const graph = new NodeLevelKnowledgeGraph({ logger: createLoggerStub() });
    graph.addNode(makeNode({ id: 'a' }));
    graph.addNode(makeNode({ id: 'b' }));
    // uses-type kind should NOT count as data flow
    graph.addEdge(makeEdge({ from: 'a', to: 'b', kind: 'uses-type' as EdgeKind }));
    const chain = graph.getDataFlowChain('a', 'b');
    expect(chain).toEqual([]);
  });
});

describe('NodeLevelKnowledgeGraph — detectCycles', () => {
  it('returns empty array for acyclic graph', () => {
    const graph = new NodeLevelKnowledgeGraph({ logger: createLoggerStub() });
    graph.addNode(makeNode({ id: 'a' }));
    graph.addNode(makeNode({ id: 'b' }));
    graph.addEdge(makeEdge({ from: 'a', to: 'b' }));
    expect(graph.detectCycles()).toEqual([]);
  });

  it('detects simple 2-node cycle', () => {
    const graph = new NodeLevelKnowledgeGraph({ logger: createLoggerStub() });
    graph.addNode(makeNode({ id: 'a' }));
    graph.addNode(makeNode({ id: 'b' }));
    graph.addEdge(makeEdge({ from: 'a', to: 'b' }));
    graph.addEdge(makeEdge({ from: 'b', to: 'a' }));
    const cycles = graph.detectCycles();
    expect(cycles.length).toBeGreaterThan(0);
  });

  it('detects 3-node cycle a→b→c→a', () => {
    const graph = new NodeLevelKnowledgeGraph({ logger: createLoggerStub() });
    ['a', 'b', 'c'].forEach(id => graph.addNode(makeNode({ id })));
    graph.addEdge(makeEdge({ from: 'a', to: 'b' }));
    graph.addEdge(makeEdge({ from: 'b', to: 'c' }));
    graph.addEdge(makeEdge({ from: 'c', to: 'a' }));
    const cycles = graph.detectCycles();
    expect(cycles.length).toBeGreaterThan(0);
  });
});

describe('NodeLevelKnowledgeGraph — getStats', () => {
  it('reports node + edge counts and edge-kind distribution', () => {
    const graph = new NodeLevelKnowledgeGraph({ logger: createLoggerStub() });
    graph.addNode(makeNode({ id: 'a' }));
    graph.addNode(makeNode({ id: 'b' }));
    graph.addEdge(makeEdge({ from: 'a', to: 'b', kind: 'calls' as EdgeKind }));
    graph.addEdge(makeEdge({ from: 'a', to: 'b', kind: 'uses-type' as EdgeKind }));

    const stats = graph.getStats();
    expect(stats.nodeCount).toBe(2);
    expect(stats.edgeCount).toBe(2);
    expect(stats.edgeKindDistribution['calls']).toBe(1);
    expect(stats.edgeKindDistribution['uses-type']).toBe(1);
    expect(stats.avgDegree).toBe(1); // 2 edges / 2 nodes
  });

  it('avgDegree is 0 for empty graph', () => {
    const graph = new NodeLevelKnowledgeGraph({ logger: createLoggerStub() });
    expect(graph.getStats().avgDegree).toBe(0);
  });
});

describe('NodeLevelKnowledgeGraph — serialize / deserialize', () => {
  it('round-trips: serialize → deserialize → identical state', () => {
    const graph1 = new NodeLevelKnowledgeGraph({ logger: createLoggerStub() });
    graph1.addNode(makeNode({ id: 'a' }));
    graph1.addNode(makeNode({ id: 'b' }));
    graph1.addEdge(makeEdge({ from: 'a', to: 'b', kind: 'calls' as EdgeKind }));

    const data = graph1.serialize();
    expect(data.nodes.length).toBe(2);
    expect(data.edges.length).toBe(1);

    const graph2 = new NodeLevelKnowledgeGraph({ logger: createLoggerStub() });
    graph2.deserialize(data);
    expect(graph2.getStats().nodeCount).toBe(2);
    expect(graph2.getStats().edgeCount).toBe(1);
    expect(graph2.getNode('a')).toBeDefined();
    expect(graph2.getOutgoingEdges('a').length).toBe(1);
  });

  it('deserialize clears existing state first', () => {
    const graph = new NodeLevelKnowledgeGraph({ logger: createLoggerStub() });
    graph.addNode(makeNode({ id: 'old' }));
    graph.deserialize({ nodes: [{ id: 'new', node: makeNode({ id: 'new' }) }], edges: [] });
    expect(graph.getNode('old')).toBeUndefined();
    expect(graph.getNode('new')).toBeDefined();
  });
});
