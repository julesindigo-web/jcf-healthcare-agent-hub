/**
 * JCF Feature Flags (T3.4)
 *
 * All flags are controlled exclusively by environment variables and are
 * READ ONCE at module-import time. No runtime mutation is possible.
 *
 * ┌──────────────────────────────────┬──────────────────────────────────────────┐
 * │ Variable                         │ Description                              │
 * ├──────────────────────────────────┼──────────────────────────────────────────┤
 * │ JCF_USE_SQLCIPHER=1              │ Enable SQLCipher encrypted database       │
 * │ JCF_DB_KEY=<key>                 │ SQLCipher encryption key (required with   │
 * │                                  │ JCF_USE_SQLCIPHER). Hex-encoded 32-byte  │
 * │                                  │ key (64 hex chars) is recommended.       │
 * └──────────────────────────────────┴──────────────────────────────────────────┘
 */

export interface FeatureFlags {
  /**
   * T3.4: Opt-in SQLCipher AES-256 encryption for the metadata database.
   * Requires `@journeyapps/sqlcipher` to be installed and `JCF_DB_KEY` to be set.
   */
  readonly sqlCipher: boolean;

  /**
   * T3.4: Encryption key for SQLCipher. Never log or expose this value.
   * Null when `sqlCipher` is false or when `JCF_DB_KEY` is not set.
   */
  readonly sqlCipherKey: string | null;
}

/**
 * Reads feature flags from the current process environment.
 * Called once at module load; returns a frozen immutable snapshot.
 */
export function readFeatureFlags(env: NodeJS.ProcessEnv = process.env): FeatureFlags {
  const sqlCipher = env.JCF_USE_SQLCIPHER === '1';
  const rawKey = env.JCF_DB_KEY;
  const sqlCipherKey = (rawKey && rawKey.trim().length > 0) ? rawKey.trim() : null;

  return Object.freeze({ sqlCipher, sqlCipherKey });
}

/** Module-scoped singleton — read once at import, immutable thereafter. */
export const FEATURE_FLAGS: FeatureFlags = readFeatureFlags();
