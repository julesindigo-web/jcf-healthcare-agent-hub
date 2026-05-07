/**
 * JCF Healthcare Agent Hub — AST Parser (Phase E2)
 *
 * Replaces the regex-based extraction in `cognitive-index.ts` with a proper
 * TypeScript Compiler API parser (via ts-morph). This fixes:
 *
 *  - False positives when `import { foo } from 'bar'` appears inside a comment
 *  - False positives inside template literals / string content
 *  - Mis-paired braces in nested arrow functions
 *  - Incorrect cyclomatic complexity (was counting keyword occurrences,
 *    including those in strings/comments)
 *  - Missing type references (generics, mapped types, conditional types)
 *
 * Usage: TS/JS/TSX/JSX files go through `AstParser.parseFile()`. Other languages
 * (Python, Go, Rust, etc.) continue using the legacy regex extractors because
 * ts-morph only handles TypeScript-family sources.
 *
 * Performance note: ts-morph's `useInMemoryFileSystem=true` + `skipLibCheck=true`
 * keeps parsing at ~5–20ms per file, comparable to regex parsing, but far more
 * accurate. The Project instance is reused for batch parsing to amortize setup.
 */

import {
  Project,
  type SourceFile,
  SyntaxKind,
  Node,
  type FunctionDeclaration,
  type ClassDeclaration,
  type InterfaceDeclaration,
  type TypeAliasDeclaration,
  type EnumDeclaration,
  type MethodDeclaration,
  type ArrowFunction,
  type FunctionExpression,
  type VariableDeclaration,
} from 'ts-morph';
import path from 'path';
import type { Logger } from './logger.js';

// ═══════════════════════════════════════════════════════════════════════════
// ── Exported Types ──
// ═══════════════════════════════════════════════════════════════════════════

export type UnitKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'method'
  | 'variable';

export interface ExtractedUnit {
  name: string;
  kind: UnitKind;
  startLine: number;
  endLine: number;
  complexity: number;
  isAsync: boolean;
  isExported: boolean;
  signature: string;
  inputSignature: string;
  outputSignature: string;
  callTargets: string[];
  typeDependencies: string[];
  sideEffects: string[];
  body: string;
}

export interface ExtractedExport {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'enum' | 'variable';
  signature: string;
  isDefault: boolean;
}

export interface ExtractedImport {
  name: string;
  from: string;
  isType: boolean;
  isDefault: boolean;
  isNamespace: boolean;
}

export interface ExtractedTypeDef {
  name: string;
  kind: 'interface' | 'type' | 'class' | 'enum';
  extendsTypes: string[];
  implementsTypes: string[];
  memberCount: number;
}

export interface ExtractedModule {
  filePath: string;
  moduleName: string;
  exports: ExtractedExport[];
  imports: ExtractedImport[];
  definedTypes: ExtractedTypeDef[];
  units: ExtractedUnit[];
  errorMessage?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Capability check ──
// ═══════════════════════════════════════════════════════════════════════════

/** File extensions we can parse with ts-morph */
export const AST_SUPPORTED_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mts', '.cts',
  '.js', '.jsx', '.mjs', '.cjs',
]);

export function isAstParseable(filePath: string): boolean {
  return AST_SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Parser ──
// ═══════════════════════════════════════════════════════════════════════════

export class AstParser {
  private readonly project: Project;
  private readonly logger: Logger;

  constructor(config: { logger: Logger }) {
    this.logger = config.logger;
    this.project = new Project({
      useInMemoryFileSystem: true,
      skipAddingFilesFromTsConfig: true,
      skipFileDependencyResolution: true,
      compilerOptions: {
        allowJs: true,
        jsx: 4 /* JsxEmit.ReactJSX */,
        target: 99 /* ScriptTarget.ESNext */,
        module: 99 /* ModuleKind.ESNext */,
        moduleResolution: 100 /* ModuleResolutionKind.Bundler */,
        noResolve: true,
        skipLibCheck: true,
      },
    });
  }

  /**
   * Parse a single file. Returns structured module info.
   * On syntax error, returns a best-effort result with `errorMessage` set.
   */
  parseFile(filePath: string, content: string): ExtractedModule {
    if (!isAstParseable(filePath)) {
      return this.emptyModule(filePath, `Unsupported extension: ${path.extname(filePath)}`);
    }

    // Remove any stale cached copy (same filePath re-used)
    const existing = this.project.getSourceFile(filePath);
    if (existing) {
      this.project.removeSourceFile(existing);
    }

    let sf: SourceFile;
    try {
      sf = this.project.createSourceFile(filePath, content, { overwrite: true });
    } catch (err) {
      this.logger.warn('AST parse failed — file skipped', {
        filePath,
        error: err instanceof Error ? err.message : String(err),
      });
      return this.emptyModule(filePath, String(err));
    }

    try {
      const mod: ExtractedModule = {
        filePath,
        moduleName: this.deriveModuleName(filePath),
        exports: this.extractExports(sf),
        imports: this.extractImports(sf),
        definedTypes: this.extractDefinedTypes(sf),
        units: this.extractUnits(sf),
      };
      return mod;
    } catch (err) {
      this.logger.warn('AST extraction failed — returning partial module', {
        filePath,
        error: err instanceof Error ? err.message : String(err),
      });
      return this.emptyModule(filePath, String(err));
    } finally {
      // Release memory — don't accumulate parsed sources across calls
      this.project.removeSourceFile(sf);
    }
  }

  /**
   * Parse many files efficiently — shares a single Project instance.
   * Returns results in same order as input.
   */
  parseFiles(files: Array<{ filePath: string; content: string }>): ExtractedModule[] {
    const results: ExtractedModule[] = [];
    for (const f of files) {
      results.push(this.parseFile(f.filePath, f.content));
    }
    return results;
  }

  private emptyModule(filePath: string, errorMessage?: string): ExtractedModule {
    const mod: ExtractedModule = {
      filePath,
      moduleName: this.deriveModuleName(filePath),
      exports: [],
      imports: [],
      definedTypes: [],
      units: [],
    };
    if (errorMessage) mod.errorMessage = errorMessage;
    return mod;
  }

  private deriveModuleName(filePath: string): string {
    const base = path.basename(filePath, path.extname(filePath));
    return base === 'index' ? path.basename(path.dirname(filePath)) : base;
  }

  // ─────────────────────────────────────────────────────────────────────
  // ── Imports ──
  // ─────────────────────────────────────────────────────────────────────

  private extractImports(sf: SourceFile): ExtractedImport[] {
    const imports: ExtractedImport[] = [];
    for (const imp of sf.getImportDeclarations()) {
      const from = imp.getModuleSpecifierValue();
      const isType = imp.isTypeOnly();

      // Default import
      const defaultImport = imp.getDefaultImport();
      if (defaultImport) {
        imports.push({
          name: defaultImport.getText(),
          from,
          isType,
          isDefault: true,
          isNamespace: false,
        });
      }

      // Namespace import:  import * as X from '...'
      const ns = imp.getNamespaceImport();
      if (ns) {
        imports.push({
          name: ns.getText(),
          from,
          isType,
          isDefault: false,
          isNamespace: true,
        });
      }

      // Named imports: { a, b as c }
      for (const named of imp.getNamedImports()) {
        imports.push({
          name: named.getAliasNode()?.getText() ?? named.getName(),
          from,
          isType: isType || named.isTypeOnly(),
          isDefault: false,
          isNamespace: false,
        });
      }
    }
    return imports;
  }

  // ─────────────────────────────────────────────────────────────────────
  // ── Exports ──
  // ─────────────────────────────────────────────────────────────────────

  private extractExports(sf: SourceFile): ExtractedExport[] {
    const exports: ExtractedExport[] = [];
    const declared = sf.getExportedDeclarations();

    for (const [name, decls] of declared) {
      for (const decl of decls) {
        const kind = this.classifyDeclarationKind(decl);
        if (!kind) continue;
        exports.push({
          name,
          kind,
          signature: this.signatureOf(decl, name, kind),
          isDefault: name === 'default',
        });
      }
    }
    return exports;
  }

  private classifyDeclarationKind(decl: Node): ExtractedExport['kind'] | null {
    if (Node.isFunctionDeclaration(decl) || Node.isArrowFunction(decl) || Node.isFunctionExpression(decl)) return 'function';
    if (Node.isClassDeclaration(decl)) return 'class';
    if (Node.isInterfaceDeclaration(decl)) return 'interface';
    if (Node.isTypeAliasDeclaration(decl)) return 'type';
    if (Node.isEnumDeclaration(decl)) return 'enum';
    if (Node.isVariableDeclaration(decl)) return 'variable';
    return null;
  }

  private signatureOf(decl: Node, name: string, kind: ExtractedExport['kind']): string {
    try {
      if (Node.isFunctionDeclaration(decl) || Node.isMethodDeclaration(decl)) {
        const params = decl.getParameters().map(p => p.getText()).join(', ');
        const ret = decl.getReturnTypeNode()?.getText() ?? 'unknown';
        return `${name}(${params}): ${ret}`;
      }
      if (Node.isClassDeclaration(decl)) return `class ${name}`;
      if (Node.isInterfaceDeclaration(decl)) return `interface ${name}`;
      if (Node.isTypeAliasDeclaration(decl)) return `type ${name} = ${decl.getTypeNode()?.getText() ?? 'unknown'}`;
      if (Node.isEnumDeclaration(decl)) return `enum ${name}`;
      if (Node.isVariableDeclaration(decl)) {
        const typeNode = decl.getTypeNode();
        return typeNode ? `const ${name}: ${typeNode.getText()}` : `const ${name}`;
      }
      return `${kind} ${name}`;
    } catch {
      return `${kind} ${name}`;
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // ── Type Definitions ──
  // ─────────────────────────────────────────────────────────────────────

  private extractDefinedTypes(sf: SourceFile): ExtractedTypeDef[] {
    const defs: ExtractedTypeDef[] = [];

    for (const cls of sf.getClasses()) {
      defs.push({
        name: cls.getName() ?? '(anonymous)',
        kind: 'class',
        extendsTypes: cls.getExtends() ? [cls.getExtends()!.getText()] : [],
        implementsTypes: cls.getImplements().map(i => i.getText()),
        memberCount: cls.getMembers().length,
      });
    }

    for (const iface of sf.getInterfaces()) {
      defs.push({
        name: iface.getName(),
        kind: 'interface',
        extendsTypes: iface.getExtends().map(e => e.getText()),
        implementsTypes: [],
        memberCount: iface.getMembers().length,
      });
    }

    for (const alias of sf.getTypeAliases()) {
      defs.push({
        name: alias.getName(),
        kind: 'type',
        extendsTypes: [],
        implementsTypes: [],
        memberCount: 0,
      });
    }

    for (const en of sf.getEnums()) {
      defs.push({
        name: en.getName(),
        kind: 'enum',
        extendsTypes: [],
        implementsTypes: [],
        memberCount: en.getMembers().length,
      });
    }

    return defs;
  }

  // ─────────────────────────────────────────────────────────────────────
  // ── Units (functions + methods + classes) ──
  // ─────────────────────────────────────────────────────────────────────

  private extractUnits(sf: SourceFile): ExtractedUnit[] {
    const units: ExtractedUnit[] = [];

    // Top-level functions
    for (const fn of sf.getFunctions()) {
      const unit = this.functionToUnit(fn);
      if (unit) units.push(unit);
    }

    // Classes + methods
    for (const cls of sf.getClasses()) {
      const clsName = cls.getName() ?? '(anonymous)';
      units.push(this.classToUnit(cls));
      for (const m of cls.getMethods()) {
        const unit = this.methodToUnit(m, clsName);
        if (unit) units.push(unit);
      }
    }

    // Interfaces / types / enums as zero-complexity units
    for (const iface of sf.getInterfaces()) {
      units.push(this.typeLikeToUnit(iface, 'interface'));
    }
    for (const alias of sf.getTypeAliases()) {
      units.push(this.typeLikeToUnit(alias, 'type'));
    }
    for (const en of sf.getEnums()) {
      units.push(this.typeLikeToUnit(en, 'enum'));
    }

    // Top-level arrow functions assigned to const/let
    for (const stmt of sf.getVariableStatements()) {
      for (const decl of stmt.getDeclarations()) {
        const init = decl.getInitializer();
        if (!init) continue;
        if (Node.isArrowFunction(init) || Node.isFunctionExpression(init)) {
          const unit = this.arrowOrFnExprToUnit(decl, init);
          if (unit) units.push(unit);
        }
      }
    }

    return units;
  }

  private functionToUnit(fn: FunctionDeclaration): ExtractedUnit | null {
    const name = fn.getName();
    if (!name) return null;
    const body = fn.getBodyText() ?? '';
    return {
      name,
      kind: 'function',
      startLine: fn.getStartLineNumber(),
      endLine: fn.getEndLineNumber(),
      complexity: this.cyclomaticComplexity(fn),
      isAsync: fn.isAsync(),
      isExported: fn.isExported(),
      signature: this.fnSignature(name, fn),
      inputSignature: fn.getParameters().map(p => p.getType().getText()).join(', '),
      outputSignature: fn.getReturnTypeNode()?.getText() ?? this.safeReturnType(fn),
      callTargets: this.collectCallTargets(fn),
      typeDependencies: this.collectTypeRefs(fn),
      sideEffects: this.detectSideEffects(body),
      body: body.length > 2000 ? body.slice(0, 2000) : body,
    };
  }

  private classToUnit(cls: ClassDeclaration): ExtractedUnit {
    const name = cls.getName() ?? '(anonymous)';
    const body = cls.getText();
    return {
      name,
      kind: 'class',
      startLine: cls.getStartLineNumber(),
      endLine: cls.getEndLineNumber(),
      complexity: cls.getMethods().reduce((s, m) => s + this.cyclomaticComplexity(m), cls.getMethods().length || 1),
      isAsync: false,
      isExported: cls.isExported(),
      signature: `class ${name}`,
      inputSignature: '',
      outputSignature: '',
      callTargets: [],
      typeDependencies: [
        ...(cls.getExtends() ? [cls.getExtends()!.getText()] : []),
        ...cls.getImplements().map(i => i.getText()),
      ],
      sideEffects: [],
      body: body.length > 500 ? body.slice(0, 500) : body,
    };
  }

  private methodToUnit(m: MethodDeclaration, clsName: string): ExtractedUnit | null {
    const name = m.getName();
    if (!name) return null;
    const body = m.getBodyText() ?? '';
    return {
      name: `${clsName}.${name}`,
      kind: 'method',
      startLine: m.getStartLineNumber(),
      endLine: m.getEndLineNumber(),
      complexity: this.cyclomaticComplexity(m),
      isAsync: m.isAsync(),
      isExported: false,
      signature: this.methodSignature(m, clsName),
      inputSignature: m.getParameters().map(p => p.getType().getText()).join(', '),
      outputSignature: m.getReturnTypeNode()?.getText() ?? this.safeReturnType(m),
      callTargets: this.collectCallTargets(m),
      typeDependencies: this.collectTypeRefs(m),
      sideEffects: this.detectSideEffects(body),
      body: body.length > 2000 ? body.slice(0, 2000) : body,
    };
  }

  private arrowOrFnExprToUnit(
    decl: VariableDeclaration,
    init: ArrowFunction | FunctionExpression
  ): ExtractedUnit | null {
    const name = decl.getName();
    if (!name) return null;
    const body = (init.getBody() ?? init).getText();
    const isArrow = Node.isArrowFunction(init);
    return {
      name,
      kind: 'function',
      startLine: init.getStartLineNumber(),
      endLine: init.getEndLineNumber(),
      complexity: this.cyclomaticComplexity(init),
      isAsync: init.isAsync(),
      isExported: decl.isExported(),
      signature: `${name} = ${isArrow ? '(...args) =>' : 'function'}`,
      inputSignature: init.getParameters().map(p => p.getType().getText()).join(', '),
      outputSignature: init.getReturnTypeNode()?.getText() ?? 'inferred',
      callTargets: this.collectCallTargets(init),
      typeDependencies: this.collectTypeRefs(init),
      sideEffects: this.detectSideEffects(body),
      body: body.length > 2000 ? body.slice(0, 2000) : body,
    };
  }

  private typeLikeToUnit(
    node: InterfaceDeclaration | TypeAliasDeclaration | EnumDeclaration,
    kind: 'interface' | 'type' | 'enum'
  ): ExtractedUnit {
    const name = node.getName();
    return {
      name,
      kind,
      startLine: node.getStartLineNumber(),
      endLine: node.getEndLineNumber(),
      complexity: 1,
      isAsync: false,
      isExported: 'isExported' in node ? (node as any).isExported() : false,
      signature: `${kind} ${name}`,
      inputSignature: '',
      outputSignature: '',
      callTargets: [],
      typeDependencies: [],
      sideEffects: [],
      body: '',
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // ── Helpers: complexity, calls, types, side-effects ──
  // ─────────────────────────────────────────────────────────────────────

  private cyclomaticComplexity(node: Node): number {
    // Start at 1 for the entry path, +1 for each decision/branch point.
    let complexity = 1;
    const branchKinds = new Set<SyntaxKind>([
      SyntaxKind.IfStatement,
      SyntaxKind.ConditionalExpression,     // ? :
      SyntaxKind.ForStatement,
      SyntaxKind.ForInStatement,
      SyntaxKind.ForOfStatement,
      SyntaxKind.WhileStatement,
      SyntaxKind.DoStatement,
      SyntaxKind.CaseClause,
      SyntaxKind.CatchClause,
    ]);
    const binaryAndOr = new Set<SyntaxKind>([
      SyntaxKind.AmpersandAmpersandToken,   // &&
      SyntaxKind.BarBarToken,               // ||
      SyntaxKind.QuestionQuestionToken,     // ??
    ]);

    node.forEachDescendant(child => {
      const k = child.getKind();
      if (branchKinds.has(k)) complexity++;
      if (Node.isBinaryExpression(child) && binaryAndOr.has(child.getOperatorToken().getKind())) {
        complexity++;
      }
      if (k === SyntaxKind.QuestionDotToken) complexity++; // optional chaining
    });

    return complexity;
  }

  private collectCallTargets(node: Node): string[] {
    const calls = new Set<string>();
    node.forEachDescendant(child => {
      if (Node.isCallExpression(child)) {
        const expr = child.getExpression();
        const text = expr.getText();
        if (text && text.length < 80) calls.add(text);
      }
    });
    return [...calls].slice(0, 30);
  }

  private collectTypeRefs(node: Node): string[] {
    const refs = new Set<string>();
    node.forEachDescendant(child => {
      if (Node.isTypeReference(child)) {
        const tn = child.getTypeName().getText();
        if (tn && tn.length < 60) refs.add(tn);
      }
    });
    return [...refs].slice(0, 30);
  }

  private detectSideEffects(body: string): string[] {
    const effects = new Set<string>();
    if (/\bconsole\.(log|error|warn|info|debug)\b/.test(body)) effects.add('console-output');
    if (/\bfs\.(writeFile|appendFile|mkdir|unlink|rm|rename|copyFile|writeFileSync)\b/.test(body)) effects.add('filesystem-write');
    if (/\bfs\.(readFile|stat|readdir|access|readFileSync|statSync|readdirSync)\b/.test(body)) effects.add('filesystem-read');
    if (/\b(fetch|axios|XMLHttpRequest|http\.request|https\.request)\b/.test(body)) effects.add('network-request');
    if (/\b(Math\.random|Date\.now|new Date\(\)|crypto\.randomUUID)\b/.test(body)) effects.add('non-deterministic');
    if (/\b(setTimeout|setInterval|setImmediate|requestAnimationFrame)\b/.test(body)) effects.add('timer');
    if (/\bthrow\s+/.test(body)) effects.add('throws');
    if (/\bprocess\.(env|exit|stdout|stderr|stdin)\b/.test(body)) effects.add('process-io');
    return [...effects];
  }

  private fnSignature(name: string, fn: FunctionDeclaration): string {
    const params = fn.getParameters().map(p => p.getText()).join(', ');
    const ret = fn.getReturnTypeNode()?.getText() ?? this.safeReturnType(fn);
    return `${fn.isAsync() ? 'async ' : ''}function ${name}(${params}): ${ret}`;
  }

  private methodSignature(m: MethodDeclaration, clsName: string): string {
    const params = m.getParameters().map(p => p.getText()).join(', ');
    const ret = m.getReturnTypeNode()?.getText() ?? this.safeReturnType(m);
    return `${m.isAsync() ? 'async ' : ''}${clsName}.${m.getName()}(${params}): ${ret}`;
  }

  private safeReturnType(node: Node): string {
    try {
      if ('getReturnType' in node && typeof (node as any).getReturnType === 'function') {
        const t = (node as any).getReturnType();
        const text: string = t?.getText?.() ?? 'inferred';
        return text.length > 120 ? 'inferred' : text;
      }
    } catch {
      /* noResolve mode may throw */
    }
    return 'inferred';
  }

  /** Memory-friendly reset if the parser has been used extensively */
  reset(): void {
    for (const sf of this.project.getSourceFiles()) {
      this.project.removeSourceFile(sf);
    }
  }
}
