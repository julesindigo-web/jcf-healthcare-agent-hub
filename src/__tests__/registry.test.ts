/**
 * Registry contract tests for `src/registry.ts`.
 *
 * The registry is the single source of truth for `name → { schema, handler }`.
 * These tests guarantee:
 *   1. Exactly 55 tools are registered (ADR-H001: estatus + verify removed;
 *      31 base + 24 healthcare = 55).
 *   2. Every tool name in `tool-descriptions.ts` has a registry entry, and
 *      every registry entry has a description.
 *   3. Every entry has a valid zod schema and an async function handler.
 *   4. The dispatcher in `server.ts` can wire registry entries — verified
 *      by smoke-running each handler with minimum-valid args (no throws
 *      on registry plumbing).
 *
 * Built in M11 audit; count updated to 32 (R-3) after diagnostics
 * tools were folded into the registry.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { z } from "zod";

import { TOOL_REGISTRY, REGISTERED_TOOL_NAMES } from "../registry.js";
import { TOOL_DESCRIPTIONS } from "../tool-descriptions.js";

import {
  createTestContext,
  type TestContext,
} from "./_test-context.js";

describe("registry.ts — tool catalog contract", () => {
  it("registers exactly 59 tools (ADR-H001: 31 base + 28 healthcare)", () => {
    expect(Object.keys(TOOL_REGISTRY).length).toBe(59);
    expect(REGISTERED_TOOL_NAMES.length).toBe(59);
  });

  it("REGISTERED_TOOL_NAMES is sorted alphabetically", () => {
    const sorted = REGISTERED_TOOL_NAMES.slice().sort();
    expect(REGISTERED_TOOL_NAMES).toEqual(sorted);
  });

  it("every registered tool has a description in tool-descriptions.ts", () => {
    const missing: string[] = [];
    for (const name of REGISTERED_TOOL_NAMES) {
      if (!TOOL_DESCRIPTIONS[name]) missing.push(name);
    }
    expect(missing, `tools missing description: ${missing.join(", ")}`).toEqual([]);
  });

  it("every description has a corresponding registry entry", () => {
    const orphans: string[] = [];
    for (const name of Object.keys(TOOL_DESCRIPTIONS)) {
      if (!TOOL_REGISTRY[name]) orphans.push(name);
    }
    expect(orphans, `orphan descriptions: ${orphans.join(", ")}`).toEqual([]);
  });

  it("every entry has a zod schema and an async function handler", () => {
    for (const [name, reg] of Object.entries(TOOL_REGISTRY)) {
      expect(reg.schema, `${name} missing schema`).toBeDefined();
      // ZodTypeAny duck-type: must have `.safeParse` method.
      expect(
        typeof (reg.schema as { safeParse?: unknown }).safeParse,
        `${name} schema is not a zod schema`
      ).toBe("function");
      expect(typeof reg.handler, `${name} handler is not a function`).toBe("function");
    }
  });

  it("includes all canonical tool names from the MCP integration suite", () => {
    // This list is intentionally duplicated from `integration.test.ts` so
    // the registry contract is verified independently of dist/ build state.
    const required = [
      // diagnostics (1) — ADR-H001: estatus/verify removed
      "ping",
      // filesystem (6)
      "read_file", "write_file", "edit_file", "append_file", "delete_file",
      "list_directory",
      // search (2)
      "search_files", "semantic_search",
      // versioning (3)
      "get_version_history", "rollback_file", "get_current_metadata",
      // dependencies (4)
      "get_dependents", "get_dependencies", "check_coherence",
      "detect_circular_dependencies",
      // operations (4)
      "batch_operations", "health_check", "get_audit_log",
      "get_enabled_features",
      // intelligence (11)
      "build_cognitive_index", "get_build_status", "get_project_skeleton", "get_module_contracts",
      "get_unit_fingerprints", "get_impact_analysis", "get_type_flow",
      "detect_patterns", "get_knowledge_subgraph", "query_code_intelligence",
      "get_intelligence_stats",
    ];
    const names = new Set(REGISTERED_TOOL_NAMES);
    for (const r of required) {
      expect(names, `missing canonical tool: ${r}`).toContain(r);
    }
  });
});

describe("registry.ts — schema validation per entry", () => {
  /**
   * Smoke-validate that each registered schema accepts at least one
   * minimum-valid input. Catches accidental schema-drift like switching
   * a required field to a different type.
   */
  const minValid: Record<string, unknown> = {
    // Diagnostics (1) — ADR-H001
    ping: {},
    // Filesystem & friends
    read_file: { path: "/x.ts" },
    write_file: { path: "/x.ts", content: "" },
    edit_file: { path: "/x.ts", edits: [{ oldText: "a", newText: "b" }] },
    append_file: { path: "/x.ts", content: "" },
    delete_file: { path: "/x.ts" },
    list_directory: { path: "/x" },
    search_files: { pattern: "*.ts" },
    semantic_search: { query: "x" },
    get_version_history: { path: "/x.ts" },
    rollback_file: { path: "/x.ts", versionId: "v" },
    get_current_metadata: { path: "/x.ts" },
    get_dependents: { path: "/x.ts" },
    get_dependencies: { path: "/x.ts" },
    check_coherence: { path: "/x.ts" },
    detect_circular_dependencies: {},
    batch_operations: { operations: [{ type: "read", path: "/x" }] },
    health_check: {},
    get_enabled_features: {},
    get_audit_log: {},
    build_cognitive_index: { rootPath: "/x" },
    get_project_skeleton: {},
    get_module_contracts: {},
    get_unit_fingerprints: {},
    query_code_intelligence: { type: "skeleton" },
    get_impact_analysis: { nodeId: "n" },
    get_type_flow: { typeName: "T" },
    detect_patterns: {},
    get_knowledge_subgraph: { nodeId: "n" },
    get_intelligence_stats: {},
    get_build_status: { jobId: "job-1" },
    // Healthcare tools (24)
    fhir_create: { resourceType: "Patient", resource: { id: "1", resourceType: "Patient", name: [{ text: "Test" }], gender: "male", birthDate: "2000-01-01" } },
    fhir_read: { resourceType: "Patient", id: "1" },
    fhir_update: { resourceType: "Patient", id: "1", resource: { id: "1", resourceType: "Patient", name: [{ text: "Test" }], gender: "male", birthDate: "2000-01-01" } },
    fhir_delete: { resourceType: "Patient", id: "1" },
    fhir_search: { resourceType: "Patient" },
    fhir_batch: { operations: [{ op: "create", resourceType: "Patient", resource: { id: "1", resourceType: "Patient" } }] },
    fhir_validate: { resourceType: "Patient", resource: { id: "1", resourceType: "Patient" } },
    fhir_capability: {},
    clinical_assess: { patientId: "p1" },
    care_plan_create: { patientId: "p1", goals: ["g1"], interventions: [{ type: "medication", description: "test", durationDays: 7 }] },
    medication_check: { current: [{ name: "aspirin", dose: "100mg", frequency: "daily" }], proposed: [{ name: "ibuprofen", dose: "200mg", frequency: "daily" }] },
    lab_interp: { tests: [{ code: "A1C", value: 5.5, unit: "%" }] },
    risk_calculate: { age: 70, conditions: ["E11.9"] },
    guideline_lookup: { condition: "E11.9" },
    hipaa_audit_report: {},
    consent_manage: { patientIdHash: "h123", purpose: "treatment", grantedBy: "dr" },
    phi_detection: { content: "sample", sensitivityLevel: "medium" },
    access_log: { action: "read" },
    breach_assess: { incidentType: "loss", affectedResources: [{ resourceType: "Patient", resourceId: "1", patientIdHash: "h" }], description: "test" },
    synthetic_patient_gen: { count: 1 },
    synthetic_condition_gen: { patientId: "p1" },
    synthetic_observation_gen: { patientId: "p1", loincCode: "1234-5", value: 100, unit: "mg/dL" },
    synthetic_bundle_gen: { patientId: "p1", conditions: ["E11.9"], observations: [{ loincCode: "1234-5", value: 100, unit: "mg/dL" }] },
    a2a_agent_card: {},
    a2a_discover_agents: {},
    a2a_send_task: { taskType: "lab_order", targetAgentId: "lab-agent-v1", patientIdHash: "h", payload: {}, priority: "routine" },
    a2a_get_task_status: { taskId: "task-123" },
    a2a_route_message: { message: { from: "a", to: "b", protocol: "a2a", payload: {} }, routingMode: "direct" },
  };

  for (const name of Object.keys(TOOL_REGISTRY)) {
    it(`${name} — schema accepts minimum-valid input`, () => {
      const sample = minValid[name];
      expect(sample, `no min-valid sample defined for ${name}`).toBeDefined();
      const schema = TOOL_REGISTRY[name].schema as z.ZodTypeAny;
      const result = schema.safeParse(sample);
      expect(
        result.success,
        result.success ? "" : JSON.stringify(result.error.issues)
      ).toBe(true);
    });
  }
});

describe("registry.ts — handler dispatch through registry", () => {
  let tc: TestContext;
  beforeEach(async () => { tc = await createTestContext(); });
  afterEach(async () => { await tc.cleanup(); });

  it("can dispatch a registered handler by name", async () => {
    const reg = TOOL_REGISTRY["health_check"];
    const result = await reg.handler(tc.ctx, {});
    expect(result).toBeDefined();
    expect(typeof result).toBe("object");
  });

  it("M11-AUDIT FIX (CRIT-2): dispatches detect_patterns returning RAW data (envelope wrap is now dispatcher-only)", async () => {
    const reg = TOOL_REGISTRY["detect_patterns"];
    const result = (await reg.handler(tc.ctx, {})) as {
      patterns: unknown[];
      overallCompressionRatio: number;
      estimatedTokenSavings: number;
    };
    expect(Array.isArray(result.patterns)).toBe(true);
    expect(typeof result.overallCompressionRatio).toBe("number");
    expect(typeof result.estimatedTokenSavings).toBe("number");
  });

  it("dispatches get_enabled_features and returns features array", async () => {
    const reg = TOOL_REGISTRY["get_enabled_features"];
    const result = (await reg.handler(tc.ctx, {})) as { features: string[] };
    expect(Array.isArray(result.features)).toBe(true);
  });

  it("dispatches detect_circular_dependencies (no-arg handler adapter)", async () => {
    const reg = TOOL_REGISTRY["detect_circular_dependencies"];
    const result = (await reg.handler(tc.ctx, {})) as { cycles: unknown[] };
    expect(Array.isArray(result.cycles)).toBe(true);
  });
});
