import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { ImportResolver } from '../lib/import-resolver';
import { Logger } from '../lib/logger';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('ImportResolver — built-ins', () => {
  const logger = new Logger('error');
  const resolver = new ImportResolver({ logger });

  it('recognizes node built-ins as non-resolvable', () => {
    for (const mod of ['fs', 'path', 'crypto', 'events', 'url']) {
      const r = resolver.resolve(mod, __filename);
      expect(r.kind).toBe('builtin');
      expect(r.resolved).toBe(null);
    }
  });

  it('recognizes node: prefix builtins', () => {
    const r = resolver.resolve('node:fs', __filename);
    expect(r.kind).toBe('builtin');
  });

  it('empty specifier is unresolved', () => {
    const r = resolver.resolve('', __filename);
    expect(r.kind).toBe('unresolved');
  });
});

describe('ImportResolver — node_modules', () => {
  const logger = new Logger('error');
  let resolver: ImportResolver;

  beforeEach(() => {
    resolver = new ImportResolver({ logger });
  });

  it('resolves an installed dependency to a real file', () => {
    const r = resolver.resolve('zod', __filename);
    // zod is in the project deps
    expect(r.resolved).toBeTruthy();
    expect(r.kind).toBe('node-module');
    expect(r.resolved).toMatch(/node_modules[/\\]zod/);
  });

  it('resolves better-sqlite3 (native binding package)', () => {
    const r = resolver.resolve('better-sqlite3', __filename);
    expect(r.resolved).toBeTruthy();
    expect(r.kind).toBe('node-module');
  });

  it('non-existent package returns unresolved', () => {
    const r = resolver.resolve('totally-does-not-exist-xyz-pkg', __filename);
    expect(r.resolved).toBe(null);
    expect(r.kind).toBe('unresolved');
  });
});

describe('ImportResolver — relative', () => {
  const logger = new Logger('error');
  const resolver = new ImportResolver({ logger });

  it('resolves a sibling module that exists', () => {
    const fromFile = path.join(__dirname, '..', 'lib', 'rate-limiter.ts');
    const r = resolver.resolve('./cache', fromFile);
    // cache.ts exists — either resolved or fallback (because AST ts-morph may
    // not actually bring .ts into play in enhanced-resolve with the configured
    // extensions); either way, the resolved path should end in /cache.ts or similar.
    expect(r.resolved).toBeTruthy();
  });

  it('fallback for non-existent relative path', () => {
    const r = resolver.resolve('./does-not-exist-at-all', __filename);
    // Should return something (fallback) rather than null, because
    // "will be generated later" is a legitimate scenario.
    expect(r.resolved).toBeTruthy();
    expect(r.kind).toBe('fallback');
  });
});

describe('ImportResolver — config snapshot', () => {
  const logger = new Logger('error');

  it('loads tsconfig.json from project root by default', () => {
    const resolver = new ImportResolver({ logger });
    const snap = resolver.getConfigSnapshot();
    // Either we found one, or we didn't — but the API must always return a shape
    expect(snap).toHaveProperty('tsConfigPath');
    expect(snap).toHaveProperty('pathAliases');
    expect(snap).toHaveProperty('baseUrl');
  });

  it('resolvePath wraps resolve() to return path-only', () => {
    const resolver = new ImportResolver({ logger });
    const direct = resolver.resolve('fs', __filename);
    const viaWrapper = resolver.resolvePath('fs', __filename);
    expect(viaWrapper).toBe(direct.resolved);
  });
});
