import { Logger } from './logger.js';
import { Database } from './database.js';
import { CognitiveIndexEngine } from './cognitive-index.js';
import { NodeLevelKnowledgeGraph } from './node-knowledge-graph.js';
import { PatternDetector } from './pattern-detector.js';
import { TypeFlowAnalyzer } from './type-flow-analyzer.js';
import type {
  IntelligenceQuery, IntelligenceResult,
  CognitiveIndex, ProjectSkeleton, ModuleContract, UnitFingerprint,
  CodePattern, TypeFlow, DataPipeline,
  PatternCompressionResult,
} from '../types/index.js';

export class CodeIntelligenceEngine {
  private logger: Logger;
  private cognitiveIndex: CognitiveIndexEngine;
  private nlkg: NodeLevelKnowledgeGraph;
  private patternDetector: PatternDetector;
  private typeFlowAnalyzer: TypeFlowAnalyzer;
  private lastBuildTime: number = 0;
  private buildDuration: number = 0;

  constructor(config: {
    logger: Logger;
    db: Database;
    cognitiveIndex: CognitiveIndexEngine;
    nlkg: NodeLevelKnowledgeGraph;
    patternDetector: PatternDetector;
    typeFlowAnalyzer: TypeFlowAnalyzer;
  }) {
    this.logger = config.logger;
    this.cognitiveIndex = config.cognitiveIndex;
    this.nlkg = config.nlkg;
    this.patternDetector = config.patternDetector;
    this.typeFlowAnalyzer = config.typeFlowAnalyzer;
  }

  async initialize(): Promise<void> {
    this.logger.info('Initializing Code Intelligence Engine');
  }

  // ── FULL BUILD ──

  /**
   * Build the complete intelligence stack: skeleton + contracts + units +
   * NLKG + patterns + type flows + data pipelines.
   *
   * M11-AUDIT FIX (CRIT-1): the optional `progress` callback receives a
   * lifecycle event at every phase boundary. Caller wires this from the
   * handler's `ctx.progress?.send(...)` so MCP clients see continuous
   * forward motion instead of staring at a multi-second / multi-minute
   * silent freeze. Progress is best-effort — the build proceeds normally
   * if the callback is undefined or throws.
   */
  async buildFullIntelligence(
    rootPath: string,
    progress?: (event: {
      progress: number;
      total: number;
      message: string;
    }) => void
  ): Promise<{
    index: CognitiveIndex;
    patternResult: PatternCompressionResult;
    typeFlows: TypeFlow[];
    pipelines: DataPipeline[];
    duration: number;
  }> {
    const startTime = Date.now();
    this.logger.info('Building full code intelligence', { rootPath });

    const safeProgress = (
      progressVal: number,
      message: string
    ): void => {
      try {
        progress?.({ progress: progressVal, total: 5, message });
      } catch {
        /* progress is best-effort — never break the build */
      }
    };

    // Step 1 / 5: Build cognitive index (skeleton + contracts + fingerprints)
    safeProgress(1, 'Phase 1/5: collecting files + building skeleton + module contracts + unit fingerprints…');
    const index = await this.cognitiveIndex.buildFullIndex(rootPath);

    // Step 2 / 5: Build node-level knowledge graph from index data
    safeProgress(2, `Phase 2/5: building knowledge graph (${index.modules.length} modules, ${index.units.length} units)…`);
    this.nlkg.buildFromCognitiveIndex(index.modules, index.units);

    // Step 3 / 5: Detect patterns and compress
    safeProgress(3, 'Phase 3/5: detecting code patterns…');
    const patternResult = this.patternDetector.detectPatterns(index.units);

    // Step 4 / 5: Analyze type flows
    safeProgress(4, 'Phase 4/5: tracing type flows…');
    const typeFlows = this.typeFlowAnalyzer.analyzeTypeFlows(index.modules, index.units);

    // Step 5 / 5: Trace data pipelines from entry points
    safeProgress(5, `Phase 5/5: tracing ${index.skeleton.entryPoints.length} data pipeline${index.skeleton.entryPoints.length === 1 ? '' : 's'}…`);
    const pipelines = this.typeFlowAnalyzer.analyzeDataPipelines(index.units, index.skeleton.entryPoints);

    this.lastBuildTime = Date.now();
    this.buildDuration = Date.now() - startTime;

    this.logger.info('Code intelligence built', {
      duration: this.buildDuration,
      modules: index.stats.totalModules,
      units: index.stats.totalUnits,
      patterns: patternResult.patterns.length,
      typeFlows: typeFlows.length,
      pipelines: pipelines.length,
    });

    return { index, patternResult, typeFlows, pipelines, duration: this.buildDuration };
  }

  // ── INCREMENTAL UPDATE ──

  async incrementalUpdate(filePath: string, content: string): Promise<void> {
    await this.cognitiveIndex.incrementalUpdate(filePath, content);
    const idx = this.cognitiveIndex.getIndex();
    if (idx) {
      this.nlkg.buildFromCognitiveIndex(idx.modules, idx.units);
      this.patternDetector.detectPatterns(idx.units);
      this.typeFlowAnalyzer.analyzeTypeFlows(idx.modules, idx.units);
    }
  }

  // ── UNIFIED QUERY INTERFACE ──

  async query(query: IntelligenceQuery): Promise<IntelligenceResult> {
    let data: unknown;
    let tokenEstimate = 0;
    let confidence = 1.0;
    const sources: string[] = [];

    switch (query.type) {
      case 'skeleton': {
        data = this.cognitiveIndex.getSkeleton();
        tokenEstimate = this.cognitiveIndex.getStats().estimatedTokenCost.skeleton;
        sources.push('cognitive-index:skeleton');
        if (!data) confidence = 0;
        break;
      }
      case 'contracts': {
        const modules = query.filters?.filePaths
          ? this.cognitiveIndex.getModules().filter(m => query.filters!.filePaths!.includes(m.filePath))
          : this.cognitiveIndex.getModules();
        data = modules;
        tokenEstimate = Math.round(JSON.stringify(modules).length / 4);
        sources.push('cognitive-index:contracts');
        break;
      }
      case 'fingerprints': {
        let units = this.cognitiveIndex.getUnits();
        if (query.filters?.filePaths) units = units.filter(u => query.filters!.filePaths!.includes(u.filePath));
        if (query.filters?.maxComplexity) units = units.filter(u => u.complexity <= query.filters!.maxComplexity!);
        if (query.filters?.patternTypes) units = units.filter(u => query.filters!.patternTypes!.includes(u.patternType));
        data = units;
        tokenEstimate = Math.round(JSON.stringify(units).length / 4);
        sources.push('cognitive-index:fingerprints');
        break;
      }
      case 'impact': {
        if (!query.target) { data = { error: 'target required for impact query' }; confidence = 0; break; }
        const impact = this.nlkg.getImpactSet(query.target);
        const subgraph = this.nlkg.extractSubgraph(query.target, query.depth || 2, 'reverse');
        data = { impact, subgraph };
        tokenEstimate = Math.round(JSON.stringify(data).length / 4);
        sources.push('nlkg:impact', 'nlkg:subgraph');
        break;
      }
      case 'flow': {
        if (!query.target) { data = { error: 'target (typeName) required for flow query' }; confidence = 0; break; }
        const typeFlow = this.typeFlowAnalyzer.getTypeFlow(query.target);
        const consumers = this.typeFlowAnalyzer.getTypeConsumers(query.target);
        const producers = this.typeFlowAnalyzer.getTypeProducers(query.target);
        data = { typeFlow, consumers, producers };
        tokenEstimate = Math.round(JSON.stringify(data).length / 4);
        sources.push('type-flow-analyzer');
        if (!typeFlow) confidence = 0.3;
        break;
      }
      case 'patterns': {
        const patterns = query.filters?.patternTypes
          ? this.patternDetector.getPatternByCategory(query.filters.patternTypes[0] as any)
          : this.patternDetector.getPatterns();
        data = { patterns, compressed: this.patternDetector.getCompressedRepresentation() };
        tokenEstimate = Math.round(this.patternDetector.getCompressedRepresentation().length / 4);
        sources.push('pattern-detector');
        break;
      }
      case 'subgraph': {
        if (!query.target) { data = { error: 'target (nodeId) required for subgraph query' }; confidence = 0; break; }
        const subgraph = this.nlkg.extractSubgraph(query.target, query.depth || 2);
        data = subgraph;
        tokenEstimate = Math.round(JSON.stringify(subgraph).length / 4);
        sources.push('nlkg:subgraph');
        break;
      }
      case 'full_context': {
        // The flagship query: returns compressed representation of entire project
        const skeleton = this.cognitiveIndex.getSkeleton();
        const modules = query.filters?.filePaths
          ? this.cognitiveIndex.getModules().filter(m => query.filters!.filePaths!.includes(m.filePath))
          : this.cognitiveIndex.getModules();
        const patternResult = this.patternDetector.detectPatterns(this.cognitiveIndex.getUnits());
        const typeFlows = this.typeFlowAnalyzer.getAllTypeFlows().slice(0, 20);
        const nlkgStats = this.nlkg.getStats();

        data = {
          skeleton,
          moduleCount: modules.length,
          exportSummary: modules.map(m => ({
            file: m.filePath,
            name: m.moduleName,
            exports: m.exports.map(e => `${e.kind} ${e.name}: ${e.signature}`),
            patterns: m.patternClassification,
          })),
          patterns: patternResult.patterns.map(p => ({
            name: p.name,
            instances: p.instances.length,
            template: p.templateSignature,
            savings: p.tokenSavings,
          })),
          typeFlows: typeFlows.map(tf => ({
            type: tf.typeName,
            steps: tf.flowSteps.length,
            consumers: tf.consumers.length,
            producers: tf.producers.length,
          })),
          graphStats: nlkgStats,
          indexStats: this.cognitiveIndex.getStats(),
        };
        tokenEstimate = Math.round(JSON.stringify(data).length / 4);
        sources.push('cognitive-index', 'pattern-detector', 'type-flow-analyzer', 'nlkg');
        break;
      }
    }

    return {
      query,
      data,
      tokenEstimate,
      confidence,
      sources,
      generatedAt: Date.now(),
    };
  }

  // ── CONVENIENCE METHODS ──

  getCognitiveIndex(): CognitiveIndex | null { return this.cognitiveIndex.getIndex(); }
  getSkeleton(): ProjectSkeleton | null { return this.cognitiveIndex.getSkeleton(); }
  getModules(): ModuleContract[] { return this.cognitiveIndex.getModules(); }
  getUnits(): UnitFingerprint[] { return this.cognitiveIndex.getUnits(); }
  getPatterns(): CodePattern[] { return this.patternDetector.getPatterns(); }
  getTypeFlows(): TypeFlow[] { return this.typeFlowAnalyzer.getAllTypeFlows(); }
  getPipelines(): DataPipeline[] { return this.typeFlowAnalyzer.getPipelines(); }

  getStats(): {
    cognitiveIndex: ReturnType<CognitiveIndexEngine['getStats']>;
    nlkg: ReturnType<NodeLevelKnowledgeGraph['getStats']>;
    patterns: ReturnType<PatternDetector['getStats']>;
    typeFlows: ReturnType<TypeFlowAnalyzer['getStats']>;
    lastBuildTime: number;
    buildDuration: number;
  } {
    return {
      cognitiveIndex: this.cognitiveIndex.getStats(),
      nlkg: this.nlkg.getStats(),
      patterns: this.patternDetector.getStats(),
      typeFlows: this.typeFlowAnalyzer.getStats(),
      lastBuildTime: this.lastBuildTime,
      buildDuration: this.buildDuration,
    };
  }
}
