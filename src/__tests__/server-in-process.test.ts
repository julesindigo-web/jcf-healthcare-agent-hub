/**
 * In-process MCP smoke tests for `server.ts` — M12.3.
 *
 * Instantiates `JcfHealthcareAgentHubServer` directly inside the vitest worker
 * (no subprocess), connects it to a `Client` via `InMemoryTransport`, and
 * exercises the registry → dispatcher → handler chain end-to-end.
 *
 * Why this exists alongside `integration.test.ts`:
 *   - `integration.test.ts` spawns `dist/index.js` as a real subprocess.
 *     This validates the deployed binary but v8 coverage instrumentation
 *     does NOT propagate into the child process, leaving server.ts at 0%
 *     measured coverage despite full e2e exercise.
 *   - This file runs the same code path inside the test worker so v8 sees
 *     every dispatcher line, every rate-limit branch, every error-wrap.
 *
 * Isolation strategy:
 *   - All persistent paths (`databasePath`, `vectorDbPath`,
 *     `cognitiveIndexPath`, `policiesPath`) are redirected to a sandbox
 *     temp dir inside the repo via `MCP_FS_*` env vars.
 *   - Embedding service is disabled (no localhost probe required).
 *   - Sandbox lives under `REPO_ROOT/.inproc-<rand>/` so `allowedDirectories`
 *     defaults permit it (same approach as `integration.test.ts`).
 *   - `afterAll` restores process.env to its pre-test snapshot.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { JcfHealthcareAgentHubServer } from "../server.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");

type ToolResult = {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
};

describe("server.ts — in-process MCP smoke (M12.3)", () => {
  let server: JcfHealthcareAgentHubServer;
  let client: Client;
  let workDir: string;
  // Snapshot env so afterAll can restore — env mutations affect this worker
  // for the rest of its lifetime otherwise.
  const envSnapshot: Record<string, string | undefined> = {};
  const envKeysToTrack = [
    "MCP_FS_DATABASEPATH",
    "MCP_FS_VECTORDBPATH",
    "MCP_FS_COGNITIVEINDEXPATH",
    "MCP_FS_POLICIESPATH",
    "MCP_FS_EMBEDDINGENABLED",
  ];

  beforeAll(async () => {
    // Sandbox dir INSIDE repo so default allowedDirectories permits writes.
    workDir = await fs.mkdtemp(path.join(REPO_ROOT, ".inproc-"));

    // Snapshot + override env. Setting these BEFORE
    // `JcfHealthcareAgentHubServer#initialize()` is critical — `ConfigManager`
    // reads them once during boot and caches into the singleton.
    for (const k of envKeysToTrack) envSnapshot[k] = process.env[k];
    process.env.MCP_FS_DATABASEPATH = path.join(workDir, ".jcf-fs-metadata.json");
    process.env.MCP_FS_VECTORDBPATH = path.join(workDir, ".jcf-vector-db.json");
    process.env.MCP_FS_COGNITIVEINDEXPATH = path.join(
      workDir,
      ".jcf-cognitive-index.json"
    );
    process.env.MCP_FS_POLICIESPATH = path.join(workDir, ".jcf-policies.json");
    process.env.MCP_FS_EMBEDDINGENABLED = "false";

    server = new JcfHealthcareAgentHubServer();
    await server.initialize();

    // Linked transport pair: client speaks to server entirely in-memory.
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    client = new Client(
      { name: "in-process-test", version: "1.0.0" },
      { capabilities: {} }
    );
    await client.connect(clientTransport);
  }, 30_000);

  afterAll(async () => {
    try {
      await client?.close();
    } catch {
      /* best-effort */
    }
    try {
      await server?.close();
    } catch {
      /* best-effort */
    }
    try {
      await fs.rm(workDir, { recursive: true, force: true });
    } catch {
      /* best-effort: Windows handle release race */
    }
    // Restore env state so subsequent test files in this worker see the
    // original environment. Vitest typically isolates files per worker
    // anyway, but the discipline is cheap and safer.
    for (const k of envKeysToTrack) {
      const original = envSnapshot[k];
      if (original === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = original;
      }
    }
  }, 15_000);

  // ── Registry verification ──────────────────────────────────────────

  it("registers all tools from TOOL_REGISTRY", async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBe(59);
    // Spot-check that core tool descriptions are populated by
    // `getToolDescription` (the lookup happens inside `registerOne`).
    const writeTool = tools.find((t) => t.name === "write_file");
    expect(writeTool, "write_file must be registered").toBeDefined();
    expect(writeTool!.description).toBeTruthy();
    expect(writeTool!.description!.length).toBeGreaterThan(10);
  });

  // ── Dispatcher: success path ───────────────────────────────────────

  it("dispatches write_file → read_file roundtrip in-process", async () => {
    const file = path.join(workDir, "hello.txt");

    const writeRes = (await client.callTool({
      name: "write_file",
      arguments: { path: file, content: "in-process world\n" },
    })) as ToolResult;
    expect(writeRes.isError).not.toBe(true);

    const readRes = (await client.callTool({
      name: "read_file",
      arguments: { path: file },
    })) as ToolResult;
    expect(readRes.isError).not.toBe(true);
    const text = readRes.content.map((c) => c.text ?? "").join("");
    expect(text).toContain("in-process world");
  });

  // ── Dispatcher: feature-flag introspection ─────────────────────────

  it("exposes enabled features through the public accessor", () => {
    const features = server.getEnabledFeatures();
    expect(Array.isArray(features)).toBe(true);
    expect(features.length).toBeGreaterThan(0);
    // versioning is enabled by default; confirms ConfigManager wiring.
    expect(features).toContain("versioning");
  });

  // ── Dispatcher: rate-limiter `check` path is exercised on every call

  it("invokes rate-limiter check on each tool call", async () => {
    // Multiple successive list_directory calls exercise the rate-limiter
    // `check` path inside `registerOne` (the generous default budget
    // accepts these without throwing). Each call also stresses the MCP
    // envelope wrapping (`content: [{ type: "text", text: ... }]`).
    for (let i = 0; i < 3; i++) {
      const res = (await client.callTool({
        name: "list_directory",
        arguments: { path: workDir },
      })) as ToolResult;
      expect(res.isError).not.toBe(true);
      expect(Array.isArray(res.content)).toBe(true);
    }
  });

  // ── Dispatcher: error-handling branch ──────────────────────────────

  it("propagates handler errors through the MCP error wrapping", async () => {
    // read_file on a non-existent path triggers fs.readFile ENOENT, which
    // bubbles through `withAudit` and into `registerOne`'s catch branch
    // where it's logged + rethrown. The MCP SDK then surfaces the error
    // as either a thrown rejection or an `isError: true` result envelope.
    let surfaced = false;
    try {
      const res = (await client.callTool({
        name: "read_file",
        arguments: { path: path.join(workDir, "definitely-not-here.txt") },
      })) as ToolResult;
      // SDK may also surface as { isError: true } instead of rejecting —
      // both are valid graceful-failure surfaces.
      if (res.isError === true) surfaced = true;
    } catch {
      surfaced = true;
    }
    expect(surfaced, "handler error must surface as throw or isError").toBe(true);
  });

  // ── Dispatcher: argument validation ────────────────────────────────

  it("rejects path traversal at the validatePath boundary", async () => {
    let blocked = false;
    try {
      const res = (await client.callTool({
        name: "read_file",
        arguments: { path: "../../etc/passwd" },
      })) as ToolResult;
      if (res.isError === true) blocked = true;
    } catch {
      blocked = true;
    }
    expect(blocked, "path traversal must be blocked").toBe(true);
  });
});
