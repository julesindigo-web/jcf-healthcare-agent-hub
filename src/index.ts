#!/usr/bin/env node

/**
 * Entry point for JCF Healthcare Agent Hub MCP server.
 *
 * Phase F1 (M-10): graceful SIGTERM/SIGINT shutdown.
 * Ensures SQLite WAL checkpoint + DB close + transport shutdown happen
 * cleanly even when killed by an orchestrator (systemd, Docker, etc.).
 */

import { JcfHealthcareAgentHubServer } from "./server.js";

async function main(): Promise<void> {
  const server = new JcfHealthcareAgentHubServer();
  try {
    await server.initialize();
    await server.connect();
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }

  // Phase F1: graceful shutdown wiring
  let shuttingDown = false;
  const shutdown = async (signal: string, code: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      // stderr so logs don't mix with JSON-RPC on stdout
      process.stderr.write(`\n[jcf-healthcare-agent-hub] received ${signal}, shutting down gracefully...\n`);
      await server.close();
    } catch (err) {
      process.stderr.write(`[jcf-healthcare-agent-hub] shutdown error: ${err}\n`);
    } finally {
      process.exit(code);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM", 0));
  process.on("SIGINT",  () => void shutdown("SIGINT",  0));
  process.on("SIGHUP",  () => void shutdown("SIGHUP",  0));

  // Last-ditch safety: flush DB on uncaught crashes
  process.on("uncaughtException", async (err) => {
    process.stderr.write(`[jcf-healthcare-agent-hub] uncaughtException: ${err.stack ?? err}\n`);
    await shutdown("uncaughtException", 1);
  });
  process.on("unhandledRejection", async (reason) => {
    process.stderr.write(`[jcf-healthcare-agent-hub] unhandledRejection: ${reason}\n`);
    await shutdown("unhandledRejection", 1);
  });
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
