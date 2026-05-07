/**
 * Shared test fixture: builds a real `HandlerContext` for direct handler tests.
 *
 * Mirrors `JcfHealthcareAgentHubServer.initialize()` but in a temp dir, so handler
 * tests can call `readFile(ctx, args)` etc. without spinning up the full MCP
 * server. Coverage is tracked correctly because every call stays in-process.
 *
 * Usage:
 * ```ts
 * import { createTestContext, type TestContext } from "./_test-context.js";
 * let tc: TestContext;
 * beforeEach(async () => { tc = await createTestContext(); });
 * afterEach(async () => { await tc.cleanup(); });
 * ```
 */

import fs from "fs/promises";
import path from "path";
import os from "os";

import { Logger } from "../lib/logger.js";
import { ConfigManager } from "../lib/config.js";
import { Database } from "../lib/database.js";
import { Cache } from "../lib/cache.js";
import { VectorDB } from "../lib/vector-db.js";
import { SecurityManager } from "../lib/security.js";
import { DependencyGraph } from "../lib/dependency-graph.js";
import { SelfHealing } from "../lib/self-healing.js";
import { CognitiveIndexEngine } from "../lib/cognitive-index.js";
import { NodeLevelKnowledgeGraph } from "../lib/node-knowledge-graph.js";
import { PatternDetector } from "../lib/pattern-detector.js";
import { TypeFlowAnalyzer } from "../lib/type-flow-analyzer.js";
import { CodeIntelligenceEngine } from "../lib/code-intelligence.js";
import { EmbeddingClient } from "../lib/embedding-client.js";
import { RateLimiter } from "../lib/rate-limiter.js";

import { buildHandlerContext, type HandlerContext } from "../handlers/context.js";

/**
 * Bundle returned by {@link createTestContext}. Holds the live context plus
 * a `cleanup()` that closes services and removes the sandbox.
 */
export interface TestContext {
  /** The live handler context — pass this to handlers under test. */
  ctx: HandlerContext;
  /** Sandbox dir; safe to write inside (the only allowed directory). */
  workDir: string;
  /** Closes all services and removes `workDir`. Call in `afterEach`. */
  cleanup: () => Promise<void>;
}

/**
 * Build a fully wired-up handler context inside a fresh temp dir.
 *
 * Every service is real (not mocked) — same code paths exercised by the live
 * server. The sandbox dir is added to `allowedDirectories` so the path-guard
 * permits writes inside it.
 *
 * Embedding is disabled (no localhost embedder during tests).
 */
export async function createTestContext(): Promise<TestContext> {
  const workDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "jcf-handlers-test-")
  );

  const logger = new Logger("error");
  const configManager = new ConfigManager(logger);

  // Lock the sandbox into the allowed-dirs so validatePath permits everything
  // inside `workDir` and rejects anything outside.
  const config = configManager.getConfig();
  config.allowedDirectories = [workDir];
  config.forbiddenPaths = [];
  config.embeddingEnabled = false;

  const dbPath = path.join(workDir, ".jcf-test-db");
  const db = new Database(dbPath, logger);
  await db.initialize();

  const cache = new Cache({
    maxSize: config.cacheMaxSize,
    ttl: config.cacheTTL,
    logger,
  });
  await cache.initialize();

  const embeddingClient = new EmbeddingClient({
    url: config.embeddingUrl,
    timeoutMs: config.embeddingTimeoutMs,
    reprobeMs: config.embeddingReprobeMs,
    enabled: false,
    logger,
    defaultInstruct: config.embeddingInstructFile,
  });

  const vectorDb = new VectorDB({
    path: path.join(workDir, ".jcf-vector-db.json"),
    dimension: config.vectorDimension,
    logger,
    embeddingClient,
  });
  await vectorDb.initialize();

  const policiesPath = path.join(workDir, ".jcf-policies.json");
  const security = new SecurityManager({
    policiesPath,
    logger,
    allowedDirectories: [workDir],
    forbiddenPaths: [],
    enableRBAC: true,
    enableSecretsScan: true,
    enableAuditLog: true,
    db,
  });
  await security.loadPolicies();

  const dependencyGraph = new DependencyGraph({ db, logger });
  await dependencyGraph.initialize();

  const selfHealing = new SelfHealing({ logger, cache, db });

  // Pin indexPath inside the sandbox so a stale `.jcf-cognitive-index.json`
  // in the test process cwd can't bleed into fresh test contexts.
  const cognitiveIndex = new CognitiveIndexEngine({
    logger,
    indexPath: path.join(workDir, ".jcf-cognitive-index.json"),
  });
  await cognitiveIndex.initialize();

  const nlkg = new NodeLevelKnowledgeGraph({ logger });
  await nlkg.initialize();

  const patternDetector = new PatternDetector({ logger });
  await patternDetector.initialize();

  const typeFlowAnalyzer = new TypeFlowAnalyzer({ logger });
  await typeFlowAnalyzer.initialize();

  const codeIntelligence = new CodeIntelligenceEngine({
    logger,
    db,
    cognitiveIndex,
    nlkg,
    patternDetector,
    typeFlowAnalyzer,
  });
  await codeIntelligence.initialize();

  const rateLimiter = new RateLimiter({ logger });

  const ctx = buildHandlerContext({
    configManager,
    config,
    logger,
    db,
    cache,
    vectorDb,
    security,
    dependencyGraph,
    selfHealing,
    cognitiveIndex,
    nlkg,
    patternDetector,
    typeFlowAnalyzer,
    codeIntelligence,
    embeddingClient,
    rateLimiter,
  });

  const cleanup = async (): Promise<void> => {
    try {
      selfHealing.stopHealthMonitoring();
    } catch {
      /* best-effort */
    }
    // VectorDB now uses SQLite WAL — no debounced save pending. No wait needed.
    try {
      await db.save();
    } catch {
      /* best-effort */
    }
    try {
      db.close();
    } catch {
      /* best-effort */
    }
    try {
      await fs.rm(workDir, { recursive: true, force: true });
    } catch {
      /* best-effort — Windows file handle race */
    }
  };

  return { ctx, workDir, cleanup };
}

/**
 * Convenience: write a sandbox file and return its absolute path.
 */
export async function writeSandboxFile(
  workDir: string,
  relPath: string,
  content: string
): Promise<string> {
  const abs = path.join(workDir, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf-8");
  return abs;
}
