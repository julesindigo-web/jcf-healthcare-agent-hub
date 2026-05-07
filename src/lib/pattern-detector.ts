import crypto from 'node:crypto';
import { Logger } from './logger.js';
import type {
  CodePattern, PatternCategory, PatternInstance,
  PatternCompressionResult, UnitFingerprint,
} from '../types/index.js';

/**
 * M11-AUDIT FIX (MED-19): Stable, content-derived pattern ID.
 *
 * Previous implementation used `Date.now()`, which produced different IDs
 * on every `detectPatterns` call — making cross-call references brittle
 * (e.g. cache keys, audit log correlation, NLKG node references).
 *
 * The new ID is `pattern:<category>:<sha1-12-of-instance-list>`. Same
 * instance set → same ID. Different instance set → different ID.
 */
function stablePatternId(category: string, instances: PatternInstance[]): string {
  const fingerprint = instances
    .map(i => `${i.filePath}::${i.unitName}|${i.deltas.join(',')}`)
    .sort()
    .join('\n');
  const hash = crypto.createHash('sha1').update(fingerprint).digest('hex').slice(0, 12);
  return `pattern:${category}:${hash}`;
}

interface PatternSignature {
  category: PatternCategory;
  template: string;
  matcher: (unit: UnitFingerprint) => boolean;
  deltaExtractor: (unit: UnitFingerprint) => string[];
}

const PATTERN_SIGNATURES: PatternSignature[] = [
  {
    category: 'crud',
    template: 'CRUD<Entity> { create(data): Promise<Entity>; read(id): Promise<Entity>; update(id, data): Promise<Entity>; delete(id): Promise<void> }',
    matcher: (u) => /^(create|add|insert|new|save)(\w+)$/i.test(u.name) || /^(get|find|list|fetch|read|search)(\w+)$/i.test(u.name) || /^(update|edit|modify|patch)(\w+)$/i.test(u.name) || /^(delete|remove|destroy)(\w+)$/i.test(u.name),
    deltaExtractor: (u) => {
      const deltas: string[] = [];
      if (u.isAsync) deltas.push('async');
      if (u.sideEffects.includes('network-request')) deltas.push('network-io');
      if (u.sideEffects.includes('filesystem-write')) deltas.push('disk-io');
      if (u.complexity > 5) deltas.push(`complexity:${u.complexity}`);
      return deltas;
    },
  },
  {
    category: 'middleware',
    template: 'Middleware { handle(req, next): Promise<void> }',
    matcher: (u) => /middleware/i.test(u.name) || u.semanticTags.includes('validation-chain') || (u.patternType === 'handler' && u.inputSignature.includes('next')),
    deltaExtractor: (u) => {
      const deltas: string[] = [];
      if (u.isAsync) deltas.push('async');
      if (u.sideEffects.includes('network-request')) deltas.push('network-io');
      return deltas;
    },
  },
  {
    category: 'observer',
    template: 'Observer { on(event, handler): void; emit(event, data): void }',
    matcher: (u) => u.semanticTags.includes('event-emitter') || /^(on|emit|subscribe|unsubscribe|listen)/i.test(u.name),
    deltaExtractor: (u) => [u.patternType],
  },
  {
    category: 'factory',
    template: 'Factory { create(type): Product }',
    matcher: (u) => /^(create|make|build|manufacture)(\w+)$/i.test(u.name) && u.patternType === 'command' && !u.sideEffects.includes('filesystem-write'),
    deltaExtractor: (u) => {
      const deltas: string[] = [];
      if (u.typeDependencies.length > 0) deltas.push(`creates:${u.typeDependencies.join(',')}`);
      return deltas;
    },
  },
  {
    category: 'singleton',
    template: 'Singleton { getInstance(): Self }',
    matcher: (u) => /^(getInstance|getShared|getDefault|createDefault)/i.test(u.name),
    deltaExtractor: () => [],
  },
  {
    category: 'adapter',
    template: 'Adapter { adapt(input): Output }',
    matcher: (u) => u.patternType === 'transformer' && /^(adapt|convert|transform|translate)/i.test(u.name),
    deltaExtractor: (u) => [`${u.inputSignature}→${u.outputSignature}`],
  },
  {
    category: 'strategy',
    template: 'Strategy { execute(context): Result }',
    matcher: (u) => /^(execute|run|apply|perform|process)/i.test(u.name) && u.patternType === 'handler',
    deltaExtractor: (u) => {
      const deltas: string[] = [];
      if (u.isAsync) deltas.push('async');
      if (u.callTargets.length > 3) deltas.push(`delegates:${u.callTargets.length}`);
      return deltas;
    },
  },
  {
    category: 'repository',
    template: 'Repository<Entity> { findById(id): Promise<Entity>; save(entity): Promise<void>; delete(id): Promise<void> }',
    matcher: (u) => (/^(find|get|list|search|save|delete|remove)/i.test(u.name) && u.sideEffects.some(s => s.includes('disk-io') || s.includes('network-io'))),
    deltaExtractor: (u) => {
      const deltas: string[] = [];
      if (u.sideEffects.includes('network-request')) deltas.push('remote-store');
      if (u.sideEffects.includes('filesystem-write')) deltas.push('local-store');
      return deltas;
    },
  },
  {
    category: 'service',
    template: 'Service { method(params): Promise<Result> }',
    matcher: (u) => u.patternType === 'handler' || (u.isAsync && u.patternType !== 'utility' && u.patternType !== 'query'),
    deltaExtractor: (u) => {
      const deltas: string[] = [];
      deltas.push(u.patternType);
      if (u.callTargets.length > 0) deltas.push(`calls:${u.callTargets.length}`);
      return deltas;
    },
  },
  {
    category: 'controller',
    template: 'Controller { handleRequest(req, res): Promise<void> }',
    matcher: (u) => u.semanticTags.includes('network-io') && u.patternType === 'handler',
    deltaExtractor: (u) => {
      const deltas: string[] = [];
      if (u.callTargets.some(c => c.includes('service') || c.includes('Service'))) deltas.push('delegates-to-service');
      return deltas;
    },
  },
  {
    category: 'utility',
    template: 'Utility { fn(input): Output } // pure, no side effects',
    matcher: (u) => u.isPure && u.patternType === 'utility',
    deltaExtractor: (u) => [`${u.inputSignature}→${u.outputSignature}`],
  },
];

export class PatternDetector {
  private logger: Logger;
  private patterns: CodePattern[] = [];

  constructor(config: { logger: Logger }) {
    this.logger = config.logger;
  }

  async initialize(): Promise<void> {
    this.logger.info('Initializing Pattern Detector');
  }

  detectPatterns(units: UnitFingerprint[]): PatternCompressionResult {
    this.logger.info('Detecting patterns', { units: units.length });
    const patternMap = new Map<string, CodePattern>();

    for (const sig of PATTERN_SIGNATURES) {
      const matchingUnits = units.filter(sig.matcher);
      if (matchingUnits.length < 2) continue; // Need at least 2 instances to form a pattern

      const instances: PatternInstance[] = matchingUnits.map(u => ({
        filePath: u.filePath,
        unitName: u.name,
        deltas: sig.deltaExtractor(u),
        confidence: this.computeInstanceConfidence(u, sig),
      }));

      const patternId = stablePatternId(sig.category, instances);
      const originalTokens = matchingUnits.reduce((s, u) => {
        const fingerprintCost = u.signature.length + u.inputSignature.length + u.outputSignature.length
          + u.sideEffects.join(',').length + u.callTargets.slice(0, 5).join(',').length
          + u.typeDependencies.join(',').length;
        return s + Math.round(fingerprintCost / 4);
      }, 0);
      const compressedTokens = Math.round(sig.template.length / 4) + instances.reduce((s, inst) => s + Math.round(inst.deltas.join(',').length / 4) + 8, 0);
      const savings = originalTokens - compressedTokens;

      const pattern: CodePattern = {
        id: patternId,
        name: `${sig.category} pattern`,
        category: sig.category,
        description: `Detected ${sig.category} pattern across ${instances.length} units`,
        templateSignature: sig.template,
        instances,
        compressionRatio: originalTokens > 0 ? compressedTokens / originalTokens : 1,
        tokenSavings: Math.max(0, savings),
      };

      patternMap.set(patternId, pattern);
    }

    this.patterns = [...patternMap.values()];

    const totalOriginal = units.length;
    const compressedUnits = this.patterns.reduce((s, p) => s + p.instances.length, 0);
    const totalSavings = this.patterns.reduce((s, p) => s + p.tokenSavings, 0);

    const result: PatternCompressionResult = {
      patterns: this.patterns,
      totalOriginalUnits: totalOriginal,
      totalCompressedUnits: compressedUnits,
      overallCompressionRatio: totalOriginal > 0 ? (totalOriginal - compressedUnits + this.patterns.length) / totalOriginal : 1,
      estimatedTokenSavings: totalSavings,
    };

    this.logger.info('Patterns detected', {
      patternCount: this.patterns.length,
      compressedUnits,
      tokenSavings: totalSavings,
    });

    return result;
  }

  private computeInstanceConfidence(unit: UnitFingerprint, sig: PatternSignature): number {
    let confidence = 0.5;
    if (sig.matcher(unit)) confidence += 0.3;
    if (unit.patternType === sig.category) confidence += 0.15;
    if (unit.semanticTags.some(t => t.includes(sig.category))) confidence += 0.05;
    return Math.min(1.0, confidence);
  }

  getPatterns(): CodePattern[] { return this.patterns; }

  getPatternByCategory(category: PatternCategory): CodePattern[] {
    return this.patterns.filter(p => p.category === category);
  }

  getCompressedRepresentation(): string {
    const lines: string[] = [];
    for (const pattern of this.patterns) {
      lines.push(`PATTERN: ${pattern.name} (${pattern.instances.length} instances)`);
      lines.push(`  Template: ${pattern.templateSignature}`);
      lines.push(`  Instances: ${pattern.instances.map(i => `${i.unitName}@${i.filePath}${i.deltas.length > 0 ? ` [+${i.deltas.join(',')}]` : ''}`).join(', ')}`);
      lines.push(`  Token savings: ~${pattern.tokenSavings}`);
      lines.push('');
    }
    return lines.join('\n');
  }

  getStats(): { patternCount: number; totalInstances: number; totalTokenSavings: number; categoryDistribution: Record<string, number> } {
    const catDist: Record<string, number> = {};
    for (const p of this.patterns) catDist[p.category] = (catDist[p.category] || 0) + p.instances.length;
    return {
      patternCount: this.patterns.length,
      totalInstances: this.patterns.reduce((s, p) => s + p.instances.length, 0),
      totalTokenSavings: this.patterns.reduce((s, p) => s + p.tokenSavings, 0),
      categoryDistribution: catDist,
    };
  }
}
