import { Logger } from './logger.js';
import type {
  TypeFlow, FlowStep, DataPipeline,
  UnitFingerprint, ModuleContract,
} from '../types/index.js';

export class TypeFlowAnalyzer {
  private logger: Logger;
  private typeFlows: Map<string, TypeFlow> = new Map();
  private pipelines: DataPipeline[] = [];

  constructor(config: { logger: Logger }) {
    this.logger = config.logger;
  }

  async initialize(): Promise<void> {
    this.logger.info('Initializing Type Flow Analyzer');
  }

  analyzeTypeFlows(modules: ModuleContract[], units: UnitFingerprint[]): TypeFlow[] {
    this.logger.info('Analyzing type flows', { modules: modules.length, units: units.length });
    this.typeFlows.clear();

    // Collect all type definitions
    const typeDefinitions = new Map<string, { filePath: string; kind: string }>();
    for (const mod of modules) {
      for (const tc of mod.definedTypes) {
        typeDefinitions.set(tc.name, { filePath: mod.filePath, kind: tc.kind });
      }
    }

    // For each type, trace its flow through the codebase
    for (const [typeName, def] of typeDefinitions) {
      const flow = this.traceTypeFlow(typeName, def.filePath, units);
      if (flow.flowSteps.length > 0) {
        this.typeFlows.set(typeName, flow);
      }
    }

    return [...this.typeFlows.values()];
  }

  private traceTypeFlow(typeName: string, definedAt: string, units: UnitFingerprint[]): TypeFlow {
    const steps: FlowStep[] = [];
    const consumers: string[] = [];
    const producers: string[] = [];
    const transformers: string[] = [];

    for (const unit of units) {
      const usesType = unit.typeDependencies.includes(typeName);
      const inputHasType = unit.inputSignature.includes(typeName);
      const outputHasType = unit.outputSignature.includes(typeName);

      if (!usesType && !inputHasType && !outputHasType) continue;

      let operation: FlowStep['operation'] = 'consumes';
      if (outputHasType && !inputHasType) {
        operation = 'produces';
        producers.push(unit.id);
      } else if (inputHasType && outputHasType && unit.patternType === 'transformer') {
        operation = 'transforms';
        transformers.push(unit.id);
      } else if (inputHasType && unit.patternType === 'validation') {
        operation = 'validates';
      } else if (outputHasType && unit.semanticTags.includes('network-io')) {
        operation = 'serializes';
      } else if (inputHasType && !outputHasType) {
        operation = 'consumes';
        consumers.push(unit.id);
      } else if (outputHasType) {
        operation = 'produces';
        producers.push(unit.id);
      }

      steps.push({
        nodeId: unit.id,
        filePath: unit.filePath,
        functionName: unit.name,
        operation,
        inputType: inputHasType ? typeName : 'unknown',
        outputType: outputHasType ? typeName : 'unknown',
      });
    }

    return {
      id: `typeflow:${typeName}:${Date.now()}`,
      typeName,
      definedAt,
      flowSteps: steps,
      consumers,
      producers,
      transformers,
    };
  }

  analyzeDataPipelines(units: UnitFingerprint[], entryPoints: string[]): DataPipeline[] {
    this.pipelines = [];
    this.logger.info('Analyzing data pipelines', { entryPoints: entryPoints.length });

    for (const entry of entryPoints) {
      const entryUnit = units.find(u =>
        u.filePath === entry && (
          u.patternType === 'handler' ||
          u.patternType === 'async-operation' ||
          u.patternType === 'initializer' ||
          u.semanticTags.includes('network-io') ||
          /^(main|init|start|bootstrap|setup|run|launch)/i.test(u.name)
        )
      );
      if (!entryUnit) continue;

      const pipeline = this.tracePipeline(entryUnit, units);
      if (pipeline.steps.length > 0) {
        this.pipelines.push(pipeline);
      }
    }

    return this.pipelines;
  }

  private tracePipeline(entryUnit: UnitFingerprint, units: UnitFingerprint[]): DataPipeline {
    const steps: FlowStep[] = [];
    const typeFlows: TypeFlow[] = [];
    const visited = new Set<string>();
    const branchingPoints: string[] = [];

    const traverse = (unit: UnitFingerprint, depth: number) => {
      if (depth > 10 || visited.has(unit.id)) return;
      visited.add(unit.id);

      let operation: FlowStep['operation'] = 'consumes';
      if (unit.patternType === 'handler') operation = 'consumes';
      else if (unit.patternType === 'validation') operation = 'validates';
      else if (unit.patternType === 'transformer') operation = 'transforms';
      else if (unit.patternType === 'command') operation = 'stores';
      else if (unit.patternType === 'query') operation = 'produces';

      steps.push({
        nodeId: unit.id,
        filePath: unit.filePath,
        functionName: unit.name,
        operation,
        inputType: unit.inputSignature || 'unknown',
        outputType: unit.outputSignature || 'unknown',
      });

      if (unit.callTargets.length > 1) branchingPoints.push(unit.id);

      // Follow call targets
      for (const target of unit.callTargets) {
        const targetUnit = units.find(u => u.name === target || u.id === target);
        if (targetUnit) traverse(targetUnit, depth + 1);
      }
    };

    traverse(entryUnit, 0);

    const exitUnit = steps.length > 0 ? steps[steps.length - 1] : null;

    return {
      name: `Pipeline from ${entryUnit.name}`,
      entryPoint: entryUnit.id,
      exitPoint: exitUnit?.nodeId || entryUnit.id,
      steps,
      typeFlow: typeFlows,
      totalSteps: steps.length,
      branchingPoints,
    };
  }

  getTypeFlow(typeName: string): TypeFlow | undefined { return this.typeFlows.get(typeName); }
  getAllTypeFlows(): TypeFlow[] { return [...this.typeFlows.values()]; }
  getPipelines(): DataPipeline[] { return this.pipelines; }

  getTypeConsumers(typeName: string): string[] {
    const flow = this.typeFlows.get(typeName);
    return flow?.consumers || [];
  }

  getTypeProducers(typeName: string): string[] {
    const flow = this.typeFlows.get(typeName);
    return flow?.producers || [];
  }

  getStats(): { typeFlowCount: number; pipelineCount: number; avgStepsPerFlow: number; avgStepsPerPipeline: number } {
    const flows = [...this.typeFlows.values()];
    const avgFlowSteps = flows.length > 0 ? flows.reduce((s, f) => s + f.flowSteps.length, 0) / flows.length : 0;
    const avgPipelineSteps = this.pipelines.length > 0 ? this.pipelines.reduce((s, p) => s + p.totalSteps, 0) / this.pipelines.length : 0;
    return { typeFlowCount: flows.length, pipelineCount: this.pipelines.length, avgStepsPerFlow: Math.round(avgFlowSteps), avgStepsPerPipeline: Math.round(avgPipelineSteps) };
  }
}
