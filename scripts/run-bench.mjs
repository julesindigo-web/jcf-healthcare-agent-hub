#!/usr/bin/env node
/**
 * Cross-platform bench runner — M12.4.
 *
 * Sets RUN_BENCH=1 (so describe.skipIf(!RUN_BENCH) blocks unskip) and
 * runs the registry-overhead test file in isolation (no parallel
 * contention from other test files).
 *
 * Why this wrapper exists:
 *   - Setting an env var inline in npm scripts is shell-specific:
 *     bash: `RUN_BENCH=1 npm run X`
 *     pwsh: `$env:RUN_BENCH=1; npm run X`
 *     cmd:  `set RUN_BENCH=1 && npm run X`
 *   - A 20-line Node wrapper sidesteps that without adding `cross-env`
 *     as a devDependency.
 */

import { spawn } from "node:child_process";

process.env.RUN_BENCH = "1";

const isWin = process.platform === "win32";
const npxBin = isWin ? "npx.cmd" : "npx";

const child = spawn(
  npxBin,
  ["vitest", "run", "src/__tests__/registry-overhead.test.ts"],
  // `shell: true` is required on Windows when spawning `.cmd`/`.bat`
  // wrappers like `npx.cmd` — without it, Node ≥20 throws EINVAL.
  { stdio: "inherit", env: process.env, shell: true }
);

child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (err) => {
  console.error("Failed to spawn vitest:", err);
  process.exit(1);
});
