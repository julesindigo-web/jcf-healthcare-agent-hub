export interface FileMetadata {
  path: string;
  size: number;
  modified: Date;
  created: Date;
  mode: string;
  language?: string | undefined;
  symbols?: any[] | undefined;  // Using any[] for flexibility with symbol analysis
  imports?: string[] | undefined;
  exports?: string[] | undefined;
  complexity?: number | undefined;
}

export interface SymbolInfo {
  name: string;
  type: 'function' | 'class' | 'variable' | 'interface' | 'type' | 'enum';
  line: number;
  column: number;
  signature?: string;
}

export interface VersionInfo {
  id: string;
  timestamp: Date;
  author?: string | undefined;
  message: string;
  hash: string;
  size: number;
  content?: string | undefined;
}

export interface DependencyGraph {
  nodes: Map<string, Set<string>>; // file -> set of dependencies
  reverse: Map<string, Set<string>>; // file -> set of dependents
}

export interface CacheEntry<T = any> {
  value: T;
  expires: number;
  created: number;
}

export interface AuditEvent {
  id: string;
  timestamp: Date;
  userId?: string | undefined;
  action: 'read' | 'write' | 'delete' | 'move' | 'search' | 'policy_check'
    // Healthcare extensions
    | 'fhir_create' | 'fhir_read' | 'fhir_update' | 'fhir_delete' | 'fhir_search' | 'fhir_batch' | 'fhir_validate'
    | 'clinical_assess' | 'care_plan_create' | 'medication_check' | 'lab_interp' | 'risk_calculate' | 'guideline_lookup'
    | 'hipaa_audit_report' | 'consent_manage' | 'phi_detection' | 'access_log' | 'breach_assess'
    | 'synthetic_patient_gen' | 'synthetic_condition_gen' | 'synthetic_observation_gen' | 'synthetic_bundle_gen'
    | 'a2a_route_message' | 'a2a_agent_card' | 'a2a_discover_agents' | 'a2a_send_task' | 'a2a_get_task_status';
  path: string;
  result: 'success' | 'failure';
  reason?: string;
  metadata?: Record<string, any>;
}

export interface RBACPolicy {
  path: string;
  roles: {
    [role: string]: {
       permissions: ('read' | 'write' | 'delete' | 'search' | 'move' | 'admin')[];
      conditions?: Record<string, any>;
    };
  };
}

export interface SecretsScanResult {
  file: string;
  line: number;
  type: 'api_key' | 'password' | 'token' | 'private_key' | 'custom';
  value: string;
  confidence: number;
}

export interface SearchResult {
  path: string;
  name?: string;
  score: number;
  snippet?: string | undefined;
  metadata?: FileMetadata;
}

export interface SemanticSearchOptions {
  query: string;
  limit?: number;
  threshold?: number;
  fileTypes?: string[];
}

export interface BatchOperation {
  type: 'read' | 'write' | 'edit' | 'delete';
  path: string;
  content?: string;
  edits?: Array<{ oldText: string; newText: string }>;
  dryRun?: boolean;
}

export interface BatchResult {
  success: boolean;
  operation: BatchOperation;
  result?: any;
  error?: string;
  rollbackAvailable: boolean;
}

export interface CoherenceCheck {
  file: string;
  score: number;
  risk: 'low' | 'medium' | 'high' | 'critical';
  dependencies: string[];
  dependents: string[];
  missing: string[];
  circular: boolean;
  impact: 'low' | 'medium' | 'high' | 'critical';
  message: string;
}

export interface ServerMetrics {
  requests: number;
  cacheHits: number;
  cacheMisses: number;
  errors: number;
  avgLatency: number;
  activeConnections: number;
  [key: string]: any;
}

export interface HealthCheck {
  status: 'healthy' | 'degraded' | 'unhealthy';
  database: any;
  cache: any;
  vectorDb: any;
  security: any;
  warnings?: string[];
  metrics: ServerMetrics;
  uptime: number;
  timestamp: string;
}

// ═══════════════════════════════════════════════════════════════
// COGNITIVE INDEX TYPES (HCI — Hierarchical Cognitive Index)
// ═══════════════════════════════════════════════════════════════

export interface ProjectSkeleton {
  name: string;
  rootPath: string;
  techStack: TechStackInfo[];
  architecturePattern: ArchitecturePattern[];
  directoryTree: DirectoryNode;
  totalFiles: number;
  totalDirectories: number;
  totalLinesOfCode: number;
  languages: Record<string, number>;
  entryPoints: string[];
  configFiles: string[];
  generatedAt: number;
}

export interface TechStackInfo {
  name: string;
  category: 'language' | 'framework' | 'library' | 'runtime' | 'database' | 'tool';
  version?: string;
  confidence: number;
  evidence: string[];
}

export interface ArchitecturePattern {
  name: string;
  confidence: number;
  evidence: string[];
}

export interface DirectoryNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: DirectoryNode[];
  fileCount?: number;
  language?: string;
}

export interface ModuleContract {
  filePath: string;
  moduleName: string;
  exports: ExportContract[];
  imports: ImportContract[];
  definedTypes: TypeContract[];
  sideEffects: string[];
  patternClassification: string[];
}

export interface ExportContract {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'enum' | 'constant' | 'default';
  signature: string;
  inputTypes: string[];
  outputType: string;
  isAsync: boolean;
  isExported: boolean;
  isDefault: boolean;
  modifiers: string[];
}

export interface ImportContract {
  name: string;
  from: string;
  isType: boolean;
  isDefault: boolean;
  isNamespace: boolean;
}

export interface TypeContract {
  name: string;
  kind: 'interface' | 'type' | 'enum' | 'class';
  properties: Array<{ name: string; type: string; optional: boolean }>;
  methods: Array<{ name: string; signature: string }>;
  extendsTypes: string[];
  genericParams: string[];
}

export interface UnitFingerprint {
  id: string;
  filePath: string;
  name: string;
  kind: 'function' | 'method' | 'class' | 'interface' | 'type' | 'enum' | 'constant';
  signature: string;
  inputSignature: string;
  outputSignature: string;
  isPure: boolean;
  isAsync: boolean;
  complexity: number;
  linesOfCode: number;
  callTargets: string[];
  typeDependencies: string[];
  sideEffects: string[];
  patternType: string;
  semanticTags: string[];
}

export interface CognitiveIndex {
  skeleton: ProjectSkeleton;
  modules: ModuleContract[];
  units: UnitFingerprint[];
  stats: CognitiveIndexStats;
  generatedAt: number;
  lastIncrementalUpdate: number;
}

export interface CognitiveIndexStats {
  totalModules: number;
  totalUnits: number;
  totalExports: number;
  totalTypes: number;
  avgComplexity: number;
  pureFunctionRatio: number;
  asyncFunctionRatio: number;
  patternDistribution: Record<string, number>;
  estimatedTokenCost: { skeleton: number; contracts: number; fingerprints: number; total: number };
}

// ═══════════════════════════════════════════════════════════════
// NODE-LEVEL KNOWLEDGE GRAPH TYPES (NLKG)
// ═══════════════════════════════════════════════════════════════

export type EdgeKind = 'calls' | 'implements' | 'extends' | 'uses-type' | 'data-flows-to' | 'consumes' | 'produces' | 'references' | 'contains';

export interface GraphNode {
  id: string;
  filePath: string;
  name: string;
  kind: 'function' | 'method' | 'class' | 'interface' | 'type' | 'enum' | 'constant' | 'module';
  signature: string;
  metadata: Record<string, unknown>;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  weight: number;
  metadata: Record<string, unknown>;
}

export interface NodeKnowledgeGraph {
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
  reverseIndex: Map<string, GraphEdge[]>;
  forwardIndex: Map<string, GraphEdge[]>;
}

export interface SubgraphExtraction {
  nodes: GraphNode[];
  edges: GraphEdge[];
  entryPoints: string[];
  boundaryNodes: string[];
  stats: { nodeCount: number; edgeCount: number; depth: number };
}

// ═══════════════════════════════════════════════════════════════
// PATTERN DETECTOR TYPES
// ═══════════════════════════════════════════════════════════════

export interface CodePattern {
  id: string;
  name: string;
  category: PatternCategory;
  description: string;
  templateSignature: string;
  instances: PatternInstance[];
  compressionRatio: number;
  tokenSavings: number;
}

export type PatternCategory = 'crud' | 'middleware' | 'observer' | 'factory' | 'singleton' | 'adapter' | 'decorator' | 'strategy' | 'repository' | 'service' | 'controller' | 'utility' | 'custom';

export interface PatternInstance {
  filePath: string;
  unitName: string;
  deltas: string[];
  confidence: number;
}

export interface PatternCompressionResult {
  patterns: CodePattern[];
  totalOriginalUnits: number;
  totalCompressedUnits: number;
  overallCompressionRatio: number;
  estimatedTokenSavings: number;
}

// ═══════════════════════════════════════════════════════════════
// TYPE FLOW ANALYZER TYPES
// ═══════════════════════════════════════════════════════════════

export interface TypeFlow {
  id: string;
  typeName: string;
  definedAt: string;
  flowSteps: FlowStep[];
  consumers: string[];
  producers: string[];
  transformers: string[];
}

export interface FlowStep {
  nodeId: string;
  filePath: string;
  functionName: string;
  operation: 'produces' | 'consumes' | 'transforms' | 'validates' | 'serializes' | 'stores';
  inputType: string;
  outputType: string;
}

export interface DataPipeline {
  name: string;
  entryPoint: string;
  exitPoint: string;
  steps: FlowStep[];
  typeFlow: TypeFlow[];
  totalSteps: number;
  branchingPoints: string[];
}

// ═══════════════════════════════════════════════════════════════
// CODE INTELLIGENCE ENGINE (Unified Orchestrator)
// ═══════════════════════════════════════════════════════════════

export interface IntelligenceQuery {
  type: 'skeleton' | 'contracts' | 'fingerprints' | 'impact' | 'flow' | 'patterns' | 'subgraph' | 'full_context';
  target?: string;
  depth?: number;
  filters?: IntelligenceFilter;
}

export interface IntelligenceFilter {
  filePaths?: string[];
  languages?: string[];
  patternTypes?: string[];
  maxComplexity?: number;
  includePrivate?: boolean;
}

export interface IntelligenceResult {
  query: IntelligenceQuery;
  data: unknown;
  tokenEstimate: number;
  confidence: number;
  sources: string[];
  generatedAt: number;
}