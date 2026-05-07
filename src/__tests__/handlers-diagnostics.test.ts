/**
 * Diagnostics handler tests — covers simplified ping handler (ADR-H001).
 * COV-02: fills the 0% branch coverage gap for diagnostics.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import { diagnosticsHandlers } from '../handlers/diagnostics.js';

const mockStats = {
  fileCount: 42,
  versionCount: 100,
  auditCount: 5,
  sizeBytes: 1024,
};

const createCtx = (overrides = {}) => ({
  db: { getStats: vi.fn().mockReturnValue(mockStats) },
  config: { serverVersion: '2.1.0-healthcare', databasePath: '/data/test.sqlite' },
  ...overrides,
});

describe('diagnosticsHandlers — ping', () => {
  it('is exported and is a function', () => {
    expect(typeof diagnosticsHandlers.ping).toBe('function');
  });

  it('estatus and verify are NOT exported (ADR-H001)', () => {
    expect(diagnosticsHandlers.estatus).toBeUndefined();
    expect(diagnosticsHandlers.verify).toBeUndefined();
  });

  it('returns online status with healthcare server name', async () => {
    const ctx = createCtx();
    const result = await diagnosticsHandlers.ping(ctx as any, {});
    expect(result.status).toBe('online');
    expect(result.server).toBe('jcf-healthcare-agent-hub');
  });

  it('returns correct version from config', async () => {
    const ctx = createCtx();
    const result = await diagnosticsHandlers.ping(ctx as any, {});
    expect(result.version).toBe('2.1.0-healthcare');
  });

  it('returns db_path from config', async () => {
    const ctx = createCtx();
    const result = await diagnosticsHandlers.ping(ctx as any, {});
    expect(result.db_path).toBe('/data/test.sqlite');
  });

  it('returns stats from ctx.db.getStats()', async () => {
    const ctx = createCtx();
    const result = await diagnosticsHandlers.ping(ctx as any, {});
    expect(result.stats.files).toBe(42);
    expect(result.stats.versions).toBe(100);
    expect(result.stats.audits).toBe(5);
    expect(result.stats.size_bytes).toBe(1024);
    expect(ctx.db.getStats).toHaveBeenCalledTimes(1);
  });

  it('returns a valid ISO timestamp', async () => {
    const ctx = createCtx();
    const result = await diagnosticsHandlers.ping(ctx as any, {});
    expect(() => new Date(result.timestamp)).not.toThrow();
    expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('does NOT include enforcement state (ADR-H001)', async () => {
    const ctx = createCtx();
    const result = await diagnosticsHandlers.ping(ctx as any, {});
    expect(result).not.toHaveProperty('enforcement');
    expect(result).not.toHaveProperty('anchorHash');
    expect(result).not.toHaveProperty('complianceLevel');
  });

  it('calls ctx.db.getStats() on every invocation', async () => {
    const ctx = createCtx();
    await diagnosticsHandlers.ping(ctx as any, {});
    await diagnosticsHandlers.ping(ctx as any, {});
    expect(ctx.db.getStats).toHaveBeenCalledTimes(2);
  });
});
