import { describe, it, expect, beforeEach } from 'vitest';
import { TypeFlowAnalyzer } from '../lib/type-flow-analyzer';
import type { ModuleContract, UnitFingerprint } from '../types/index';

/**
 * Phase B2.7 (M5 audit) -- jcf-healthcare-agent-hub type-flow-analyzer contract tests.
 * Tests TypeFlowAnalyzer: type definition tracing, flow operation classification
 * (consumes/produces/transforms/validates/serializes), pipeline traversal with
 * branch + cycle detection, and stats aggregation.
 */

function createLoggerStub(): any {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
}

function makeUnit(overrides: Partial<UnitFingerprint> = {}): UnitFingerprint {
  return {
    id: 'unit:test',
    name: 'testFn',
    filePath: '/test/file.ts',
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
    filePath: '/test/module.ts',
    definedTypes: [],
    exports: [],
    imports: [],
    patternClassification: [],
    ...overrides,
  } as ModuleContract;
}

describe('TypeFlowAnalyzer — initialization & lifecycle', () => {
  let analyzer: TypeFlowAnalyzer;

  beforeEach(() => {
    analyzer = new TypeFlowAnalyzer({ logger: createLoggerStub() });
  });

  it('constructs without throwing', () => {
    expect(analyzer).toBeDefined();
  });

  it('initialize() resolves without throwing', async () => {
    await expect(analyzer.initialize()).resolves.toBeUndefined();
  });

  it('starts with empty type flows and pipelines', () => {
    expect(analyzer.getAllTypeFlows()).toEqual([]);
    expect(analyzer.getPipelines()).toEqual([]);
  });

  it('getStats returns zero counts on empty state', () => {
    const stats = analyzer.getStats();
    expect(stats.typeFlowCount).toBe(0);
    expect(stats.pipelineCount).toBe(0);
    expect(stats.avgStepsPerFlow).toBe(0);
    expect(stats.avgStepsPerPipeline).toBe(0);
  });
});

describe('TypeFlowAnalyzer — analyzeTypeFlows', () => {
  let analyzer: TypeFlowAnalyzer;

  beforeEach(() => {
    analyzer = new TypeFlowAnalyzer({ logger: createLoggerStub() });
  });

  it('returns empty array when no modules or units provided', () => {
    const result = analyzer.analyzeTypeFlows([], []);
    expect(result).toEqual([]);
  });

  it('detects type flows when units reference defined types', () => {
    const modules: ModuleContract[] = [
      makeModule({
        filePath: '/api/types.ts',
        definedTypes: [{ name: 'UserSession', kind: 'interface' } as any],
      }),
    ];
    const units: UnitFingerprint[] = [
      makeUnit({
        id: 'u1',
        name: 'createSession',
        outputSignature: 'UserSession',
        patternType: 'command',
      }),
      makeUnit({
        id: 'u2',
        name: 'consumeSession',
        inputSignature: 'UserSession',
        patternType: 'handler',
      }),
    ];

    const flows = analyzer.analyzeTypeFlows(modules, units);
    expect(flows.length).toBe(1);
    expect(flows[0].typeName).toBe('UserSession');
    expect(flows[0].definedAt).toBe('/api/types.ts');
    expect(flows[0].flowSteps.length).toBe(2);
  });

  it('classifies producers (output type, no input type)', () => {
    const modules: ModuleContract[] = [
      makeModule({ definedTypes: [{ name: 'Foo', kind: 'class' } as any] }),
    ];
    const units: UnitFingerprint[] = [
      makeUnit({ id: 'p1', outputSignature: 'Foo', inputSignature: 'void' }),
    ];
    const flows = analyzer.analyzeTypeFlows(modules, units);
    expect(flows[0].producers).toContain('p1');
  });

  it('classifies consumers (input type, no output type)', () => {
    const modules: ModuleContract[] = [
      makeModule({ definedTypes: [{ name: 'Bar', kind: 'interface' } as any] }),
    ];
    const units: UnitFingerprint[] = [
      makeUnit({ id: 'c1', inputSignature: 'Bar', outputSignature: 'void' }),
    ];
    const flows = analyzer.analyzeTypeFlows(modules, units);
    expect(flows[0].consumers).toContain('c1');
  });

  it('classifies transformers (input + output type, patternType=transformer)', () => {
    const modules: ModuleContract[] = [
      makeModule({ definedTypes: [{ name: 'Data', kind: 'class' } as any] }),
    ];
    const units: UnitFingerprint[] = [
      makeUnit({
        id: 't1',
        inputSignature: 'Data',
        outputSignature: 'Data',
        patternType: 'transformer',
      }),
    ];
    const flows = analyzer.analyzeTypeFlows(modules, units);
    expect(flows[0].transformers).toContain('t1');
  });

  it('classifies validates operation (input + patternType=validation)', () => {
    const modules: ModuleContract[] = [
      makeModule({ definedTypes: [{ name: 'Cmd', kind: 'class' } as any] }),
    ];
    const units: UnitFingerprint[] = [
      makeUnit({
        id: 'v1',
        inputSignature: 'Cmd',
        outputSignature: 'void',
        patternType: 'validation',
      }),
    ];
    const flows = analyzer.analyzeTypeFlows(modules, units);
    const v1Step = flows[0].flowSteps.find(s => s.nodeId === 'v1');
    expect(v1Step?.operation).toBe('validates');
  });

  it('classifies serializes operation (input+output have type, network-io tag, non-transformer pattern)', () => {
    // Note: serializes branch fires only when input+output both have type but
    // patternType is NOT transformer/validation -- otherwise produces/transforms
    // takes precedence due to else-if chain ordering.
    const modules: ModuleContract[] = [
      makeModule({ definedTypes: [{ name: 'Resp', kind: 'class' } as any] }),
    ];
    const units: UnitFingerprint[] = [
      makeUnit({
        id: 's1',
        outputSignature: 'Resp',
        inputSignature: 'Resp', // input also has type
        patternType: 'handler', // not transformer, not validation
        semanticTags: ['network-io'],
      }),
    ];
    const flows = analyzer.analyzeTypeFlows(modules, units);
    const s1Step = flows[0].flowSteps.find(s => s.nodeId === 's1');
    expect(s1Step?.operation).toBe('serializes');
  });

  it('skips units with no relation to the type', () => {
    const modules: ModuleContract[] = [
      makeModule({ definedTypes: [{ name: 'Used', kind: 'interface' } as any] }),
    ];
    const units: UnitFingerprint[] = [
      makeUnit({ id: 'unrelated', inputSignature: 'void', outputSignature: 'void' }),
    ];
    const flows = analyzer.analyzeTypeFlows(modules, units);
    // Should NOT create a flow with zero steps
    expect(flows).toHaveLength(0);
  });

  it('detects type via typeDependencies field', () => {
    const modules: ModuleContract[] = [
      makeModule({ definedTypes: [{ name: 'DepType', kind: 'interface' } as any] }),
    ];
    const units: UnitFingerprint[] = [
      makeUnit({
        id: 'u-dep-1',
        typeDependencies: ['DepType'],
      }),
      makeUnit({
        id: 'u-dep-2',
        typeDependencies: ['DepType'],
      }),
    ];
    const flows = analyzer.analyzeTypeFlows(modules, units);
    expect(flows[0].flowSteps.length).toBe(2);
  });

  it('clears prior flows on subsequent analyze call', () => {
    const modules1: ModuleContract[] = [
      makeModule({ definedTypes: [{ name: 'T1', kind: 'class' } as any] }),
    ];
    const units1: UnitFingerprint[] = [makeUnit({ inputSignature: 'T1' })];
    analyzer.analyzeTypeFlows(modules1, units1);
    expect(analyzer.getAllTypeFlows().length).toBe(1);

    // Run again with empty -- should clear
    analyzer.analyzeTypeFlows([], []);
    expect(analyzer.getAllTypeFlows().length).toBe(0);
  });
});

describe('TypeFlowAnalyzer — getTypeFlow / consumers / producers', () => {
  let analyzer: TypeFlowAnalyzer;

  beforeEach(() => {
    analyzer = new TypeFlowAnalyzer({ logger: createLoggerStub() });
  });

  it('getTypeFlow returns undefined for unknown type', () => {
    expect(analyzer.getTypeFlow('Nonexistent')).toBeUndefined();
  });

  it('getTypeConsumers returns empty array for unknown type', () => {
    expect(analyzer.getTypeConsumers('Unknown')).toEqual([]);
  });

  it('getTypeProducers returns empty array for unknown type', () => {
    expect(analyzer.getTypeProducers('Unknown')).toEqual([]);
  });

  it('returns correct flow after analyze', () => {
    const modules: ModuleContract[] = [
      makeModule({ definedTypes: [{ name: 'X', kind: 'class' } as any] }),
    ];
    const units: UnitFingerprint[] = [
      makeUnit({ id: 'p', outputSignature: 'X', inputSignature: 'void' }),
      makeUnit({ id: 'c', inputSignature: 'X', outputSignature: 'void' }),
    ];
    analyzer.analyzeTypeFlows(modules, units);

    const flow = analyzer.getTypeFlow('X');
    expect(flow).toBeDefined();
    expect(flow!.typeName).toBe('X');

    expect(analyzer.getTypeConsumers('X')).toContain('c');
    expect(analyzer.getTypeProducers('X')).toContain('p');
  });
});

describe('TypeFlowAnalyzer — analyzeDataPipelines', () => {
  let analyzer: TypeFlowAnalyzer;

  beforeEach(() => {
    analyzer = new TypeFlowAnalyzer({ logger: createLoggerStub() });
  });

  it('returns empty array when no entry points provided', () => {
    expect(analyzer.analyzeDataPipelines([], [])).toEqual([]);
  });

  it('skips entry points without matching units', () => {
    const units = [makeUnit({ filePath: '/other.ts' })];
    const result = analyzer.analyzeDataPipelines(units, ['/missing.ts']);
    expect(result).toEqual([]);
  });

  it('builds pipeline from handler entry point', () => {
    const units: UnitFingerprint[] = [
      makeUnit({
        id: 'h',
        name: 'handle',
        filePath: '/api/handler.ts',
        patternType: 'handler',
        callTargets: ['validate'],
      }),
      makeUnit({
        id: 'v',
        name: 'validate',
        filePath: '/api/validator.ts',
        patternType: 'validation',
        callTargets: [],
      }),
    ];

    const pipelines = analyzer.analyzeDataPipelines(units, ['/api/handler.ts']);
    expect(pipelines.length).toBe(1);
    expect(pipelines[0].entryPoint).toBe('h');
    expect(pipelines[0].steps.length).toBeGreaterThanOrEqual(1);
    expect(pipelines[0].name).toContain('handle');
  });

  it('detects branching points when unit has >1 call targets', () => {
    const units: UnitFingerprint[] = [
      makeUnit({
        id: 'fork',
        name: 'fork',
        filePath: '/api/fork.ts',
        patternType: 'handler',
        callTargets: ['a', 'b', 'c'],
      }),
      makeUnit({ id: 'a', name: 'a', filePath: '/a.ts' }),
      makeUnit({ id: 'b', name: 'b', filePath: '/b.ts' }),
      makeUnit({ id: 'c', name: 'c', filePath: '/c.ts' }),
    ];

    const pipelines = analyzer.analyzeDataPipelines(units, ['/api/fork.ts']);
    expect(pipelines[0].branchingPoints).toContain('fork');
  });

  it('caps recursion depth (does not infinite loop on cycles)', () => {
    // Cycle: a → b → a
    const units: UnitFingerprint[] = [
      makeUnit({
        id: 'a',
        name: 'a',
        filePath: '/cycle.ts',
        patternType: 'handler',
        callTargets: ['b'],
      }),
      makeUnit({
        id: 'b',
        name: 'b',
        filePath: '/cycle.ts',
        patternType: 'handler',
        callTargets: ['a'],
      }),
    ];

    const pipelines = analyzer.analyzeDataPipelines(units, ['/cycle.ts']);
    // Should not hang; should produce finite steps
    expect(pipelines.length).toBeGreaterThanOrEqual(0);
    if (pipelines.length > 0) {
      expect(pipelines[0].steps.length).toBeLessThan(100);
    }
  });

  it('handles network-io semantic tag entry points', () => {
    const units: UnitFingerprint[] = [
      makeUnit({
        id: 'api',
        name: 'apiHandler',
        filePath: '/api/server.ts',
        semanticTags: ['network-io'],
        patternType: 'utility', // not handler, but has network-io tag
      }),
    ];
    const pipelines = analyzer.analyzeDataPipelines(units, ['/api/server.ts']);
    expect(pipelines.length).toBe(1);
  });

  it('classifies operations: command→stores, query→produces', () => {
    const units: UnitFingerprint[] = [
      makeUnit({
        id: 'h',
        name: 'h',
        filePath: '/p.ts',
        patternType: 'handler',
        callTargets: ['cmd', 'q'],
      }),
      makeUnit({ id: 'cmd', name: 'cmd', filePath: '/cmd.ts', patternType: 'command' }),
      makeUnit({ id: 'q', name: 'q', filePath: '/q.ts', patternType: 'query' }),
    ];

    const pipelines = analyzer.analyzeDataPipelines(units, ['/p.ts']);
    const ops = pipelines[0].steps.map(s => s.operation);
    expect(ops).toContain('stores');
    expect(ops).toContain('produces');
  });
});

describe('TypeFlowAnalyzer — broadened pipeline entry criteria', () => {
  let analyzer: TypeFlowAnalyzer;

  beforeEach(() => {
    analyzer = new TypeFlowAnalyzer({ logger: createLoggerStub() });
  });

  it('builds pipeline from async-operation patternType entry', () => {
    const units: UnitFingerprint[] = [
      makeUnit({
        id: 'main',
        name: 'main',
        filePath: '/src/index.ts',
        patternType: 'async-operation',
        callTargets: ['setup'],
      }),
      makeUnit({ id: 'setup', name: 'setup', filePath: '/src/setup.ts', callTargets: [] }),
    ];
    const pipelines = analyzer.analyzeDataPipelines(units, ['/src/index.ts']);
    expect(pipelines.length).toBe(1);
    expect(pipelines[0].steps.length).toBeGreaterThanOrEqual(1);
  });

  it('builds pipeline from initializer patternType entry', () => {
    const units: UnitFingerprint[] = [
      makeUnit({
        id: 'init',
        name: 'initialize',
        filePath: '/src/app.ts',
        patternType: 'initializer',
        callTargets: [],
      }),
    ];
    const pipelines = analyzer.analyzeDataPipelines(units, ['/src/app.ts']);
    expect(pipelines.length).toBe(1);
  });

  it('builds pipeline from name-matched entry (main, init, start, bootstrap)', () => {
    for (const name of ['main', 'initServer', 'startApp', 'bootstrapModule', 'setupRoutes', 'runWorker', 'launchProcess']) {
      const a = new TypeFlowAnalyzer({ logger: createLoggerStub() });
      const units: UnitFingerprint[] = [
        makeUnit({
          id: `u-${name}`,
          name,
          filePath: '/entry.ts',
          patternType: 'utility',
          callTargets: [],
        }),
      ];
      const pipelines = a.analyzeDataPipelines(units, ['/entry.ts']);
      expect(pipelines.length).toBe(1);
    }
  });

  it('still skips entry points with no matching unit criteria', () => {
    const units: UnitFingerprint[] = [
      makeUnit({
        id: 'helper',
        name: 'helperFn',
        filePath: '/src/server.ts',
        patternType: 'utility',
        semanticTags: [],
      }),
    ];
    const pipelines = analyzer.analyzeDataPipelines(units, ['/src/server.ts']);
    expect(pipelines.length).toBe(0);
  });
});

describe('TypeFlowAnalyzer — getStats with populated state', () => {
  it('computes averages correctly across multiple flows', () => {
    const analyzer = new TypeFlowAnalyzer({ logger: createLoggerStub() });
    const modules: ModuleContract[] = [
      makeModule({ definedTypes: [{ name: 'A', kind: 'class' } as any, { name: 'B', kind: 'class' } as any] }),
    ];
    const units: UnitFingerprint[] = [
      makeUnit({ id: '1', inputSignature: 'A', outputSignature: 'void' }),
      makeUnit({ id: '2', outputSignature: 'A', inputSignature: 'void' }),
      makeUnit({ id: '3', inputSignature: 'B', outputSignature: 'void' }),
    ];
    analyzer.analyzeTypeFlows(modules, units);

    const stats = analyzer.getStats();
    expect(stats.typeFlowCount).toBe(2);
    expect(stats.avgStepsPerFlow).toBeGreaterThan(0);
  });
});
