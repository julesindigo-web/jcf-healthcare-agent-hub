#!/usr/bin/env node

/**
 * HTTP entry point for Railway deployment.
 * 
 * This file creates an HTTP server that:
 * 1. Serves a /health endpoint for Railway health checks
 * 2. Serves the MCP server via stdio transport proxied through HTTP
 * 
 * Railway requires HTTP servers, but MCP SDK 1.29.0 uses stdio transport.
 * This wrapper provides the HTTP interface Railway needs while keeping
 * the MCP server unchanged.
 */

import http from "http";
import { spawn } from "child_process";
import { URL } from "url";

const PORT = parseInt(process.env.PORT || process.env.HTTP_PORT || "8080", 10);

// Create HTTP server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  
  // Health check endpoint for Railway
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "healthy",
      server: "jcf-healthcare-agent-hub",
      version: "2.1.0-healthcare",
      timestamp: new Date().toISOString()
    }));
    return;
  }

  // Root endpoint
  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("JCF Healthcare Agent Hub MCP Server\n\nEndpoints:\n  GET /health - Health check\n  POST /mcp - MCP communication (JSON-RPC 2.0)");
    return;
  }

  // MCP endpoint - proxy to stdio server
  if (url.pathname === "/mcp") {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "text/plain" });
      res.end("Method Not Allowed. Use POST for MCP communication.");
      return;
    }

    try {
      // Read request body
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks).toString();

      // Spawn MCP server process
      const mcpProcess = spawn("node", ["dist/index.js"], {
        stdio: ["pipe", "pipe", "pipe"]
      });

      // Send request to MCP server via stdin
      mcpProcess.stdin.write(body);
      mcpProcess.stdin.end();

      // Collect response from stdout
      const responseChunks: Buffer[] = [];
      mcpProcess.stdout.on("data", (chunk) => {
        responseChunks.push(chunk);
      });

      mcpProcess.on("close", (code) => {
        const responseBody = Buffer.concat(responseChunks).toString();
        
        if (code === 0) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(responseBody);
        } else {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "MCP server process failed", code }));
        }
      });

      // Handle errors
      mcpProcess.on("error", (err) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to spawn MCP server", message: err.message }));
      });

      // Timeout after 30 seconds
      setTimeout(() => {
        mcpProcess.kill();
        if (!res.headersSent) {
          res.writeHead(504, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Request timeout" }));
        }
      }, 30000);

    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error", message: String(error) }));
    }
    return;
  }

  // 404 for unknown paths
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

// Start server
server.listen(PORT, () => {
  console.error(`HTTP server listening on port ${PORT}`);
  console.error(`Health check: http://localhost:${PORT}/health`);
  console.error(`MCP endpoint: http://localhost:${PORT}/mcp`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.error("Received SIGTERM, shutting down gracefully...");
  server.close(() => {
    console.error("HTTP server closed");
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  console.error("Received SIGINT, shutting down gracefully...");
  server.close(() => {
    console.error("HTTP server closed");
    process.exit(0);
  });
});
