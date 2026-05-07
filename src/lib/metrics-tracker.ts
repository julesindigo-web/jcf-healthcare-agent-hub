/**
 * JCF Healthcare Agent Hub — Per-Tool Metrics Tracker.
 *
 * M11-AUDIT FIX (MED-15 + MED-16): replaces hardcoded zeros previously
 * returned by `health_check` with real, in-memory call statistics.
 *
 * Tracked metrics:
 *   - totalRequests   (number of tool dispatches since boot)
 *   - totalErrors     (number of dispatches that threw)
 *   - activeRequests  (currently in-flight dispatches)
 *   - avgLatencyMs    (rolling-window mean of completed dispatches)
 *   - perTool         (same shape, scoped per tool name)
 *
 * Window: rolling N=1000 latency samples per tool to bound memory.
 *
 * Thread-safety: Node single-threaded event loop — no locking required.
 */

import type { Logger } from "./logger.js";

export interface ToolMetricSnapshot {
  count: number;
  errors: number;
  active: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
}

export interface MetricsSnapshot {
  totalRequests: number;
  totalErrors: number;
  activeRequests: number;
  avgLatencyMs: number;
  perTool: Record<string, ToolMetricSnapshot>;
  uptimeMs: number;
}

interface ToolBucket {
  count: number;
  errors: number;
  active: number;
  /** Rolling-window samples (most recent first, capped at WINDOW). */
  samples: number[];
}

const ROLLING_WINDOW = 1000;

export class MetricsTracker {
  private logger: Logger;
  private start: number = Date.now();
  private buckets: Map<string, ToolBucket> = new Map();

  constructor(config: { logger: Logger }) {
    this.logger = config.logger;
  }

  /** Mark request start. Returns a token for `markEnd`. */
  markStart(toolName: string): { tool: string; t0: number } {
    const bucket = this.bucketFor(toolName);
    bucket.active++;
    return { tool: toolName, t0: performance.now() };
  }

  /** Mark request end. `errored=true` increments error counter. */
  markEnd(token: { tool: string; t0: number }, errored: boolean): void {
    const elapsedMs = performance.now() - token.t0;
    const bucket = this.bucketFor(token.tool);
    bucket.active = Math.max(0, bucket.active - 1);
    bucket.count++;
    if (errored) bucket.errors++;
    bucket.samples.push(elapsedMs);
    if (bucket.samples.length > ROLLING_WINDOW) bucket.samples.shift();
  }

  /** Aggregate snapshot suitable for `health_check`. */
  snapshot(): MetricsSnapshot {
    let totalRequests = 0;
    let totalErrors = 0;
    let activeRequests = 0;
    let totalLatencyMs = 0;
    let totalSamples = 0;
    const perTool: Record<string, ToolMetricSnapshot> = {};

    for (const [name, b] of this.buckets) {
      totalRequests += b.count;
      totalErrors += b.errors;
      activeRequests += b.active;
      const avg = b.samples.length > 0
        ? b.samples.reduce((s, x) => s + x, 0) / b.samples.length
        : 0;
      totalLatencyMs += b.samples.reduce((s, x) => s + x, 0);
      totalSamples += b.samples.length;
      perTool[name] = {
        count: b.count,
        errors: b.errors,
        active: b.active,
        avgLatencyMs: round(avg),
        p50LatencyMs: percentile(b.samples, 0.5),
        p95LatencyMs: percentile(b.samples, 0.95),
        p99LatencyMs: percentile(b.samples, 0.99),
      };
    }

    return {
      totalRequests,
      totalErrors,
      activeRequests,
      avgLatencyMs: totalSamples > 0 ? round(totalLatencyMs / totalSamples) : 0,
      perTool,
      uptimeMs: Date.now() - this.start,
    };
  }

  /** Reset all counters (test-only utility). */
  reset(): void {
    this.buckets.clear();
    this.start = Date.now();
    this.logger.debug("MetricsTracker reset");
  }

  private bucketFor(name: string): ToolBucket {
    let b = this.buckets.get(name);
    if (!b) {
      b = { count: 0, errors: 0, active: 0, samples: [] };
      this.buckets.set(name, b);
    }
    return b;
  }
}

function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return round(sorted[idx]!);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
