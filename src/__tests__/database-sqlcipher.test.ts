/**
 * Unit tests for T3.4 SQLCipher opt-in path in Database.openDatabase().
 *
 * Covers:
 *   1. Standard path  (sqlCipher=false)       → opens with better-sqlite3.
 *   2. sqlCipher=true + no key                → throws missing-key error.
 *   3. sqlCipher=true + whitespace key        → treated as no key, throws.
 *   4. sqlCipher=true + key + no driver       → throws install-hint error.
 *
 * The happy-path (driver installed + key valid) is an integration concern
 * that requires @journeyapps/sqlcipher to be installed separately and is
 * verified by the manual smoke test in T3.6.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';

import { Database } from '../lib/database.js';
import { Logger } from '../lib/logger.js';
import { readFeatureFlags } from '../lib/feature-flags.js';

const logger = new Logger('error');

let workDir: string;
beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jcf-sqlcipher-'));
});
afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

describe('Database.openDatabase — standard path (sqlCipher=false)', () => {
  it('initializes successfully with no SQLCipher config', async () => {
    const flags = readFeatureFlags({});
    const db = new Database(path.join(workDir, 'std.sqlite'), logger, { flags });
    await expect(db.initialize()).resolves.toBeUndefined();
    db.close();
  });
});

describe('Database.openDatabase — SQLCipher: missing key (T3.4)', () => {
  it('throws with JCF_USE_SQLCIPHER=1 but no JCF_DB_KEY', async () => {
    const flags = readFeatureFlags({ JCF_USE_SQLCIPHER: '1' });
    expect(flags.sqlCipher).toBe(true);
    expect(flags.sqlCipherKey).toBeNull();

    const db = new Database(path.join(workDir, 'nokey.sqlite'), logger, { flags });
    await expect(db.initialize()).rejects.toThrow(/JCF_DB_KEY is missing/);
  });

  it('throws when JCF_DB_KEY is whitespace-only', async () => {
    const flags = readFeatureFlags({ JCF_USE_SQLCIPHER: '1', JCF_DB_KEY: '   ' });
    expect(flags.sqlCipherKey).toBeNull();

    const db = new Database(path.join(workDir, 'wskey.sqlite'), logger, { flags });
    await expect(db.initialize()).rejects.toThrow(/JCF_DB_KEY is missing/);
  });
});

describe('Database.openDatabase — SQLCipher: driver not installed (T3.4)', () => {
  it('throws install hint when @journeyapps/sqlcipher is absent', async () => {
    const flags = readFeatureFlags({
      JCF_USE_SQLCIPHER: '1',
      JCF_DB_KEY: 'a'.repeat(64),
    });

    const db = new Database(path.join(workDir, 'nodrv.sqlite'), logger, { flags });
    await expect(db.initialize()).rejects.toThrow(
      /@journeyapps\/sqlcipher|not installed|npm install/i
    );
  });
});
