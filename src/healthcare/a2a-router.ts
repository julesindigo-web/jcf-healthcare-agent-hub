/**
 * Healthcare Module — A2A (Agent-to-Agent) Router Bridge
 *
 * Phase 5: Expanded from 1 to 5 tools — minimum viable A2A for hackathon demo.
 * Implements draft-01 of W3C Agent2Agent protocol.
 *
 * Tools:
 *   - a2a_agent_card      — declare this server's capabilities
 *   - a2a_discover_agents — discover registered healthcare agents
 *   - a2a_send_task       — send a healthcare task to an agent
 *   - a2a_get_task_status — poll task status
 *   - a2a_route_message   — route A2A messages (original)
 */

import type { HandlerContext } from "../handlers/context.js";
import { z } from "zod";
import { withAudit } from "../handlers/shared/audit.js";

// ──────────────────────────────────────────────────────────────
// Schemas
// ──────────────────────────────────────────────────────────────

const A2AAgentCardArgs = z.object({});

const A2ADiscoverAgentsArgs = z.object({
  capability: z.string().optional(),
});

const A2ASendTaskArgs = z.object({
  taskType: z.enum(["lab_order", "medication_request", "imaging_request", "referral", "care_coordination"]),
  targetAgentId: z.string(),
  patientIdHash: z.string(),
  payload: z.record(z.any()),
  priority: z.enum(["routine", "urgent", "stat"]).default("routine"),
});

const A2AGetTaskStatusArgs = z.object({
  taskId: z.string(),
});

const A2ARouteMessageArgs = z.object({
  message: z.object({
    from: z.string(),
    to: z.string(),
    protocol: z.literal("a2a"),
    payload: z.record(z.any()),
    metadata: z.record(z.any()).optional(),
  }),
  routingMode: z.enum(["direct", "broadcast", "capability"]).default("direct"),
});

// ──────────────────────────────────────────────────────────────
// In-memory task store (hackathon demo — not persistent)
// ──────────────────────────────────────────────────────────────
const _taskStore = new Map<string, {
  taskId: string;
  taskType: string;
  targetAgentId: string;
  patientIdHash: string;
  status: "queued" | "in_progress" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
  result?: unknown;
}>();

// ──────────────────────────────────────────────────────────────
// Static agent registry (hackathon demo)
// ──────────────────────────────────────────────────────────────
const AGENT_REGISTRY = [
  {
    agentId: "lab-agent-v1",
    name: "Laboratory Agent",
    version: "1.0.0",
    capabilities: ["lab_order", "lab_result_retrieval"],
    fhirVersion: "R4",
    status: "available",
    endpoint: "a2a://lab-agent/",
  },
  {
    agentId: "pharmacy-agent-v1",
    name: "Pharmacy Agent",
    version: "1.0.0",
    capabilities: ["medication_request", "drug_interaction_check", "dispense"],
    fhirVersion: "R4",
    status: "available",
    endpoint: "a2a://pharmacy-agent/",
  },
  {
    agentId: "radiology-agent-v1",
    name: "Radiology Agent",
    version: "1.0.0",
    capabilities: ["imaging_request", "radiology_report"],
    fhirVersion: "R4",
    status: "available",
    endpoint: "a2a://radiology-agent/",
  },
  {
    agentId: "referral-agent-v1",
    name: "Specialist Referral Agent",
    version: "1.0.0",
    capabilities: ["referral", "appointment_scheduling"],
    fhirVersion: "R4",
    status: "available",
    endpoint: "a2a://referral-agent/",
  },
];

// ──────────────────────────────────────────────────────────────
// Handlers
// ──────────────────────────────────────────────────────────────

export async function a2aAgentCard(
  _ctx: HandlerContext,
  _args: z.infer<typeof A2AAgentCardArgs>
) {
  return {
    agentId: "jcf-healthcare-hub-v2.1",
    name: "JCF Healthcare Agent Hub",
    version: "2.1.0-healthcare",
    protocol: "a2a-draft-01",
    capabilities: [
      "fhir_crud", "clinical_decision_support", "hipaa_compliance",
      "phi_detection", "synthetic_data", "a2a_routing",
    ],
    fhirVersion: "R4",
    supportedResourceTypes: ["Patient", "Condition", "Observation", "Procedure", "MedicationRequest"],
    hipaaCompliant: true,
    endpoint: "mcp://jcf-healthcare-agent-hub/",
    publicKey: null,
  };
}

export async function a2aDiscoverAgents(
  ctx: HandlerContext,
  args: z.infer<typeof A2ADiscoverAgentsArgs>
) {
  return withAudit(ctx, "a2a_discover_agents" as const, "registry", async () => {
    const agents = args.capability
      ? AGENT_REGISTRY.filter(a => a.capabilities.includes(args.capability!))
      : AGENT_REGISTRY;
    return {
      agentCount: agents.length,
      agents,
      discoveredAt: new Date().toISOString(),
    };
  });
}

export async function a2aSendTask(
  ctx: HandlerContext,
  args: z.infer<typeof A2ASendTaskArgs>
) {
  return withAudit(ctx, "a2a_send_task" as const, `agent:${args.targetAgentId}`, async () => {
    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    _taskStore.set(taskId, {
      taskId,
      taskType: args.taskType,
      targetAgentId: args.targetAgentId,
      patientIdHash: args.patientIdHash,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    });
    const estimatedMinutes = args.priority === "stat" ? 5 : args.priority === "urgent" ? 30 : 120;
    return {
      taskId,
      status: "queued",
      targetAgentId: args.targetAgentId,
      taskType: args.taskType,
      priority: args.priority,
      estimatedCompletionMinutes: estimatedMinutes,
      createdAt: now,
    };
  });
}

export async function a2aGetTaskStatus(
  ctx: HandlerContext,
  args: z.infer<typeof A2AGetTaskStatusArgs>
) {
  return withAudit(ctx, "a2a_get_task_status" as const, `task:${args.taskId}`, async () => {
    const task = _taskStore.get(args.taskId);
    if (!task) {
      return { taskId: args.taskId, status: "not_found", message: "Task not found in registry" };
    }
    return {
      taskId: task.taskId,
      taskType: task.taskType,
      targetAgentId: task.targetAgentId,
      status: task.status,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      result: task.result ?? null,
    };
  });
}

export async function a2aRouteMessage(
  ctx: HandlerContext,
  args: z.infer<typeof A2ARouteMessageArgs>
) {
  return withAudit(ctx, "a2a_route_message" as const, `from:${args.message.from}→to:${args.message.to}`, async () => {
    const { to, from } = args.message;
    const targetAgent = AGENT_REGISTRY.find(a => a.agentId === to || a.endpoint.includes(to));
    const route = targetAgent
      ? `${args.routingMode}:${targetAgent.endpoint}`
      : `${args.routingMode}:${to}`;
    return {
      delivered: !!targetAgent,
      route,
      from,
      to,
      messageId: `a2a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      targetAgentFound: !!targetAgent,
      timestamp: new Date().toISOString(),
    };
  });
}

// Export schemas for registry
export const a2aSchemas = {
  a2aAgentCard: A2AAgentCardArgs,
  a2aDiscoverAgents: A2ADiscoverAgentsArgs,
  a2aSendTask: A2ASendTaskArgs,
  a2aGetTaskStatus: A2AGetTaskStatusArgs,
  a2aRouteMessage: A2ARouteMessageArgs,
};