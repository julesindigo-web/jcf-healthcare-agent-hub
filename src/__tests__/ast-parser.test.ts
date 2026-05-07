import { describe, it, expect, beforeAll } from 'vitest';
import { AstParser, AST_SUPPORTED_EXTENSIONS, isAstParseable } from '../lib/ast-parser';
import { Logger } from '../lib/logger';

/**
 * Phase E.4 (M5 audit) -- jcf-healthcare-agent-hub ast-parser.ts contract tests.
 * Replaces missing test coverage for the ts-morph AST extraction layer
 * (Phase E2). Validates extraction correctness for
 * exports, imports, units, and graceful degradation on syntax errors.
 */
describe('AST_SUPPORTED_EXTENSIONS + isAstParseable', () => {
  it('supports TypeScript family', () => {
    expect(isAstParseable('foo.ts')).toBe(true);
    expect(isAstParseable('foo.tsx')).toBe(true);
    expect(isAstParseable('foo.mts')).toBe(true);
    expect(isAstParseable('foo.cts')).toBe(true);
  });

  it('supports JavaScript family', () => {
    expect(isAstParseable('foo.js')).toBe(true);
    expect(isAstParseable('foo.jsx')).toBe(true);
    expect(isAstParseable('foo.mjs')).toBe(true);
    expect(isAstParseable('foo.cjs')).toBe(true);
  });

  it('rejects unsupported extensions', () => {
    expect(isAstParseable('foo.py')).toBe(false);
    expect(isAstParseable('foo.go')).toBe(false);
    expect(isAstParseable('foo.rs')).toBe(false);
    expect(isAstParseable('foo.md')).toBe(false);
    expect(isAstParseable('foo')).toBe(false);
  });

  it('is case-insensitive on extension', () => {
    expect(isAstParseable('foo.TS')).toBe(true);
    expect(isAstParseable('foo.TSX')).toBe(true);
  });

  it('AST_SUPPORTED_EXTENSIONS contains 8 extensions', () => {
    expect(AST_SUPPORTED_EXTENSIONS.size).toBe(8);
  });
});

describe('AstParser', () => {
  let parser: AstParser;
  let logger: Logger;

  beforeAll(() => {
    logger = new Logger('error');
    parser = new AstParser({ logger });
  });

  describe('parseFile -- exports', () => {
    it('extracts exported function declaration', () => {
      const code = `export function add(a: number, b: number): number { return a + b; }`;
      const result = parser.parseFile('test.ts', code);
      expect(result.errorMessage).toBeUndefined();
      expect(result.exports).toContainEqual(
        expect.objectContaining({ name: 'add', kind: 'function', isDefault: false })
      );
    });

    it('extracts exported class', () => {
      const code = `export class MyClass { foo() { return 1; } }`;
      const result = parser.parseFile('test.ts', code);
      expect(result.exports).toContainEqual(
        expect.objectContaining({ name: 'MyClass', kind: 'class' })
      );
    });

    it('extracts exported interface', () => {
      const code = `export interface User { id: string; name: string; }`;
      const result = parser.parseFile('test.ts', code);
      expect(result.exports).toContainEqual(
        expect.objectContaining({ name: 'User', kind: 'interface' })
      );
    });

    it('extracts exported type alias', () => {
      const code = `export type ID = string;`;
      const result = parser.parseFile('test.ts', code);
      expect(result.exports).toContainEqual(
        expect.objectContaining({ name: 'ID', kind: 'type' })
      );
    });

    it('extracts exported enum', () => {
      const code = `export enum Color { Red, Green, Blue }`;
      const result = parser.parseFile('test.ts', code);
      expect(result.exports).toContainEqual(
        expect.objectContaining({ name: 'Color', kind: 'enum' })
      );
    });

    it('marks default export', () => {
      const code = `export default function main() {}`;
      const result = parser.parseFile('test.ts', code);
      expect(result.exports.some(e => e.isDefault === true)).toBe(true);
    });
  });

  describe('parseFile -- imports', () => {
    it('extracts named imports', () => {
      const code = `import { foo, bar } from 'module';`;
      const result = parser.parseFile('test.ts', code);
      expect(result.imports).toContainEqual(
        expect.objectContaining({ name: 'foo', from: 'module', isType: false })
      );
      expect(result.imports).toContainEqual(
        expect.objectContaining({ name: 'bar', from: 'module' })
      );
    });

    it('extracts default imports', () => {
      const code = `import React from 'react';`;
      const result = parser.parseFile('test.ts', code);
      expect(result.imports).toContainEqual(
        expect.objectContaining({ name: 'React', from: 'react', isDefault: true })
      );
    });

    it('extracts namespace imports', () => {
      const code = `import * as fs from 'fs';`;
      const result = parser.parseFile('test.ts', code);
      expect(result.imports).toContainEqual(
        expect.objectContaining({ name: 'fs', from: 'fs', isNamespace: true })
      );
    });

    it('marks type-only imports', () => {
      const code = `import type { User } from './types';`;
      const result = parser.parseFile('test.ts', code);
      expect(result.imports).toContainEqual(
        expect.objectContaining({ name: 'User', isType: true })
      );
    });

    it('does NOT extract imports from line comments (regex would fail here)', () => {
      const code = `// import { fake } from 'fake';\nconst x = 1;`;
      const result = parser.parseFile('test.ts', code);
      expect(result.imports.find(i => i.name === 'fake')).toBeUndefined();
    });

    it('does NOT extract imports from block comments', () => {
      const code = `/* import { ghost } from 'ghost'; */\nconst y = 2;`;
      const result = parser.parseFile('test.ts', code);
      expect(result.imports.find(i => i.name === 'ghost')).toBeUndefined();
    });

    it('does NOT extract imports from template literals', () => {
      const code = "const s = `import { phantom } from 'phantom';`;";
      const result = parser.parseFile('test.ts', code);
      expect(result.imports.find(i => i.name === 'phantom')).toBeUndefined();
    });
  });

  describe('parseFile -- units', () => {
    it('extracts function units with cyclomatic complexity', () => {
      const code = `export function decide(x: number): string {
        if (x > 10) return 'big';
        if (x > 0) return 'small';
        return 'zero';
      }`;
      const result = parser.parseFile('test.ts', code);
      const unit = result.units.find(u => u.name === 'decide');
      expect(unit).toBeDefined();
      expect(unit!.kind).toBe('function');
      expect(unit!.complexity).toBeGreaterThan(1); // has 2 conditionals
    });

    it('marks async functions', () => {
      const code = `export async function fetchData() { return 1; }`;
      const result = parser.parseFile('test.ts', code);
      const unit = result.units.find(u => u.name === 'fetchData');
      expect(unit?.isAsync).toBe(true);
    });

    it('marks exported flag correctly', () => {
      const code = `export function pub() {}\nfunction priv() {}`;
      const result = parser.parseFile('test.ts', code);
      const pub = result.units.find(u => u.name === 'pub');
      const priv = result.units.find(u => u.name === 'priv');
      expect(pub?.isExported).toBe(true);
      if (priv) expect(priv.isExported).toBe(false);
    });
  });

  describe('parseFile -- error handling', () => {
    it('returns errorMessage for unsupported extension', () => {
      const result = parser.parseFile('test.py', 'def foo(): pass');
      expect(result.errorMessage).toContain('Unsupported');
      expect(result.exports).toHaveLength(0);
    });

    it('handles syntax errors gracefully (no throw)', () => {
      const code = `function broken( {`;
      const result = parser.parseFile('test.ts', code);
      expect(result).toBeDefined();
      expect(result.filePath).toBe('test.ts');
    });

    it('preserves filePath on all error paths', () => {
      const result = parser.parseFile('weird.zzz', 'random');
      expect(result.filePath).toBe('weird.zzz');
    });
  });

  describe('parseFiles -- batch', () => {
    it('processes multiple files in order', () => {
      const files = [
        { filePath: 'a.ts', content: 'export const a = 1;' },
        { filePath: 'b.ts', content: 'export const b = 2;' },
      ];
      const results = parser.parseFiles(files);
      expect(results).toHaveLength(2);
      expect(results[0].exports.find(e => e.name === 'a')).toBeDefined();
      expect(results[1].exports.find(e => e.name === 'b')).toBeDefined();
    });

    it('handles empty input', () => {
      const results = parser.parseFiles([]);
      expect(results).toEqual([]);
    });

    it('does not let one bad file break others', () => {
      const files = [
        { filePath: 'good.ts', content: 'export const good = true;' },
        { filePath: 'bad.ts', content: 'function broken( {' },
        { filePath: 'good2.ts', content: 'export const good2 = true;' },
      ];
      const results = parser.parseFiles(files);
      expect(results).toHaveLength(3);
      expect(results[0].exports.find(e => e.name === 'good')).toBeDefined();
      expect(results[2].exports.find(e => e.name === 'good2')).toBeDefined();
    });
  });

  describe('parseFile -- defined types', () => {
    it('extracts class with extends', () => {
      const code = `class Base {} export class Derived extends Base {}`;
      const result = parser.parseFile('test.ts', code);
      const type = result.definedTypes.find(t => t.name === 'Derived');
      expect(type?.kind).toBe('class');
      expect(type?.extendsTypes).toContain('Base');
    });

    it('extracts interface with extends', () => {
      const code = `interface A {} export interface B extends A {}`;
      const result = parser.parseFile('test.ts', code);
      const type = result.definedTypes.find(t => t.name === 'B');
      expect(type?.kind).toBe('interface');
      expect(type?.extendsTypes).toContain('A');
    });
  });
});
