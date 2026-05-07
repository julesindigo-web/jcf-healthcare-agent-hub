/**
 * Tool registry — single source of truth for `name → { schema, handler }`.
 *
 * Created during the M11 audit as part of decomposing
 * `JcfHealthcareAgentHubServer` into pure handler modules. Mirrors the M10
 * jcf-memory pattern: each tool gets a single registry entry that pairs
 * its zod input schema with the pure async handler function.
 *
 * The dispatcher in `server.ts` iterates over `TOOL_REGISTRY` and wires
 * every entry into the MCP server. Adding a new tool requires:
 *   1. Implementing the pure handler in the appropriate `handlers/*` module.
 *   2. Adding one entry to `TOOL_REGISTRY` below.
 *   3. Adding a description to `tool-descriptions.ts`.
 *
 * NO change to `server.ts` is needed for new tools — the registry-driven
 * dispatcher picks them up automatically.
 *
 * 31 tools across 7 categories:
 *   diagnostics(1) + filesystem(6) + search(2) + versioning(3)
 *     + dependencies(4) + operations(4) + intelligence(11) = 31
 *
 * ADR-H001: estatus + verify removed — constitutional enforcement not relevant
 * for healthcare domain. ping retained as pure health check.
 *
 * HEALTHCARE EXTENSION (v2.1.0-healthcare):
 *   fhir(8) + clinical(6) + compliance(5) + synthetic(4) + a2a(5) = 28 additional tools
 *   Grand total: 59 tools
 */

import { z } from "zod";
import type { HandlerContext, ToolHandler } from "./handlers/context.js";

// ── Category modules ──
import * as filesystem from "./handlers/filesystem.js";
import * as search from "./handlers/search.js";
import * as versioning from "./handlers/versioning.js";
import * as dependencies from "./handlers/dependencies.js";
import * as operations from "./handlers/operations.js";
import * as intelligence from "./handlers/intelligence.js";
import { diagnosticsHandlers } from "./handlers/diagnostics.js";
import * as healthcare from "./healthcare/index.js";

/**
 * One registry entry — a tool's zod input schema paired with its pure
 * handler function. The handler signature is `(ctx, args) => Promise<unknown>`;
 * the dispatcher in `server.ts` wraps the result into the MCP envelope.
 */
export interface ToolRegistration {
  /** Zod schema for the MCP `inputSchema`. */
  schema: z.ZodTypeAny;
  /** Pure handler. Takes the shared context plus zod-validated args. */
  handler: ToolHandler<unknown, unknown>;
}

/**
 * Helper to assert that a handler conforms to the generic `ToolHandler`
 * signature. Pure type-erasure — runtime is `(ctx, args) => h(ctx, args)`.
 *
 * Without this wrapper TypeScript can't unify the heterogeneous handler
 * signatures (each takes a different `Args` type) under the registry's
 * uniform `ToolHandler<unknown, unknown>` slot.
 */
function adapt<Args, Result>(
  h: (ctx: HandlerContext, args: Args) => Promise<Result>
): ToolHandler<unknown, unknown> {
  return (ctx: HandlerContext, args: unknown) =>
    h(ctx, args as Args) as Promise<unknown>;
}

/**
 * The full tool registry. Order matches the original `setupTools()` order
 * in `server.ts` — tests that snapshot tool registration order should keep
 * passing.
 */
export const TOOL_REGISTRY: Record<string, ToolRegistration> = {
  // ───────────────────────── DIAGNOSTICS (1) ─────────────────
  // ADR-H001: estatus + verify removed — not relevant for healthcare domain.
  ping: {
    schema: z.object({}),
    handler: adapt(diagnosticsHandlers.ping),
  },

  // ───────────────────────── FILESYSTEM (6) ─────────────────────────
  read_file: {
    schema: z.object({
      path: z.string(),
      offset: z.number().int().positive().optional(),
      limit: z.number().int().positive().optional(),
      maxLines: z.number().int().positive().optional(),
    }),
    handler: adapt(filesystem.readFile),
  },
  write_file: {
    schema: z.object({
      path: z.string(),
      content: z.string(),
      author: z.string().optional(),
      message: z.string().optional(),
    }),
    handler: adapt(filesystem.writeFile),
  },
  edit_file: {
    schema: z.object({
      path: z.string(),
      edits: z.array(
        z.object({
          oldText: z.string(),
          newText: z.string(),
        })
      ),
      // M13.2: god-mode safety surface. `unsafe` opts out
      // of the pre-flight risk scan + post-edit integrity check;
      // `dryRun` runs the full pipeline without writing to disk.
      unsafe: z.boolean().optional(),
      dryRun: z.boolean().optional(),
    }),
    handler: adapt(filesystem.editFile),
  },
  append_file: {
    schema: z.object({
      path: z.string(),
      content: z.string(),
      createIfMissing: z.boolean().optional(),
    }),
    handler: adapt(filesystem.appendFile),
  },
  delete_file: {
    schema: z.object({ path: z.string() }),
    handler: adapt(filesystem.deleteFile),
  },
  list_directory: {
    schema: z.object({
      path: z.string(),
      includeHidden: z.boolean().optional(),
    }),
    handler: adapt(filesystem.listDirectory),
  },

  // ───────────────────────── SEARCH (2) ─────────────────────────
  search_files: {
    schema: z.object({
      pattern: z.string(),
      baseDir: z.string().optional(),
    }),
    handler: adapt(search.searchFiles),
  },
  semantic_search: {
    schema: z.object({
      query: z.string(),
      limit: z.number().optional(),
      threshold: z.number().optional(),
      rootPath: z.string().optional(),
      autoIndex: z.boolean().optional(),
    }),
    handler: adapt(search.semanticSearch),
  },

  // ───────────────────────── VERSIONING (3) ─────────────────────────
  get_version_history: {
    schema: z.object({
      path: z.string(),
      limit: z.number().optional(),
    }),
    handler: adapt(versioning.getVersionHistory),
  },
  rollback_file: {
    schema: z.object({
      path: z.string(),
      versionId: z.string(),
    }),
    handler: adapt(versioning.rollbackFile),
  },
  get_current_metadata: {
    schema: z.object({ path: z.string() }),
    handler: adapt(versioning.getMetadata),
  },

  // ───────────────────────── DEPENDENCIES (4) ─────────────────────────
  get_dependents: {
    schema: z.object({
      path: z.string(),
      transitive: z.boolean().optional(),
    }),
    handler: adapt(dependencies.getDependents),
  },
  get_dependencies: {
    schema: z.object({
      path: z.string(),
      transitive: z.boolean().optional(),
    }),
    handler: adapt(dependencies.getDependencies),
  },
  check_coherence: {
    schema: z.object({ path: z.string() }),
    handler: adapt(dependencies.checkCoherence),
  },
  detect_circular_dependencies: {
    schema: z.object({}),
    handler: adapt((ctx) => dependencies.detectCycles(ctx)),
  },

  // ───────────────────────── OPERATIONS (4) ─────────────────────────
  batch_operations: {
    schema: z.object({
      operations: z.array(
        z.object({
          type: z.enum(["read", "write", "edit", "delete"]),
          path: z.string(),
          content: z.string().optional(),
          edits: z
            .array(
              z.object({
                oldText: z.string(),
                newText: z.string(),
              })
            )
            .optional(),
        })
      ),
    }),
    handler: adapt(operations.batchOperations),
  },
  health_check: {
    schema: z.object({}),
    handler: adapt((ctx) => operations.healthCheck(ctx)),
  },
  get_enabled_features: {
    schema: z.object({}),
    handler: adapt((ctx) => operations.getEnabledFeatures(ctx)),
  },
  get_audit_log: {
    // M11-AUDIT FIX (MED-5): tightened `result` from `z.string()` to enum
    // so invalid values are rejected at validation time. Previously the
    // string passed through to SQL, where it would silently match nothing
    // (no audit events with `result='garbage'`) — clients had no signal
    // that their filter was malformed.
    schema: z.object({
      userId: z.string().optional(),
      action: z.string().optional(),
      result: z.enum(["success", "failure"]).optional(),
      limit: z.number().int().positive().optional(),
    }),
    handler: adapt(operations.getAuditLog),
  },

  // ───────────────────────── INTELLIGENCE (11) ─────────────────────────
  build_cognitive_index: {
    schema: z.object({ rootPath: z.string() }),
    handler: adapt(intelligence.buildCognitiveIndex),
  },
  get_build_status: {
    schema: z.object({ jobId: z.string() }),
    handler: adapt(intelligence.getBuildStatus),
  },
  get_project_skeleton: {
    schema: z.object({}),
    handler: adapt(intelligence.getProjectSkeleton),
  },
  get_module_contracts: {
    schema: z.object({
      filePaths: z.array(z.string()).optional(),
    }),
    handler: adapt(intelligence.getModuleContracts),
  },
  get_unit_fingerprints: {
    schema: z.object({
      filePaths: z.array(z.string()).optional(),
      patternTypes: z.array(z.string()).optional(),
      maxComplexity: z.number().optional(),
    }),
    handler: adapt(intelligence.getUnitFingerprints),
  },
  query_code_intelligence: {
    schema: z.object({
      type: z.enum([
        "skeleton",
        "contracts",
        "fingerprints",
        "impact",
        "flow",
        "patterns",
        "subgraph",
        "full_context",
      ]),
      target: z.string().optional(),
      depth: z.number().optional(),
      filePaths: z.array(z.string()).optional(),
      languages: z.array(z.string()).optional(),
      patternTypes: z.array(z.string()).optional(),
      maxComplexity: z.number().optional(),
    }),
    handler: adapt(intelligence.queryCodeIntelligence),
  },
  get_impact_analysis: {
    schema: z.object({
      nodeId: z.string(),
      depth: z.number().optional(),
    }),
    handler: adapt(intelligence.getImpactAnalysis),
  },
  get_type_flow: {
    schema: z.object({ typeName: z.string() }),
    handler: adapt(intelligence.getTypeFlow),
  },
  detect_patterns: {
    schema: z.object({}),
    handler: adapt(intelligence.detectPatterns),
  },
  get_knowledge_subgraph: {
    schema: z.object({
      nodeId: z.string(),
      depth: z.number().optional(),
    }),
    handler: adapt(intelligence.getKnowledgeSubgraph),
  },
   get_intelligence_stats: {
     schema: z.object({}),
     handler: adapt(intelligence.getIntelligenceStats),
   },

   // ───────────────────────── HEALTHCARE (FHIR + CDS + Compliance + A2A) ─────────────────────────
   // Import healthcare handlers at top of file: import * as healthcare from "./healthcare/index.js";
   fhir_create: {
     schema: healthcare.fhirSchemas.fhirCreate,
     handler: adapt(healthcare.fhirCreate),
   },
   fhir_read: {
     schema: healthcare.fhirSchemas.fhirRead,
     handler: adapt(healthcare.fhirRead),
   },
   fhir_update: {
     schema: healthcare.fhirSchemas.fhirUpdate,
     handler: adapt(healthcare.fhirUpdate),
   },
   fhir_delete: {
     schema: healthcare.fhirSchemas.fhirDelete,
     handler: adapt(healthcare.fhirDelete),
   },
   fhir_search: {
     schema: healthcare.fhirSchemas.fhirSearch,
     handler: adapt(healthcare.fhirSearch),
   },
   fhir_batch: {
     schema: healthcare.fhirSchemas.fhirBatch,
     handler: adapt(healthcare.fhirBatch),
   },
   fhir_validate: {
     schema: healthcare.fhirSchemas.fhirValidate,
     handler: adapt(healthcare.fhirValidate),
   },
   fhir_capability: {
     schema: healthcare.fhirSchemas.fhirCapability,
     handler: adapt(healthcare.fhirCapability),
   },

   clinical_assess: {
     schema: healthcare.clinicalSchemas.clinicalAssess,
     handler: adapt(healthcare.clinicalAssess),
   },
   care_plan_create: {
     schema: healthcare.clinicalSchemas.carePlanCreate,
     handler: adapt(healthcare.carePlanCreate),
   },
   medication_check: {
     schema: healthcare.clinicalSchemas.medicationCheck,
     handler: adapt(healthcare.medicationCheck),
   },
   lab_interp: {
     schema: healthcare.clinicalSchemas.labInterp,
     handler: adapt(healthcare.labInterp),
   },
   risk_calculate: {
     schema: healthcare.clinicalSchemas.riskCalculate,
     handler: adapt(healthcare.riskCalculate),
   },
   guideline_lookup: {
     schema: healthcare.clinicalSchemas.guidelineLookup,
     handler: adapt(healthcare.guidelineLookup),
   },

   hipaa_audit_report: {
     schema: healthcare.complianceSchemas.hipaaAuditReport,
     handler: adapt(healthcare.hipaaAuditReport),
   },
   consent_manage: {
     schema: healthcare.complianceSchemas.consentManage,
     handler: adapt(healthcare.consentManage),
   },
   phi_detection: {
     schema: healthcare.complianceSchemas.phiDetection,
     handler: adapt(healthcare.phiDetection),
   },
   access_log: {
     schema: healthcare.complianceSchemas.accessLog,
     handler: adapt(healthcare.accessLog),
   },
   breach_assess: {
     schema: healthcare.complianceSchemas.breachAssess,
     handler: adapt(healthcare.breachAssess),
   },

   synthetic_patient_gen: {
     schema: healthcare.syntheticSchemas.syntheticPatientGen,
     handler: adapt(healthcare.syntheticPatientGen),
   },
   synthetic_condition_gen: {
     schema: healthcare.syntheticSchemas.syntheticConditionGen,
     handler: adapt(healthcare.syntheticConditionGen),
   },
   synthetic_observation_gen: {
     schema: healthcare.syntheticSchemas.syntheticObservationGen,
     handler: adapt(healthcare.syntheticObservationGen),
   },
   synthetic_bundle_gen: {
     schema: healthcare.syntheticSchemas.syntheticBundleGen,
     handler: adapt(healthcare.syntheticBundleGen),
   },

   a2a_agent_card: {
     schema: healthcare.a2aSchemas.a2aAgentCard,
     handler: adapt(healthcare.a2aAgentCard),
   },
   a2a_discover_agents: {
     schema: healthcare.a2aSchemas.a2aDiscoverAgents,
     handler: adapt(healthcare.a2aDiscoverAgents),
   },
   a2a_send_task: {
     schema: healthcare.a2aSchemas.a2aSendTask,
     handler: adapt(healthcare.a2aSendTask),
   },
   a2a_get_task_status: {
     schema: healthcare.a2aSchemas.a2aGetTaskStatus,
     handler: adapt(healthcare.a2aGetTaskStatus),
   },
   a2a_route_message: {
     schema: healthcare.a2aSchemas.a2aRouteMessage,
     handler: adapt(healthcare.a2aRouteMessage),
   },
 };

/**
 * Stable sorted list of registered tool names. Useful for tests that want
 * to verify registration completeness without depending on insertion order.
 */
export const REGISTERED_TOOL_NAMES: readonly string[] = Object.freeze(
  Object.keys(TOOL_REGISTRY).slice().sort()
);
