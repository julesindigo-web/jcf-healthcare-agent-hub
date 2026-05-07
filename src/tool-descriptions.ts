/**
 * JCF Healthcare Agent Hub — Rich Tool Descriptions
 *
 * Per-tool human-readable descriptions with parameters, return shape, and examples.
 * Consumed by `setupToolHandler` to populate MCP `description` field.
 *
 * Rationale (from dogfooding audit): Previous descriptions were
 * `${name} - JCF Healthcare Agent Hub operation` — zero semantic signal for LLM callers.
 * Rich descriptions dramatically improve LLM tool-selection accuracy.
 */

export const TOOL_DESCRIPTIONS: Record<string, string> = {
  // ── DIAGNOSTICS (1) — ADR-H001: estatus/verify removed ──
  ping: `Health check + DB stats + JCF Healthcare Agent Hub server status.

Parameters: none

Returns: { status, server, version, db_path, stats, timestamp }

Example: {}  →  { "status": "online", "server": "jcf-healthcare-agent-hub", ... }`,

  // ── CORE FILESYSTEM (6) ──
  read_file: `Read a text file with optional line-based pagination.

Parameters:
- path (string, required): Absolute file path.
- offset (integer, 1-indexed, optional): Starting line. Default 1.
- limit (integer, optional): Max lines returned. Default 2000 (large-file guard).
- maxLines (integer, optional): Override default limit ceiling.

Returns: { content, metadata, readInfo }
- readInfo: { totalLines, totalBytes, offset, limit, returnedLines, truncated, nextOffset?, resumeHint? }

Example:
  { "path": "C:/repo/src/main.ts" }              → first 2000 lines
  { "path": "C:/repo/big.log", "offset": 5000, "limit": 500 } → lines 5000-5499
If readInfo.truncated, call again with offset=readInfo.nextOffset to continue.`,

  write_file: `Write (create or overwrite) a file. Triggers content-hash versioning, secrets scanning (blocks on detected secrets), path validation, and audit logging.

Parameters:
- path (required): Absolute target path.
- content (required): Full file content as UTF-8 string.
- author (optional): Identifier for audit/version metadata.
- message (optional): Commit-style message for version entry.

Returns: { success, versionId, metadata }

Example: { "path": "C:/repo/notes.md", "content": "# Hello", "author": "Alice", "message": "init" }`,

  edit_file: `Apply find-and-replace edits atomically. Triggers versioning + audit.

Parameters:
- path (required): Absolute file path.
- edits (array, required): [{ oldText, newText }] pairs. Applied sequentially.

Returns: { applied: number, versionId, metadata }

Example: { "path": "C:/repo/a.ts", "edits": [{ "oldText": "foo", "newText": "bar" }] }`,

  append_file: `Append content to a file. Supports chunked writes for large payloads that exceed payload-size limits.

Parameters:
- path (required): Absolute file path.
- content (required): UTF-8 content to append.
- createIfMissing (boolean, optional): Create the file if absent. Default false.

Returns: { success, bytesAppended }

Example: { "path": "C:/repo/log.txt", "content": "line\\n", "createIfMissing": true }`,

  delete_file: `Delete a file. Pre-delete snapshot is saved to version history so rollback_file can restore.

Parameters: { path: string }
Returns: { success: boolean }

Example: { "path": "C:/repo/tmp.bak" }`,

  list_directory: `List directory entries with size + type + language detection.

Parameters:
- path (required): Absolute directory path.
- includeHidden (boolean, optional): Include dotfiles. Default false.

Returns: { entries: [{ name, path, type, size?, language?, modified? }] }
  - language: detected from extension for files (e.g. 'typescript', 'python')
  - modified: ISO-8601 mtime timestamp

Example: { "path": "C:/repo/src", "includeHidden": false }`,

  search_files: `Glob-based file search with baseDir scoping.

Parameters:
- pattern (required): Glob pattern (e.g., "**/*.ts", "src/**/test-*.js").
- baseDir (optional): Root for search. Default process.cwd().

Returns: { results: string[] }

Example: { "pattern": "**/*.md", "baseDir": "C:/repo" }`,

  // ── SEMANTIC (1) ──
  semantic_search: `tf-idf + n-gram semantic search across indexed files. Returns files ranked by cosine similarity.

Parameters:
- query (required): Natural-language query.
- limit (optional): Max results. Default 10.
- threshold (optional): Minimum score 0-1. Default 0.1.

Returns: { results: [{ path, score, snippet }] }

Example: { "query": "authentication middleware token validation", "limit": 5, "threshold": 0.3 }
Note: Requires prior indexing via write_file operations (auto-indexed on write).`,

  // ── VERSION CONTROL (3) ──
  get_version_history: `Retrieve chronological version timeline for a file. Each entry has id, hash, author, message, size, timestamp.

Parameters: { path: string, limit?: number }
Returns: { versions: VersionInfo[] }

Example: { "path": "C:/repo/src/main.ts", "limit": 10 }`,

  rollback_file: `Restore file to a previous version. Creates a pre-rollback snapshot first (reversible).

Parameters: { path: string, versionId: string }
Returns: { success, restoredFrom, newVersionId }

Example: { "path": "C:/repo/src/main.ts", "versionId": "v-abc123" }`,

  get_current_metadata: `File analysis: language, size, mtime, symbols, imports, exports, cyclomatic complexity, content hash.

Parameters: { path: string }
Returns: { metadata: FileMetadata }

Example: { "path": "C:/repo/src/main.ts" }`,

  // ── DEPENDENCY & COHERENCE (4) ──
  get_dependencies: `Forward dependencies: files this one imports/requires. When transitive=true, includes the full downstream closure.

Parameters: { path: string, transitive?: boolean }
Returns: { dependencies: string[], transitive: boolean }

Example: { "path": "C:/repo/src/main.ts", "transitive": true }`,

  get_dependents: `Reverse dependents: files that import this one. When transitive=true, includes the full upstream closure.

Parameters: { path: string, transitive?: boolean }
Returns: { dependents: string[], transitive: boolean }

Example: { "path": "C:/repo/src/lib/util.ts", "transitive": false }`,

  check_coherence: `Coupling/isolation analysis. Coherence score 0-1 (higher = better isolation) + risk class (low/medium/high/critical).

Parameters: { path: string }
Returns: { coherence: { score, risk, fanIn, fanOut, message } }

Example: { "path": "C:/repo/src/main.ts" }`,

  detect_circular_dependencies: `Find ALL dependency cycles in the project graph.

Parameters: {}
Returns: { cycles: string[][] }

Example: {}`,

  // ── OPERATIONS & MONITORING (4) ──
  batch_operations: `Execute multiple filesystem ops (read/write/edit/delete) atomically — failure of any op rolls back prior successful ops. Configurable limit (default 100 ops/batch).

Parameters: { operations: [{ type, path, content?, edits? }] }
Returns: { results: BatchResult[], allSucceeded }

Example:
  { "operations": [
      { "type": "write", "path": "C:/a.txt", "content": "1" },
      { "type": "write", "path": "C:/b.txt", "content": "2" }
    ] }`,

  health_check: `System health snapshot across all subsystems.

Parameters: {}
Returns: {
  status: 'healthy' | 'degraded',
  database: { fileCount, versionCount, auditCount, sizeBytes },
  cache: { primarySize, secondarySize, hits, misses, hitRate, available, redisConnected },
  vectorDb: { indexedFiles, totalDocuments, uniqueTerms, embedding },
  security: { totalPolicies, secretsPatterns, blockedPaths, forbiddenPaths },
  rateLimiter: { allowed, blocked, blockRate, global, perTool },
  metrics: { requests, cacheHits, cacheMisses, errors, avgLatency, activeConnections },
  uptime: number,
  timestamp: ISO-8601
}

Example: {}`,

  get_enabled_features: `List all active feature flags.

Parameters: {}
Returns: { features: string[] }  // count = features.length

Example: {}`,

  get_audit_log: `Query audit trail with filters. All filesystem operations are recorded immutably.

Parameters: { userId?, action?, result?, limit? }
Returns: { events: AuditEvent[] }

Example: { "action": "write", "limit": 20 }`,

  // ── COGNITIVE INTELLIGENCE (11) ──
  build_cognitive_index: `Build the 3-layer cognitive index for a project (Skeleton → Contracts → Fingerprints) + Node-Level Knowledge Graph + Pattern detection + Type flow. REQUIRED before using any other cognitive tool.

Long-running operation: emits MCP progress notifications during build (collect → skeleton → contracts → fingerprints → graph → patterns → type-flow → pipelines).
Supports background execution: returns { jobId } immediately when background:true; use get_build_status to poll.

Parameters: { rootPath: string, background?: boolean }
Returns: { status, duration, modules, units, patterns, typeFlows, pipelines, estimatedTokens } | { jobId: string }

Example: { "rootPath": "C:/repo" }
Example: { "rootPath": "C:/repo", "background": true }  →  { "jobId": "build-1234" }`,

  get_build_status: `Check the status of a background build_cognitive_index job.

Parameters: { jobId: string }
Returns: { jobId, status, progress, total, message, durationMs? }
- status: "pending" | "running" | "completed" | "failed"
- progress: current phase index (0-based)
- total: total phases (6)
- message: human-readable message
- durationMs: elapsed time in ms (only present when completed or failed)

Example: { "jobId": "build-1234" }`,

  get_project_skeleton: `Layer 1 — project overview. Directory tree (depth-4), detected tech stack, architecture patterns, entry points, config files, language distribution.

Parameters: {}
Returns: ProjectSkeleton (or error message if index not built).

Example: {}`,

  get_module_contracts: `Layer 2 — per-file exports, imports, defined types, pattern classification. Optionally filter by file paths.

Parameters: { filePaths?: string[] }
Returns: { modules: ModuleContract[] }

Example: { "filePaths": ["C:/repo/src/auth.ts"] }`,

  get_unit_fingerprints: `Layer 3 — per-function/class fingerprints: signature, complexity, purity, side effects, semantic tags, call targets, type deps. Filterable.

Parameters: { filePaths?, patternTypes?, maxComplexity? }
Returns: { units: UnitFingerprint[] }

Example: { "patternTypes": ["command"], "maxComplexity": 10 }`,

  query_code_intelligence: `Unified query interface — one tool, 8 query types. 'full_context' returns compressed project knowledge optimized for LLM context windows.

Parameters: { type, target?, depth?, filePaths?, languages?, patternTypes?, maxComplexity? }
Query types: skeleton | contracts | fingerprints | impact | flow | patterns | subgraph | full_context

Example: { "type": "full_context" }
Example: { "type": "impact", "target": "module:C:/repo/src/auth.ts", "depth": 2 }`,

  get_impact_analysis: `Impact set (direct + transitive) for a node + reverse subgraph. Use before refactoring to know what will break.

Parameters: { nodeId: string, depth?: number }
Returns: { impact: { direct, transitive, totalAffected }, subgraph }

Example: { "nodeId": "module:C:/repo/src/auth.ts", "depth": 2 }`,

  get_type_flow: `Trace a type through the codebase: where it's defined, who produces it, who transforms it, who validates it, who consumes it.

Parameters: { typeName: string }
Returns: { typeFlow, consumers, producers }

Example: { "typeName": "UserSession" }`,

  detect_patterns: `Detect 11 code pattern categories (CRUD, middleware, observer, factory, singleton, adapter, strategy, repository, service, controller, utility) + semantic compression with token-savings estimation.

Parameters: {}
Returns: { patterns: [...], overallCompressionRatio, estimatedTokenSavings }

Example: {}`,

  get_knowledge_subgraph: `Extract subgraph around a node (depth-limited, bidirectional).

Parameters: { nodeId: string, depth?: number }
Returns: { nodes, edges, entryPoints, boundaryNodes, stats }

Example: { "nodeId": "module:C:/repo/src/main.ts", "depth": 3 }`,

  get_intelligence_stats: `Statistics snapshot across all cognitive modules: HCI index, NLKG graph, patterns, type flows, last build duration.

Parameters: {}
Returns: { cognitiveIndex, nlkg, patterns, typeFlows, lastBuildTime, buildDuration }

Example: {}`,

  // ── HEALTHCARE EXTENSION (v2.1.0-healthcare) ──
  fhir_create: `Create FHIR resource. Parameters: resourceType (string), resource (record), author (string, optional). Returns: {id, location}. Example: {"resourceType":"Patient","resource":{"id":"1"}}`,
  fhir_read: `Read FHIR resource by ID. Parameters: resourceType (string), id (string). Returns: {resource}. Example: {"resourceType":"Patient","id":"1"}`,
  fhir_update: `Update FHIR resource. Parameters: resourceType, id, resource, author?, message?. Returns: {id, location}. Example: {"resourceType":"Patient","id":"1","resource":{"id":"1"}}`,
  fhir_delete: `Delete FHIR resource. Parameters: resourceType (string), id (string). Returns: {success:boolean}. Example: {"resourceType":"Patient","id":"1"}`,
  fhir_search: `Search FHIR resources. Parameters: resourceType (string), params? (record). Returns: {total, resources}. Example: {"resourceType":"Patient","params":{"gender":"male"}}`,
  fhir_batch: `Batch FHIR operations. Parameters: operations array of {op, resourceType, id?, resource?}. Returns: {results}. Example: {"operations":[{"op":"create","resourceType":"Patient","resource":{"id":"1"}}]}`,
  fhir_validate: `Validate FHIR resource. Parameters: resourceType, resource. Returns: {valid,missing,errors}. Example: {"resourceType":"Patient","resource":{"id":"1"}}`,
  fhir_capability: `Declare FHIR server capabilities. Parameters: none. Returns: {version, resourceTypes, operations, implementation}. Example: {}`,
  clinical_assess: `Assess patient risks. Parameters: patientId (string), conditions? (string[]), medications?, labs?. Returns: {risks,recommendations,timestamp}. Example: {"patientId":"p1","conditions":["E11.9"]}`,
  care_plan_create: `Create care plan. Parameters: patientId, goals (string[]), interventions array. Returns: {planId, timeline, createdAt}. Example: {"patientId":"p1","goals":["g1"],"interventions":[{"type":"medication","description":"test"}]}`,
  medication_check: `Check medication conflicts. Parameters: current meds, proposed meds. Returns: {conflicts, interactions}. Example: {"current":[{"name":"aspirin"}],"proposed":[{"name":"ibuprofen"}]}`,
  lab_interp: `Interpret lab results. Parameters: tests array with code,value,unit,referenceRange?. Returns: {interpretations}. Example: {"tests":[{"code":"A1C","value":5.5,"unit":"%"}]}`,
  risk_calculate: `Calculate risk score. Parameters: age, conditions, labs?. Returns: {score,category,explanation}. Example: {"age":70,"conditions":["E11.9"]}`,
  guideline_lookup: `Lookup guidelines. Parameters: condition (string), patientAge?. Returns: {condition,recommendations,source}. Example: {"condition":"E11.9"}`,
  hipaa_audit_report: `HIPAA audit report. Parameters: startDate?, endDate?, patientIdHash?. Returns: {period,totalAccessEvents,phiAccessEvents,suspiciousPatterns,generatedAt}. Example: {}`,
  consent_manage: `Manage consent. Parameters: patientIdHash, purpose, grantedBy, expiry?. Returns: {consentId,status}. Example: {"patientIdHash":"h","purpose":"treatment","grantedBy":"dr"}`,
  phi_detection: `Detect PHI in content. Parameters: content (string), filePath?, sensitivityLevel. Returns: {phiCount,matches,safe}. Example: {"content":"sample","sensitivityLevel":"medium"}`,
  access_log: `Query access log. Parameters: userId?, patientIdHash?, resourceType?, action (read|write|delete|query), limit?. Returns: {events,total,limit}. Example: {"action":"read"}`,
  breach_assess: `Assess data breach. Parameters: incidentType, affectedResources array, description, containsSensitiveData? (boolean, default false). Returns: {assessmentId,riskLevel,requiresNotification,recommendedActions}. Example: {"incidentType":"loss","affectedResources":[{"resourceType":"Patient","resourceId":"1","patientIdHash":"h"}],"description":"test","containsSensitiveData":true}`,
  synthetic_patient_gen: `Generate synthetic patients. Parameters: count (default 1), gender?, minAge?, maxAge?. Returns: {patients}. Example: {"count":2}`,
  synthetic_condition_gen: `Generate synthetic condition. Parameters: patientId, conditionCode?. Returns: {condition}. Example: {"patientId":"p1","conditionCode":"E11.9"}`,
  synthetic_observation_gen: `Generate synthetic observation. Parameters: patientId, loincCode, value, unit, effectiveDateTime?. Returns: {observation}. Example: {"patientId":"p1","loincCode":"1234-5","value":100,"unit":"mg/dL"}`,
  synthetic_bundle_gen: `Generate synthetic bundle. Parameters: patientId, conditions?, observations array. Returns: {bundle}. Example: {"patientId":"p1","conditions":["E11.9"],"observations":[{"loincCode":"1234-5","value":100,"unit":"mg/dL"}]}`,
  a2a_agent_card: `Declare this server's A2A capabilities and identity. Parameters: none. Returns: {agentId,name,version,capabilities,fhirVersion,hipaaCompliant,endpoint}. Example: {}`,
  a2a_discover_agents: `Discover registered healthcare agents. Parameters: capability? (filter by capability). Returns: {agentCount,agents}. Example: {"capability":"lab_order"}`,
  a2a_send_task: `Send a healthcare task to an agent. Parameters: taskType, targetAgentId, patientIdHash, payload, priority? (routine|urgent|stat). Returns: {taskId,status,estimatedCompletionMinutes}. Example: {"taskType":"lab_order","targetAgentId":"lab-agent-v1","patientIdHash":"h","payload":{}}`,
  a2a_get_task_status: `Poll A2A task status. Parameters: taskId. Returns: {taskId,taskType,status,result?}. Example: {"taskId":"task-123"}`,
  a2a_route_message: `Route A2A message. Parameters: message (from,to,protocol,payload,metadata?), routingMode. Returns: {delivered,route,messageId,timestamp}. Example: {"message":{"from":"a","to":"b","protocol":"a2a","payload":{}},"routingMode":"direct"}`,
};

/** Default fallback when a tool lacks a registered description */
export const DEFAULT_TOOL_DESCRIPTION = (name: string): string =>
  `${name} — JCF Healthcare Agent Hub operation. (Description registration pending.)`;

/** Look up rich description; fall back to default. */
export function getToolDescription(name: string): string {
  return TOOL_DESCRIPTIONS[name] ?? DEFAULT_TOOL_DESCRIPTION(name);
}
