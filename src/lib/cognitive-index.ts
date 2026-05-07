import fs from 'fs/promises';
import path from 'path';
import fg from 'fast-glob';
import { Logger } from './logger.js';
import { AstParser, isAstParseable, type ExtractedUnit } from './ast-parser.js';
import { resolveFromInstallRoot } from './install-root.js';
import type {
  ProjectSkeleton, TechStackInfo, ArchitecturePattern, DirectoryNode,
  ModuleContract, ExportContract, ImportContract, TypeContract,
  UnitFingerprint, CognitiveIndex, CognitiveIndexStats,
} from '../types/index.js';

const SKIP_DIRS = new Set(['node_modules','.git','dist','coverage','__pycache__','.next','build','target','vendor','.cache']);
const ENTRY_POINTS = ['index.ts','index.js','main.ts','main.js','app.ts','app.js','server.ts','server.js','main.py','app.py','main.go','main.rs'];
const CONFIG_FILES = ['package.json','tsconfig.json','.eslintrc','pyproject.toml','requirements.txt','go.mod','Cargo.toml','docker-compose.yml','Dockerfile','vitest.config.ts','jest.config.js','vite.config.ts','next.config.js'];

const TECH_SIGS: Array<{p:RegExp;name:string;cat:TechStackInfo['category']}> = [
  {p:/"react"/i,name:'React',cat:'framework'},{p:/"vue"/i,name:'Vue',cat:'framework'},
  {p:/"angular"/i,name:'Angular',cat:'framework'},{p:/"next"/i,name:'Next.js',cat:'framework'},
  {p:/"express"/i,name:'Express',cat:'framework'},{p:/"fastify"/i,name:'Fastify',cat:'framework'},
  {p:/"nestjs"/i,name:'NestJS',cat:'framework'},{p:/"svelte"/i,name:'Svelte',cat:'framework'},
  {p:/"prisma"/i,name:'Prisma',cat:'tool'},{p:/"typeorm"/i,name:'TypeORM',cat:'tool'},
  {p:/"mongoose"/i,name:'Mongoose',cat:'tool'},{p:/"sequelize"/i,name:'Sequelize',cat:'tool'},
  {p:/"jest"/i,name:'Jest',cat:'tool'},{p:/"vitest"/i,name:'Vitest',cat:'tool'},
  {p:/"tailwindcss"/i,name:'TailwindCSS',cat:'tool'},{p:/"zod"/i,name:'Zod',cat:'library'},
  {p:/"axios"/i,name:'Axios',cat:'library'},{p:/"pino"/i,name:'Pino',cat:'library'},
  {p:/"ioredis"/i,name:'ioredis',cat:'library'},{p:/@modelcontextprotocol/i,name:'MCP SDK',cat:'library'},
  {p:/django/i,name:'Django',cat:'framework'},{p:/flask/i,name:'Flask',cat:'framework'},
  {p:/fastapi/i,name:'FastAPI',cat:'framework'},{p:/pydantic/i,name:'Pydantic',cat:'library'},
  {p:/sqlalchemy/i,name:'SQLAlchemy',cat:'tool'},{p:/pytest/i,name:'pytest',cat:'tool'},
  {p:/numpy/i,name:'NumPy',cat:'library'},{p:/pandas/i,name:'Pandas',cat:'library'},
  {p:/torch/i,name:'PyTorch',cat:'library'},{p:/tensorflow/i,name:'TensorFlow',cat:'library'},
];

const ARCH_SIGS: Array<{re:RegExp;name:string;ev:string[];minEvidence?:number}> = [
  {re:/src\/(controllers?|routes?)\//i,name:'MVC',ev:['controllers/','routes/']},
  {re:/src\/(models?|views?|controllers?)\//i,name:'MVC',ev:['models/','views/','controllers/'],minEvidence:2},
  {re:/src\/(entities?|use-?cases?|adapters?)\//i,name:'Clean Architecture',ev:['entities/','use-cases/','adapters/'],minEvidence:2},
  {re:/src\/(domain|application|infrastructure|presentation)\//i,name:'DDD',ev:['domain/','application/','infrastructure/'],minEvidence:2},
  {re:/src\/pages\//i,name:'Next.js Pages',ev:['pages/','api/','components/'],minEvidence:2},
  {re:/src\/app\//i,name:'Next.js App Router',ev:['app/','components/'],minEvidence:1},
  {re:/(cmd|internal|pkg)\//i,name:'Go Standard',ev:['cmd/','internal/','pkg/']},
  {re:/(packages|libs)\//i,name:'Monorepo',ev:['packages/','libs/']},
  {re:/(microservices?|services?\/[\w-]+\/src)\//i,name:'Microservices',ev:['services/']},
  {re:/src\/(handlers?|server)\.ts/i,name:'MCP Server',ev:['server.ts','handlers/','registry.ts']},
];

const LANG_EXT: Record<string,string> = {
  '.ts':'typescript','.tsx':'tsx','.js':'javascript','.jsx':'jsx','.py':'python',
  '.go':'go','.rs':'rust','.java':'java','.cs':'csharp','.rb':'ruby','.php':'php',
  '.swift':'swift','.kt':'kotlin','.scala':'scala','.c':'c','.cpp':'cpp',
  '.html':'html','.css':'css','.scss':'scss','.sql':'sql','.json':'json',
  '.yaml':'yaml','.yml':'yaml','.md':'markdown','.sh':'bash',
};

export class CognitiveIndexEngine {
  private logger: Logger;
  private index: CognitiveIndex | null = null;
  private indexPath: string;
  private dirty = false;
  private savePromise: Promise<void> | null = null;
  // Phase E2: real AST parser for TS/JS.
  // Regex path kept as fallback for languages ts-morph doesn't handle.
  private astParser: AstParser;

  constructor(config: { logger: Logger; indexPath?: string }) {
    this.logger = config.logger;
    // R-1: default indexPath was relative
    // ('.jcf-cognitive-index.json'), which `fs.writeFile` resolves
    // against `process.cwd()` at write-time. When MCP spawned from a
    // foreign cwd, the index landed in the wrong directory and was
    // observed populated with `.integ-*` test fixture data (the
    // `Step Flash` symptom that triggered the audit). Anchor to
    // install-root so the file always lands in a stable location.
    const fallback = resolveFromInstallRoot('.jcf-cognitive-index.json');
    if (config.indexPath && config.indexPath.length > 0) {
      this.indexPath = path.isAbsolute(config.indexPath)
        ? config.indexPath
        : resolveFromInstallRoot(config.indexPath);
    } else {
      this.indexPath = fallback;
    }
    this.astParser = new AstParser({ logger: config.logger });
  }

  async initialize(): Promise<void> {
    this.logger.info('Initializing Cognitive Index Engine');
    try {
      const raw = JSON.parse(await fs.readFile(this.indexPath, 'utf-8'));
      this.index = this.deserializeIndex(raw);
      this.logger.info('Cognitive index loaded', { modules: this.index.stats.totalModules, units: this.index.stats.totalUnits });
    } catch { this.index = null; }
  }

  getIndex(): CognitiveIndex | null { return this.index; }

  private async saveIndex(): Promise<void> {
    /* v8 ignore start */
    if (!this.dirty || !this.index) return;
    if (this.savePromise) { this.dirty = true; return; }
    /* v8 ignore stop */
    this.dirty = false;
    this.savePromise = this._doSave().finally(() => { this.savePromise = null; });
    await this.savePromise;
    /* v8 ignore next 1 */
    if (this.dirty) await this.saveIndex();
  }

  private async _doSave(): Promise<void> {
    /* v8 ignore next 1 */
    if (!this.index) return;
    const tmp = this.indexPath + '.tmp';
    // M11-AUDIT FIX (MED-13): write → fsync → rename for crash atomicity.
    // Previously `writeFile` + `rename` could leave a half-written `.tmp`
    // file on power loss; the rename target would then point at corrupt
    // JSON. `fh.sync()` flushes the OS page cache to disk, and only then
    // do we publish via rename. Best-effort: failure is logged but the
    // save still completes (data integrity on next clean shutdown).
    //
    // ENOENT-tolerance: a debounced save can race with sandbox teardown
    // (tests) or user-initiated cleanup. Treating ENOENT on the temp open
    // as a benign skip prevents unhandled rejections in those cases.
    let fh;
    try {
      fh = await fs.open(tmp, 'w');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') {
        this.logger.debug('Cognitive-index save skipped — directory removed', {
          path: this.indexPath,
        });
        return;
      }
      throw err;
    }
    try {
      await fh.writeFile(JSON.stringify(this.serializeIndex(this.index), null, 2), 'utf-8');
      try {
        await fh.sync();
      } catch (err) {
        // Some filesystems (e.g. FAT, certain NFS mounts) don't support
        // fsync — fall through. The rename below is still atomic on POSIX.
        this.logger.debug('fsync skipped on cognitive-index tmp', { error: String(err) });
      }
    } finally {
      await fh.close();
    }
    try {
      await fs.rename(tmp, this.indexPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') {
        // Same race window — clean up the orphan tmp file if possible.
        await fs.unlink(tmp).catch(() => {});
        this.logger.debug('Cognitive-index rename skipped — directory removed', {
          path: this.indexPath,
        });
        return;
      }
      throw err;
    }
  }

  // ── LAYER 0: PROJECT SKELETON ──

  async buildSkeleton(rootPath: string): Promise<ProjectSkeleton> {
    const directoryTree = await this.buildDirTree(rootPath);
    const allFiles = await this.collectFiles(rootPath);
    const languages = this.langDistribution(allFiles);
    const techStack = await this.detectTechStack(rootPath, allFiles);
    const archPatterns = this.detectArchPatterns(directoryTree, techStack);
    const entryPoints = allFiles.filter(f => ENTRY_POINTS.includes(path.basename(f)));
    const configFiles = allFiles.filter(f => CONFIG_FILES.includes(path.basename(f)));
    let totalLines = 0;
    const sampleN = Math.min(allFiles.length, 200);
    for (let i = 0; i < sampleN; i++) {
      /* v8 ignore next 1 */
      try { totalLines += (await fs.readFile(allFiles[i], 'utf-8')).split('\n').length; } catch { /* skip */ }
    }
    /* v8 ignore next 1 */
    if (allFiles.length > sampleN) totalLines = Math.round(totalLines * (allFiles.length / sampleN));
    const dirCount = (await fg('**/*/', { cwd: rootPath, onlyDirectories: true, ignore: [...SKIP_DIRS] })).length;
    return { name: path.basename(rootPath), rootPath, techStack, architecturePattern: archPatterns, directoryTree, totalFiles: allFiles.length, totalDirectories: dirCount, totalLinesOfCode: totalLines, languages, entryPoints, configFiles, generatedAt: Date.now() };
  }

  private async buildDirTree(rootPath: string, depth = 0): Promise<DirectoryNode> {
    const name = path.basename(rootPath);
    const node: DirectoryNode = { name, path: rootPath, type: 'directory' };
    /* v8 ignore next 1 */
    if (depth > 4) { node.fileCount = (await fg('*', { cwd: rootPath, onlyFiles: true, ignore: [...SKIP_DIRS] })).length; return node; }
    try {
      const entries = await fs.readdir(rootPath, { withFileTypes: true });
      const children: DirectoryNode[] = [];
      for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        const full = path.join(rootPath, entry.name);
        if (entry.isDirectory()) { children.push(await this.buildDirTree(full, depth + 1)); }
        else { 
          const ext = path.extname(entry.name).toLowerCase();
          children.push({ name: entry.name, path: full, type: 'file', language: LANG_EXT[ext] }); 
        }
      }
      node.children = children;
    /* v8 ignore next 1 */
    } catch { node.children = []; }
    return node;
  }

  private async collectFiles(rootPath: string): Promise<string[]> {
    return fg('**/*', { cwd: rootPath, onlyFiles: true, ignore: [...SKIP_DIRS, '*.min.js','*.min.css','*.map'], absolute: true }) as Promise<string[]>;
  }

  private langDistribution(files: string[]): Record<string, number> {
    const c: Record<string, number> = {};
    for (const f of files) { const lang = LANG_EXT[path.extname(f).toLowerCase()]; if (lang) c[lang] = (c[lang]||0)+1; }
    return c;
  }

  private async detectTechStack(rootPath: string, allFiles: string[]): Promise<TechStackInfo[]> {
    const stack = new Map<string, TechStackInfo>();
    // package.json
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(rootPath, 'package.json'), 'utf-8'));
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
      for (const [depName, depVer] of Object.entries(allDeps)) {
        const ver = String(depVer).replace(/[\^~>=<]/g, '');
        for (const sig of TECH_SIGS) {
          if (depName.toLowerCase().includes(sig.name.toLowerCase()) || sig.p.test(depName)) {
            const entry: TechStackInfo = { name: sig.name, category: sig.cat, confidence: 0.95, evidence: [`package.json: ${depName}`] };
            if (ver) entry.version = ver;
            stack.set(sig.name, entry);
          }
        }
      }
    } catch { /* no pkg json */ }
    // requirements.txt
    try {
      for (const line of (await fs.readFile(path.join(rootPath, 'requirements.txt'), 'utf-8')).split('\n')) {
        const t = line.trim().split('#')[0]?.trim(); if (!t) continue;
        const [n,_v] = t.split('==');
        for (const sig of TECH_SIGS) {
          if (sig.name.toLowerCase()===n?.toLowerCase()) {
            const reqEntry: TechStackInfo = { name: sig.name, category: sig.cat, confidence: 0.9, evidence: [`requirements.txt: ${t}`] };
            if (_v) reqEntry.version = _v;
            stack.set(sig.name, reqEntry);
          }
        }
      }
    } catch { /* no req txt */ }
    // go.mod / Cargo.toml
    for (const f of ['go.mod','Cargo.toml']) {
      try {
        const c = await fs.readFile(path.join(rootPath, f), 'utf-8');
        for (const sig of TECH_SIGS) { if (sig.p.test(c)) stack.set(sig.name,{name:sig.name,category:sig.cat,confidence:0.9,evidence:[f]}); }
      } catch { /* skip */ }
    }
    // languages
    const langs = this.langDistribution(allFiles);
    const langCat: Record<string,string> = {typescript:'TypeScript',javascript:'JavaScript',python:'Python',go:'Go',rust:'Rust',java:'Java',csharp:'C#'};
    for (const [l,cnt] of Object.entries(langs)) {
      if (cnt>0) stack.set(`lang:${l}`,{name:langCat[l]||l,category:'language',confidence:1.0,evidence:[`${cnt} files`]});
    }
    return [...stack.values()].sort((a,b)=>b.confidence-a.confidence);
  }

  private detectArchPatterns(tree: DirectoryNode, techStack: TechStackInfo[] = []): ArchitecturePattern[] {
    const allPaths = this.flattenPaths(tree).map(p => p.replace(/\\/g, '/'));
    const patterns: ArchitecturePattern[] = [];
    const hasMcpSdk = techStack.some(t => t.name === 'MCP SDK');
    for (const arch of ARCH_SIGS) {
      const mc = allPaths.filter(p=>arch.re.test(p)).length;
      if (mc === 0) continue;
      const matchedEvidence = arch.ev.filter(e=>allPaths.some(p=>p.includes(e)));
      const minEv = arch.minEvidence ?? 1;
      if (matchedEvidence.length < minEv) continue;
      if (hasMcpSdk && (arch.name.startsWith('Next.js'))) continue;
      patterns.push({name:arch.name,confidence:Math.min(0.95,0.5+mc*0.05+matchedEvidence.length*0.1),evidence:matchedEvidence});
    }
    return patterns.sort((a,b)=>b.confidence-a.confidence);
  }

  private flattenPaths(n: DirectoryNode): string[] {
    const r: string[] = [n.path];
    if (n.children) for (const c of n.children) r.push(...this.flattenPaths(c));
    return r;
  }

  // ── LAYER 1: MODULE CONTRACTS ──

  async extractModuleContracts(files: string[]): Promise<ModuleContract[]> {
    const contracts: ModuleContract[] = [];
    for (let i = 0; i < files.length; i += 50) {
      const batch = files.slice(i, i + 50);
      const results = await Promise.allSettled(batch.map(f => this.extractSingleContract(f)));
      for (const r of results) { if (r.status === 'fulfilled' && r.value) contracts.push(r.value); }
    }
    return contracts;
  }

  private async extractSingleContract(filePath: string): Promise<ModuleContract | null> {
    const ext = path.extname(filePath).toLowerCase();
    if (!['.ts','.tsx','.js','.jsx','.py','.java','.go','.rs','.cs'].includes(ext)) return null;
    let content: string;
    try { content = await fs.readFile(filePath, 'utf-8'); } catch { return null; }
    /* v8 ignore next 1 */
    if (content.length > 500000) return null;

    // Phase E2: Use ts-morph AST for TS/JS — far more accurate than regex.
    if (isAstParseable(filePath)) {
      const astContract = this.contractFromAst(filePath, content);
      if (astContract) return astContract;
      // If AST parsing fails, fall through to regex path
    }

    const moduleName = path.basename(filePath, ext);
    return {
      filePath, moduleName,
      exports: this.extractExports(content, ext),
      imports: this.extractImports(content, ext),
      definedTypes: this.extractTypes(content, ext),
      sideEffects: this.detectSideEffects(content, ext),
      patternClassification: this.classifyModulePattern(content, moduleName),
    };
  }

  // ── Phase E2: AST-based extraction for TS/JS ──

  /** Convert ts-morph ExtractedModule → ModuleContract (for TS/JS only) */
  private contractFromAst(filePath: string, content: string): ModuleContract | null {
    try {
      const mod = this.astParser.parseFile(filePath, content);
      if (mod.errorMessage) {
        this.logger.debug('AST parse had error, using regex fallback', { filePath, error: mod.errorMessage });
        return null;
      }

      const exports: ExportContract[] = mod.exports.map(e => ({
        name: e.name,
        kind: e.kind === 'variable' ? 'constant' : (e.kind as ExportContract['kind']),
        signature: e.signature,
        inputTypes: [],
        outputType: 'inferred',
        isAsync: e.signature.startsWith('async '),
        isExported: true,
        isDefault: e.isDefault,
        /* v8 ignore next 1 */
        modifiers: e.signature.startsWith('async ') ? ['async'] : [],
      }));

      const imports: ImportContract[] = mod.imports.map(i => ({
        name: i.name,
        from: i.from,
        isType: i.isType,
        isDefault: i.isDefault,
        isNamespace: i.isNamespace,
      }));

      const definedTypes: TypeContract[] = mod.definedTypes.map(t => ({
        name: t.name,
        kind: t.kind,
        extendsTypes: t.extendsTypes,
        properties: [],
        methods: [],
        genericParams: [],
      }));

      return {
        filePath,
        moduleName: mod.moduleName,
        exports,
        imports,
        definedTypes,
        sideEffects: this.detectSideEffects(content, path.extname(filePath).toLowerCase()),
        patternClassification: this.classifyModulePattern(content, mod.moduleName),
      };
    } catch (err) {
      this.logger.warn('AST contract extraction threw', { filePath, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  /** Convert ts-morph ExtractedUnit[] → UnitFingerprint[] (for TS/JS only) */
  private unitsFromAst(filePath: string, content: string): UnitFingerprint[] | null {
    try {
      const mod = this.astParser.parseFile(filePath, content);
      if (mod.errorMessage) return null;
      return mod.units.map(u => this.astUnitToFingerprint(filePath, u));
    } catch (err) {
      this.logger.warn('AST unit extraction threw', { filePath, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  private astUnitToFingerprint(filePath: string, u: ExtractedUnit): UnitFingerprint {
    const linesOfCode = Math.max(1, u.endLine - u.startLine + 1);
    const isPure = u.sideEffects.length === 0 && !u.isAsync && (u.kind === 'function' || u.kind === 'method');
    const kindMapped: UnitFingerprint['kind'] = (
      u.kind === 'method' ? 'method' :
      /* v8 ignore next 1 */
      u.kind === 'variable' ? 'function' :
      u.kind
    ) as UnitFingerprint['kind'];
    return {
      id: `${filePath}::${u.name}`,
      filePath,
      name: u.name,
      kind: kindMapped,
      signature: u.signature,
      inputSignature: u.inputSignature,
      outputSignature: u.outputSignature,
      isPure,
      isAsync: u.isAsync,
      complexity: u.complexity,
      linesOfCode,
      callTargets: u.callTargets,
      typeDependencies: u.typeDependencies,
      sideEffects: u.sideEffects,
      patternType: this.classifyUnitPattern(u.name, u.sideEffects, u.isAsync),
      semanticTags: this.generateSemanticTags(u.name, u.sideEffects, u.callTargets),
    };
  }

  private extractImports(content: string, ext: string): ImportContract[] {
    const imports: ImportContract[] = [];
    if (['.ts','.tsx','.js','.jsx'].includes(ext)) {
      // Named imports
      const named = /import\s+(?:type\s+)?{([^}]+)}\s+from\s+['"]([^'"]+)['"]/g;
      let m: RegExpExecArray | null;
      while ((m = named.exec(content)) !== null) {
        for (const part of m[1].split(',')) {
          const segments = part.trim().split(/\s+as\s+/);
          const name = (segments[1] || segments[0]).trim();
          if (name) imports.push({ name, from: m[2], isType: m[0].includes('import type'), isDefault: false, isNamespace: false });
        }
      }
      // Default imports
      const def = /import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g;
      while ((m = def.exec(content)) !== null) {
        if (!m[0].includes('{') && m[1] !== 'type') imports.push({ name: m[1], from: m[2], isType: false, isDefault: true, isNamespace: false });
      }
      // Namespace imports
      const ns = /import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g;
      while ((m = ns.exec(content)) !== null) imports.push({ name: m[1], from: m[2], isType: false, isDefault: false, isNamespace: true });
    /* v8 ignore next 1 */
    } else if (ext === '.py') {
      /* v8 ignore next 7 */
      const py = /(?:from\s+([.\w]+)\s+import\s+(?:\(([^)]+)\)|([^\n]+))|import\s+([.\w]+))/g;
      let m: RegExpExecArray | null;
      while ((m = py.exec(content)) !== null) {
        const from = m[1] || m[4];
        const names = m[2]?.split(',').map(n=>n.trim()) || (m[3] ? m[3].split(',').map(n=>n.trim()) : [from]);
        for (const n of names) { const cn = n.split(/\s+as\s+/).pop()?.trim(); if (cn) imports.push({name:cn,from:from||'',isType:false,isDefault:false,isNamespace:false}); }
      }
    } else if (ext === '.java') {
      const jimp = /import\s+(?:static\s+)?([^;]+);/g;
      let m: RegExpExecArray | null;
      /* v8 ignore next 1 */
      while ((m = jimp.exec(content)) !== null) { const parts = m[1].trim().split('.'); imports.push({name:parts[parts.length-1]||m[1].trim(),from:m[1].trim(),isType:false,isDefault:false,isNamespace:false}); }
    } else if (ext === '.go') {
      const gimp = /import\s+(?:\(([^)]+)\)|"([^"]+)")/g;
      let m: RegExpExecArray | null;
      while ((m = gimp.exec(content)) !== null) {
        /* v8 ignore next 1 */
        const block = m[1] || m[2]; if (!block) continue;
        /* v8 ignore next 1 */
        for (const line of block.split('\n')) { const t = line.trim().replace(/"/g,''); if (t && !t.startsWith('//')) { const p = t.split('/'); imports.push({name:p[p.length-1]||t,from:t,isType:false,isDefault:false,isNamespace:false}); } }
      }
    }
    return imports;
  }

  private extractExports(content: string, ext: string): ExportContract[] {
    const exports: ExportContract[] = [];
    if (['.ts','.tsx','.js','.jsx'].includes(ext)) {
      // Export functions
      const ef = /export\s+(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/g;
      let m: RegExpExecArray | null;
      while ((m = ef.exec(content)) !== null) {
        exports.push({ name: m[1], kind: 'function', signature: m[0].replace(/export\s+/, '').trim(), inputTypes: this.parseParamTypes(m[2]), outputType: this.inferReturnType(content, m[1]), isAsync: m[0].includes('async'), isExported: true, isDefault: false, modifiers: m[0].includes('async') ? ['async'] : [] });
      }
      // Export classes
      const ec = /export\s+(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/g;
      while ((m = ec.exec(content)) !== null) exports.push({ name: m[1], kind: 'class', signature: `class ${m[1]}`, inputTypes: [], outputType: m[1], isAsync: false, isExported: true, isDefault: m[0].includes('default'), modifiers: m[0].includes('abstract') ? ['abstract'] : [] });
      // Export interfaces
      const ei = /export\s+interface\s+(\w+)\s*(?:<[^>]*>)?\s*(?:extends\s+[\w,\s]+)?\s*\{/g;
      while ((m = ei.exec(content)) !== null) exports.push({ name: m[1], kind: 'interface', signature: `interface ${m[1]}`, inputTypes: [], outputType: m[1], isAsync: false, isExported: true, isDefault: false, modifiers: [] });
      // Export types
      const et = /export\s+type\s+(\w+)\s*(?:<[^>]*>)?\s*=/g;
      while ((m = et.exec(content)) !== null) exports.push({ name: m[1], kind: 'type', signature: `type ${m[1]}`, inputTypes: [], outputType: m[1], isAsync: false, isExported: true, isDefault: false, modifiers: [] });
      // Export enums
      const ee = /export\s+(?:const\s+)?enum\s+(\w+)/g;
      while ((m = ee.exec(content)) !== null) exports.push({ name: m[1], kind: 'enum', signature: `enum ${m[1]}`, inputTypes: [], outputType: m[1], isAsync: false, isExported: true, isDefault: false, modifiers: m[0].includes('const') ? ['const'] : [] });
      // Export const/let/var
      const ev = /export\s+(?:default\s+)?(?:const|let|var)\s+(\w+)/g;
      while ((m = ev.exec(content)) !== null) {
        if (!exports.some(e=>e.name===m![1])) exports.push({ name: m[1], kind: 'constant', signature: `const ${m[1]}`, inputTypes: [], outputType: 'unknown', isAsync: false, isExported: true, isDefault: m[0].includes('default'), modifiers: [] });
      }
    /* v8 ignore next 1 */
    } else if (ext === '.py') {
      /* v8 ignore next 5 */
      const pdef = /(?:def|class)\s+(\w+)/g;
      let m: RegExpExecArray | null;
      while ((m = pdef.exec(content)) !== null) {
        if (!m[1].startsWith('_')) exports.push({ name: m[1], kind: m[0].startsWith('class') ? 'class' : 'function', signature: m[0], inputTypes: [], outputType: 'unknown', isAsync: m[0].includes('async'), isExported: true, isDefault: false, modifiers: [] });
      }
    } else if (ext === '.java') {
      const jclass = /(?:public|protected)\s+(?:abstract\s+)?(?:class|interface|enum)\s+(\w+)/g;
      let m: RegExpExecArray | null;
      while ((m = jclass.exec(content)) !== null) exports.push({ name: m[1], kind: m[0].includes('interface') ? 'interface' : m[0].includes('enum') ? 'enum' : 'class', signature: m[0].trim(), inputTypes: [], outputType: m[1], isAsync: false, isExported: true, isDefault: false, modifiers: m[0].includes('abstract') ? ['abstract'] : [] });
    }
    return exports;
  }

  private extractTypes(content: string, ext: string): TypeContract[] {
    const types: TypeContract[] = [];
    if (['.ts','.tsx'].includes(ext)) {
      // Interfaces
      const ire = /(?:export\s+)?interface\s+(\w+)\s*(?:<([^>]+)>)?\s*(?:extends\s+([^{]+))?\s*\{([^}]*)\}/g;
      let m: RegExpExecArray | null;
      while ((m = ire.exec(content)) !== null) {
        const props = this.parseObjectBody(m[4]);
        types.push({ name: m[1], kind: 'interface', properties: props.props, methods: props.methods, extendsTypes: m[3]?.split(',').map(s=>s.trim())||[], genericParams: m[2]?.split(',').map(s=>s.trim())||[] });
      }
      // Type aliases
      const tre = /(?:export\s+)?type\s+(\w+)\s*(?:<([^>]+)>)?\s*=\s*([^;]+)/g;
      while ((m = tre.exec(content)) !== null) {
        types.push({ name: m[1], kind: 'type', properties: [], methods: [], extendsTypes: [], genericParams: m[2]?.split(',').map(s=>s.trim())||[] });
      }
      // Enums
      const ere = /(?:export\s+)?(?:const\s+)?enum\s+(\w+)\s*\{([^}]*)\}/g;
      while ((m = ere.exec(content)) !== null) {
        const members = m[2].split(',').map(s => s.trim().split('=')[0]?.trim()).filter(Boolean);
        types.push({ name: m[1], kind: 'enum', properties: members.map(n=>({name:n,type:'enum-member',optional:false})), methods: [], extendsTypes: [], genericParams: [] });
      }
    }
    return types;
  }

  private parseObjectBody(body: string): { props: Array<{name:string;type:string;optional:boolean}>; methods: Array<{name:string;signature:string}> } {
    const props: Array<{name:string;type:string;optional:boolean}> = [];
    const methods: Array<{name:string;signature:string}> = [];
    for (const line of body.split('\n')) {
      const t = line.trim().replace(/[,;]$/, '');
      if (!t || t.startsWith('//') || t.startsWith('/*')) continue;
      // Method pattern: name(params): ReturnType
      const methodMatch = t.match(/^(\w+)\s*\(([^)]*)\)\s*(?::\s*(.+?))?$/);
      if (methodMatch) { methods.push({ name: methodMatch[1], signature: t }); continue; }
      // Property pattern: name?: Type
      const propMatch = t.match(/^(\w+)(\??)\s*:\s*(.+)$/);
      if (propMatch) { props.push({ name: propMatch[1], type: propMatch[3].trim(), optional: propMatch[2] === '?' }); continue; }
      // Readonly property
      const roMatch = t.match(/^readonly\s+(\w+)(\??)\s*:\s*(.+)$/);
      if (roMatch) { props.push({ name: roMatch[1], type: roMatch[3].trim(), optional: roMatch[2] === '?' }); }
    }
    return { props, methods };
  }

  private parseParamTypes(params: string): string[] {
    if (!params.trim()) return [];
    return params.split(',').map(p => {
      const parts = p.split(':');
      /* v8 ignore next 1 */
      return parts.length > 1 ? parts[1]?.trim() || 'unknown' : 'unknown';
    });
  }

  private inferReturnType(content: string, fnName: string): string {
    const re = new RegExp(`function\\s+${fnName}\\s*[^)]*\\)\\s*(?::\\s*(\\w+))?`, 's');
    const m = re.exec(content);
    return m?.[1] || 'unknown';
  }

  private detectSideEffects(content: string, ext: string): string[] {
    const effects: string[] = [];
    if (['.ts','.tsx','.js','.jsx'].includes(ext)) {
      if (/console\.(log|warn|error|info)/.test(content)) effects.push('console-output');
      if (/process\.exit/.test(content)) effects.push('process-exit');
      if (/fs\.(write|unlink|mkdir|rmdir|rename|append)/.test(content)) effects.push('filesystem-write');
      if (/fetch\(|axios\.|http\.request/.test(content)) effects.push('network-request');
      if (/addEventListener|\.on\(/.test(content)) effects.push('event-listener');
      if (/setInterval|setTimeout/.test(content)) effects.push('timer');
      if (/new\s+Date\(\)/.test(content)) effects.push('datetime-dependency');
      if (/Math\.random|crypto\.random/.test(content)) effects.push('non-deterministic');
    }
    return effects;
  }

  private classifyModulePattern(content: string, moduleName: string): string[] {
    const patterns: string[] = [];
    const lower = content.toLowerCase();
    const ml = moduleName.toLowerCase();
    if (/export\s+default\s+(?:function|class)/.test(content)) patterns.push('default-export');
    if ((lower.match(/export\s+(?:function|const|class)/g) || []).length > 5) patterns.push('barrel-module');
    if (/router\.(get|post|put|delete|patch)/.test(content)) patterns.push('route-handler');
    if (/middleware/.test(lower) || /next\(\)/.test(content)) patterns.push('middleware');
    if (/\.on\(|\.emit\(|addEventListener/.test(content)) patterns.push('event-handler');
    if (/(create|read|update|delete|find|get|list)(?:ById|One|Many|All)?/i.test(content)) patterns.push('data-access');
    if (/export\s+(?:interface|type)\s+\w+/.test(content) && !/export\s+(?:function|class)/.test(content)) patterns.push('type-definition');
    if (/describe\(|it\(|test\(/.test(content)) patterns.push('test-module');
    if (/export\s+\{[^}]+\}/.test(content)) patterns.push('re-export');
    if (ml.includes('config') || ml.includes('env') || ml.includes('constant')) patterns.push('configuration');
    if (ml.includes('util') || ml.includes('helper') || ml.includes('common')) patterns.push('utility');
    if (ml.includes('service')) patterns.push('service');
    if (ml.includes('controller')) patterns.push('controller');
    if (ml.includes('model') || ml.includes('entity') || ml.includes('schema')) patterns.push('data-model');
    if (ml.includes('middleware')) patterns.push('middleware');
    return patterns;
  }

  // ── LAYER 2: UNIT FINGERPRINTS ──

  async extractUnitFingerprints(files: string[]): Promise<UnitFingerprint[]> {
    const units: UnitFingerprint[] = [];
    for (let i = 0; i < files.length; i += 50) {
      const batch = files.slice(i, i + 50);
      const results = await Promise.allSettled(batch.map(f => this.extractFileUnits(f)));
      for (const r of results) { if (r.status === 'fulfilled' && r.value) units.push(...r.value); }
    }
    return units;
  }

  private async extractFileUnits(filePath: string): Promise<UnitFingerprint[]> {
    const ext = path.extname(filePath).toLowerCase();
    if (!['.ts','.tsx','.js','.jsx','.py','.java'].includes(ext)) return [];
    let content: string;
    /* v8 ignore next 1 */
    try { content = await fs.readFile(filePath, 'utf-8'); } catch { return []; }
    /* v8 ignore next 1 */
    if (content.length > 500000) return [];

    // Phase E2: AST fast-path for TS/JS
    if (isAstParseable(filePath)) {
      const astUnits = this.unitsFromAst(filePath, content);
      if (astUnits !== null) return astUnits;
      // If AST path returned null (parse error), fall through to regex
    }

    const units: UnitFingerprint[] = [];

    if (['.ts','.tsx','.js','.jsx'].includes(ext)) {
      // Functions
      const fRe = /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)(?:\s*:\s*([^={]+?))?\s*[\{;]/g;
      let m: RegExpExecArray | null;
      while ((m = fRe.exec(content)) !== null) {
        const name = m[1];
        const isAsync = m[0].includes('async');
        const body = this.extractFunctionBody(content, m.index);
        const loc = body.split('\n').length;
        const complexity = this.countComplexity(body);
        const calls = this.extractCallTargets(body);
        const typeDeps = this.extractTypeRefs(body);
        const sideEffects = this.detectSideEffects(body, ext);
        const isPure = sideEffects.length === 0 && !isAsync;
        units.push({
          id: `${filePath}::${name}`, filePath, name, kind: 'function',
          signature: m[0].replace(/export\s+/,'').trim(),
          inputSignature: m[2].trim(), outputSignature: (m[3]||'void').trim(),
          isPure, isAsync, complexity, linesOfCode: loc,
          callTargets: calls, typeDependencies: typeDeps, sideEffects,
          patternType: this.classifyUnitPattern(name, sideEffects, isAsync),
          semanticTags: this.generateSemanticTags(name, sideEffects, calls),
        });
      }
      // Classes
      const cRe = /(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)\s*(?:<[^>]*>)?\s*(?:extends\s+(\w+))?\s*(?:implements\s+([^{]+))?\s*\{/g;
      while ((m = cRe.exec(content)) !== null) {
        const name = m[1];
        const body = this.extractClassBody(content, m.index);
        const loc = body.split('\n').length;
        const complexity = this.countComplexity(body);
        /* v8 ignore next 1 */
        const typeDeps = [m[2], ...(m[3]?.split(',').map(s=>s.trim())||[])].filter(Boolean) as string[];
        units.push({
          id: `${filePath}::${name}`, filePath, name, kind: 'class',
          /* v8 ignore next 1 */
          signature: `class ${name}${m[2]?` extends ${m[2]}`:''}`,
          inputSignature: '', outputSignature: name,
          isPure: false, isAsync: false, complexity, linesOfCode: loc,
          callTargets: this.extractCallTargets(body), typeDependencies: typeDeps,
          sideEffects: this.detectSideEffects(body, ext),
          patternType: this.classifyUnitPattern(name, this.detectSideEffects(body, ext), false),
          semanticTags: this.generateSemanticTags(name, this.detectSideEffects(body, ext), this.extractCallTargets(body)),
        });
      }
      // Arrow functions assigned to const
      const aRe = /(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*(?::\s*([^=]+?))?\s*=>/g;
      while ((m = aRe.exec(content)) !== null) {
        const name = m[1];
        const isAsync = m[0].includes('async');
        units.push({
          id: `${filePath}::${name}`, filePath, name, kind: 'function',
          signature: `const ${name} = ${isAsync?'async ':''}(${m[2]}) => ...`,
          inputSignature: m[2].trim(), outputSignature: (m[3]||'unknown').trim(),
          isPure: !isAsync, isAsync, complexity: 1, linesOfCode: 1,
          callTargets: [], typeDependencies: [], sideEffects: [],
          patternType: 'utility', semanticTags: this.generateSemanticTags(name, [], []),
        });
      }
    } else if (ext === '.py') {
      /* v8 ignore next 16 */
      const pRe = /(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/g;
      let m: RegExpExecArray | null;
      while ((m = pRe.exec(content)) !== null) {
        const name = m[1];
        if (name.startsWith('__') && name.endsWith('__')) continue;
        const isAsync = m[0].includes('async ');
        units.push({
          id: `${filePath}::${name}`, filePath, name, kind: m[0].startsWith('class') ? 'class' : 'function',
          signature: `def ${name}(${m[2]})`, inputSignature: m[2].trim(), outputSignature: 'unknown',
          isPure: !isAsync, isAsync, complexity: 1, linesOfCode: 1,
          callTargets: [], typeDependencies: [], sideEffects: [],
          patternType: this.classifyUnitPattern(name, [], isAsync),
          semanticTags: this.generateSemanticTags(name, [], []),
        });
      }
    }
    return units;
  }

  private extractFunctionBody(content: string, startIndex: number): string {
    let depth = 0; let started = false; let end = startIndex;
    for (let i = startIndex; i < content.length; i++) {
      if (content[i] === '{') { depth++; started = true; }
      else if (content[i] === '}') { depth--; if (started && depth === 0) { end = i; break; } }
    }
    return content.slice(startIndex, end + 1);
  }

  private extractClassBody(content: string, startIndex: number): string {
    return this.extractFunctionBody(content, startIndex);
  }

  private countComplexity(body: string): number {
    let c = 1;
    const patterns = /\b(if|else|for|while|switch|case|catch|&&|\|\||\?\.|try)\b/g;
    const matches = body.match(patterns);
    if (matches) c += matches.length;
    return c;
  }

  private extractCallTargets(body: string): string[] {
    const calls = new Set<string>();
    const re = /(?:(\w+)\s*\.\s*)?(\w+)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      const method = m[2];
      if (!['if','for','while','switch','catch','return','throw','new','typeof','instanceof','async','await','const','let','var','function','class','import','export'].includes(method)) {
        calls.add(m[1] ? `${m[1]}.${method}` : method);
      }
    }
    return [...calls].slice(0, 30);
  }

  private extractTypeRefs(body: string): string[] {
    const refs = new Set<string>();
    const re = /:\s*([A-Z]\w+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) refs.add(m[1]);
    const genRe = /<\s*([A-Z]\w+)/g;
    /* v8 ignore next 1 */
    while ((m = genRe.exec(body)) !== null) refs.add(m[1]);
    return [...refs];
  }

  private classifyUnitPattern(name: string, sideEffects: string[], isAsync: boolean): string {
    if (/^(get|find|list|fetch|read|search|query|count|exists|has|is)/i.test(name)) return 'query';
    if (/^(create|add|insert|new|save|write|post)/i.test(name)) return 'command';
    if (/^(update|edit|modify|patch|put|set)/i.test(name)) return 'command';
    if (/^(delete|remove|destroy|erase)/i.test(name)) return 'command';
    if (/^(validate|check|verify|assert|ensure)/i.test(name)) return 'validation';
    if (/^(handle|on|process|execute|run|perform)/i.test(name)) return 'handler';
    if (/^(transform|convert|map|parse|serialize|format|encode|decode)/i.test(name)) return 'transformer';
    if (/^(init|setup|configure|bootstrap|start)/i.test(name)) return 'initializer';
    if (/^(teardown|cleanup|dispose|stop|shutdown)/i.test(name)) return 'finalizer';
    if (sideEffects.includes('network-request')) return 'io-bound';
    if (sideEffects.includes('filesystem-write')) return 'io-bound';
    if (isAsync) return 'async-operation';
    return 'utility';
  }

  private generateSemanticTags(name: string, sideEffects: string[], calls: string[]): string[] {
    const tags: string[] = [];
    if (/^(get|find|list|fetch)/i.test(name)) tags.push('data-retrieval');
    if (/^(create|add|insert)/i.test(name)) tags.push('data-creation');
    if (/^(update|edit|modify)/i.test(name)) tags.push('data-mutation');
    if (/^(delete|remove)/i.test(name)) tags.push('data-deletion');
    if (sideEffects.includes('network-request')) tags.push('network-io');
    if (sideEffects.includes('filesystem-write')) tags.push('disk-io');
    if (sideEffects.includes('console-output')) tags.push('logging');
    if (sideEffects.includes('non-deterministic')) tags.push('non-deterministic');
    if (sideEffects.includes('timer')) tags.push('timer-dependent');
    if (calls.some(c => c.includes('validate') || c.includes('check'))) tags.push('validation-chain');
    if (calls.some(c => c.includes('emit'))) tags.push('event-emitter');
    return tags;
  }

  // ── FULL BUILD & QUERY ──

  async buildFullIndex(rootPath: string, files?: string[]): Promise<CognitiveIndex> {
    const startTime = Date.now();
    this.logger.info('Building full cognitive index', { rootPath });

    const allFiles = files || await this.collectFiles(rootPath);
    const codeFiles = allFiles.filter(f => {
      const ext = path.extname(f).toLowerCase();
      return ['.ts','.tsx','.js','.jsx','.py','.java','.go','.rs','.cs','.rb','.php','.swift','.kt','.scala'].includes(ext);
    });

    const [skeleton, modules, units] = await Promise.all([
      this.buildSkeleton(rootPath),
      this.extractModuleContracts(codeFiles),
      this.extractUnitFingerprints(codeFiles),
    ]);

    const stats = this.computeStats(modules, units);

    this.index = {
      skeleton, modules, units, stats,
      generatedAt: Date.now(),
      lastIncrementalUpdate: Date.now(),
    };

    this.dirty = true;
    await this.saveIndex();

    this.logger.info('Cognitive index built', {
      duration: Date.now() - startTime,
      modules: modules.length,
      units: units.length,
      estimatedTokens: stats.estimatedTokenCost.total,
    });

    return this.index;
  }

  async incrementalUpdate(filePath: string, _content: string): Promise<void> {
    if (!this.index) return;
    const ext = path.extname(filePath).toLowerCase();
    if (!['.ts','.tsx','.js','.jsx','.py','.java','.go','.rs','.cs'].includes(ext)) return;

    // Remove old entries for this file
    this.index.modules = this.index.modules.filter(m => m.filePath !== filePath);
    this.index.units = this.index.units.filter(u => u.filePath !== filePath);

    // Re-extract
    const contract = await this.extractSingleContract(filePath);
    if (contract) this.index.modules.push(contract);

    const newUnits = await this.extractFileUnits(filePath);
    this.index.units.push(...newUnits);

    this.index.stats = this.computeStats(this.index.modules, this.index.units);
    this.index.lastIncrementalUpdate = Date.now();
    this.dirty = true;
    await this.saveIndex();
  }

  getSkeleton(): ProjectSkeleton | null {
    /* v8 ignore next 1 */
    return this.index?.skeleton ?? null;
  }
  getModules(): ModuleContract[] {
    /* v8 ignore next 1 */
    return this.index?.modules ?? [];
  }
  getUnits(): UnitFingerprint[] {
    /* v8 ignore next 1 */
    return this.index?.units ?? [];
  }

  getModulesForFile(filePath: string): ModuleContract | null {
    /* v8 ignore next 1 */
    return this.index?.modules.find(m => m.filePath === filePath) ?? null;
  }

  getUnitsForFile(filePath: string): UnitFingerprint[] {
    /* v8 ignore next 1 */
    return this.index?.units.filter(u => u.filePath === filePath) ?? [];
  }

  queryUnitsByPattern(patternType: string): UnitFingerprint[] {
    /* v8 ignore next 1 */
    return this.index?.units.filter(u => u.patternType === patternType) ?? [];
  }

  queryUnitsByTag(tag: string): UnitFingerprint[] {
    /* v8 ignore next 1 */
    return this.index?.units.filter(u => u.semanticTags.includes(tag)) ?? [];
  }

  queryExportsByName(name: string): Array<{ module: ModuleContract; export: ExportContract }> {
    const results: Array<{ module: ModuleContract; export: ExportContract }> = [];
    /* v8 ignore next 1 */
    for (const mod of this.index?.modules ?? []) {
      for (const exp of mod.exports) {
        if (exp.name === name || exp.name.toLowerCase().includes(name.toLowerCase())) {
          results.push({ module: mod, export: exp });
        }
      }
    }
    return results;
  }

  private computeStats(modules: ModuleContract[], units: UnitFingerprint[]): CognitiveIndexStats {
    const totalExports = modules.reduce((s, m) => s + m.exports.length, 0);
    const totalTypes = modules.reduce((s, m) => s + m.definedTypes.length, 0);
    const avgComplexity = units.length > 0 ? units.reduce((s, u) => s + u.complexity, 0) / units.length : 0;
    const pureCount = units.filter(u => u.isPure).length;
    const asyncCount = units.filter(u => u.isAsync).length;
    const patternDist: Record<string, number> = {};
    for (const u of units) { patternDist[u.patternType] = (patternDist[u.patternType] || 0) + 1; }

    // Token estimation: rough heuristic — 1 token ≈ 4 chars
    /* v8 ignore next 1 */
    const skeletonTokens = Math.round(JSON.stringify(this.index?.skeleton || {}).length / 4);
    const contractTokens = Math.round(JSON.stringify(modules).length / 4);
    const fingerprintTokens = Math.round(JSON.stringify(units).length / 4);

    return {
      totalModules: modules.length,
      totalUnits: units.length,
      totalExports,
      totalTypes,
      avgComplexity: Math.round(avgComplexity * 100) / 100,
      pureFunctionRatio: units.length > 0 ? Math.round((pureCount / units.length) * 1000) / 1000 : 0,
      asyncFunctionRatio: units.length > 0 ? Math.round((asyncCount / units.length) * 1000) / 1000 : 0,
      patternDistribution: patternDist,
      estimatedTokenCost: {
        skeleton: skeletonTokens,
        contracts: contractTokens,
        fingerprints: fingerprintTokens,
        total: skeletonTokens + contractTokens + fingerprintTokens,
      },
    };
  }

  // ── SERIALIZATION ──

  private serializeIndex(idx: CognitiveIndex): any {
    return {
      skeleton: idx.skeleton,
      modules: idx.modules,
      units: idx.units.map(u => ({ ...u })),
      stats: idx.stats,
      generatedAt: idx.generatedAt,
      lastIncrementalUpdate: idx.lastIncrementalUpdate,
    };
  }

  private deserializeIndex(raw: any): CognitiveIndex {
    return {
      skeleton: raw.skeleton,
      modules: raw.modules || [],
      units: raw.units || [],
      stats: raw.stats || { totalModules: 0, totalUnits: 0, totalExports: 0, totalTypes: 0, avgComplexity: 0, pureFunctionRatio: 0, asyncFunctionRatio: 0, patternDistribution: {}, estimatedTokenCost: { skeleton: 0, contracts: 0, fingerprints: 0, total: 0 } },
      generatedAt: raw.generatedAt || Date.now(),
      lastIncrementalUpdate: raw.lastIncrementalUpdate || Date.now(),
    };
  }

  getStats(): CognitiveIndexStats { return this.index?.stats ?? { totalModules: 0, totalUnits: 0, totalExports: 0, totalTypes: 0, avgComplexity: 0, pureFunctionRatio: 0, asyncFunctionRatio: 0, patternDistribution: {}, estimatedTokenCost: { skeleton: 0, contracts: 0, fingerprints: 0, total: 0 } }; }
}
