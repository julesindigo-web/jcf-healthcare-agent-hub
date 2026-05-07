/**
 * Healthcare Module — Synthetic PHI-Safe Data Generation
 *
 * Tools: 4
 * Status: Placeholder implementation (Faker-based)
 */

import type { HandlerContext } from "../handlers/context.js";
import { z } from "zod";
import { withAudit } from "../handlers/shared/audit.js";

// ──────────────────────────────────────────────────────────────
// Schemas
// ──────────────────────────────────────────────────────────────

const SyntheticPatientGenArgs = z.object({
  count: z.number().int().positive().max(100).default(1),
  gender: z.enum(["male", "female", "other"]).optional(),
  minAge: z.number().int().min(0).max(120).default(0),
  maxAge: z.number().int().min(0).max(120).default(120),
});

const SyntheticConditionGenArgs = z.object({
  patientId: z.string(),
  conditionCode: z.string().optional(),
});

const SyntheticObservationGenArgs = z.object({
  patientId: z.string(),
  loincCode: z.string(),
  value: z.number(),
  unit: z.string(),
  effectiveDateTime: z.string().datetime().optional(),
});

const SyntheticBundleGenArgs = z.object({
  patientId: z.string(),
  conditions: z.array(z.string()).default([]),
  observations: z.array(
    z.object({
      loincCode: z.string(),
      value: z.number(),
      unit: z.string(),
    })
  ).default([]),
});

// ──────────────────────────────────────────────────────────────
// Handlers (placeholders — Faker-based)
// ──────────────────────────────────────────────────────────────

export async function syntheticPatientGen(
  ctx: HandlerContext,
  args: z.infer<typeof SyntheticPatientGenArgs>
) {
  return withAudit(ctx, "synthetic_patient_gen" as const, "synthetic", async () => {
    const patients = [];
    for (let i = 0; i < args.count; i++) {
      const id = `syn-${Date.now()}-${i}`;
      const gender = args.gender ?? (Math.random() > 0.5 ? "male" : "female");
      const age = Math.floor(Math.random() * (args.maxAge - args.minAge + 1)) + args.minAge;
      const birthDate = new Date(Date.now() - age * 365 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
      patients.push({
        resourceType: "Patient",
        id,
        name: [{ use: "official", text: `Synthetic Patient ${id}` }],
        gender,
        birthDate,
        address: [{ use: "home", text: "123 Fake Street, Springfield" }],
        telecom: [
          { system: "email", value: `patient${id}@example.com` },
          { system: "phone", value: `+1-555-${Math.floor(1000 + Math.random() * 9000)}` },
        ],
      });
    }
    return { patients };
  });
}

export async function syntheticConditionGen(
  ctx: HandlerContext,
  args: z.infer<typeof SyntheticConditionGenArgs>
) {
  return withAudit(ctx, "synthetic_condition_gen" as const, `patient:${args.patientId}`, async () => {
    const conditionCode = args.conditionCode ?? "E11.9";
    const conditionId = `cond-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const resource = {
      resourceType: "Condition",
      id: conditionId,
      clinicalStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code: "active" }] },
      verificationStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-ver-status", code: "confirmed" }] },
      code: { coding: [{ system: "http://hl7.org/fhir/sid/icd-10", code: conditionCode, display: "Type 2 diabetes mellitus" }] },
      subject: { reference: `Patient/${args.patientId}` },
      onsetDateTime: new Date().toISOString(),
    };
    return { condition: resource };
  });
}

export async function syntheticObservationGen(
  ctx: HandlerContext,
  args: z.infer<typeof SyntheticObservationGenArgs>
) {
  return withAudit(ctx, "synthetic_observation_gen" as const, `patient:${args.patientId}`, async () => {
    const obsId = `obs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const resource = {
      resourceType: "Observation",
      id: obsId,
      status: "final",
      code: {
        coding: [{ system: "http://loinc.org", code: args.loincCode }],
        text: `Synthetic observation ${args.loincCode}`,
      },
      subject: { reference: `Patient/${args.patientId}` },
      effectiveDateTime: args.effectiveDateTime ?? new Date().toISOString(),
      valueQuantity: { value: args.value, unit: args.unit },
    };
    return { observation: resource };
  });
}

export async function syntheticBundleGen(
  ctx: HandlerContext,
  args: z.infer<typeof SyntheticBundleGenArgs>
) {
  return withAudit(ctx, "synthetic_bundle_gen" as const, `patient:${args.patientId}`, async () => {
    const patientRes = await syntheticPatientGen(ctx, { count: 1, minAge: 30, maxAge: 60 });
    const patient = patientRes.patients[0];
    // Use the generated patient's actual ID so all resource references are internally consistent
    const patientId = patient.id;
    const conditions = await Promise.all(
      args.conditions.map(c => syntheticConditionGen(ctx, { patientId, conditionCode: c }))
    );
    const observations = await Promise.all(
      args.observations.map(o => syntheticObservationGen(ctx, { patientId, ...o }))
    );
    const bundle = {
      resourceType: "Bundle",
      type: "collection",
      total: 1 + conditions.length + observations.length,
      entry: [
        { fullUrl: `urn:uuid:${patient.id}`, resource: patient },
        ...conditions.map(c => ({ fullUrl: `urn:uuid:${c.condition.id}`, resource: c.condition })),
        ...observations.map(o => ({ fullUrl: `urn:uuid:${o.observation.id}`, resource: o.observation })),
      ],
    };
    return { bundle };
  });
}

// Export schemas for registry
export const syntheticSchemas = {
  syntheticPatientGen: SyntheticPatientGenArgs,
  syntheticConditionGen: SyntheticConditionGenArgs,
  syntheticObservationGen: SyntheticObservationGenArgs,
  syntheticBundleGen: SyntheticBundleGenArgs,
};