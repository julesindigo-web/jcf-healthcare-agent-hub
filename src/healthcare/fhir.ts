/**
 * Healthcare Module — FHIR R4/R5 Resource Engine
 *
 * Tools: 8
 * ADR-H002: FHIR storage via filesystem (not DB-only).
 * Resources written to fhir-store/ResourceType/id.json AND versioned in DB.
 * Read/Search/Delete all operate on filesystem for consistency.
 * PERF: Static imports, parallel batch, paginated search.
 *
 * SEC-01 FIX: config normalization already in place.
 * SEC-02 FIX: RBAC on reads enforced via audit.ts change.
 * JCF-1 FIX: Two-phase commit with compensation for FHIR create/update.
 */

import type { HandlerContext } from "../handlers/context.js";
import { z } from "zod";
import { withAudit } from "../handlers/shared/audit.js";
import { validatePath } from "../handlers/shared/path-guard.js";
import { fsGetMetadata } from "../handlers/shared/metadata.js";
import { promises as fsPromises } from "node:fs";
import { dirname } from "node:path";
import { hashContent } from "../handlers/shared/util.js";

// ──────────────────────────────────────────────────────────────
// Schemas
// ──────────────────────────────────────────────────────────────

const FhirCreateArgs = z.object({
  resourceType: z.string(),
  resource: z.record(z.any()),
  author: z.string().optional(),
});

const FhirReadArgs = z.object({
  resourceType: z.string(),
  id: z.string(),
});

const FhirUpdateArgs = z.object({
  resourceType: z.string(),
  id: z.string(),
  resource: z.record(z.any()),
  author: z.string().optional(),
  message: z.string().optional(),
});

const FhirDeleteArgs = z.object({
  resourceType: z.string(),
  id: z.string(),
});

const FhirSearchArgs = z.object({
  resourceType: z.string(),
  params: z.record(z.string()).optional(),
  limit: z.number().int().positive().max(1000).default(100),
  offset: z.number().int().min(0).default(0),
});

const FhirBatchArgs = z.object({
  operations: z.array(
    z.object({
      op: z.enum(["create", "read", "update", "delete"]),
      resourceType: z.string(),
      id: z.string().optional(),
      resource: z.record(z.any()).optional(),
    })
  ),
});

const FhirValidateArgs = z.object({
  resourceType: z.string(),
  resource: z.record(z.any()),
});

const FhirCapabilityArgs = z.object({});

// ──────────────────────────────────────────────────────────────
// Handlers
// ──────────────────────────────────────────────────────────────

export async function fhirCreate(
  ctx: HandlerContext,
  args: z.infer<typeof FhirCreateArgs>
) {
  if (!args.resource.id || typeof args.resource.id !== "string") {
    throw new Error(`FHIR resource must have a string 'id' field`);
  }
  const filePath = validatePath(ctx, `fhir-store/${args.resourceType}/${args.resource.id}.json`);
  const content = JSON.stringify(args.resource, null, 2);
  const hash = hashContent(content);
  return withAudit(ctx, "fhir_create" as const, filePath, async () => {
    // Ensure directory exists
    await fsPromises.mkdir(dirname(filePath), { recursive: true });
    // Write file to disk first
    await fsPromises.writeFile(filePath, content, "utf-8");
    // Attempt to write version record; if this fails, rollback file to avoid orphan
    try {
      await ctx.db.addVersion(
        filePath,
        hash,
        args.author || "anonymous",
        `FHIR create ${args.resourceType}`,
        Buffer.byteLength(content, "utf-8"),
        content
      );
    } catch (dbError) {
      // Compensating delete: remove file to maintain consistency
      await fsPromises.unlink(filePath).catch(() => {});
      throw dbError;
    }
    const meta = await fsGetMetadata(filePath);
    await ctx.db.setFileMetadata(meta);
    return { id: args.resource.id, location: `fhir://local/${args.resourceType}/${args.resource.id}` };
  });
}

export async function fhirRead(
  ctx: HandlerContext,
  args: z.infer<typeof FhirReadArgs>
) {
  const filePath = validatePath(ctx, `fhir-store/${args.resourceType}/${args.id}.json`);
  return withAudit(ctx, "fhir_read" as const, filePath, async () => {
    const content = await fsPromises.readFile(filePath, "utf-8");
    const resource = JSON.parse(content);
    // JCF-7: Validate resource integrity (optional skip via query not implemented yet)
    // For now, we call fhirValidate to enforce required fields
    const validation = await fhirValidate(ctx, { resourceType: args.resourceType, resource: resource });
    if (!validation.valid) {
      throw new Error(`FHIR validation failed: ${validation.errors.join(", ")}`);
    }
    return { resource };
  });
}

export async function fhirUpdate(
  ctx: HandlerContext,
  args: z.infer<typeof FhirUpdateArgs>
) {
  const filePath = validatePath(ctx, `fhir-store/${args.resourceType}/${args.id}.json`);
  const content = JSON.stringify(args.resource, null, 2);
  const hash = hashContent(content);
  return withAudit(ctx, "fhir_update" as const, filePath, async () => {
    await fsPromises.mkdir(dirname(filePath), { recursive: true });
    await fsPromises.writeFile(filePath, content, "utf-8");
    try {
      await ctx.db.addVersion(
        filePath,
        hash,
        args.author || "anonymous",
        args.message || "FHIR update",
        Buffer.byteLength(content, "utf-8"),
        content
      );
    } catch (dbError) {
      await fsPromises.unlink(filePath).catch(() => {});
      throw dbError;
    }
    const meta = await fsGetMetadata(filePath);
    await ctx.db.setFileMetadata(meta);
    return { id: args.id, location: `fhir://local/${args.resourceType}/${args.id}` };
  });
}

export async function fhirDelete(
  ctx: HandlerContext,
  args: z.infer<typeof FhirDeleteArgs>
) {
  const filePath = validatePath(ctx, `fhir-store/${args.resourceType}/${args.id}.json`);
  return withAudit(ctx, "fhir_delete" as const, filePath, async () => {
    let preDeleteContent: string | null = null;
    try {
      preDeleteContent = await fsPromises.readFile(filePath, "utf-8");
    } catch {
      // File may not exist, proceed with delete attempt
    }
    try {
      await fsPromises.unlink(filePath);
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
    // Delete file metadata first (cascades to versions); then add tombstone version
    await ctx.db.deleteFileMetadata(filePath);
    if (preDeleteContent !== null) {
      const hash = hashContent(preDeleteContent);
      const size = Buffer.byteLength(preDeleteContent, "utf-8");
      await ctx.db.addVersion(
        filePath,
        hash,
        "system",
        "File deleted",
        size,
        preDeleteContent
      );
    }
    return { success: true };
  });
}

export async function fhirSearch(
  ctx: HandlerContext,
  args: z.infer<typeof FhirSearchArgs>
) {
  const dirPath = validatePath(ctx, `fhir-store/${args.resourceType}`);
  return withAudit(ctx, "fhir_search" as const, dirPath, async () => {
    let files: string[];
    try {
      files = await fsPromises.readdir(dirPath);
    } catch (e: any) {
      if (e.code === "ENOENT") return { total: 0, offset: args.offset, limit: args.limit, resources: [] };
      throw e;
    }
    // Read all matching JSON files in parallel
    const jsonFiles = files.filter(f => f.endsWith(".json"));
    const candidates = await Promise.all(
      jsonFiles.map(async file => {
        const full = `${dirPath}/${file}`;
        const content = await fsPromises.readFile(full, "utf-8");
        return JSON.parse(content) as Record<string, unknown>;
      })
    );
    // Apply param filters
    const filtered = args.params
      ? candidates.filter(resource =>
          Object.entries(args.params!).every(([k, v]) => {
            const val = resource[k] ?? resource[`_${k}`];
            return val !== undefined && String(val).includes(String(v));
          })
        )
      : candidates;
    // Pagination
    const page = filtered.slice(args.offset, args.offset + args.limit);
    return { total: filtered.length, offset: args.offset, limit: args.limit, resources: page };
  });
}

export async function fhirBatch(
  ctx: HandlerContext,
  args: z.infer<typeof FhirBatchArgs>
) {
   return withAudit(ctx, "fhir_batch" as const, "batch", async () => {
     // Process sequentially to avoid race conditions on the same resource
    const results: Array<{ success: boolean; result?: any; error?: string }> = [];

    for (const op of args.operations) {
      try {
        let result: any;
        switch (op.op) {
          case "create":
            result = await fhirCreate(ctx, { resourceType: op.resourceType, resource: op.resource! });
            break;
          case "read":
            result = await fhirRead(ctx, { resourceType: op.resourceType, id: op.id! });
            break;
          case "update":
            result = await fhirUpdate(ctx, { resourceType: op.resourceType, id: op.id!, resource: op.resource! });
            break;
          case "delete":
            result = await fhirDelete(ctx, { resourceType: op.resourceType, id: op.id! });
            break;
          default:
            throw new Error(`Unknown op: ${op.op}`);
        }
        results.push({ success: true, result });
      } catch (e: any) {
        results.push({ success: false, error: e instanceof Error ? e.message : String(e) });
      }
    }

    return { results };
  });
}

export async function fhirValidate(
  _ctx: HandlerContext,
  args: z.infer<typeof FhirValidateArgs>
) {
  const requiredFields: Record<string, string[]> = {
    Patient:            ["id", "resourceType", "name", "gender", "birthDate"],
    Condition:          ["id", "resourceType", "code", "subject"],
    Observation:        ["id", "resourceType", "status", "code"],
    Procedure:          ["id", "resourceType", "status", "code", "subject"],
    MedicationRequest:  ["id", "resourceType", "status", "intent", "medication", "subject"],
    Encounter:          ["id", "resourceType", "status", "class", "subject"],
    AllergyIntolerance: ["id", "resourceType", "patient"],
  };
  const required = requiredFields[args.resourceType] || [];
  const missing = required.filter(f => !(f in args.resource));
  return {
    valid: missing.length === 0,
    missing,
    errors: missing.map(f => `Missing required field: ${f}`),
    resourceType: args.resourceType,
  } as const;
}

export async function fhirCapability(
  _ctx: HandlerContext,
  _args: z.infer<typeof FhirCapabilityArgs>
) {
  return {
    fhirVersion: "R4",
    resourceTypes: ["Patient", "Condition", "Observation", "Procedure", "MedicationRequest", "Encounter", "AllergyIntolerance"],
    operations: ["create", "read", "update", "delete", "search", "batch", "validate"],
    searchParams: ["_id", "_lastUpdated", "_profile", "_source"],
    storageBackend: "filesystem+sqlite-versioning",
    implementation: "JCF Healthcare Agent Hub (MCP)",
  };
}

// Export schemas for registry
export const fhirSchemas = {
  fhirCreate: FhirCreateArgs,
  fhirRead: FhirReadArgs,
  fhirUpdate: FhirUpdateArgs,
  fhirDelete: FhirDeleteArgs,
  fhirSearch: FhirSearchArgs,
  fhirBatch: FhirBatchArgs,
  fhirValidate: FhirValidateArgs,
  fhirCapability: FhirCapabilityArgs,
};
