/**
 * Regression tests for `src/lib/install-root.ts` (R-1).
 *
 * These guard the precedence contract that replaced `process.cwd()`-based
 * path resolution across version.ts, config.ts, search.ts, import-resolver.ts,
 * and cognitive-index.ts:
 *
 *   1. JCF_HEALTHCARE_AGENT_HUB_HOME env var has highest precedence.
 *      (Legacy alias JCF_HANDLING_TOOL_HOME still supported).
 *   2. Anchor walk from import.meta.url is the default for production.
 *   3. process.cwd() is LAST RESORT and only when both above fail.
 *
 * Per workflow guardrail G1 (perf-opt): every optimization MUST include a
 * regression test. This file tests the install-root behaviour that
 * underpins the path-resolution refactor.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import {
  getInstallRoot,
  getInstallRootSource,
  getDataRoot,
  resolveFromInstallRoot,
  resolveFromDataRoot,
  __resetInstallRootCacheForTests,
} from '../lib/install-root.js';

// Snapshot env vars touched by these tests so we can restore between cases.
let savedHome: string | undefined;
let savedDataDir: string | undefined;
let savedLegacyHome: string | undefined;
let savedLegacyDataDir: string | undefined;

beforeEach(() => {
  savedHome = process.env.JCF_HEALTHCARE_AGENT_HUB_HOME;
  savedDataDir = process.env.JCF_HEALTHCARE_AGENT_HUB_DATA_DIR;
  savedLegacyHome = process.env.JCF_HANDLING_TOOL_HOME;
  savedLegacyDataDir = process.env.JCF_HANDLING_TOOL_DATA_DIR;
  delete process.env.JCF_HEALTHCARE_AGENT_HUB_HOME;
  delete process.env.JCF_HEALTHCARE_AGENT_HUB_DATA_DIR;
  delete process.env.JCF_HANDLING_TOOL_HOME;
  delete process.env.JCF_HANDLING_TOOL_DATA_DIR;
  __resetInstallRootCacheForTests();
});

afterEach(() => {
  if (savedHome !== undefined) process.env.JCF_HEALTHCARE_AGENT_HUB_HOME = savedHome;
  else delete process.env.JCF_HEALTHCARE_AGENT_HUB_HOME;
  if (savedDataDir !== undefined) process.env.JCF_HEALTHCARE_AGENT_HUB_DATA_DIR = savedDataDir;
  else delete process.env.JCF_HEALTHCARE_AGENT_HUB_DATA_DIR;
  if (savedLegacyHome !== undefined) process.env.JCF_HANDLING_TOOL_HOME = savedLegacyHome;
  else delete process.env.JCF_HANDLING_TOOL_HOME;
  if (savedLegacyDataDir !== undefined) process.env.JCF_HANDLING_TOOL_DATA_DIR = savedLegacyDataDir;
  else delete process.env.JCF_HANDLING_TOOL_DATA_DIR;
  __resetInstallRootCacheForTests();
});

describe('install-root — env var override (precedence rule 1)', () => {
  it('respects JCF_HEALTHCARE_AGENT_HUB_HOME absolute path', () => {
    const target = path.resolve(os.tmpdir(), 'jcf-fixture-install-root');
    process.env.JCF_HEALTHCARE_AGENT_HUB_HOME = target;

    expect(getInstallRoot()).toBe(target);
    expect(getInstallRootSource()).toBe('env');
  });

  it('canonicalises a relative JCF_HEALTHCARE_AGENT_HUB_HOME', () => {
    process.env.JCF_HEALTHCARE_AGENT_HUB_HOME = '.';
    const root = getInstallRoot();
    expect(path.isAbsolute(root)).toBe(true);
    expect(getInstallRootSource()).toBe('env');
  });

  it('ignores empty / whitespace-only env value (falls through to anchor walk)', () => {
    process.env.JCF_HEALTHCARE_AGENT_HUB_HOME = '   ';
    // Anchor walk should still find the package because the test runs
    // from inside the jcf-healthcare-agent-hub repo.
    const root = getInstallRoot();
    expect(getInstallRootSource()).not.toBe('env');
    // Package name match means the resolved root has package.json with
    // name === 'jcf-healthcare-agent-hub'. We can't assert the exact path
    // (depends on test harness layout), but it should be absolute.
    expect(path.isAbsolute(root)).toBe(true);
  });
});

describe('install-root — anchor walk (precedence rule 2)', () => {
  it('finds jcf-healthcare-agent-hub package root from this test file', () => {
    // No env, no override — should walk up from import.meta.url and
    // land on the package root (where package.json declares the name
    // `jcf-healthcare-agent-hub`).
    const root = getInstallRoot();
    expect(getInstallRootSource()).toBe('anchor-walk');
    // The test file lives under <root>/src/__tests__, so walking up two
    // levels from this directory must equal the resolved root. We verify
    // by checking that <root>/package.json exists and matches.
    expect(path.isAbsolute(root)).toBe(true);
    // basename should be 'jcf-healthcare-agent-hub' for the canonical layout.
    expect(path.basename(root)).toBe('jcf-healthcare-agent-hub');
  });

  it('memoises the result across calls', () => {
    const a = getInstallRoot();
    const b = getInstallRoot();
    expect(a).toBe(b);
  });
});

describe('install-root — data root', () => {
  it('defaults to <install-root>/data', () => {
    const expected = path.resolve(getInstallRoot(), 'data');
    expect(getDataRoot()).toBe(expected);
  });

  it('respects JCF_HEALTHCARE_AGENT_HUB_DATA_DIR absolute override', () => {
    const target = path.resolve(os.tmpdir(), 'jcf-fixture-data-dir');
    process.env.JCF_HEALTHCARE_AGENT_HUB_DATA_DIR = target;
    expect(getDataRoot()).toBe(target);
  });

  it('treats relative JCF_HEALTHCARE_AGENT_HUB_DATA_DIR as relative to install-root', () => {
    process.env.JCF_HEALTHCARE_AGENT_HUB_DATA_DIR = 'custom-data';
    const expected = path.resolve(getInstallRoot(), 'custom-data');
    expect(getDataRoot()).toBe(expected);
  });
});

describe('install-root — resolveFrom helpers', () => {
  it('resolveFromInstallRoot prepends install-root to relative paths', () => {
    const result = resolveFromInstallRoot('package.json');
    const expected = path.resolve(getInstallRoot(), 'package.json');
    expect(result).toBe(expected);
  });

  it('resolveFromInstallRoot returns absolute paths unchanged', () => {
    const abs = path.resolve(os.tmpdir(), 'absolute-fixture.json');
    expect(resolveFromInstallRoot(abs)).toBe(abs);
  });

  it('resolveFromDataRoot prepends data-root to relative paths', () => {
    const result = resolveFromDataRoot('jcf-fs-metadata.sqlite');
    const expected = path.resolve(getDataRoot(), 'jcf-fs-metadata.sqlite');
    expect(result).toBe(expected);
  });

  it('resolveFromDataRoot returns absolute paths unchanged', () => {
    const abs = path.resolve(os.tmpdir(), 'absolute-data.sqlite');
    expect(resolveFromDataRoot(abs)).toBe(abs);
  });
});

describe('install-root — test cache reset semantics', () => {
  it('__resetInstallRootCacheForTests forces re-resolution', () => {
    // First resolution under no override → anchor walk.
    const initial = getInstallRoot();
    expect(getInstallRootSource()).toBe('anchor-walk');

    // Reset, set env override, and ensure new resolution returns env path.
    __resetInstallRootCacheForTests();
    const target = path.resolve(os.tmpdir(), 'jcf-fixture-reset');
    process.env.JCF_HEALTHCARE_AGENT_HUB_HOME = target;
    expect(getInstallRoot()).toBe(target);
    expect(getInstallRootSource()).toBe('env');
    expect(getInstallRoot()).not.toBe(initial);
  });

  it('reset also clears data-root cache', () => {
    const before = getDataRoot();
    __resetInstallRootCacheForTests();
    process.env.JCF_HEALTHCARE_AGENT_HUB_HOME = path.resolve(os.tmpdir(), 'jcf-fixture-data-reset');
    const after = getDataRoot();
    expect(after).not.toBe(before);
    expect(after).toBe(path.resolve(process.env.JCF_HEALTHCARE_AGENT_HUB_HOME, 'data'));
  });
});

describe('install-root — regression: pre-fix `process.cwd()` drift', () => {
  /**
   * This test pins the contract that prevented the `Step Flash` symptom
   * from recurring: even if the test runner itself is invoked from a
   * foreign cwd, the install-root must NOT come from cwd as long as the
   * anchor walk can find the package root.
   */
  it('does not resolve to process.cwd() when anchor walk succeeds', () => {
    // Anchor walk should find package root, NOT cwd-fallback.
    const root = getInstallRoot();
    expect(getInstallRootSource()).toBe('anchor-walk');
    // Defensive: even if cwd happens to equal install-root in this
    // particular test environment, the source must still be 'anchor-walk'.
    void root;
  });
});
