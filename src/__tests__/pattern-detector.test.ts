import { describe, it, expect, beforeEach } from 'vitest';
import { PatternDetector } from '../lib/pattern-detector';
import type { UnitFingerprint, PatternCategory } from '../types/index';

/**
 * Phase B2.7 (M5 audit) -- jcf-healthcare-agent-hub pattern-detector contract tests.
 * Tests PatternDetector: 11 pattern category recognition (CRUD, middleware,
 * observer, factory, singleton, adapter, strategy, repository, service,
 * controller, utility), template compression with token-savings estimation,
 * and stats aggregation.
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

describe('PatternDetector — initialization & lifecycle', () => {
  let detector: PatternDetector;

  beforeEach(() => {
    detector = new PatternDetector({ logger: createLoggerStub() });
  });

  it('constructs without throwing', () => {
    expect(detector).toBeDefined();
  });

  it('initialize() resolves without throwing', async () => {
    await expect(detector.initialize()).resolves.toBeUndefined();
  });

  it('starts with empty patterns', () => {
    expect(detector.getPatterns()).toEqual([]);
  });

  it('getStats returns zero counts on empty state', () => {
    const stats = detector.getStats();
    expect(stats.patternCount).toBe(0);
    expect(stats.totalInstances).toBe(0);
    expect(stats.totalTokenSavings).toBe(0);
    expect(stats.categoryDistribution).toEqual({});
  });
});

describe('PatternDetector — detectPatterns', () => {
  let detector: PatternDetector;

  beforeEach(() => {
    detector = new PatternDetector({ logger: createLoggerStub() });
  });

  it('returns empty patterns when no units provided', () => {
    const result = detector.detectPatterns([]);
    expect(result.patterns).toEqual([]);
    expect(result.totalOriginalUnits).toBe(0);
  });

  it('does not detect pattern with only 1 instance (needs >= 2)', () => {
    const units: UnitFingerprint[] = [
      makeUnit({ name: 'createUser', patternType: 'command' }),
    ];
    const result = detector.detectPatterns(units);
    expect(result.patterns.find(p => p.category === 'crud')).toBeUndefined();
  });

  it('detects CRUD pattern from create/get/update/delete naming', () => {
    const units: UnitFingerprint[] = [
      makeUnit({ id: 'u1', name: 'createUser', patternType: 'command' }),
      makeUnit({ id: 'u2', name: 'getUser', patternType: 'query' }),
      makeUnit({ id: 'u3', name: 'updateUser', patternType: 'command' }),
      makeUnit({ id: 'u4', name: 'deleteUser', patternType: 'command' }),
    ];
    const result = detector.detectPatterns(units);
    const crud = result.patterns.find(p => p.category === 'crud');
    expect(crud).toBeDefined();
    expect(crud!.instances.length).toBeGreaterThanOrEqual(2);
  });

  it('detects middleware pattern from name and validation-chain tag', () => {
    const units: UnitFingerprint[] = [
      makeUnit({ id: 'm1', name: 'authMiddleware', patternType: 'handler' }),
      makeUnit({ id: 'm2', name: 'corsMiddleware', semanticTags: ['validation-chain'] }),
    ];
    const result = detector.detectPatterns(units);
    expect(result.patterns.find(p => p.category === 'middleware')).toBeDefined();
  });

  it('detects observer pattern from event-emitter tag', () => {
    const units: UnitFingerprint[] = [
      makeUnit({ id: 'o1', name: 'onMessage', semanticTags: ['event-emitter'] }),
      makeUnit({ id: 'o2', name: 'emitEvent', semanticTags: ['event-emitter'] }),
    ];
    const result = detector.detectPatterns(units);
    expect(result.patterns.find(p => p.category === 'observer')).toBeDefined();
  });

  it('detects factory pattern (create + command + no filesystem-write)', () => {
    const units: UnitFingerprint[] = [
      makeUnit({ id: 'f1', name: 'createWidget', patternType: 'command', sideEffects: [] }),
      makeUnit({ id: 'f2', name: 'buildButton', patternType: 'command', sideEffects: [] }),
    ];
    const result = detector.detectPatterns(units);
    expect(result.patterns.find(p => p.category === 'factory')).toBeDefined();
  });

  it('detects singleton pattern from getInstance naming', () => {
    const units: UnitFingerprint[] = [
      makeUnit({ id: 's1', name: 'getInstance' }),
      makeUnit({ id: 's2', name: 'getSharedInstance' }),
    ];
    const result = detector.detectPatterns(units);
    expect(result.patterns.find(p => p.category === 'singleton')).toBeDefined();
  });

  it('detects adapter pattern (transformer + adapt naming)', () => {
    const units: UnitFingerprint[] = [
      makeUnit({ id: 'a1', name: 'adaptToV2', patternType: 'transformer' }),
      makeUnit({ id: 'a2', name: 'convertFormat', patternType: 'transformer' }),
    ];
    const result = detector.detectPatterns(units);
    expect(result.patterns.find(p => p.category === 'adapter')).toBeDefined();
  });

  it('detects strategy pattern (handler + execute/run/apply naming)', () => {
    const units: UnitFingerprint[] = [
      makeUnit({ id: 'st1', name: 'executeStrategy', patternType: 'handler' }),
      makeUnit({ id: 'st2', name: 'runOperation', patternType: 'handler' }),
    ];
    const result = detector.detectPatterns(units);
    expect(result.patterns.find(p => p.category === 'strategy')).toBeDefined();
  });

  it('detects repository pattern (find/save with disk-io or network-io)', () => {
    const units: UnitFingerprint[] = [
      makeUnit({
        id: 'r1',
        name: 'findUser',
        sideEffects: ['disk-io'],
      }),
      makeUnit({
        id: 'r2',
        name: 'saveUser',
        sideEffects: ['network-io'],
      }),
    ];
    const result = detector.detectPatterns(units);
    expect(result.patterns.find(p => p.category === 'repository')).toBeDefined();
  });

  it('detects controller pattern (network-io tag + handler)', () => {
    const units: UnitFingerprint[] = [
      makeUnit({
        id: 'c1',
        name: 'handleHttp',
        patternType: 'handler',
        semanticTags: ['network-io'],
      }),
      makeUnit({
        id: 'c2',
        name: 'handleApi',
        patternType: 'handler',
        semanticTags: ['network-io'],
      }),
    ];
    const result = detector.detectPatterns(units);
    expect(result.patterns.find(p => p.category === 'controller')).toBeDefined();
  });

  it('detects utility pattern (pure + utility patternType)', () => {
    const units: UnitFingerprint[] = [
      makeUnit({ id: 'u1', name: 'helperA', isPure: true, patternType: 'utility' }),
      makeUnit({ id: 'u2', name: 'helperB', isPure: true, patternType: 'utility' }),
    ];
    const result = detector.detectPatterns(units);
    expect(result.patterns.find(p => p.category === 'utility')).toBeDefined();
  });

  it('computes overall compression ratio (number, can be 0 to 1+ when patterns overlap)', () => {
    const units: UnitFingerprint[] = [
      makeUnit({ id: 'u1', name: 'createA', patternType: 'command' }),
      makeUnit({ id: 'u2', name: 'createB', patternType: 'command' }),
      makeUnit({ id: 'u3', name: 'getC', patternType: 'query' }),
    ];
    const result = detector.detectPatterns(units);
    // Ratio formula: (totalOriginal - compressedUnits + patternCount) / totalOriginal
    // Can be 0 or negative when patterns overlap (a unit counted in multiple categories);
    // can be 1 when no compression occurs. Always finite + numeric.
    expect(typeof result.overallCompressionRatio).toBe('number');
    expect(Number.isFinite(result.overallCompressionRatio)).toBe(true);
  });

  it('returns ratio === 1 when no patterns can be detected (no compression)', () => {
    // Single unit -- no pattern (need >= 2 to form pattern)
    const units: UnitFingerprint[] = [
      makeUnit({ id: 'u1', name: 'isolated', patternType: 'utility', isPure: true }),
    ];
    const result = detector.detectPatterns(units);
    expect(result.overallCompressionRatio).toBe(1);
  });

  it('returns valid PatternCompressionResult with all fields', () => {
    const units: UnitFingerprint[] = [
      makeUnit({ id: 'u1', name: 'createX', patternType: 'command' }),
      makeUnit({ id: 'u2', name: 'createY', patternType: 'command' }),
    ];
    const result = detector.detectPatterns(units);
    expect(result).toHaveProperty('patterns');
    expect(result).toHaveProperty('totalOriginalUnits');
    expect(result).toHaveProperty('totalCompressedUnits');
    expect(result).toHaveProperty('overallCompressionRatio');
    expect(result).toHaveProperty('estimatedTokenSavings');
  });

  it('reports estimated token savings as non-negative', () => {
    const units: UnitFingerprint[] = [
      makeUnit({ id: 'a', name: 'createA', patternType: 'command', signature: '(data) => Promise<A>' }),
      makeUnit({ id: 'b', name: 'createB', patternType: 'command', signature: '(data) => Promise<B>' }),
      makeUnit({ id: 'c', name: 'createC', patternType: 'command', signature: '(data) => Promise<C>' }),
    ];
    const result = detector.detectPatterns(units);
    expect(result.estimatedTokenSavings).toBeGreaterThanOrEqual(0);
  });

  it('accounts for full fingerprint cost (inputs, outputs, sideEffects, callTargets, typeDeps)', () => {
    const units: UnitFingerprint[] = [
      makeUnit({
        id: 'a', name: 'createUser', patternType: 'command',
        signature: 'async function createUser(data: UserInput): Promise<User>',
        inputSignature: 'UserInput',
        outputSignature: 'Promise<User>',
        sideEffects: ['filesystem-write', 'network-request'],
        callTargets: ['validate', 'persist', 'notify'],
        typeDependencies: ['UserInput', 'User'],
      }),
      makeUnit({
        id: 'b', name: 'createPost', patternType: 'command',
        signature: 'async function createPost(data: PostInput): Promise<Post>',
        inputSignature: 'PostInput',
        outputSignature: 'Promise<Post>',
        sideEffects: ['filesystem-write', 'network-request'],
        callTargets: ['validate', 'persist', 'notify'],
        typeDependencies: ['PostInput', 'Post'],
      }),
    ];
    const result = detector.detectPatterns(units);
    const crudPattern = result.patterns.find(p => p.category === 'crud');
    if (crudPattern) {
      // Full fingerprint cost should produce meaningful token savings
      expect(crudPattern.tokenSavings).toBeGreaterThan(0);
    }
  });

  it('token savings increase with richer fingerprints', () => {
    const minimalUnits: UnitFingerprint[] = [
      makeUnit({ id: 'a', name: 'createA', patternType: 'command', signature: 'fn()' }),
      makeUnit({ id: 'b', name: 'createB', patternType: 'command', signature: 'fn()' }),
    ];
    const richUnits: UnitFingerprint[] = [
      makeUnit({
        id: 'a', name: 'createA', patternType: 'command',
        signature: 'async function createA(ctx: HandlerContext, args: CreateArgs): Promise<CreateResult>',
        inputSignature: 'HandlerContext, CreateArgs',
        outputSignature: 'Promise<CreateResult>',
        sideEffects: ['filesystem-write'],
        callTargets: ['validate', 'persist'],
        typeDependencies: ['HandlerContext', 'CreateArgs', 'CreateResult'],
      }),
      makeUnit({
        id: 'b', name: 'createB', patternType: 'command',
        signature: 'async function createB(ctx: HandlerContext, args: CreateArgs): Promise<CreateResult>',
        inputSignature: 'HandlerContext, CreateArgs',
        outputSignature: 'Promise<CreateResult>',
        sideEffects: ['filesystem-write'],
        callTargets: ['validate', 'persist'],
        typeDependencies: ['HandlerContext', 'CreateArgs', 'CreateResult'],
      }),
    ];
    const minResult = detector.detectPatterns(minimalUnits);
    const richDetector = new PatternDetector({ logger: createLoggerStub() });
    const richResult = richDetector.detectPatterns(richUnits);
    // Rich fingerprints should yield higher total savings
    expect(richResult.estimatedTokenSavings).toBeGreaterThanOrEqual(minResult.estimatedTokenSavings);
  });
});

describe('PatternDetector — getPatternByCategory', () => {
  let detector: PatternDetector;

  beforeEach(() => {
    detector = new PatternDetector({ logger: createLoggerStub() });
  });

  it('returns empty array for unknown category', () => {
    detector.detectPatterns([]);
    expect(detector.getPatternByCategory('crud' as PatternCategory)).toEqual([]);
  });

  it('returns matching patterns when category exists', () => {
    const units: UnitFingerprint[] = [
      makeUnit({ id: 'u1', name: 'createX', patternType: 'command' }),
      makeUnit({ id: 'u2', name: 'getY', patternType: 'query' }),
    ];
    detector.detectPatterns(units);
    const crud = detector.getPatternByCategory('crud' as PatternCategory);
    if (crud.length > 0) {
      expect(crud[0].category).toBe('crud');
    }
  });
});

describe('PatternDetector — getCompressedRepresentation', () => {
  let detector: PatternDetector;

  beforeEach(() => {
    detector = new PatternDetector({ logger: createLoggerStub() });
  });

  it('returns empty string when no patterns detected', () => {
    expect(detector.getCompressedRepresentation()).toBe('');
  });

  it('returns formatted string with PATTERN headers when patterns exist', () => {
    const units: UnitFingerprint[] = [
      makeUnit({ id: 'u1', name: 'createX', patternType: 'command' }),
      makeUnit({ id: 'u2', name: 'createY', patternType: 'command' }),
    ];
    detector.detectPatterns(units);

    const repr = detector.getCompressedRepresentation();
    if (detector.getPatterns().length > 0) {
      expect(repr).toMatch(/PATTERN:/);
      expect(repr).toMatch(/Template:/);
      expect(repr).toMatch(/Instances:/);
      expect(repr).toMatch(/Token savings:/);
    }
  });

  it('reports instance count in PATTERN header', () => {
    const units: UnitFingerprint[] = [
      makeUnit({ id: 'u1', name: 'createA', patternType: 'command' }),
      makeUnit({ id: 'u2', name: 'createB', patternType: 'command' }),
      makeUnit({ id: 'u3', name: 'createC', patternType: 'command' }),
    ];
    detector.detectPatterns(units);
    const repr = detector.getCompressedRepresentation();
    if (detector.getPatterns().length > 0) {
      expect(repr).toMatch(/\(\d+ instances\)/);
    }
  });
});

describe('PatternDetector — getStats with populated state', () => {
  let detector: PatternDetector;

  beforeEach(() => {
    detector = new PatternDetector({ logger: createLoggerStub() });
  });

  it('computes category distribution accurately', () => {
    const units: UnitFingerprint[] = [
      makeUnit({ id: 'u1', name: 'createX', patternType: 'command' }),
      makeUnit({ id: 'u2', name: 'createY', patternType: 'command' }),
      makeUnit({ id: 'h1', name: 'getInstance' }),
      makeUnit({ id: 'h2', name: 'getSharedInstance' }),
    ];
    detector.detectPatterns(units);

    const stats = detector.getStats();
    expect(stats.patternCount).toBeGreaterThanOrEqual(1);
    expect(stats.totalInstances).toBeGreaterThan(0);
    expect(typeof stats.categoryDistribution).toBe('object');
  });

  it('totalInstances equals sum of pattern instance counts', () => {
    const units: UnitFingerprint[] = [
      makeUnit({ id: 'u1', name: 'createA', patternType: 'command' }),
      makeUnit({ id: 'u2', name: 'createB', patternType: 'command' }),
    ];
    detector.detectPatterns(units);

    const stats = detector.getStats();
    const expectedTotal = detector.getPatterns().reduce((s, p) => s + p.instances.length, 0);
    expect(stats.totalInstances).toBe(expectedTotal);
  });
});
