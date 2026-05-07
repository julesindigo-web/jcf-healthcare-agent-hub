/**
 * JCF Healthcare Agent Hub — Token-based RBAC (T3.2)
 *
 * Replaces the env-only identity model (`MCP_FS_USER_ID`, `MCP_FS_USER_ROLE`)
 * with a token-validated identity model suitable for multi-tenant or
 * network-facing deployments. The env path is preserved as a backward-
 * compatible fallback for single-tenant local agents.
 *
 * SECURITY MODEL
 * --------------
 *   - Tokens are 32-byte random hex strings (256 bits of entropy).
 *   - Only the SHA-256 hash of each token is persisted; the raw token
 *     is returned to the caller exactly once at issue time and never
 *     stored, logged, or exposed via list/get APIs.
 *   - Constant-time comparison (`crypto.timingSafeEqual`) is used to
 *     guard against timing-side-channel disclosure during validation.
 *   - Every issued token has a short `id` (first 16 hex chars of the
 *     hash) safe to surface in audit logs; the id alone cannot be used
 *     to authenticate.
 *   - Optional `expiresAt` (ISO-8601 UTC) allows time-bounded tokens.
 *   - Tokens can be revoked via {@link revokeToken}; revoked tokens
 *     fail validation even if the raw secret is still in client hands.
 *
 * BOOTSTRAP
 * ---------
 *   - On first boot, if env `JCF_BOOTSTRAP_ADMIN_TOKEN` is set AND no
 *     active admin token exists in the DB, that env value is hashed and
 *     stored as the bootstrap admin. After bootstrap, the env is ignored
 *     for the lifetime of the DB. This breaks the "no first admin" cycle
 *     without ever putting plaintext secrets in the DB.
 *
 * THREAT MODEL
 * ------------
 *   - Spoofing (token forgery) → mitigated by 256-bit random + SHA-256.
 *   - Repudiation (no audit) → mitigated by token id in every audit row.
 *   - Information disclosure (token in logs) → mitigated by hash-only
 *     storage and `[REDACTED]` in error paths.
 *   - Elevation (admin token leak) → mitigated by short expiry + revoke
 *     list (operator decision, not enforced by this module).
 *   - Timing attack on validate → mitigated by `timingSafeEqual`.
 */

import crypto from 'crypto';
import type { Database } from './database.js';
import type { Logger } from './logger.js';

/** Roles enforced by `lib/security.ts` RBAC policies. */
export type AuthRole = 'admin' | 'user' | 'guest';

/** Public token row — NEVER includes the hash or raw token. */
export interface AuthTokenInfo {
  id: string;
  role: AuthRole;
  label: string;
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
}

/** Result of a successful validation — minimum surface for audit/RBAC. */
export interface ValidatedTokenIdentity {
  id: string;
  role: AuthRole;
  label: string;
}

/** Options for issuing a fresh token. */
export interface IssueTokenOptions {
  role: AuthRole;
  label: string;
  /** Optional ISO-8601 expiry. Omit for non-expiring. */
  expiresAt?: string;
}

/** Issued-token payload — raw secret returned ONCE; persist it client-side. */
export interface IssuedToken {
  /** The actual secret. Hand to the client and store securely. NEVER log. */
  rawToken: string;
  /** Public id (first 16 hex chars of hash). Safe to log and audit. */
  id: string;
  role: AuthRole;
  label: string;
  createdAt: string;
  expiresAt?: string;
}

const RAW_TOKEN_BYTES = 32; // 256 bits
const ID_PREFIX_LEN = 16;

/**
 * Compute the SHA-256 hash of a raw token (lowercase hex).
 *
 * Exported for unit-test introspection only. Production callers go
 * through {@link issueToken} and {@link validateToken}.
 */
export function hashRawToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

/** Constant-time hex string equality — guards against timing side-channels. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  // Convert both to Buffers; equal length is required by timingSafeEqual.
  const aBuf = Buffer.from(a, 'hex');
  const bBuf = Buffer.from(b, 'hex');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

/**
 * Issue a fresh token. Returns the raw secret EXACTLY ONCE — the caller
 * is responsible for handing it to the client and storing it securely.
 * Subsequent reads (via {@link listTokens}) only expose the id + metadata.
 *
 * @param db Database instance (must be initialized).
 * @param opts Role, label, and optional expiry.
 */
export function issueToken(db: Database, opts: IssueTokenOptions): IssuedToken {
  if (!opts.label || opts.label.trim().length === 0) {
    throw new Error('issueToken: label is required (used for audit correlation)');
  }
  if (!isValidRole(opts.role)) {
    throw new Error(
      `issueToken: invalid role "${opts.role}" (allowed: admin | user | guest)`
    );
  }
  if (opts.expiresAt !== undefined) {
    const t = Date.parse(opts.expiresAt);
    if (Number.isNaN(t)) {
      throw new Error(
        `issueToken: invalid expiresAt "${opts.expiresAt}" (must be ISO-8601)`
      );
    }
    if (t <= Date.now()) {
      throw new Error('issueToken: expiresAt must be in the future');
    }
  }

  const rawToken = crypto.randomBytes(RAW_TOKEN_BYTES).toString('hex');
  const hash = hashRawToken(rawToken);
  const id = hash.slice(0, ID_PREFIX_LEN);
  const createdAt = new Date().toISOString();

  db.insertAuthToken({
    id,
    hash,
    role: opts.role,
    label: opts.label,
    createdAt,
    expiresAt: opts.expiresAt,
  });

  const issued: IssuedToken = {
    rawToken,
    id,
    role: opts.role,
    label: opts.label,
    createdAt,
  };
  if (opts.expiresAt !== undefined) issued.expiresAt = opts.expiresAt;
  return issued;
}

/**
 * Validate a raw token. Returns the validated identity on success or
 * `null` if the token is unknown / revoked / expired / malformed.
 *
 * Constant-time comparison guards against timing-channel disclosure
 * even when the SQL row exists but the hash mismatches; on a missing
 * row we still perform a dummy compare against a sentinel hash to
 * keep the timing profile uniform.
 */
export function validateToken(
  db: Database,
  rawToken: string
): ValidatedTokenIdentity | null {
  if (typeof rawToken !== 'string' || rawToken.length === 0) {
    // Perform dummy DB lookup to maintain constant timing
    db.getAuthTokenByHash(NULL_HASH);
    timingSafeEqualHex(NULL_HASH, NULL_HASH);
    return null;
  }
  // Reject obviously malformed tokens early (must be lowercase hex of
  // 2× RAW_TOKEN_BYTES). Reject without DB lookup to keep DoS surface
  // narrow — but DO perform a constant-time dummy compare against the
  // null hash to flatten the timing profile vs the legitimate path.
  const expectedLen = RAW_TOKEN_BYTES * 2;
  if (rawToken.length !== expectedLen || !/^[0-9a-f]+$/i.test(rawToken)) {
    // Perform dummy DB lookup to maintain constant timing
    db.getAuthTokenByHash(NULL_HASH);
    timingSafeEqualHex(NULL_HASH, NULL_HASH); // dummy compare
    return null;
  }

  const hash = hashRawToken(rawToken);
  const row = db.getAuthTokenByHash(hash);
  
  // Always perform timing-safe comparison, regardless of row existence
  // This ensures constant-time behavior for all code paths
  if (!row) {
    timingSafeEqualHex(NULL_HASH, NULL_HASH); // dummy compare for timing parity
    return null;
  }

  // Constant-time equality on the stored hash vs the just-computed hash.
  // The row lookup already filtered by hash so this is paranoid defense
  // — but it ensures even a future "look up by id then compare hash"
  // refactor stays timing-safe.
  if (!timingSafeEqualHex(row.hash, hash)) {
    return null;
  }

  if (row.revokedAt) {
    return null;
  }
  if (row.expiresAt) {
    const t = Date.parse(row.expiresAt);
    if (Number.isFinite(t) && t <= Date.now()) {
      return null;
    }
  }
  if (!isValidRole(row.role)) {
    // Defense in depth: never elevate an unknown role to a known one.
    return null;
  }

  return { id: row.id, role: row.role as AuthRole, label: row.label };
}

/**
 * Revoke a token by its public id. Returns true if a previously-active
 * token was revoked, false if the id was unknown or already revoked.
 */
export function revokeToken(db: Database, id: string): boolean {
  if (typeof id !== 'string' || id.length === 0) return false;
  return db.revokeAuthToken(id, new Date().toISOString());
}

/** List all tokens (id + metadata only — never the hash or raw secret). */
export function listTokens(db: Database): AuthTokenInfo[] {
  // Narrow each row's `role: string` to `AuthRole` and drop unknown
  // roles defensively. The DB column type is TEXT — a manual SQL edit
  // could in principle smuggle a non-canonical role value; we don't
  // expose those rows.
  return db
    .listAuthTokens()
    .filter((r) => isValidRole(r.role))
    .map((r) => {
      const out: AuthTokenInfo = {
        id: r.id,
        role: r.role as AuthRole,
        label: r.label,
        createdAt: r.createdAt,
      };
      if (r.expiresAt !== undefined) out.expiresAt = r.expiresAt;
      if (r.revokedAt !== undefined) out.revokedAt = r.revokedAt;
      return out;
    });
}

/**
 * Bootstrap the first admin token from `JCF_BOOTSTRAP_ADMIN_TOKEN`
 * env var, IF AND ONLY IF no active admin token exists in the DB.
 *
 * Idempotent: safe to call on every boot. After the first successful
 * bootstrap, subsequent calls are no-ops because an active admin token
 * exists. The env value is hashed and stored — it is never persisted
 * in plaintext.
 *
 * Returns the hashed-only `AuthTokenInfo` of the bootstrap row when one
 * was created, or `null` when bootstrap was skipped (env unset or admin
 * already exists).
 *
 * The operator is responsible for setting a strong env value (≥ 32 hex
 * chars, equivalent entropy to a normally-issued token) — this function
 * does NOT generate one for them. Reasoning: the operator typically
 * needs the value out-of-band (e.g. printed in a deployment script) and
 * a fresh-random bootstrap value would be useless.
 */
export function bootstrapAdminFromEnv(
  db: Database,
  logger: Logger,
  envValue: string | undefined = process.env.JCF_BOOTSTRAP_ADMIN_TOKEN
): AuthTokenInfo | null {
  if (!envValue || envValue.length === 0) return null;
  if (db.countAuthTokensByRole('admin') > 0) {
    logger.debug('Bootstrap skipped: active admin token exists', {});
    return null;
  }
  // Validate the env-supplied token meets the same shape as issued tokens.
  const expectedLen = RAW_TOKEN_BYTES * 2;
  if (envValue.length !== expectedLen || !/^[0-9a-f]+$/i.test(envValue)) {
    throw new Error(
      `JCF_BOOTSTRAP_ADMIN_TOKEN must be ${expectedLen} hex chars (256 bits) — ` +
        `generate via: node -e "console.log(require('crypto').randomBytes(${RAW_TOKEN_BYTES}).toString('hex'))"`
    );
  }
  const hash = hashRawToken(envValue.toLowerCase());
  const id = hash.slice(0, ID_PREFIX_LEN);
  const createdAt = new Date().toISOString();
  db.insertAuthToken({
    id,
    hash,
    role: 'admin',
    label: 'bootstrap-admin',
    createdAt,
  });
  logger.info('Bootstrap admin token registered from env', { id, label: 'bootstrap-admin' });
  return {
    id,
    role: 'admin',
    label: 'bootstrap-admin',
    createdAt,
  };
}

// ── Internal helpers ────────────────────────────────────────────────────

const NULL_HASH = '0'.repeat(64); // 64 zero hex chars = SHA-256 length

function isValidRole(value: unknown): value is AuthRole {
  return value === 'admin' || value === 'user' || value === 'guest';
}
