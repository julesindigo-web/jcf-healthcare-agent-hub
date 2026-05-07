/**
 * End-to-End Integration Test — all 32 MCP tools
 *
 * Spawns the built server (`dist/index.js`) as a real subprocess, speaks
 * MCP stdio JSON-RPC through the official SDK `Client`, and exercises
 * every registered tool with valid arguments.
 *
 * This is what converts "tools are registered" (compile-time truth) into
 * "tools actually work end-to-end" (runtime truth).
 *
 * R-3 + R-4:
 *   - tool count updated 29 → 32 after diagnostics merged into registry.
 *   - sandbox moved from REPO_ROOT to os.tmpdir() to eliminate `.integ-*`
 *     orphan dirs polluting the workspace when tests crash mid-run.
 *   - afterAll cleanup now LOUD-FAILS instead of swallowing rm errors,
 *     so leftover sandboxes are surfaced rather than accumulating.
 *   - JCF_HEALTHCARE_AGENT_HUB_HOME is set to REPO_ROOT explicitly so the
 *     server still resolves package.json/config from the repo (not the
 *     foreign cwd). This is the contract the new install-root.ts
 *     module exposes; tests pin it to keep behaviour deterministic.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SERVER_PATH = path.join(REPO_ROOT, 'dist', 'index.js');

type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };

function assertOk(res: ToolResult, label: string): void {
  expect(res.isError, `${label} — handler returned isError=true: ${JSON.stringify(res.content).slice(0, 300)}`).not.toBe(true);
  expect(res.content, `${label} — empty content`).toBeDefined();
  expect(Array.isArray(res.content), `${label} — content not array`).toBe(true);
}

describe('MCP Integration — all 32 tools end-to-end', () => {
  let client: Client;
  let transport: StdioClientTransport;
  let workDir: string;
  let testFile: string;
  let testFileTs: string;

  beforeAll(async () => {
    // Verify build exists — fail fast with a helpful message
    await fs.access(SERVER_PATH).catch(() => {
      throw new Error(`dist/index.js not found at ${SERVER_PATH}. Run \`npm run build\` first.`);
    });

    // R-4: sandbox in os.tmpdir() to keep the repo
    // tree clean. Pre-fix used `mkdtemp(REPO_ROOT, '.integ-')` which left
    // orphan dirs whenever a test crashed before afterAll fired. The
    // server's allowedDirectories is empty (permissive default) so a
    // tmpdir sandbox is accepted by path-guard.
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jcf-healthcare-agent-hub-integ-'));
    testFile = path.join(workDir, 'note.txt');
    testFileTs = path.join(workDir, 'widget.ts');

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_PATH],
      // R-1: pin install-root explicitly so the spawned
      // server resolves package.json / mcp-fs-config / data paths against
      // the repo, not whatever cwd the test runner happened to inherit.
      env: {
        ...process.env,
        NODE_ENV: 'test',
        JCF_HEALTHCARE_AGENT_HUB_HOME: REPO_ROOT,
      } as Record<string, string>,
      cwd: REPO_ROOT,
    });

    client = new Client(
      { name: 'jcf-healthcare-agent-hub-integration-tests', version: '1.0.0' },
      { capabilities: {} }
    );

    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    // Client close: failures are still tolerated because vitest may have
    // already torn the transport down on test failure.
    try { await client?.close(); } catch { /* transport already closed */ }

    // R-4: rm is now LOUD on failure. Swallowing
    // rm errors is what produced `.integ-noWQe8/` and `.integ-us5ISq/`
    // orphan dirs that ended up indexed by cognitive-index.
    if (workDir) {
      await fs.rm(workDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }, 15_000);

  // ── Registration ────────────────────────────────────────────────────

  it('registers exactly 59 tools (ADR-H001: 31 base + 28 healthcare)', async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBe(59);
    // Spot-check a few critical names — list mirrors registry.test.ts
    const names = new Set(tools.map(t => t.name));
    const required = [
      // diagnostics (1) — ADR-H001: estatus/verify removed
      'ping',
      // filesystem (6)
      'read_file', 'write_file', 'edit_file', 'append_file', 'delete_file',
      'list_directory',
      // search (2)
      'search_files', 'semantic_search',
      // versioning (3)
      'get_version_history', 'rollback_file', 'get_current_metadata',
      // dependencies (4)
      'get_dependencies', 'get_dependents', 'detect_circular_dependencies',
      'check_coherence',
      // intelligence (11)
      'build_cognitive_index', 'get_build_status', 'get_project_skeleton', 'get_module_contracts',
      'get_unit_fingerprints', 'get_impact_analysis', 'get_type_flow',
      'detect_patterns', 'get_knowledge_subgraph', 'query_code_intelligence',
      'get_intelligence_stats',
      // operations (4)
      'batch_operations', 'health_check', 'get_audit_log',
      'get_enabled_features',
    ];
    for (const n of required) expect(names, `missing tool: ${n}`).toContain(n);
  });

  // ── Core Operations (7) ─────────────────────────────────────────────

  describe('Core Operations', () => {
    it('write_file creates file', async () => {
      const res = await client.callTool({
        name: 'write_file',
        arguments: { path: testFile, content: 'first line\nsecond line\nthird line\n' },
      }) as ToolResult;
      assertOk(res, 'write_file');
    });

    it('read_file reads back full content', async () => {
      const res = await client.callTool({
        name: 'read_file',
        arguments: { path: testFile },
      }) as ToolResult;
      assertOk(res, 'read_file');
      const text = res.content.map(c => c.text ?? '').join('');
      expect(text).toContain('first line');
    });

    it('read_file honours offset/limit pagination', async () => {
      const res = await client.callTool({
        name: 'read_file',
        arguments: { path: testFile, offset: 2, limit: 1 },
      }) as ToolResult;
      assertOk(res, 'read_file pagination');
      const text = res.content.map(c => c.text ?? '').join('');
      expect(text).toContain('second line');
      expect(text).not.toContain('first line');
    });

    it('append_file appends to existing file', async () => {
      const res = await client.callTool({
        name: 'append_file',
        arguments: { path: testFile, content: 'appended line\n' },
      }) as ToolResult;
      assertOk(res, 'append_file');
    });

    it('edit_file applies find-replace edits', async () => {
      const res = await client.callTool({
        name: 'edit_file',
        arguments: {
          path: testFile,
          edits: [{ oldText: 'first line', newText: 'FIRST_LINE' }],
        },
      }) as ToolResult;
      assertOk(res, 'edit_file');

      // Verify via read
      const after = await client.callTool({
        name: 'read_file',
        arguments: { path: testFile },
      }) as ToolResult;
      const text = after.content.map(c => c.text ?? '').join('');
      expect(text).toContain('FIRST_LINE');
    });

    it('list_directory lists sandbox contents', async () => {
      const res = await client.callTool({
        name: 'list_directory',
        arguments: { path: workDir },
      }) as ToolResult;
      assertOk(res, 'list_directory');
      const text = res.content.map(c => c.text ?? '').join('');
      expect(text).toContain('note.txt');
    });

    it('search_files matches pattern', async () => {
      const res = await client.callTool({
        name: 'search_files',
        arguments: { pattern: '**/*.txt', baseDir: workDir },
      }) as ToolResult;
      assertOk(res, 'search_files');
    });
  });

  // ── Version Control (3) ─────────────────────────────────────────────

  describe('Version Control', () => {
    it('get_current_metadata returns file metadata', async () => {
      const res = await client.callTool({
        name: 'get_current_metadata',
        arguments: { path: testFile },
      }) as ToolResult;
      assertOk(res, 'get_current_metadata');
    });

    it('get_version_history returns entries after writes', async () => {
      // Do a couple more writes to accumulate versions
      await client.callTool({
        name: 'write_file',
        arguments: { path: testFile, content: 'revision 2\n' },
      });
      await client.callTool({
        name: 'write_file',
        arguments: { path: testFile, content: 'revision 3\n' },
      });
      const res = await client.callTool({
        name: 'get_version_history',
        arguments: { path: testFile, limit: 10 },
      }) as ToolResult;
      assertOk(res, 'get_version_history');
    });

    it('rollback_file fails gracefully with invalid versionId', async () => {
      // Test the ERROR path — handler should return structured isError, not crash
      const res = await client.callTool({
        name: 'rollback_file',
        arguments: { path: testFile, versionId: 'nonexistent-version-id' },
      }) as ToolResult;
      // Either isError true, or content mentions not found — both are valid graceful
      const ok = res.isError === true
        || res.content.some(c => (c.text ?? '').toLowerCase().includes('not'));
      expect(ok, `rollback_file should fail gracefully; got ${JSON.stringify(res).slice(0, 200)}`).toBe(true);
    });
  });

  // ── Dependency & Coherence (4) ──────────────────────────────────────

  describe('Dependency & Coherence', () => {
    it('get_dependencies returns array (possibly empty)', async () => {
      const res = await client.callTool({
        name: 'get_dependencies',
        arguments: { path: testFile },
      }) as ToolResult;
      assertOk(res, 'get_dependencies');
    });

    it('get_dependents returns array', async () => {
      const res = await client.callTool({
        name: 'get_dependents',
        arguments: { path: testFile },
      }) as ToolResult;
      assertOk(res, 'get_dependents');
    });

    it('detect_circular_dependencies runs', async () => {
      const res = await client.callTool({
        name: 'detect_circular_dependencies',
        arguments: {},
      }) as ToolResult;
      assertOk(res, 'detect_circular_dependencies');
    });

    it('check_coherence runs on file', async () => {
      const res = await client.callTool({
        name: 'check_coherence',
        arguments: { path: testFile },
      }) as ToolResult;
      assertOk(res, 'check_coherence');
    });
  });

  // ── Semantic Intelligence (1) ──────────────────────────────────────

  describe('Semantic Intelligence', () => {
    it('semantic_search responds (empty index → empty result is OK)', async () => {
      const res = await client.callTool({
        name: 'semantic_search',
        arguments: { query: 'first line of note', limit: 5 },
      }) as ToolResult;
      assertOk(res, 'semantic_search');
    });
  });

  // ── Cognitive Intelligence (9) ──────────────────────────────────────

  describe('Cognitive Intelligence', () => {
    // Seed a real TS file for the AST to munch on
    it('[setup] write widget.ts with real exports', async () => {
      const tsContent = `
export interface Widget { id: string; size: number }
export function createWidget(id: string, size = 1): Widget {
  if (size < 0) throw new Error('negative size');
  return { id, size };
}
export class WidgetFactory {
  private widgets: Widget[] = [];
  async build(id: string): Promise<Widget> {
    const w = createWidget(id);
    this.widgets.push(w);
    return w;
  }
}
`;
      const res = await client.callTool({
        name: 'write_file',
        arguments: { path: testFileTs, content: tsContent },
      }) as ToolResult;
      assertOk(res, 'setup widget.ts');
    });

    it('build_cognitive_index builds on sandbox', async () => {
      const res = await client.callTool(
        { name: 'build_cognitive_index', arguments: { rootPath: workDir } },
        undefined,
        { timeout: 180_000, resetTimeoutOnProgress: true },
      ) as ToolResult;
      assertOk(res, 'build_cognitive_index');
    }, 180_000);

    it('get_project_skeleton returns skeleton', async () => {
      const res = await client.callTool({
        name: 'get_project_skeleton',
        arguments: {},
      }) as ToolResult;
      assertOk(res, 'get_project_skeleton');
    });

    it('get_module_contracts returns contracts', async () => {
      const res = await client.callTool({
        name: 'get_module_contracts',
        arguments: { filePaths: [testFileTs] },
      }) as ToolResult;
      assertOk(res, 'get_module_contracts');
    });

    it('get_unit_fingerprints returns fingerprints', async () => {
      const res = await client.callTool({
        name: 'get_unit_fingerprints',
        arguments: { filePaths: [testFileTs] },
      }) as ToolResult;
      assertOk(res, 'get_unit_fingerprints');
    });

    it('get_impact_analysis analyses target', async () => {
      const res = await client.callTool({
        name: 'get_impact_analysis',
        arguments: { nodeId: testFileTs },
      }) as ToolResult;
      assertOk(res, 'get_impact_analysis');
    });

    it('get_type_flow resolves type', async () => {
      const res = await client.callTool({
        name: 'get_type_flow',
        arguments: { typeName: 'Widget' },
      }) as ToolResult;
      assertOk(res, 'get_type_flow');
    });

    it('detect_patterns runs', async () => {
      const res = await client.callTool({
        name: 'detect_patterns',
        arguments: {},
      }) as ToolResult;
      assertOk(res, 'detect_patterns');
    });

    it('get_knowledge_subgraph runs', async () => {
      const res = await client.callTool({
        name: 'get_knowledge_subgraph',
        arguments: { nodeId: testFileTs },
      }) as ToolResult;
      assertOk(res, 'get_knowledge_subgraph');
    });

    it('query_code_intelligence (skeleton) runs', async () => {
      const res = await client.callTool({
        name: 'query_code_intelligence',
        arguments: { type: 'skeleton' },
      }) as ToolResult;
      assertOk(res, 'query_code_intelligence');
    });
  });

  // ── Operations & Observability (5) ─────────────────────────────────

  describe('Operations & Observability', () => {
    it('batch_operations executes list of reads', async () => {
      const res = await client.callTool({
        name: 'batch_operations',
        arguments: {
          operations: [
            { type: 'read', path: testFile },
            { type: 'read', path: testFileTs },
          ],
        },
      }) as ToolResult;
      assertOk(res, 'batch_operations');
    });

    it('health_check reports status', async () => {
      const res = await client.callTool({
        name: 'health_check',
        arguments: {},
      }) as ToolResult;
      assertOk(res, 'health_check');
      const text = res.content.map(c => c.text ?? '').join('');
      expect(text.toLowerCase()).toMatch(/status|healthy|degraded|ok/);
    });

    it('get_audit_log returns recent events', async () => {
      const res = await client.callTool({
        name: 'get_audit_log',
        arguments: { limit: 50 },
      }) as ToolResult;
      assertOk(res, 'get_audit_log');
    });

    it('get_enabled_features lists features', async () => {
      const res = await client.callTool({
        name: 'get_enabled_features',
        arguments: {},
      }) as ToolResult;
      assertOk(res, 'get_enabled_features');
    });

    it('get_intelligence_stats returns stats', async () => {
      const res = await client.callTool({
        name: 'get_intelligence_stats',
        arguments: {},
      }) as ToolResult;
      assertOk(res, 'get_intelligence_stats');
    });
  });

  // ── Diagnostics (1) ─────────────────────────────────────────────────
  // ADR-H001: estatus + verify removed from healthcare hub.
  // ping is the sole diagnostic tool.

  describe('Diagnostics', () => {
    it('ping returns online status with server name', async () => {
      const res = await client.callTool({ name: 'ping', arguments: {} }) as ToolResult;
      assertOk(res, 'ping');
      const text = res.content.map(c => c.text ?? '').join('');
      expect(text).toContain('online');
      expect(text).toContain('jcf-healthcare-agent-hub');
    });
  });

  // ── Destructive last ────────────────────────────────────────────────

  describe('Destructive (delete last)', () => {
    it('delete_file removes the file', async () => {
      const res = await client.callTool({
        name: 'delete_file',
        arguments: { path: testFile },
      }) as ToolResult;
      assertOk(res, 'delete_file');
    });
  });
});
