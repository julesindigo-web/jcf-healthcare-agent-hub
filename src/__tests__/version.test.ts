import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  PACKAGE_NAME,
  SERVER_NAME,
  SERVER_VERSION,
  VERSION_METADATA,
  PACKAGE_DESCRIPTION,
  PACKAGE_AUTHOR,
  PACKAGE_LICENSE,
  loadPackageJson,
  safeString,
} from '../version';

/**
 * Phase G1: lock down the version
 * single-source-of-truth contract established in Phase A2.
 */
describe('version.ts — SSOT from package.json', () => {
  const testDir = dirname(fileURLToPath(import.meta.url));
  // src/__tests__/version.test.ts → up 3 → repo root
  const pkgPath = join(testDir, '..', '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
    name: string;
    version: string;
    description?: string;
  };

  it('PACKAGE_NAME matches package.json name', () => {
    expect(PACKAGE_NAME).toBe(pkg.name);
    expect(PACKAGE_NAME).toBe('jcf-healthcare-agent-hub');
  });

  it('SERVER_VERSION matches package.json version', () => {
    expect(SERVER_VERSION).toBe(pkg.version);
  });

  it('SERVER_VERSION is semver-shaped', () => {
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('SERVER_NAME is the canonical display name', () => {
    expect(SERVER_NAME).toBe('JCF Healthcare Agent Hub MCP');
  });

  it('PACKAGE_DESCRIPTION matches package.json description', () => {
    expect(PACKAGE_DESCRIPTION).toBe(pkg.description ?? '');
  });

  it('VERSION_METADATA is frozen', () => {
    expect(Object.isFrozen(VERSION_METADATA)).toBe(true);
  });

  it('VERSION_METADATA bundles name + version', () => {
    expect(VERSION_METADATA.name).toBe(PACKAGE_NAME);
    expect(VERSION_METADATA.version).toBe(SERVER_VERSION);
    expect(VERSION_METADATA.displayName).toBe(SERVER_NAME);
  });

  it('no fallback value leaks (0.0.0-UNKNOWN) — package.json was loaded', () => {
    expect(SERVER_VERSION).not.toBe('0.0.0-UNKNOWN');
  });

  it('PACKAGE_AUTHOR is a string (may be empty)', () => {
    expect(typeof PACKAGE_AUTHOR).toBe('string');
  });

  it('PACKAGE_LICENSE is a string (may be empty)', () => {
    expect(typeof PACKAGE_LICENSE).toBe('string');
  });
});

describe('loadPackageJson() — direct invocation for fallback coverage', () => {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const validPkgPath = join(testDir, '..', '..', 'package.json');

  it('returns ultimate fallback when ALL candidate paths fail', () => {
    const result = loadPackageJson(['/nonexistent/path/1', '/nonexistent/path/2']);
    expect(result.name).toBe('jcf-healthcare-agent-hub');
    expect(result.version).toBe('0.0.0-UNKNOWN');
    expect(result.description).toBe('JCF Healthcare Agent Hub');
  });

  it('returns empty fallback when candidates is empty array', () => {
    const result = loadPackageJson([]);
    expect(result.name).toBe('jcf-healthcare-agent-hub');
    expect(result.version).toBe('0.0.0-UNKNOWN');
  });

  it('successfully loads valid package.json from explicit candidate', () => {
    const result = loadPackageJson([validPkgPath]);
    expect(result.name).toBe('jcf-healthcare-agent-hub');
    expect(result.version).not.toBe('0.0.0-UNKNOWN');
    expect(result.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('falls through to second candidate when first throws', () => {
    const result = loadPackageJson(['/nonexistent/first', validPkgPath]);
    expect(result.name).toBe('jcf-healthcare-agent-hub');
    expect(result.version).not.toBe('0.0.0-UNKNOWN');
  });

  it('uses default candidates when no argument provided (production path)', () => {
    const result = loadPackageJson();
    expect(result.name).toBe('jcf-healthcare-agent-hub');
    expect(result.version).not.toBe('0.0.0-UNKNOWN');
  });

  it('handles invalid JSON gracefully (catches and continues)', () => {
    const thisTestFile = fileURLToPath(import.meta.url);
    const result = loadPackageJson([thisTestFile, validPkgPath]);
    expect(result.name).toBe('jcf-healthcare-agent-hub');
    expect(result.version).not.toBe('0.0.0-UNKNOWN');
  });
});

describe('safeString() — null-coalescing helper for branch coverage', () => {
  it('returns empty string for undefined input', () => {
    expect(safeString(undefined)).toBe('');
  });

  it('returns empty string for null input', () => {
    expect(safeString(null)).toBe('');
  });

  it('returns input value when defined non-empty string', () => {
    expect(safeString('hello')).toBe('hello');
  });

  it('returns empty string for empty string input (passthrough)', () => {
    expect(safeString('')).toBe('');
  });
});
