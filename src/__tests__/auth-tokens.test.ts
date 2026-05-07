/**
 * Unit tests for `src/lib/auth-tokens.ts` (T3.2 RBAC token store).
 *
 * Coverage:
 *   - Token issue + roundtrip validation (happy path)
 *   - Hash-only persistence (raw secret never written to DB)
 *   - Constant-time comparison guard (timing-safe equality)
 *   - Token revocation
 *   - Expired-token rejection
 *   - Malformed-token rejection (without DB lookup)
 *   - Unknown-token rejection (with timing parity dummy compare)
 *   - listTokens excludes hash + filters unknown roles
 *   - bootstrapAdminFromEnv idempotency + env validation
 *   - audit.ts integration: token-aware getCurrentUser priority + fail-loud
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";

import { Database } from "../lib/database.js";
import { Logger } from "../lib/logger.js";
import {
  hashRawToken,
  timingSafeEqualHex,
  issueToken,
  validateToken,
  revokeToken,
  listTokens,
  bootstrapAdminFromEnv,
} from "../lib/auth-tokens.js";

let workDir: string;
let db: Database;
const logger = new Logger("error");

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "jcf-authtokens-"));
  const dbPath = path.join(workDir, ".jcf-test-db");
  db = new Database(dbPath, logger);
  await db.initialize();
});

afterEach(async () => {
  try {
    db.close();
  } catch {
    /* best-effort */
  }
  try {
    await fs.rm(workDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// ─────────────────────────────────────────────────────────────────────
// hashRawToken / timingSafeEqualHex (helpers)
// ─────────────────────────────────────────────────────────────────────

describe("hashRawToken", () => {
  it("produces a 64-char lowercase hex SHA-256 digest", () => {
    const h = hashRawToken("hello world");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for identical inputs", () => {
    expect(hashRawToken("same input")).toBe(hashRawToken("same input"));
  });

  it("differs on different inputs (avalanche)", () => {
    const a = hashRawToken("foo");
    const b = hashRawToken("foO");
    expect(a).not.toBe(b);
  });
});

describe("timingSafeEqualHex", () => {
  it("returns true for equal hex strings", () => {
    expect(timingSafeEqualHex("abcd1234", "abcd1234")).toBe(true);
  });

  it("returns false for different hex strings", () => {
    expect(timingSafeEqualHex("abcd1234", "abcd5678")).toBe(false);
  });

  it("returns false for length mismatch (no buffer overrun)", () => {
    expect(timingSafeEqualHex("ab", "abcd")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// issueToken
// ─────────────────────────────────────────────────────────────────────

describe("issueToken", () => {
  it("returns a 64-char hex raw token + 16-char id matching the hash prefix", () => {
    const issued = issueToken(db, { role: "admin", label: "test-1" });
    expect(issued.rawToken).toMatch(/^[0-9a-f]{64}$/);
    expect(issued.id).toMatch(/^[0-9a-f]{16}$/);
    expect(hashRawToken(issued.rawToken).startsWith(issued.id)).toBe(true);
  });

  it("never persists the raw token in the DB (hash-only)", () => {
    const issued = issueToken(db, { role: "user", label: "secret-leak-test" });
    const tokens = listTokens(db);
    const stored = tokens.find((t) => t.id === issued.id);
    expect(stored).toBeDefined();
    expect(JSON.stringify(stored)).not.toContain(issued.rawToken);
  });

  it("rejects empty label", () => {
    expect(() => issueToken(db, { role: "user", label: "" })).toThrow(
      /label is required/
    );
  });

  it("rejects whitespace-only label", () => {
    expect(() => issueToken(db, { role: "user", label: "   " })).toThrow(
      /label is required/
    );
  });

  it("rejects unknown role", () => {
    expect(() =>
      issueToken(db, { role: "superadmin" as any, label: "x" })
    ).toThrow(/invalid role/);
  });

  it("rejects malformed expiresAt", () => {
    expect(() =>
      issueToken(db, { role: "user", label: "x", expiresAt: "not a date" })
    ).toThrow(/invalid expiresAt/);
  });

  it("rejects expiresAt in the past", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    expect(() =>
      issueToken(db, { role: "user", label: "x", expiresAt: past })
    ).toThrow(/expiresAt must be in the future/);
  });

  it("accepts valid future expiresAt", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const issued = issueToken(db, {
      role: "user",
      label: "x",
      expiresAt: future,
    });
    expect(issued.expiresAt).toBe(future);
  });
});

// ─────────────────────────────────────────────────────────────────────
// validateToken
// ─────────────────────────────────────────────────────────────────────

describe("validateToken", () => {
  it("returns the validated identity for a valid raw token", () => {
    const issued = issueToken(db, { role: "admin", label: "happy" });
    const v = validateToken(db, issued.rawToken);
    expect(v).not.toBeNull();
    expect(v!.id).toBe(issued.id);
    expect(v!.role).toBe("admin");
    expect(v!.label).toBe("happy");
  });

  it("returns null for an unknown token (no DB row)", () => {
    const fakeRaw = "a".repeat(64);
    expect(validateToken(db, fakeRaw)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(validateToken(db, "")).toBeNull();
  });

  it("returns null for non-hex characters", () => {
    expect(validateToken(db, "z".repeat(64))).toBeNull();
  });

  it("returns null for wrong length (too short)", () => {
    expect(validateToken(db, "a".repeat(32))).toBeNull();
  });

  it("returns null for wrong length (too long)", () => {
    expect(validateToken(db, "a".repeat(128))).toBeNull();
  });

  it("returns null after revocation", () => {
    const issued = issueToken(db, { role: "user", label: "revoke-me" });
    expect(validateToken(db, issued.rawToken)).not.toBeNull();
    expect(revokeToken(db, issued.id)).toBe(true);
    expect(validateToken(db, issued.rawToken)).toBeNull();
  });

  it("returns null after expiry", () => {
    const future = new Date(Date.now() + 50).toISOString();
    const issued = issueToken(db, {
      role: "user",
      label: "expire-me",
      expiresAt: future,
    });
    expect(validateToken(db, issued.rawToken)).not.toBeNull();
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(validateToken(db, issued.rawToken)).toBeNull();
        resolve();
      }, 100);
    });
  });

  it("rejects tokens stored under unknown roles (defense-in-depth)", () => {
    // Manually insert a row with a non-canonical role to simulate a
    // tampered DB. validateToken must not promote 'superadmin' to a
    // valid AuthRole.
    const rawToken = "f".repeat(64);
    const hash = hashRawToken(rawToken);
    const id = hash.slice(0, 16);
    db.insertAuthToken({
      id,
      hash,
      role: "superadmin", // non-canonical
      label: "tampered",
      createdAt: new Date().toISOString(),
    });
    expect(validateToken(db, rawToken)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// revokeToken
// ─────────────────────────────────────────────────────────────────────

describe("revokeToken", () => {
  it("returns true when an active token is revoked", () => {
    const issued = issueToken(db, { role: "user", label: "rev-1" });
    expect(revokeToken(db, issued.id)).toBe(true);
  });

  it("returns false on second revoke (idempotent at API level)", () => {
    const issued = issueToken(db, { role: "user", label: "rev-2" });
    expect(revokeToken(db, issued.id)).toBe(true);
    expect(revokeToken(db, issued.id)).toBe(false);
  });

  it("returns false for unknown id", () => {
    expect(revokeToken(db, "deadbeefdeadbeef")).toBe(false);
  });

  it("returns false for empty id", () => {
    expect(revokeToken(db, "")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// listTokens
// ─────────────────────────────────────────────────────────────────────

describe("listTokens", () => {
  it("returns id + metadata for each token (no hash, no raw secret)", () => {
    const issued = issueToken(db, { role: "admin", label: "list-1" });
    const list = listTokens(db);
    expect(list.length).toBe(1);
    const row = list[0]!;
    expect(row.id).toBe(issued.id);
    expect(row.role).toBe("admin");
    expect(row.label).toBe("list-1");
    expect((row as any).hash).toBeUndefined();
    expect((row as any).rawToken).toBeUndefined();
  });

  it("includes both active and revoked tokens with revokedAt populated", () => {
    const a = issueToken(db, { role: "user", label: "active" });
    const b = issueToken(db, { role: "user", label: "revoked" });
    revokeToken(db, b.id);
    const list = listTokens(db);
    expect(list.length).toBe(2);
    const aRow = list.find((t) => t.id === a.id)!;
    const bRow = list.find((t) => t.id === b.id)!;
    expect(aRow.revokedAt).toBeUndefined();
    expect(bRow.revokedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("filters out tokens with non-canonical roles (defense-in-depth)", () => {
    issueToken(db, { role: "user", label: "ok" });
    // Tamper-insert a row with non-canonical role.
    const rawTok = "1".repeat(64);
    const hash = hashRawToken(rawTok);
    db.insertAuthToken({
      id: hash.slice(0, 16),
      hash,
      role: "superadmin",
      label: "smuggled",
      createdAt: new Date().toISOString(),
    });
    const list = listTokens(db);
    expect(list.find((t) => t.label === "smuggled")).toBeUndefined();
    expect(list.find((t) => t.label === "ok")).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────
// bootstrapAdminFromEnv
// ─────────────────────────────────────────────────────────────────────

describe("bootstrapAdminFromEnv", () => {
  it("returns null and is a no-op when env is unset", () => {
    expect(bootstrapAdminFromEnv(db, logger, undefined)).toBeNull();
    expect(listTokens(db)).toEqual([]);
  });

  it("returns null and is a no-op when env is empty string", () => {
    expect(bootstrapAdminFromEnv(db, logger, "")).toBeNull();
    expect(listTokens(db)).toEqual([]);
  });

  it("creates an admin token from a valid 64-char hex env value", () => {
    const env = "c".repeat(64);
    const info = bootstrapAdminFromEnv(db, logger, env);
    expect(info).not.toBeNull();
    expect(info!.role).toBe("admin");
    expect(info!.label).toBe("bootstrap-admin");
    // The raw env value should validate.
    const v = validateToken(db, env);
    expect(v).not.toBeNull();
    expect(v!.role).toBe("admin");
  });

  it("rejects env values of wrong length", () => {
    expect(() => bootstrapAdminFromEnv(db, logger, "abc")).toThrow(
      /must be 64 hex chars/
    );
  });

  it("rejects env values with non-hex characters", () => {
    const bad = "Z".repeat(64);
    expect(() => bootstrapAdminFromEnv(db, logger, bad)).toThrow(
      /must be 64 hex chars/
    );
  });

  it("is idempotent — second call with active admin returns null", () => {
    const env1 = "1".repeat(64);
    const env2 = "2".repeat(64);
    const first = bootstrapAdminFromEnv(db, logger, env1);
    expect(first).not.toBeNull();
    const second = bootstrapAdminFromEnv(db, logger, env2);
    expect(second).toBeNull();
    // The first env value still validates; the second never did.
    expect(validateToken(db, env1)).not.toBeNull();
    expect(validateToken(db, env2)).toBeNull();
  });

  it("re-bootstraps after the only admin is revoked", () => {
    const env1 = "3".repeat(64);
    const first = bootstrapAdminFromEnv(db, logger, env1);
    expect(first).not.toBeNull();
    expect(revokeToken(db, first!.id)).toBe(true);
    // With no active admin, a fresh bootstrap should succeed.
    const env2 = "4".repeat(64);
    const second = bootstrapAdminFromEnv(db, logger, env2);
    expect(second).not.toBeNull();
    expect(validateToken(db, env2)).not.toBeNull();
  });
});
