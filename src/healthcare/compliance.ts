/**
 * Healthcare Module — HIPAA Compliance & Audit
 *
 * Tools: 5
 * Phase 3: Real PHI detection, real audit DB queries, fixed breach assess.
 * SEC-02: PHI-specific regex patterns (name, DOB, phone, SSN, MRN, address, email).
 * SEC-03: hipaaAuditReport + accessLog now query ctx.db.getAuditLog().
 * SEC-06: breachAssess uses explicit containsSensitiveData param (not UUID heuristic).
 */

import type { HandlerContext } from "../handlers/context.js";
import { z } from "zod";
import { withAudit } from "../handlers/shared/audit.js";

// ──────────────────────────────────────────────────────────────
// Schemas
// ──────────────────────────────────────────────────────────────

const HipaaAuditReportArgs = z.object({
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  patientIdHash: z.string().optional(),
});

const ConsentManageArgs = z.object({
  patientIdHash: z.string(),
  purpose: z.string(),
  grantedBy: z.string(),
  expiry: z.string().datetime().optional(),
});

const PhiDetectionArgs = z.object({
  content: z.string(),
  filePath: z.string().optional(),
  sensitivityLevel: z.enum(["low", "medium", "high"]).default("medium"),
});

const AccessLogArgs = z.object({
  userId: z.string().optional(),
  patientIdHash: z.string().optional(),
  resourceType: z.string().optional(),
  action: z.enum(["read", "write", "delete", "query"]),
  limit: z.number().int().positive().optional(),
});

const BreachAssessArgs = z.object({
  incidentType: z.string(),
  affectedResources: z.array(
    z.object({
      resourceType: z.string(),
      resourceId: z.string(),
      patientIdHash: z.string(),
    })
  ),
  description: z.string(),
  containsSensitiveData: z.boolean().default(false),
});

// ──────────────────────────────────────────────────────────────
// Handlers
// ──────────────────────────────────────────────────────────────

export async function hipaaAuditReport(
  ctx: HandlerContext,
  args: z.infer<typeof HipaaAuditReportArgs>
) {
  return withAudit(ctx, "hipaa_audit_report" as const, "audit", async () => {
    const start = args.startDate ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const end = args.endDate ?? new Date().toISOString();
    // SEC-03: Query real audit log from DB via queryAudits
    const allEvents = ctx.db.queryAudits({
      startTime: new Date(start),
      endTime: new Date(end),
      limit: 10000,
    });
    const period = allEvents;
    const phiEvents = period.filter((e) =>
      String(e.action ?? "").startsWith("fhir") || String(e.path ?? "").includes("patient")
    );
    // Suspicious: >100 phi events from same userId in period
    const userCounts: Record<string, number> = {};
    for (const e of phiEvents) {
      const uid = String((e as unknown as Record<string, unknown>).userId ?? "unknown");
      userCounts[uid] = (userCounts[uid] ?? 0) + 1;
    }
    const suspiciousPatterns = Object.entries(userCounts)
      .filter(([, count]) => count > 100)
      .map(([userId, count]) => ({ userId, eventCount: count, pattern: "high_frequency_phi_access" }));
    return {
      period: { start, end },
      totalAccessEvents: period.length,
      phiAccessEvents: phiEvents.length,
      suspiciousPatterns,
      generatedAt: new Date().toISOString(),
    };
  });
}

export async function consentManage(
  ctx: HandlerContext,
  args: z.infer<typeof ConsentManageArgs>
) {
  return withAudit(ctx, "consent_manage" as const, `patient:${args.patientIdHash}`, async () => {
    const consentId = `consent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return {
      consentId,
      patientIdHash: args.patientIdHash,
      purpose: args.purpose,
      grantedBy: args.grantedBy,
      grantedAt: new Date().toISOString(),
      expiry: args.expiry,
      status: "active",
    };
  });
}

// SEC-02: PHI-specific regex patterns per HIPAA Safe Harbor §164.514(b)(2)
const PHI_PATTERNS: Array<{ name: string; regex: RegExp; severity: "low" | "medium" | "high" }> = [
  { name: "SSN",        regex: /\b\d{3}-\d{2}-\d{4}\b/g,                         severity: "high" },
  { name: "DOB",        regex: /\b(19|20)\d{2}[-/](0[1-9]|1[0-2])[-/](0[1-9]|[12]\d|3[01])\b/g, severity: "high" },
  { name: "phone",      regex: /\b(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g, severity: "medium" },
  { name: "email",      regex: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g, severity: "medium" },
  { name: "MRN",        regex: /\b(MRN|mrn|Medical Record)[\s#:]{0,3}\d{4,12}\b/g, severity: "high" },
  { name: "NPI",        regex: /\b(NPI)[\s#:]{0,3}\d{10}\b/g,                    severity: "high" },
  { name: "person_name",regex: /\b(Dr\.|Mr\.|Mrs\.|Ms\.|Miss)\s+[A-Z][a-z]+\s+[A-Z][a-z]+/g, severity: "medium" },
  { name: "address",    regex: /\b\d{1,5}\s+[A-Z][a-z]+\s+(Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln)\b/gi, severity: "medium" },
  { name: "zip_code",   regex: /\b\d{5}(-\d{4})?\b/g,                             severity: "low" },
  { name: "ipv4",       regex: /\b(25[0-5]|2[0-4]\d|[01]?\d\d?)\.(25[0-5]|2[0-4]\d|[01]?\d\d?)\.(25[0-5]|2[0-4]\d|[01]?\d\d?)\.(25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g, severity: "low" },
];

const SEVERITY_THRESHOLD: Record<"low" | "medium" | "high", number> = {
  low: 3, medium: 2, high: 1,
};

export async function phiDetection(
  _ctx: HandlerContext,
  args: z.infer<typeof PhiDetectionArgs>
) {
  const threshold = SEVERITY_THRESHOLD[args.sensitivityLevel];
  const lines = args.content.split("\n");
  const matches: Array<{ line: number; type: string; value: string; severity: string }> = [];

  for (const pattern of PHI_PATTERNS) {
    // Only include patterns at or above threshold
    const severityRank = SEVERITY_THRESHOLD[pattern.severity];
    if (severityRank > threshold) continue;
    lines.forEach((lineText: string, idx: number) => {
      const re = new RegExp(pattern.regex.source, pattern.regex.flags);
      while (re.exec(lineText) !== null) {
        matches.push({
          line: idx + 1,
          type: pattern.name,
          value: `[REDACTED:${pattern.name}]`, // never expose actual PHI in output
          severity: pattern.severity,
        });
      }
    });
  }

  return {
    phiCount: matches.length,
    matches,
    safe: matches.length === 0,
    sensitivityLevel: args.sensitivityLevel,
  };
}

export async function accessLog(
  ctx: HandlerContext,
  args: z.infer<typeof AccessLogArgs>
) {
  return withAudit(ctx, "access_log" as const, "log", async () => {
    // SEC-03: Query real audit log from DB via queryAudits
    const limit = args.limit ?? 100;
    const allEvents = ctx.db.queryAudits({ limit: limit * 5 });
    // Post-filter by userId, patientIdHash, resourceType, action
    const filtered = allEvents.filter((e) => {
      const ec = e as unknown as Record<string, unknown>;
      if (args.userId && String(ec.userId ?? "") !== args.userId) return false;
      if (args.action && String(ec.action ?? "") !== args.action) return false;
      if (args.patientIdHash && !String(ec.path ?? "").includes(args.patientIdHash)) return false;
      if (args.resourceType && !String(ec.path ?? "").includes(args.resourceType)) return false;
      return true;
    }).slice(0, limit);
    return {
      events: filtered,
      total: filtered.length,
      limit,
    };
  });
}

export async function breachAssess(
  ctx: HandlerContext,
  args: z.infer<typeof BreachAssessArgs>
) {
  return withAudit(ctx, "breach_assess" as const, "breach", async () => {
    // SEC-06: Use explicit containsSensitiveData param, not UUID-heuristic
    const affectedCount = args.affectedResources.length;
    const riskScore = affectedCount * (args.containsSensitiveData ? 10 : 1);
    let level: "low" | "medium" | "high" | "critical";
    if (riskScore < 5) level = "low";
    else if (riskScore < 25) level = "medium";
    else if (riskScore < 100) level = "high";
    else level = "critical";
    const requiresNotification = level === "high" || level === "critical" || affectedCount >= 500;
    return {
      assessmentId: `breach-${Date.now()}`,
      riskLevel: level,
      affectedCount,
      containsSensitiveData: args.containsSensitiveData,
      requiresNotification,
      hipaaBreach: requiresNotification,
      recommendedActions: [
        "Isolate affected systems immediately",
        "Notify privacy officer within 24 hours",
        "Document incident details and timeline",
        requiresNotification ? "Notify HHS OCR within 60 days (HIPAA Breach Notification Rule)" : "Monitor for escalation",
        affectedCount >= 500 ? "Issue media notice for affected state residents" : "Individual notification within 60 days",
      ],
    };
  });
}

// Export schemas for registry
export const complianceSchemas = {
  hipaaAuditReport: HipaaAuditReportArgs,
  consentManage: ConsentManageArgs,
  phiDetection: PhiDetectionArgs,
  accessLog: AccessLogArgs,
  breachAssess: BreachAssessArgs,
};