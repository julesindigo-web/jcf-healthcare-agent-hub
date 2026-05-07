/**
 * JobManager — background job tracker for long-running operations.
 *
 * M14 (2026-05-02): Prevent MCP client timeout (60s)
 * for `build_cognitive_index` by running the build asynchronously
 * and returning a `job_id` immediately.
 *
 * Jobs are in-memory only (process lifetime). Status is queryable
 * via `getBuildStatus` tool.
 */

import { Logger } from './logger.js';
import type { BuildCognitiveIndexResult } from '../handlers/intelligence.js';

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface Job {
  jobId: string;
  toolName: string;
  status: JobStatus;
  progress: number;
  total: number;
  message: string;
  result?: BuildCognitiveIndexResult;
  error?: string;
  createdAt: number;
  updatedAt: number;
  durationMs?: number;
}

export class JobManager {
  private jobs = new Map<string, Job>();
  private logger: Logger;
  private maxJobs: number;

  constructor(config: { logger: Logger; maxJobs?: number }) {
    this.logger = config.logger;
    this.maxJobs = config.maxJobs ?? 100;
  }

  /**
   * Create a new background job. Returns the job_id immediately.
   */
  create(toolName: string): string {
    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const job: Job = {
      jobId,
      toolName,
      status: 'queued',
      progress: 0,
      total: 5, // 5 phases for cognitive index
      message: `Job queued for ${toolName}…`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.jobs.set(jobId, job);
    this.evictOld();
    this.logger.info('Background job created', { jobId, toolName });
    return jobId;
  }

  /**
   * Update job progress (called from progress callback).
   */
  updateProgress(jobId: string, progress: number, total: number, message: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.progress = progress;
    job.total = total;
    job.message = message;
    job.status = 'running';
    job.updatedAt = Date.now();
  }

  /**
   * Mark job as completed with result.
   */
  complete(jobId: string, result: BuildCognitiveIndexResult): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.status = 'completed';
    job.result = result;
    job.progress = job.total;
    job.message = `Build complete: ${result.modules} modules, ${result.units} units, ${result.patterns} patterns in ${result.duration}ms`;
    job.updatedAt = Date.now();
    job.durationMs = job.updatedAt - job.createdAt;
    this.logger.info('Background job completed', { jobId, durationMs: job.durationMs });
  }

  /**
   * Mark job as failed with error.
   */
  fail(jobId: string, error: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.status = 'failed';
    job.error = error;
    job.updatedAt = Date.now();
    job.durationMs = job.updatedAt - job.createdAt;
    this.logger.warn('Background job failed', { jobId, error });
  }

  /**
   * Get job status. Returns undefined if job not found.
   */
  get(jobId: string): Job | undefined {
    return this.jobs.get(jobId);
  }

  /**
   * List all jobs (most recent first).
   */
  list(limit = 20): Job[] {
    return [...this.jobs.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  /**
   * Evict old completed/failed jobs beyond maxJobs.
   */
  private evictOld(): void {
    const all = [...this.jobs.entries()];
    if (all.length <= this.maxJobs) return;
    const toRemove = all
      .sort((a, b) => a[1].createdAt - b[1].createdAt)
      .slice(0, all.length - this.maxJobs);
    for (const [id] of toRemove) {
      this.jobs.delete(id);
    }
  }
}
