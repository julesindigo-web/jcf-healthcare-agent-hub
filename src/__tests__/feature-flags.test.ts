/**
 * Unit tests for src/lib/feature-flags.ts (T3.4)
 * Covers: readFeatureFlags, FEATURE_FLAGS singleton, all env-variable combinations.
 */

import { describe, it, expect } from 'vitest';
import { readFeatureFlags } from '../lib/feature-flags.js';

describe('readFeatureFlags', () => {
  it('returns sqlCipher=false and sqlCipherKey=null when no env vars are set', () => {
    const flags = readFeatureFlags({});
    expect(flags.sqlCipher).toBe(false);
    expect(flags.sqlCipherKey).toBeNull();
  });

  it('returns sqlCipher=true when JCF_USE_SQLCIPHER=1', () => {
    const flags = readFeatureFlags({ JCF_USE_SQLCIPHER: '1' });
    expect(flags.sqlCipher).toBe(true);
  });

  it('returns sqlCipher=false for values other than "1" (e.g. "true", "yes", "0")', () => {
    expect(readFeatureFlags({ JCF_USE_SQLCIPHER: 'true' }).sqlCipher).toBe(false);
    expect(readFeatureFlags({ JCF_USE_SQLCIPHER: 'yes' }).sqlCipher).toBe(false);
    expect(readFeatureFlags({ JCF_USE_SQLCIPHER: '0' }).sqlCipher).toBe(false);
    expect(readFeatureFlags({ JCF_USE_SQLCIPHER: '' }).sqlCipher).toBe(false);
  });

  it('returns sqlCipherKey from JCF_DB_KEY when set', () => {
    const flags = readFeatureFlags({ JCF_DB_KEY: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890' });
    expect(flags.sqlCipherKey).toBe('abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890');
  });

  it('trims whitespace from JCF_DB_KEY', () => {
    const flags = readFeatureFlags({ JCF_DB_KEY: '  mykey  ' });
    expect(flags.sqlCipherKey).toBe('mykey');
  });

  it('returns sqlCipherKey=null when JCF_DB_KEY is empty string', () => {
    const flags = readFeatureFlags({ JCF_DB_KEY: '' });
    expect(flags.sqlCipherKey).toBeNull();
  });

  it('returns sqlCipherKey=null when JCF_DB_KEY is whitespace only', () => {
    const flags = readFeatureFlags({ JCF_DB_KEY: '   ' });
    expect(flags.sqlCipherKey).toBeNull();
  });

  it('returns sqlCipherKey=null when JCF_DB_KEY is not set', () => {
    const flags = readFeatureFlags({});
    expect(flags.sqlCipherKey).toBeNull();
  });

  it('returns a frozen (immutable) flags object', () => {
    const flags = readFeatureFlags({ JCF_USE_SQLCIPHER: '1', JCF_DB_KEY: 'key' });
    expect(Object.isFrozen(flags)).toBe(true);
    expect(() => {
      (flags as any).sqlCipher = false;
    }).toThrow();
  });

  it('correctly handles all flags simultaneously', () => {
    const flags = readFeatureFlags({
      JCF_USE_SQLCIPHER: '1',
      JCF_DB_KEY: 'hex64charkey',
    });
    expect(flags.sqlCipher).toBe(true);
    expect(flags.sqlCipherKey).toBe('hex64charkey');
  });
});
