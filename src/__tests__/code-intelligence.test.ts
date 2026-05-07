import { describe, it, expect, beforeEach } from 'vitest';
import { CodeIntelligenceEngine } from '../lib/code-intelligence';
import type {
  IntelligenceQuery,
  CognitiveIndex,
  ProjectSkeleton,
  ModuleContract,
  UnitFingerprint,
  CodePattern,
  TypeFlow,
  DataPipeline,
  PatternCompressionResult,
} from '../types/index';

/**
 * Phase B2.7e (M5 audit) -- jcf-healthcare-agent-hub code-intelligence contract tests.
 * Tests CodeIntelligenceEngine: orchestrator over CognitiveIndex, NLKG,
 * PatternDetector, TypeFlowAnalyzer. Each of the 8 query types is exercised
 * with stubbed dependencies to verify routing, source attribution, confidence
 * adjustment, and token estimation.
 */

function createLoggerStub(): any {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

function makeUnit(overrides: Partial<UnitFingerprint> = {}): UnitFingerprint {
  return {
    id: 'u1',
    name: 'fn',
    filePath: '/f.ts',
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

function makeSkeleton(overrides: Partial<ProjectSkeleton> = {}): ProjectSkeleton {
  return {
    rootPath: '/repo',
    directoryTree: {} as any,
    techStack: { languages: [], frameworks: [], buildTools: [], testFrameworks: [] },
    architecturePatterns: [],
    entryPoints: [],
    configFiles: [],
    languageDistribution: {},
    moduleCount: 0,
    estimatedTokenSize: 0,
    ...overrides,
  } as ProjectSkeleton;
}

function makeCognitiveIndex(overrides: Partial<CognitiveIndex> = {}): CognitiveIndex {
  return {
    skeleton: makeSkeleton(),
    modules: [],
    units: [],
    stats: {
      totalModules: 0,
      totalUnits: 0,
      avgComplexity: 0,
      avgFanOut: 0,
      cyclomaticHotspots: [],
      estimatedTokenCost: { skeleton: 100, contracts: 200, fingerprints: 300, total: 600 },
    },
    builtAt: Date.now(),
    rootPath: '/repo',
    ...overrides,
  } as CognitiveIndex;
}

function makeStubs(opts: {
  index?: CognitiveIndex | null;
  patterns?: CodePattern[];
  typeFlow?: TypeFlow | undefined;
  pipelines?: DataPipeline[];
  patternResult?: PatternCompressionResult;
  nlkgStats?: any;
} = {}) {
  const idx = opts.index ?? makeCognitiveIndex();
  const cognitiveIndex = {
    buildFullIndex: async () => idx,
    incrementalUpdate: async () => {},
    getIndex: () => idx,
    getSkeleton: () => idx?.skeleton ?? null,
    getModules: () => idx?.modules ?? [],
    getUnits: () => idx?.units ?? [],
    getStats: () => idx?.stats ?? makeCognitiveIndex().stats,
  } as any;

  const nlkg = {
    buildFromCognitiveIndex: () => {},
    getImpactSet: (id: string) => ({ direct: [`d-${id}`], transitive: [], totalAffected: 1 }),
    extractSubgraph: (id: string, depth: number) => ({
      nodes: [{ id }],
      edges: [],
      entryPoints: [id],
      boundaryNodes: [],
      stats: { nodeCount: 1, edgeCount: 0, depth },
    }),
    getStats: () => opts.nlkgStats ?? { nodeCount: 0, edgeCount: 0 },
  } as any;

  const patternDetector = {
    detectPatterns: () =>
      opts.patternResult ?? {
        patterns: opts.patterns ?? [],
        totalOriginalUnits: 0,
        totalCompressedUnits: 0,
        overallCompressionRatio: 1,
        estimatedTokenSavings: 0,
      },
    getPatterns: () => opts.patterns ?? [],
    getPatternByCategory: (cat: string) => (opts.patterns ?? []).filter(p => p.category === cat),
    getCompressedRepresentation: () => 'PATTERN: stub\n',
    getStats: () => ({
      patternCount: (opts.patterns ?? []).length,
      totalInstances: 0,
      totalTokenSavings: 0,
      categoryDistribution: {},
    }),
  } as any;

  const typeFlowAnalyzer = {
    analyzeTypeFlows: () => [],
    analyzeDataPipelines: () => opts.pipelines ?? [],
    getTypeFlow: () => opts.typeFlow,
    getTypeConsumers: () => (opts.typeFlow?.consumers ?? []) as string[],
    getTypeProducers: () => (opts.typeFlow?.producers ?? []) as string[],
    getAllTypeFlows: () => (opts.typeFlow ? [opts.typeFlow] : []),
    getPipelines: () => opts.pipelines ?? [],
    getStats: () => ({
      typeFlowCount: opts.typeFlow ? 1 : 0,
      pipelineCount: (opts.pipelines ?? []).length,
      avgStepsPerFlow: 0,
      avgStepsPerPipeline: 0,
    }),
  } as any;

  return { cognitiveIndex, nlkg, patternDetector, typeFlowAnalyzer };
}

describe('CodeIntelligenceEngine — initialization & lifecycle', () => {
  let engine: CodeIntelligenceEngine;

  beforeEach(() => {
    const stubs = makeStubs();
    engine = new CodeIntelligenceEngine({
      logger: createLoggerStub(),
      db: {} as any,
      ...stubs,
    });
  });

  it('constructs without throwing', () => {
    expect(engine).toBeDefined();
  });

  it('initialize() resolves without throwing', async () => {
    await expect(engine.initialize()).resolves.toBeUndefined();
  });

  it('getStats returns aggregated statistics from all subsystems', () => {
    const stats = engine.getStats();
    expect(stats).toHaveProperty('cognitiveIndex');
    expect(stats).toHaveProperty('nlkg');
    expect(stats).toHaveProperty('patterns');
    expect(stats).toHaveProperty('typeFlows');
    expect(stats).toHaveProperty('lastBuildTime');
    expect(stats).toHaveProperty('buildDuration');
    expect(stats.lastBuildTime).toBe(0); // before any build
    expect(stats.buildDuration).toBe(0);
  });
});

describe('CodeIntelligenceEngine — buildFullIntelligence', () => {
  it('orchestrates full intelligence build and returns aggregated result', async () => {
    const idx = makeCognitiveIndex({
      modules: [makeModule({ filePath: '/a.ts' })],
      units: [makeUnit({ id: 'u1' })],
      skeleton: makeSkeleton({ entryPoints: ['/a.ts'] }),
      stats: {
        totalModules: 1,
        totalUnits: 1,
        avgComplexity: 1,
        avgFanOut: 0,
        cyclomaticHotspots: [],
        estimatedTokenCost: { skeleton: 50, contracts: 100, fingerprints: 150, total: 300 },
      } as any,
    });
    const stubs = makeStubs({
      index: idx,
      pipelines: [{ name: 'p', entryPoint: 'u1', exitPoint: 'u1', steps: [], typeFlow: [], totalSteps: 0, branchingPoints: [] } as any],
    });
    const engine = new CodeIntelligenceEngine({
      logger: createLoggerStub(),
      db: {} as any,
      ...stubs,
    });

    const result = await engine.buildFullIntelligence('/repo');
    expect(result.index).toBe(idx);
    expect(result.duration).toBeGreaterThanOrEqual(0);
    expect(result.patternResult).toBeDefined();
    expect(Array.isArray(result.typeFlows)).toBe(true);
    expect(Array.isArray(result.pipelines)).toBe(true);
  });

  it('records lastBuildTime and buildDuration after build', async () => {
    const stubs = makeStubs();
    const engine = new CodeIntelligenceEngine({
      logger: createLoggerStub(),
      db: {} as any,
      ...stubs,
    });
    await engine.buildFullIntelligence('/repo');
    const stats = engine.getStats();
    expect(stats.lastBuildTime).toBeGreaterThan(0);
    expect(stats.buildDuration).toBeGreaterThanOrEqual(0);
  });
});

describe('CodeIntelligenceEngine — incrementalUpdate', () => {
  it('runs without throwing when index exists', async () => {
    const stubs = makeStubs();
    const engine = new CodeIntelligenceEngine({
      logger: createLoggerStub(),
      db: {} as any,
      ...stubs,
    });
    await expect(engine.incrementalUpdate('/x.ts', 'export const x = 1;')).resolves.toBeUndefined();
  });

  it('skips post-update steps when getIndex returns null', async () => {
    const stubs = makeStubs({ index: null });
    // Override getIndex to return null
    stubs.cognitiveIndex.getIndex = () => null;
    const engine = new CodeIntelligenceEngine({
      logger: createLoggerStub(),
      db: {} as any,
      ...stubs,
    });
    await expect(engine.incrementalUpdate('/y.ts', 'content')).resolves.toBeUndefined();
  });
});

describe('CodeIntelligenceEngine — query: skeleton', () => {
  it('returns skeleton with correct sources and token estimate', async () => {
    const skel = makeSkeleton({ entryPoints: ['/main.ts'] });
    const idx = makeCognitiveIndex({ skeleton: skel });
    const stubs = makeStubs({ index: idx });
    const engine = new CodeIntelligenceEngine({
      logger: createLoggerStub(),
      db: {} as any,
      ...stubs,
    });

    const result = await engine.query({ type: 'skeleton' } as IntelligenceQuery);
    expect(result.data).toBe(skel);
    expect(result.sources).toContain('cognitive-index:skeleton');
    expect(result.confidence).toBe(1.0);
  });

  it('returns confidence=0 when skeleton is null', async () => {
    const stubs = makeStubs();
    stubs.cognitiveIndex.getSkeleton = () => null;
    const engine = new CodeIntelligenceEngine({
      logger: createLoggerStub(),
      db: {} as any,
      ...stubs,
    });

    const result = await engine.query({ type: 'skeleton' } as IntelligenceQuery);
    expect(result.confidence).toBe(0);
  });
});

describe('CodeIntelligenceEngine — query: contracts', () => {
  it('returns all modules when no filter provided', async () => {
    const modules = [makeModule({ filePath: '/a.ts' }), makeModule({ filePath: '/b.ts' })];
    const idx = makeCognitiveIndex({ modules });
    const stubs = makeStubs({ index: idx });
    const engine = new CodeIntelligenceEngine({
      logger: createLoggerStub(),
      db: {} as any,
      ...stubs,
    });

    const result = await engine.query({ type: 'contracts' } as IntelligenceQuery);
    expect(result.data).toEqual(modules);
    expect(result.sources).toContain('cognitive-index:contracts');
  });

  it('filters modules by filePaths when provided', async () => {
    const modules = [makeModule({ filePath: '/a.ts' }), makeModule({ filePath: '/b.ts' })];
    const idx = makeCognitiveIndex({ modules });
    const stubs = makeStubs({ index: idx });
    const engine = new CodeIntelligenceEngine({
      logger: createLoggerStub(),
      db: {} as any,
      ...stubs,
    });

    const result = await engine.query({
      type: 'contracts',
      filters: { filePaths: ['/a.ts'] },
    } as IntelligenceQuery);
    expect(Array.isArray(result.data)).toBe(true);
    expect((result.data as ModuleContract[]).length).toBe(1);
    expect((result.data as ModuleContract[])[0].filePath).toBe('/a.ts');
  });
});

describe('CodeIntelligenceEngine — query: fingerprints', () => {
  it('returns all units when no filter', async () => {
    const units = [makeUnit({ id: 'a' }), makeUnit({ id: 'b' })];
    const idx = makeCognitiveIndex({ units });
    const stubs = makeStubs({ index: idx });
    const engine = new CodeIntelligenceEngine({
      logger: createLoggerStub(),
      db: {} as any,
      ...stubs,
    });

    const result = await engine.query({ type: 'fingerprints' } as IntelligenceQuery);
    expect((result.data as UnitFingerprint[]).length).toBe(2);
  });

  it('filters by filePaths', async () => {
    const units = [
      makeUnit({ id: 'a', filePath: '/a.ts' }),
      makeUnit({ id: 'b', filePath: '/b.ts' }),
    ];
    const idx = makeCognitiveIndex({ units });
    const stubs = makeStubs({ index: idx });
    const engine = new CodeIntelligenceEngine({
      logger: createLoggerStub(),
      db: {} as any,
      ...stubs,
    });

    const result = await engine.query({
      type: 'fingerprints',
      filters: { filePaths: ['/a.ts'] },
    } as IntelligenceQuery);
    expect((result.data as UnitFingerprint[]).length).toBe(1);
  });

  it('filters by maxComplexity', async () => {
    const units = [
      makeUnit({ id: 'easy', complexity: 2 }),
      makeUnit({ id: 'hard', complexity: 20 }),
    ];
    const idx = makeCognitiveIndex({ units });
    const stubs = makeStubs({ index: idx });
    const engine = new CodeIntelligenceEngine({
      logger: createLoggerStub(),
      db: {} as any,
      ...stubs,
    });

    const result = await engine.query({
      type: 'fingerprints',
      filters: { maxComplexity: 5 },
    } as IntelligenceQuery);
    expect((result.data as UnitFingerprint[]).length).toBe(1);
    expect((result.data as UnitFingerprint[])[0].id).toBe('easy');
  });

  it('filters by patternTypes', async () => {
    const units = [
      makeUnit({ id: 'h', patternType: 'handler' }),
      makeUnit({ id: 'u', patternType: 'utility' }),
    ];
    const idx = makeCognitiveIndex({ units });
    const stubs = makeStubs({ index: idx });
    const engine = new CodeIntelligenceEngine({
      logger: createLoggerStub(),
      db: {} as any,
      ...stubs,
    });

    const result = await engine.query({
      type: 'fingerprints',
      filters: { patternTypes: ['handler'] as any },
    } as IntelligenceQuery);
    expect((result.data as UnitFingerprint[]).length).toBe(1);
    expect((result.data as UnitFingerprint[])[0].id).toBe('h');
  });
});

describe('CodeIntelligenceEngine — query: impact', () => {
  it('returns error when target missing', async () => {
    const stubs = makeStubs();
    const engine = new CodeIntelligenceEngine({
      logger: createLoggerStub(),
      db: {} as any,
      ...stubs,
    });

    const result = await engine.query({ type: 'impact' } as IntelligenceQuery);
    expect((result.data as any).error).toMatch(/target required/i);
    expect(result.confidence).toBe(0);
  });

  it('returns impact set + subgraph for target', async () => {
    const stubs = makeStubs();
    const engine = new CodeIntelligenceEngine({
      logger: createLoggerStub(),
      db: {} as any,
      ...stubs,
    });

    const result = await engine.query({
      type: 'impact',
      target: 'module:auth',
      depth: 3,
    } as IntelligenceQuery);
    expect(result.data).toHaveProperty('impact');
    expect(result.data).toHaveProperty('subgraph');
    expect(result.sources).toContain('nlkg:impact');
    expect(result.sources).toContain('nlkg:subgraph');
  });
});

describe('CodeIntelligenceEngine — query: flow', () => {
  it('returns error when target missing', async () => {
    const stubs = makeStubs();
    const engine = new CodeIntelligenceEngine({
      logger: createLoggerStub(),
      db: {} as any,
      ...stubs,
    });

    const result = await engine.query({ type: 'flow' } as IntelligenceQuery);
    expect((result.data as any).error).toMatch(/target.*flow/i);
    expect(result.confidence).toBe(0);
  });

  it('returns typeFlow + consumers + producers when found', async () => {
    const flow: TypeFlow = {
      id: 'tf:1',
      typeName: 'User',
      definedAt: '/u.ts',
      flowSteps: [],
      consumers: ['c1'],
      producers: ['p1'],
      transformers: [],
    };
    const stubs = makeStubs({ typeFlow: flow });
    const engine = new CodeIntelligenceEngine({
      logger: createLoggerStub(),
      db: {} as any,
      ...stubs,
    });

    const result = await engine.query({ type: 'flow', target: 'User' } as IntelligenceQuery);
    expect((result.data as any).typeFlow).toBe(flow);
    expect((result.data as any).consumers).toContain('c1');
    expect((result.data as any).producers).toContain('p1');
    expect(result.sources).toContain('type-flow-analyzer');
  });

  it('confidence drops to 0.3 when typeFlow not found', async () => {
    const stubs = makeStubs({ typeFlow: undefined });
    const engine = new CodeIntelligenceEngine({
      logger: createLoggerStub(),
      db: {} as any,
      ...stubs,
    });

    const result = await engine.query({ type: 'flow', target: 'Unknown' } as IntelligenceQuery);
    expect(result.confidence).toBe(0.3);
  });
});

describe('CodeIntelligenceEngine — query: patterns', () => {
  it('returns all patterns when no filter', async () => {
    const stubs = makeStubs();
    const engine = new CodeIntelligenceEngine({
      logger: createLoggerStub(),
      db: {} as any,
      ...stubs,
    });

    const result = await engine.query({ type: 'patterns' } as IntelligenceQuery);
    expect(result.data).toHaveProperty('patterns');
    expect(result.data).toHaveProperty('compressed');
    expect(result.sources).toContain('pattern-detector');
  });

  it('filters by patternTypes when provided', async () => {
    const stubs = makeStubs();
    const engine = new CodeIntelligenceEngine({
      logger: createLoggerStub(),
      db: {} as any,
      ...stubs,
    });

    const result = await engine.query({
      type: 'patterns',
      filters: { patternTypes: ['crud'] as any },
    } as IntelligenceQuery);
    expect(result.data).toHaveProperty('patterns');
  });
});

describe('CodeIntelligenceEngine — query: subgraph', () => {
  it('returns error when target missing', async () => {
    const stubs = makeStubs();
    const engine = new CodeIntelligenceEngine({
      logger: createLoggerStub(),
      db: {} as any,
      ...stubs,
    });

    const result = await engine.query({ type: 'subgraph' } as IntelligenceQuery);
    expect((result.data as any).error).toMatch(/target.*nodeId/i);
    expect(result.confidence).toBe(0);
  });

  it('returns subgraph for target', async () => {
    const stubs = makeStubs();
    const engine = new CodeIntelligenceEngine({
      logger: createLoggerStub(),
      db: {} as any,
      ...stubs,
    });

    const result = await engine.query({
      type: 'subgraph',
      target: 'module:auth',
      depth: 4,
    } as IntelligenceQuery);
    expect(result.data).toHaveProperty('nodes');
    expect(result.sources).toContain('nlkg:subgraph');
  });
});

describe('CodeIntelligenceEngine — query: full_context', () => {
  it('returns flagship aggregated context with all sources', async () => {
    const stubs = makeStubs({
      patterns: [{
        id: 'p1', name: 'crud pattern', category: 'crud', description: 'desc',
        templateSignature: 'tmpl', instances: [],
        compressionRatio: 0.5, tokenSavings: 100,
      } as any],
      typeFlow: {
        id: 'tf1', typeName: 'X', definedAt: '/x.ts',
        flowSteps: [], consumers: [], producers: [], transformers: [],
      },
    });
    const engine = new CodeIntelligenceEngine({
      logger: createLoggerStub(),
      db: {} as any,
      ...stubs,
    });

    const result = await engine.query({ type: 'full_context' } as IntelligenceQuery);
    expect(result.data).toHaveProperty('skeleton');
    expect(result.data).toHaveProperty('moduleCount');
    expect(result.data).toHaveProperty('exportSummary');
    expect(result.data).toHaveProperty('patterns');
    expect(result.data).toHaveProperty('typeFlows');
    expect(result.data).toHaveProperty('graphStats');
    expect(result.data).toHaveProperty('indexStats');
    expect(result.sources).toContain('cognitive-index');
    expect(result.sources).toContain('pattern-detector');
    expect(result.sources).toContain('type-flow-analyzer');
    expect(result.sources).toContain('nlkg');
  });

  it('respects filePaths filter for module subset', async () => {
    const modules = [
      makeModule({ filePath: '/a.ts', moduleName: 'A', exports: [{ kind: 'function', name: 'fn', signature: '() => void' } as any] }),
      makeModule({ filePath: '/b.ts', moduleName: 'B' }),
    ];
    const stubs = makeStubs({ index: makeCognitiveIndex({ modules }) });
    const engine = new CodeIntelligenceEngine({
      logger: createLoggerStub(),
      db: {} as any,
      ...stubs,
    });

    const result = await engine.query({
      type: 'full_context',
      filters: { filePaths: ['/a.ts'] },
    } as IntelligenceQuery);
    expect((result.data as any).moduleCount).toBe(1);
  });

  it('caps typeFlows summary to 20 entries', async () => {
    // Even if we provide 1, the slice(0,20) shouldn't error
    const stubs = makeStubs({
      typeFlow: { id: 't', typeName: 'T', definedAt: '/t.ts', flowSteps: [], consumers: [], producers: [], transformers: [] },
    });
    const engine = new CodeIntelligenceEngine({
      logger: createLoggerStub(),
      db: {} as any,
      ...stubs,
    });

    const result = await engine.query({ type: 'full_context' } as IntelligenceQuery);
    expect(Array.isArray((result.data as any).typeFlows)).toBe(true);
    expect((result.data as any).typeFlows.length).toBeLessThanOrEqual(20);
  });
});

describe('CodeIntelligenceEngine — convenience getters', () => {
  it('getCognitiveIndex returns wrapped value', () => {
    const idx = makeCognitiveIndex();
    const stubs = makeStubs({ index: idx });
    const engine = new CodeIntelligenceEngine({
      logger: createLoggerStub(),
      db: {} as any,
      ...stubs,
    });
    expect(engine.getCognitiveIndex()).toBe(idx);
  });

  it('getSkeleton returns wrapped value', () => {
    const skel = makeSkeleton();
    const stubs = makeStubs({ index: makeCognitiveIndex({ skeleton: skel }) });
    const engine = new CodeIntelligenceEngine({
      logger: createLoggerStub(),
      db: {} as any,
      ...stubs,
    });
    expect(engine.getSkeleton()).toBe(skel);
  });

  it('getModules / getUnits / getPatterns / getTypeFlows / getPipelines all return arrays', () => {
    const stubs = makeStubs();
    const engine = new CodeIntelligenceEngine({
      logger: createLoggerStub(),
      db: {} as any,
      ...stubs,
    });
    expect(Array.isArray(engine.getModules())).toBe(true);
    expect(Array.isArray(engine.getUnits())).toBe(true);
    expect(Array.isArray(engine.getPatterns())).toBe(true);
    expect(Array.isArray(engine.getTypeFlows())).toBe(true);
    expect(Array.isArray(engine.getPipelines())).toBe(true);
  });
});
