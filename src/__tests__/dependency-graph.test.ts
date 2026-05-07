import { describe, it, expect, beforeEach } from 'vitest';
import { DependencyGraphManager } from '../lib/dependency-graph';
import { Logger } from '../lib/logger';
import type { FileMetadata } from '../types/index';

/**
 * Phase E.4 (M5 audit) -- jcf-healthcare-agent-hub dependency-graph.ts contract tests.
 * Validates graph operations, cycle detection, change impact analysis,
 * and import/export round-trip serialization.
 *
 * Database is stubbed -- DependencyGraphManager only uses 2 methods
 * (getAllFiles, getFileMetadata) which are easy to mock.
 */
function createDbStub(): any {
  return {
    getAllFiles: () => [],
    getFileMetadata: () => null,
  };
}

function createMetadata(filePath: string, imports: string[]): FileMetadata {
  return {
    path: filePath,
    size: 100,
    modified: new Date(),
    created: new Date(),
    mode: '100644',
    imports,
  };
}

describe('DependencyGraphManager', () => {
  let graph: DependencyGraphManager;
  let logger: Logger;

  beforeEach(() => {
    logger = new Logger('error');
    graph = new DependencyGraphManager({ db: createDbStub(), logger, projectRoot: '/test' });
  });

  describe('registerFile + getDependencies + getDependents', () => {
    it('registers file with no deps', async () => {
      await graph.registerFile('/test/a.ts', createMetadata('/test/a.ts', []));
      expect(graph.getDependencies('/test/a.ts')).toEqual([]);
    });

    it('does not throw when registering with imports', async () => {
      await graph.registerFile('/test/a.ts', createMetadata('/test/a.ts', ['./util']));
      const deps = graph.getDependencies('/test/a.ts');
      expect(Array.isArray(deps)).toBe(true);
    });
  });

  describe('removeFile', () => {
    it('removes file from forward graph', async () => {
      await graph.registerFile('/test/a.ts', createMetadata('/test/a.ts', []));
      await graph.removeFile('/test/a.ts');
      expect(graph.getDependencies('/test/a.ts')).toEqual([]);
    });

    it('does not throw when removing non-existent file', async () => {
      await expect(graph.removeFile('/test/nonexistent.ts')).resolves.not.toThrow();
    });
  });

  describe('detectCycles', () => {
    it('returns empty when no cycles', () => {
      expect(graph.detectCycles()).toEqual([]);
    });

    it('finds simple 3-node cycle (a -> b -> c -> a)', () => {
      graph.import({
        nodes: { 'a': ['b'], 'b': ['c'], 'c': ['a'] },
        reverse: { 'b': ['a'], 'c': ['b'], 'a': ['c'] },
      });
      const cycles = graph.detectCycles();
      expect(cycles.length).toBeGreaterThanOrEqual(1);
      expect(cycles[0].length).toBeGreaterThanOrEqual(3);
    });

    it('finds self-loop cycle (a -> a)', () => {
      graph.import({
        nodes: { 'a': ['a'] },
        reverse: { 'a': ['a'] },
      });
      const cycles = graph.detectCycles();
      expect(cycles.length).toBeGreaterThanOrEqual(1);
    });

    it('returns empty for DAG (no cycles)', () => {
      graph.import({
        nodes: { 'a': ['b', 'c'], 'b': ['d'], 'c': ['d'], 'd': [] },
        reverse: { 'b': ['a'], 'c': ['a'], 'd': ['b', 'c'] },
      });
      expect(graph.detectCycles()).toEqual([]);
    });
  });

  describe('getTransitiveDependencies', () => {
    it('returns transitive closure forward', () => {
      graph.import({
        nodes: { 'a': ['b'], 'b': ['c'], 'c': ['d'], 'd': [] },
        reverse: { 'b': ['a'], 'c': ['b'], 'd': ['c'] },
      });
      const deps = graph.getTransitiveDependencies('a');
      expect(deps.has('b')).toBe(true);
      expect(deps.has('c')).toBe(true);
      expect(deps.has('d')).toBe(true);
    });

    it('handles cycles without infinite loop', () => {
      graph.import({
        nodes: { 'a': ['b'], 'b': ['a'] },
        reverse: { 'a': ['b'], 'b': ['a'] },
      });
      const deps = graph.getTransitiveDependencies('a');
      expect(deps.has('b')).toBe(true);
    });
  });

  describe('getTransitiveDependents', () => {
    it('returns transitive closure reverse', () => {
      graph.import({
        nodes: { 'a': [], 'b': ['a'], 'c': ['b'], 'd': ['c'] },
        reverse: { 'a': ['b'], 'b': ['c'], 'c': ['d'] },
      });
      const dependents = graph.getTransitiveDependents('a');
      expect(dependents.has('b')).toBe(true);
      expect(dependents.has('c')).toBe(true);
      expect(dependents.has('d')).toBe(true);
    });
  });

  describe('calculateCoherenceScore', () => {
    it('returns 1.0 for isolated file', () => {
      graph.import({ nodes: { 'isolated': [] }, reverse: {} });
      expect(graph.calculateCoherenceScore('isolated')).toBe(1.0);
    });

    it('returns lower score for highly coupled file', () => {
      graph.import({
        nodes: { 'a': ['b', 'c', 'd', 'e'], 'b': [], 'c': [], 'd': [], 'e': [] },
        reverse: { 'b': ['a'], 'c': ['a'], 'd': ['a'], 'e': ['a'] },
      });
      const score = graph.calculateCoherenceScore('a');
      // a connects to all others -> low coherence
      expect(score).toBeLessThan(1.0);
    });

    it('score is in [0, 1]', () => {
      graph.import({ nodes: { 'a': ['b'], 'b': [] }, reverse: { 'b': ['a'] } });
      const score = graph.calculateCoherenceScore('a');
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    });
  });

  describe('analyzeChangeImpact', () => {
    it('returns low risk for isolated file', () => {
      graph.import({ nodes: { 'a': [], 'b': [], 'c': [] }, reverse: {} });
      const impact = graph.analyzeChangeImpact('a');
      expect(impact.risk).toBe('low');
      expect(impact.affectedFiles).toEqual([]);
    });

    it('escalates risk with high transitive impact', () => {
      // a is depended on by b, c, d (3/4 affected = 75%)
      graph.import({
        nodes: { 'a': [], 'b': ['a'], 'c': ['a'], 'd': ['a'] },
        reverse: { 'a': ['b', 'c', 'd'] },
      });
      const impact = graph.analyzeChangeImpact('a');
      expect(impact.affectedFiles.length).toBe(3);
      expect(['high', 'critical']).toContain(impact.risk);
    });

    it('score inversely correlates with impactRatio', () => {
      graph.import({ nodes: { 'a': [], 'b': [], 'c': [] }, reverse: {} });
      const impactA = graph.analyzeChangeImpact('a');
      // Isolated file -> score should be high (1.0)
      expect(impactA.score).toBe(1.0);
    });
  });

  describe('getStats', () => {
    it('reports zero stats for empty graph', () => {
      const stats = graph.getStats();
      expect(stats.nodeCount).toBe(0);
      expect(stats.edgeCount).toBe(0);
      expect(stats.cycleCount).toBe(0);
    });

    it('counts nodes and edges accurately', () => {
      graph.import({
        nodes: { 'a': ['b', 'c'], 'b': ['c'], 'c': [] },
        reverse: { 'b': ['a'], 'c': ['a', 'b'] },
      });
      const stats = graph.getStats();
      expect(stats.nodeCount).toBe(3);
      expect(stats.edgeCount).toBe(3); // a->b, a->c, b->c
    });

    it('avgDegree calculation', () => {
      graph.import({
        nodes: { 'a': ['b'], 'b': [] },
        reverse: { 'b': ['a'] },
      });
      const stats = graph.getStats();
      expect(stats.avgDegree).toBeCloseTo(0.5); // 1 edge / 2 nodes
    });
  });

  describe('export + import round-trip', () => {
    it('preserves graph state', () => {
      const original = {
        nodes: { 'a': ['b'], 'b': ['c'], 'c': [] },
        reverse: { 'b': ['a'], 'c': ['b'] },
      };
      graph.import(original);
      const exported = graph.export();
      expect(exported.nodes).toEqual(original.nodes);
      expect(exported.reverse).toEqual(original.reverse);
    });

    it('import clears existing state', () => {
      graph.import({ nodes: { 'old': ['x'] }, reverse: { 'x': ['old'] } });
      graph.import({ nodes: { 'new': [] }, reverse: {} });
      expect(graph.getDependencies('old')).toEqual([]);
    });
  });

  describe('wrapper methods (server compat)', () => {
    it('getCoherenceScore == calculateCoherenceScore', () => {
      graph.import({ nodes: { 'x': [] }, reverse: {} });
      expect(graph.getCoherenceScore('x')).toBe(graph.calculateCoherenceScore('x'));
    });

    it('detectCircularDependencies == detectCycles (length match)', () => {
      graph.import({ nodes: { 'a': ['a'] }, reverse: { 'a': ['a'] } });
      expect(graph.detectCircularDependencies().length).toBe(graph.detectCycles().length);
    });

    it('assessChangeRisk == analyzeChangeImpact', () => {
      graph.import({ nodes: { 'a': [] }, reverse: {} });
      const a = graph.assessChangeRisk('a');
      const b = graph.analyzeChangeImpact('a');
      expect(a.risk).toBe(b.risk);
    });
  });

  describe('getResolverInfo', () => {
    it('returns resolver snapshot with expected shape', () => {
      const info = graph.getResolverInfo();
      expect(info).toHaveProperty('tsConfigPath');
      expect(info).toHaveProperty('pathAliases');
      expect(info).toHaveProperty('baseUrl');
      expect(typeof info.pathAliases).toBe('number');
    });
  });
});
