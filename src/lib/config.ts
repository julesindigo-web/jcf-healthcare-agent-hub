import * as fs from 'fs/promises';
import * as path from 'path';
import { Logger } from './logger.js';
import { z } from 'zod';
import { SERVER_NAME, SERVER_VERSION } from '../version.js';
import { resolveFromInstallRoot } from './install-root.js';

const ConfigSchema = z.object({
  serverName: z.string().default(SERVER_NAME),
  serverVersion: z.string().default(SERVER_VERSION),
  allowedDirectories: z.array(z.string()).default([]),
  requireApprovalForPathsOutsideCwd: z.boolean().default(false),
  approvalTtlMs: z.number().positive().default(24 * 60 * 60 * 1000),
  forbiddenPaths: z.array(z.string()).default([
    'C:\\Windows',
    'C:\\Program Files',
    'C:\\Program Files (x86)',
    'C:\\System Volume Information',
    'C:\\$Recycle.Bin',
  ]),
  maxFileSize: z.number().positive().default(100 * 1024 * 1024),
  maxDirectoryDepth: z.number().positive().default(20),
  cacheMaxSize: z.number().positive().default(1000),
  cacheTTL: z.number().positive().default(5 * 60 * 1000),
  databasePath: z.string().default('.jcf-fs-metadata.json'),
  enableVersioning: z.boolean().default(true),
  maxVersionsPerFile: z.number().positive().default(10),
  vectorDbPath: z.string().default('.jcf-vector-db.json'),
  vectorDimension: z.number().positive().default(384),
  enableSemanticSearch: z.boolean().default(true),
  policiesPath: z.string().default('.jcf-policies.json'),
  enableRBAC: z.boolean().default(true),
  enableSecretsScan: z.boolean().default(true),
  enableAuditLog: z.boolean().default(true),
  enableDependencyTracking: z.boolean().default(true),
  enableSelfHealing: z.boolean().default(true),
  maxAutoFixes: z.number().nonnegative().default(5),
  enableCompression: z.boolean().default(false),
  batchOperationLimit: z.number().positive().default(100),
  enableCognitiveIndex: z.boolean().default(true),
  enableNodeKnowledgeGraph: z.boolean().default(true),
  enablePatternDetection: z.boolean().default(true),
  enableTypeFlowAnalysis: z.boolean().default(true),
  enableCodeIntelligence: z.boolean().default(true),
  cognitiveIndexPath: z.string().default('.jcf-cognitive-index.json'),
  embeddingEnabled: z.boolean().default(true),
  embeddingUrl: z.string().default('http://127.0.0.1:8742/api/embed'),
  // ADR-006 (M12) — bumped 15000ms → 30000ms after the M12
  // audit identified the marginal-timeout edge: cold safetensors load
  // (~7.3 s) + sequential pre-batch path overlap could blow the 15s
  // budget on bulk auto-index. New default leaves comfortable headroom.
  embeddingTimeoutMs: z.number().positive().default(30000),
  embeddingReprobeMs: z.number().positive().default(60000),
  embeddingDims: z.number().positive().default(1024),
  embeddingInstructFile: z.string().default('Find the most relevant code, configuration, or documentation for the given query'),
  // ADR-006 (M12) — chunk size for embedDocuments batches. Arrays larger
  // than this get split into ⌈N/chunkSize⌉ HTTP sub-batches dispatched
  // serially. 100 keeps a worst-case 1024-dim float32 payload under
  // ~1 MB which is comfortable for FastAPI's default request-body
  // settings; lower this when the embedder is on a constrained link.
  embeddingBatchChunkSize: z.number().positive().default(100),
  // ADR-006 (M12) — separate budget for the warmup POST so ops can
  // give the cold-load path generous headroom (~30 s for safetensors)
  // without inflating the per-request timeout used by hot-path embeds.
  embeddingWarmupTimeoutMs: z.number().positive().default(60000),
  // M11-AUDIT FIX (HIGH-5): previously hardcoded magic numbers — now configurable.
  semanticAutoIndexMaxFiles: z.number().positive().default(500),
  semanticAutoIndexMaxFileBytes: z.number().positive().default(2 * 1024 * 1024),
  // M14 (Bug #7): cumulative byte cap for auto-index to prevent OOM on large repos.
  semanticAutoIndexMaxTotalBytes: z.number().positive().default(50 * 1024 * 1024),
  cognitiveIndexMaxFileBytes: z.number().positive().default(500 * 1024),
  // Progress notifications: emit every N items during long-running ops.
  progressNotificationStep: z.number().positive().default(25),
});

export interface Config {
  serverName: string;
  serverVersion: string;
  allowedDirectories: string[];
  requireApprovalForPathsOutsideCwd: boolean;
  approvalTtlMs: number;
  forbiddenPaths: string[];
  maxFileSize: number;
  maxDirectoryDepth: number;
  cacheMaxSize: number;
  cacheTTL: number;
  databasePath: string;
  enableVersioning: boolean;
  maxVersionsPerFile: number;
  vectorDbPath: string;
  vectorDimension: number;
  enableSemanticSearch: boolean;
  policiesPath: string;
  enableRBAC: boolean;
  enableSecretsScan: boolean;
  enableAuditLog: boolean;
  enableDependencyTracking: boolean;
  enableSelfHealing: boolean;
  maxAutoFixes: number;
  enableCompression: boolean;
  batchOperationLimit: number;
  enableCognitiveIndex: boolean;
  enableNodeKnowledgeGraph: boolean;
  enablePatternDetection: boolean;
  enableTypeFlowAnalysis: boolean;
  enableCodeIntelligence: boolean;
  cognitiveIndexPath: string;
  semanticAutoIndexMaxFiles: number;
  semanticAutoIndexMaxFileBytes: number;
  semanticAutoIndexMaxTotalBytes: number;
  cognitiveIndexMaxFileBytes: number;
  progressNotificationStep: number;
  embeddingEnabled: boolean;
  embeddingUrl: string;
  embeddingTimeoutMs: number;
  embeddingReprobeMs: number;
  embeddingDims: number;
  embeddingInstructFile: string;
  embeddingBatchChunkSize: number;
  embeddingWarmupTimeoutMs: number;
}

export class ConfigManager {
  public logger: Logger;
  private config: Config;

  constructor(logger: Logger) {
    this.logger = logger;
    this.config = this.getDefaultConfig();
  }

  private getDefaultConfig(): Config {
    return {
      serverName: SERVER_NAME,
      serverVersion: SERVER_VERSION,
      allowedDirectories: [],
      requireApprovalForPathsOutsideCwd: false,
      approvalTtlMs: 24 * 60 * 60 * 1000,
      forbiddenPaths: [
        'C:\\Windows',
        'C:\\Program Files',
        'C:\\Program Files (x86)',
        'C:\\System Volume Information',
        'C:\\$Recycle.Bin',
      ],
      maxFileSize: 100 * 1024 * 1024,
      maxDirectoryDepth: 20,
      cacheMaxSize: 1000,
      cacheTTL: 5 * 60 * 1000,
      databasePath: '.jcf-fs-metadata.json',
      enableVersioning: true,
      maxVersionsPerFile: 10,
      vectorDbPath: '.jcf-vector-db.json',
      vectorDimension: 384,
      enableSemanticSearch: true,
      policiesPath: '.jcf-policies.json',
      enableRBAC: true,
      enableSecretsScan: true,
      enableAuditLog: true,
      enableDependencyTracking: true,
      enableSelfHealing: true,
      maxAutoFixes: 5,
      enableCompression: false,
      batchOperationLimit: 100,
      enableCognitiveIndex: true,
      enableNodeKnowledgeGraph: true,
      enablePatternDetection: true,
      semanticAutoIndexMaxFiles: 500,
      semanticAutoIndexMaxFileBytes: 2 * 1024 * 1024,
      semanticAutoIndexMaxTotalBytes: 50 * 1024 * 1024,
      cognitiveIndexMaxFileBytes: 500 * 1024,
      progressNotificationStep: 25,
      enableTypeFlowAnalysis: true,
      enableCodeIntelligence: true,
      cognitiveIndexPath: '.jcf-cognitive-index.json',
      embeddingEnabled: true,
      embeddingUrl: 'http://127.0.0.1:8742/api/embed',
      embeddingTimeoutMs: 30000,
      embeddingReprobeMs: 60000,
      embeddingDims: 1024,
      embeddingInstructFile:
        'Find the most relevant code, configuration, or documentation for the given query',
      embeddingBatchChunkSize: 100,
      embeddingWarmupTimeoutMs: 60000,
    };
  }

  async initialize(): Promise<void> {
    this.logger.info("Initializing configuration");

    // R-1: use install-root anchor instead of process.cwd() so the
    // config is found regardless of where the MCP server is spawned
    // from. Override via JCF_HANDLING_TOOL_HOME env.
    const configPath = resolveFromInstallRoot('mcp-fs-config.json');
    try {
      const fileContent = await fs.readFile(configPath, 'utf-8');
      const fileConfig = JSON.parse(fileContent);
      this.config = { ...this.config, ...fileConfig };
      this.logger.info("Loaded configuration from file", { path: configPath });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn("Failed to load config file, using defaults", { error: String(error) });
      }
    }

    this.loadFromEnv();

    try {
      this.config = ConfigSchema.parse(this.config);
    } catch (error) {
      this.logger.error("Configuration validation failed", error as Error);
      throw error;
    }

    this.logger.info("Configuration initialized", {
      enabledFeatures: this.getEnabledFeatures(),
    });
  }

  /**
   * Security-critical config keys that MUST NOT be overridden via env vars.
   * These directly control security boundaries (RBAC, secrets scanning, audit logs).
   * Overriding these via env vars would allow an attacker with env control to
   * disable all security features.
   */
  private readonly SECURITY_CRITICAL_KEYS = new Set([
    'enableRBAC',
    'enableSecretsScan',
    'enableAuditLog',
    'forbiddenPaths',
    'allowedDirectories',
    'policiesPath',
  ]);

  private loadFromEnv(): void {
    const envPrefix = 'MCP_FS_';
    const envConfig: Record<string, unknown> = {};

    // Build normalized mapping: strip underscores, lowercase → canonical key
    // Handles MCP_FS_ENABLE_RBAC → enableRBAC correctly.
    const canonicalKeys = Object.keys(this.config);
    const normToCanonical: Record<string, string> = {};
    for (const k of canonicalKeys) {
      const norm = k.replace(/_/g, '').toLowerCase();
      normToCanonical[norm] = k;
    }

    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith(envPrefix) && value !== undefined) {
        const suffix = key.slice(envPrefix.length);
        const norm = suffix.replace(/_/g, '').toLowerCase();
        const canonicalKey = normToCanonical[norm];

        // Skip if no matching config property
        if (!canonicalKey) {
          this.logger.debug(
            `Ignoring unknown config override via env var ${key} (no matching config property)`
          );
          continue;
        }

        // BLOCK security-critical overrides via env vars
        if (this.SECURITY_CRITICAL_KEYS.has(canonicalKey)) {
          this.logger.warn(
            `Security-critical config '${canonicalKey}' cannot be overridden via env var ${key}. Ignoring.`
          );
          continue;
        }

        envConfig[canonicalKey] = this.parseEnvValue(value);
      }
    }

    this.config = { ...this.config, ...envConfig };
  }

  private parseEnvValue(value: string): unknown {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
    if (!isNaN(Number(value)) && value.trim() !== '') {
      return Number(value);
    }
    if (value.startsWith('[') || value.startsWith('{')) {
      try {
        return JSON.parse(value);
      } catch {
        // Fall through to string
      }
    }
    return value;
  }

  getConfig(): Config {
    return this.config;
  }

  get<T extends keyof Config>(key: T): Config[T] {
    return this.config[key];
  }

  // R-1: the three getters below previously resolved their
  // relative-config-paths against `process.cwd()`, which spawned
  // duplicate sqlite files at every cwd the server happened to boot in
  // (workspace-root vs `data/` divergence). Anchored to install-root the
  // resolution is now stable across spawn contexts.
  getDatabasePath(): string {
    return resolveFromInstallRoot(this.config.databasePath);
  }

  getVectorDbPath(): string {
    return resolveFromInstallRoot(this.config.vectorDbPath);
  }

  getPoliciesPath(): string {
    return resolveFromInstallRoot(this.config.policiesPath);
  }

  isEnabled(feature: string): boolean {
    const featureFlag = `enable${feature.charAt(0).toUpperCase()}${feature.slice(1)}`;
    return (this.config as any)[featureFlag] ?? false;
  }

  getEnabledFeatures(): string[] {
    const features: string[] = [];
    const featureKeys = [
      'enableVersioning',
      'enableSemanticSearch',
      'enableRBAC',
      'enableSecretsScan',
      'enableAuditLog',
      'enableDependencyTracking',
      'enableSelfHealing',
      'enableCompression',
      'enableCognitiveIndex',
      'enableNodeKnowledgeGraph',
      'enablePatternDetection',
      'enableTypeFlowAnalysis',
      'enableCodeIntelligence',
    ] as const;

    for (const key of featureKeys) {
      if (this.config[key]) {
        features.push(key.replace('enable', '').toLowerCase());
      }
    }
    return features;
  }

  isAllowedDirectory(dirPath: string): boolean {
    if (this.config.allowedDirectories.length === 0) {
      return true;
    }
    const normalized = path.resolve(dirPath);
    return this.config.allowedDirectories.some(allowed =>
      normalized.startsWith(path.resolve(allowed))
    );
  }

  getAllowedDirectories(): string[] {
    return this.config.allowedDirectories;
  }
}

let globalConfig: ConfigManager | null = null;

export async function initializeConfig(): Promise<ConfigManager> {
  if (!globalConfig) {
    const logger = new Logger('info');
    globalConfig = new ConfigManager(logger);
    await globalConfig.initialize();
  }
  return globalConfig;
}

export function getConfig(): Config {
  if (!globalConfig) {
    throw new Error('Config not initialized. Call initializeConfig() first.');
  }
  return globalConfig.getConfig();
}
