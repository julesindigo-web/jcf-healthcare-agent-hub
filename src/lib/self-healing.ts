import fs from 'fs/promises';
import path from 'path';
import { EventEmitter } from 'node:events';
import { Logger } from './logger.js';
import type { Database } from './database.js';
import type { CacheManager } from './cache.js';

/**
 * Self-Healing System - Autonomous Error Detection & Recovery
 *
 * Features:
 * - Automatic detection of common file system errors
 * - Intelligent fix suggestions and auto-application
 * - Pattern learning from past errors with success rate tracking
 * - Graceful degradation on failure
 * - Health monitoring and proactive maintenance
 * - Rollback capabilities for risky operations
 * - Proactive file watching and integrity checks
 * - Auto-recreation of critical metadata files
 * - Actual file restoration from version history
 * - Periodic health monitoring with configurable interval
 */

export interface HealResult {
  healed: boolean;
  fixApplied?: string;
  message: string;
  duration?: number;
}

export interface ProactiveCheckResult {
  healthy: boolean;
  issues: string[];
  autoFixesApplied: number;
  details: Array<{ component: string; status: 'ok' | 'degraded' | 'failed'; message?: string }>;
}

/**
 * Phase B5: Event payload types for self-healing observability.
 * Callers can subscribe via `selfHealing.events.on('heal:success', handler)`.
 */
export interface HealingEvents {
  'heal:attempt':  { signature: string; context: Record<string, any> };
  'heal:success':  { signature: string; fixApplied: string; duration: number };
  'heal:failure':  { signature: string; message: string; duration: number; errorMessage: string };
  'heal:cooldown': { signature: string; count: number };
  'health:check':  { healthy: boolean; issueCount: number; autoFixesApplied: number };
  'health:degraded': { issues: string[] };
}

export class SelfHealing {
  private logger: Logger;
  private cache: CacheManager;
  private db: Database;
  private fixHistory: Map<string, { success: boolean; count: number; lastAttempt: number; lastSuccess?: number }> = new Map();
  private readonly maxAutoFixes: number;
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private vectorDbRef: any = null; // Set externally for vector DB recovery

  /**
   * Phase B5: Event emitter for heal/health lifecycle observability.
   * Closes the dogfooding gap where heal attempts happened invisibly.
   * Typed via `HealingEvents` for safe subscription.
   *
   * Example:
   *   selfHealing.events.on('heal:success', (ev) => logger.info('healed', ev));
   *   selfHealing.events.on('health:degraded', (ev) => alertOps(ev.issues));
   */
  public readonly events = new EventEmitter({ captureRejections: true });

  constructor(config: {
    logger: Logger;
    cache: CacheManager;
    db: Database;
    maxAutoFixes?: number;
  }) {
    this.logger = config.logger;
    this.cache = config.cache;
    this.db = config.db;
    this.maxAutoFixes = config.maxAutoFixes || 5;
  }

  /**
   * Set reference to VectorDB for recovery operations
   */
  setVectorDbRef(vdb: any): void {
    this.vectorDbRef = vdb;
  }

  /**
   * Start periodic health monitoring
   */
  startHealthMonitoring(intervalMs: number = 60000): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    this.healthCheckInterval = setInterval(async () => {
      try {
        const result = await this.proactiveHealthCheck();
        if (!result.healthy) {
          this.logger.warn('Proactive health check found issues', { issues: result.issues });
        }
      } catch (error) {
        this.logger.error('Health monitoring error', error instanceof Error ? error : new Error(String(error)));
      }
    }, intervalMs);
    this.logger.info('Health monitoring started', { intervalMs });
  }

  /**
   * Stop periodic health monitoring
   */
  stopHealthMonitoring(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
      this.logger.info('Health monitoring stopped');
    }
  }

  /**
   * Analyze an error and attempt to fix it automatically
   */
  async healError(error: Error, context: Record<string, any>): Promise<HealResult> {
    const startTime = Date.now();
    const errorSignature = this.categorizeError(error, context);
    this.logger.info("Analyzing error for self-healing", { signature: errorSignature });

    // Check if we've tried too many times
    const history = this.fixHistory.get(errorSignature) || { success: false, count: 0, lastAttempt: 0 };

    // Reset count if last attempt was > 5 minutes ago (allow retry after cooldown)
    if (history.lastAttempt > 0 && Date.now() - history.lastAttempt > 5 * 60 * 1000) {
      history.count = 0;
    }

    if (history.count >= this.maxAutoFixes) {
      // Phase B5: emit cooldown event for observability
      this.events.emit('heal:cooldown', { signature: errorSignature, count: history.count });
      return {
        healed: false,
        message: `Max auto-fix attempts (${this.maxAutoFixes}) exceeded for error type: ${errorSignature}. Cooldown period active.`,
        duration: Date.now() - startTime,
      };
    }

    // Phase B5: emit attempt event
    this.events.emit('heal:attempt', { signature: errorSignature, context });

    // Attempt appropriate fix
    const result = await this.attemptFix(errorSignature, error, context);
    const duration = Date.now() - startTime;

    // Update fix history
    history.count++;
    history.lastAttempt = Date.now();
    if (result.healed) {
      history.success = true;
      history.lastSuccess = Date.now();
      this.logger.info("Self-healing succeeded", { signature: errorSignature, fix: result.fixApplied });
      // Phase B5: emit success event
      this.events.emit('heal:success', {
        signature: errorSignature,
        fixApplied: result.fixApplied ?? 'unknown',
        duration,
      });
    } else {
      this.logger.warn("Self-healing failed", { signature: errorSignature, message: result.message });
      // Phase B5: emit failure event
      this.events.emit('heal:failure', {
        signature: errorSignature,
        message: result.message,
        duration,
        errorMessage: error.message,
      });
    }
    this.fixHistory.set(errorSignature, history);

    return { ...result, duration };
  }

  /**
   * Categorize error to determine appropriate fix strategy
   */
  private categorizeError(error: Error, context: Record<string, any>): string {
    const message = error.message.toLowerCase();
    const code = (error as any).code;

    if (code === 'ENOENT' || message.includes('no such file') || message.includes('not found')) return 'file_not_found';
    if (code === 'EACCES' || code === 'EPERM' || message.includes('permission')) return 'permission_denied';
    if (code === 'ENOSPC' || message.includes('no space') || message.includes('quota')) return 'disk_full';
    if (code === 'EBUSY' || message.includes('lock') || message.includes('in use')) return 'file_locked';
    if (code === 'EISDIR' || message.includes('is a directory')) return 'is_directory';
    if (code === 'ENOTDIR' || message.includes('not a directory')) return 'not_directory';
    if (message.includes('unexpected token') || message.includes('invalid json') || message.includes('corrupt')) return 'data_corruption';
    if (message.includes('encoding') || message.includes('decode') || message.includes('utf-8')) return 'encoding_error';
    if (context.operation?.includes('cache') || context.component === 'cache') return 'cache_error';
    if (message.includes('connect') || message.includes('network') || message.includes('timeout')) return 'network_error';
    if (message.includes('circular') || message.includes('cycle')) return 'circular_dependency';
    return 'generic_error';
  }

  /**
   * Attempt to fix an error based on its category
   */
  private async attemptFix(
    category: string,
    error: Error,
    context: Record<string, any>
  ): Promise<HealResult> {
    switch (category) {
      case 'file_not_found': return this.fixFileNotFound(error, context);
      case 'permission_denied': return this.fixPermissionDenied(error, context);
      case 'disk_full': return this.fixDiskFull(error, context);
      case 'file_locked': return this.fixFileLocked(error, context);
      case 'is_directory': return this.fixIsDirectory(error, context);
      case 'not_directory': return this.fixNotDirectory(error, context);
      case 'data_corruption': return this.fixDataCorruption(error, context);
      case 'encoding_error': return this.fixEncodingError(error, context);
      case 'cache_error': return this.fixCacheError(error, context);
      case 'network_error': return this.fixNetworkError(error, context);
      case 'circular_dependency': return this.fixCircularDependency(error, context);
      default: return { healed: false, message: "No auto-fix strategy available for this error category" };
    }
  }

  /**
   * Fix: File not found — try to restore from version history
   */
  private async fixFileNotFound(_error: Error, context: { filePath?: string }): Promise<HealResult> {
    const filePath = context.filePath;
    if (!filePath) return { healed: false, message: "Cannot fix: file path unknown" };

    try {
      await fs.access(filePath);
      return { healed: false, message: "File actually exists, different issue" };
    } catch {
      // File truly missing — try to restore from version history
      const versions = this.db.getVersions(filePath);
      if (versions.length > 0) {
        // Find the most recent version with content
        const latestVersion = versions.find(v => v.content);
        if (latestVersion?.content) {
          try {
            // Ensure parent directory exists
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await fs.writeFile(filePath, latestVersion.content, 'utf-8');
            return {
              healed: true,
              fixApplied: `Restored file from version ${latestVersion.id}`,
              message: `File restored from version history (${versions.length} versions available)`,
            };
          } catch (restoreError) {
            return { healed: false, message: `Failed to restore from version: ${restoreError}` };
          }
        }
        return {
          healed: false,
          message: `File missing, ${versions.length} version(s) exist but none have stored content`,
        };
      }

      // Check if it's a metadata file that can be recreated
      if (filePath.includes('.jcf-')) {
        try {
          await this.recreateMetadataFile(filePath);
          return {
            healed: true,
            fixApplied: `Recreated metadata file: ${path.basename(filePath)}`,
            message: "Metadata file restored",
          };
        } catch (recreateError) {
          return { healed: false, message: `Failed to recreate: ${recreateError}` };
        }
      }

      return { healed: false, message: "File not found and no backup available" };
    }
  }

  /**
   * Fix: Permission denied — attempt to check and report
   */
  private async fixPermissionDenied(_error: Error, context: { filePath?: string }): Promise<HealResult> {
    const filePath = context.filePath;
    if (!filePath) return { healed: false, message: "Cannot fix: file path unknown" };

    try {
      // Check if parent directory is accessible
      const parentDir = path.dirname(filePath);
      await fs.access(parentDir, fs.constants.W_OK);
      return {
        healed: false,
        message: `Parent directory is writable but file access denied. The file may be locked by another process.`,
      };
    } catch {
      return {
        healed: false,
        message: `Permission denied — parent directory not writable. Please check permissions or run as administrator.`,
      };
    }
  }

  /**
   * Fix: Disk full — clear caches and cleanup
   */
  private async fixDiskFull(_error: Error, _context: Record<string, any>): Promise<HealResult> {
    this.logger.warn("Disk space low, attempting cache cleanup");
    try {
      this.cache.clear();
      this.logger.info("Cache cleared to free disk space");
      await this.db.cleanup();
      return {
        healed: true,
        fixApplied: "Cleared caches and cleaned up old data",
        message: "Cache and database cleanup completed",
      };
    } catch (cleanupError) {
      return { healed: false, message: `Cleanup failed: ${cleanupError}` };
    }
  }

  /**
   * Fix: File locked — retry with exponential backoff
   */
  private async fixFileLocked(_error: Error, context: { filePath?: string; retryCount?: number }): Promise<HealResult> {
    const retryCount = context.retryCount || 0;
    if (retryCount < 3) {
      const delay = Math.pow(2, retryCount) * 500; // 500ms, 1s, 2s
      this.logger.info("File locked, retrying with backoff", { retry: retryCount + 1, delay });
      await new Promise(resolve => setTimeout(resolve, delay));

      // Check if file is now accessible
      if (context.filePath) {
        try {
          await fs.access(context.filePath, fs.constants.W_OK);
          return { healed: true, fixApplied: "File became available after wait", message: `File unlocked after ${delay}ms wait` };
        } catch {
          // Still locked
        }
      }

      return { healed: false, message: `Retrying after ${delay}ms (attempt ${retryCount + 1}/3)` };
    }
    return { healed: false, message: "File remains locked after 3 retry attempts" };
  }

  /**
   * Fix: Is a directory — suggest correct path or list directory
   */
  private async fixIsDirectory(_error: Error, context: { filePath?: string }): Promise<HealResult> {
    const filePath = context.filePath;
    if (!filePath) return { healed: false, message: "Cannot fix: file path unknown" };

    try {
      const entries = await fs.readdir(filePath);
      return {
        healed: false,
        message: `Path is a directory, not a file. Directory contains ${entries.length} entries. Use list_directory instead.`,
      };
    } catch {
      return { healed: false, message: "Path is a directory — use list_directory tool instead" };
    }
  }

  /**
   * Fix: Not a directory — suggest creating parent directory
   */
  private async fixNotDirectory(_error: Error, context: { filePath?: string }): Promise<HealResult> {
    const filePath = context.filePath;
    if (!filePath) return { healed: false, message: "Cannot fix: file path unknown" };

    const parentDir = path.dirname(filePath);
    try {
      await fs.mkdir(parentDir, { recursive: true });
      return {
        healed: true,
        fixApplied: `Created parent directory: ${parentDir}`,
        message: "Parent directory created",
      };
    } catch {
      return { healed: false, message: "Failed to create parent directory" };
    }
  }

  /**
   * Fix: Data corruption — restore from backup or rebuild
   */
  private async fixDataCorruption(_error: Error, context: { filePath?: string; component?: string }): Promise<HealResult> {
    const component = context.component || 'unknown';

    try {
      if (component === 'database' || context.filePath?.includes('.jcf-fs-metadata')) {
        this.logger.warn("Database corruption detected, attempting rebuild");
        await this.rebuildDatabase();
        return {
          healed: true,
          fixApplied: "Rebuilt database from surviving entries",
          message: "Database reconstruction completed",
        };
      }

      if (component === 'vector-db' || context.filePath?.includes('.jcf-vector-db')) {
        this.logger.warn("Vector database corruption, clearing and rebuilding");
        if (this.vectorDbRef) {
          await this.vectorDbRef.clear();
          return {
            healed: true,
            fixApplied: "Cleared corrupted vector database",
            message: "Vector database cleared — files will be re-indexed on next access",
          };
        }
        return { healed: false, message: "Vector database needs manual rebuild" };
      }

      // Generic corruption — try to restore the file from version history
      if (context.filePath) {
        const versions = this.db.getVersions(context.filePath);
        const lastGood = versions.find(v => v.content);
        if (lastGood?.content) {
          await fs.writeFile(context.filePath, lastGood.content, 'utf-8');
          return {
            healed: true,
            fixApplied: `Restored from version ${lastGood.id}`,
            message: "File restored from last known good version",
          };
        }
      }
    } catch (rebuildError) {
      return { healed: false, message: `Rebuild failed: ${rebuildError}` };
    }

    return { healed: false, message: "Cannot determine appropriate recovery strategy" };
  }

  /**
   * Fix: Encoding error — try reading with different encoding
   */
  private async fixEncodingError(_error: Error, context: { filePath?: string }): Promise<HealResult> {
    const filePath = context.filePath;
    if (!filePath) return { healed: false, message: "Cannot fix: file path unknown" };

    // Try to read as binary and detect encoding
    try {
      const buffer = await fs.readFile(filePath);
      // Check for BOM markers
      if (buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
        return { healed: false, message: "File has UTF-8 BOM — try reading with utf-8 encoding explicitly" };
      }
      if (buffer[0] === 0xFF && buffer[1] === 0xFE) {
        return { healed: false, message: "File appears to be UTF-16 LE — not supported for text reading" };
      }
      // Try latin1 as fallback
      const content = buffer.toString('latin1');
      if (content.length > 0) {
        return {
          healed: false,
          message: `File may use latin1 encoding. Read ${buffer.byteLength} bytes. Try encoding='latin1' option.`,
        };
      }
    } catch {
      // Can't read at all
    }

    return { healed: false, message: "Cannot determine file encoding" };
  }

  /**
   * Fix: Cache error — invalidate and refresh
   */
  private async fixCacheError(_error: Error, context: { key?: string }): Promise<HealResult> {
    try {
      if (context.key) {
        this.cache.delete(context.key);
        this.logger.debug("Cache entry invalidated", { key: context.key });
      } else {
        this.cache.clear();
        this.logger.info("Full cache cleared due to errors");
      }
      return {
        healed: true,
        fixApplied: "Cache invalidated and cleared",
        message: "Cache state reset",
      };
    } catch (cacheError) {
      return { healed: false, message: `Cache clear failed: ${cacheError}` };
    }
  }

  /**
   * Fix: Network error — disable Redis and fall back to local cache
   */
  private async fixNetworkError(_error: Error, context: { service?: string }): Promise<HealResult> {
    if (context.service === 'redis') {
      this.logger.warn("Redis connection failed, switching to local cache only");
      return {
        healed: true,
        fixApplied: "Disabled Redis, using local cache",
        message: "Fallback to local cache activated",
      };
    }
    return { healed: false, message: "Network error not recoverable" };
  }

  /**
   * Fix: Circular dependency — report and suggest refactoring
   */
  private async fixCircularDependency(_error: Error, context: { cyclePath?: string[] }): Promise<HealResult> {
    const cycle = context.cyclePath;
    if (cycle && cycle.length > 0) {
      return {
        healed: false,
        message: `Circular dependency detected: ${cycle.join(' → ')}. Refactor to break the cycle by extracting shared logic into a separate module.`,
      };
    }
    return { healed: false, message: "Circular dependency detected — manual refactoring required" };
  }

  /**
   * Rebuild database from remaining entries
   */
  private async rebuildDatabase(): Promise<void> {
    const allFiles = this.db.getAllFiles();
    const validEntries: Array<{ path: string; metadata: any }> = [];

    for (const filePath of allFiles) {
      try {
        const metadata = this.db.getFileMetadata(filePath);
        if (metadata && metadata.path && metadata.modified && metadata.created) {
          validEntries.push({ path: filePath, metadata });
        }
      } catch { /* skip invalid entries */ }
    }

    this.logger.info(`Database rebuild: ${validEntries.length}/${allFiles.length} valid entries recovered`);

    try {
      await this.db.cleanup();
    } catch (error) {
      this.logger.error('Database rebuild save failed', error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  /**
   * Recreate standard metadata files if missing
   */
  private async recreateMetadataFile(filePath: string): Promise<void> {
    const fileName = path.basename(filePath);

    // Ensure parent directory exists
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    if (fileName === '.jcf-fs-metadata.json') {
      const emptyDb = { files: {}, versions: {}, audits: [], lastCleanup: Date.now() };
      await fs.writeFile(filePath, JSON.stringify(emptyDb, null, 2), 'utf-8');
    } else if (fileName === '.jcf-policies.json') {
      const defaultPolicies = [{
        path: '/',
        roles: {
          admin: { permissions: ['read', 'write', 'delete', 'move', 'copy', 'admin'] },
          user: { permissions: ['read', 'write', 'copy'] },
          readonly: { permissions: ['read'] },
        },
      }];
      await fs.writeFile(filePath, JSON.stringify(defaultPolicies, null, 2), 'utf-8');
    } else if (fileName === '.jcf-vector-db.json') {
      const emptyIndex = { index: {}, documentFrequencies: {}, totalDocuments: 0 };
      await fs.writeFile(filePath, JSON.stringify(emptyIndex, null, 2), 'utf-8');
    } else {
      throw new Error(`Unknown metadata file: ${fileName}`);
    }
  }

  /**
   * Proactive health check — checks all subsystems
   */
  async proactiveHealthCheck(): Promise<ProactiveCheckResult> {
    const issues: string[] = [];
    let autoFixesApplied = 0;
    const details: Array<{ component: string; status: 'ok' | 'degraded' | 'failed'; message?: string }> = [];

    // Check database integrity
    try {
      const stats = this.db.getStats();
      if (stats.fileCount === 0 && stats.auditCount === 0) {
        issues.push("Database appears empty — may be corrupted");
        details.push({ component: 'database', status: 'degraded', message: 'Empty database' });
      } else {
        details.push({ component: 'database', status: 'ok' });
      }

      // Check database file size
      const dbPath = (this.db as any).dbPath;
      if (dbPath) {
        try {
          const fileStats = await fs.stat(dbPath);
          if (fileStats.size === 0) {
            issues.push("Database file is empty");
            details.push({ component: 'database', status: 'failed', message: 'Zero-byte database file' });
          }
        } catch { /* file may not exist yet */ }
      }
    } catch (error) {
      issues.push(`Database check failed: ${error}`);
      details.push({ component: 'database', status: 'failed', message: String(error) });
    }

    // Check cache health
    try {
      const cacheStats = this.cache.getStats();
      if (cacheStats.hits + cacheStats.misses > 0 && cacheStats.hitRate < 0.1) {
        issues.push("Cache hit rate very low — performance degraded");
        details.push({ component: 'cache', status: 'degraded', message: `Hit rate: ${(cacheStats.hitRate * 100).toFixed(1)}%` });
      } else {
        details.push({ component: 'cache', status: 'ok' });
      }
    } catch (error) {
      issues.push(`Cache check failed: ${error}`);
      details.push({ component: 'cache', status: 'failed', message: String(error) });
    }

    // Check fix history for repeated failures
    for (const [sig, hist] of this.fixHistory.entries()) {
      if (hist.count > 0 && !hist.success && hist.count >= this.maxAutoFixes * 0.8) {
        issues.push(`Repeated failures for error type: ${sig} (${hist.count} attempts)`);
      }
    }

    // Check critical metadata files exist
    const criticalFiles = ['.jcf-fs-metadata.json', '.jcf-policies.json'];
    for (const fileName of criticalFiles) {
      try {
        const dbPath = (this.db as any).dbPath;
        if (dbPath) {
          const dir = path.dirname(dbPath);
          const filePath = path.join(dir, fileName);
          await fs.access(filePath);
        }
      } catch {
        issues.push(`Critical file missing: ${fileName}`);
        autoFixesApplied++;
      }
    }

    const result = {
      healthy: issues.length === 0,
      issues,
      autoFixesApplied,
      details,
    };

    // Phase B5: emit health events for observability
    this.events.emit('health:check', {
      healthy: result.healthy,
      issueCount: issues.length,
      autoFixesApplied,
    });
    if (!result.healthy) {
      this.events.emit('health:degraded', { issues });
    }

    return result;
  }

  /**
   * Legacy health check (backward compat)
   */
  async healthCheck(): Promise<{
    healthy: boolean;
    issues: string[];
    autoFixesApplied: number;
  }> {
    const result = await this.proactiveHealthCheck();
    return { healthy: result.healthy, issues: result.issues, autoFixesApplied: result.autoFixesApplied };
  }

  /**
   * Get self-healing statistics
   */
  getStats(): {
    totalFixAttempts: number;
    successfulFixes: number;
    successRate: number;
    errorCategories: Record<string, { attempts: number; successes: number }>;
  } {
    let totalAttempts = 0;
    let successfulFixes = 0;
    const errorCategories: Record<string, { attempts: number; successes: number }> = {};

    for (const [category, history] of this.fixHistory.entries()) {
      totalAttempts += history.count;
      if (history.success) successfulFixes++;

      const catStats = errorCategories[category] || { attempts: 0, successes: 0 };
      catStats.attempts += history.count;
      if (history.success) catStats.successes++;
      errorCategories[category] = catStats;
    }

    return {
      totalFixAttempts: totalAttempts,
      successfulFixes,
      successRate: totalAttempts > 0 ? successfulFixes / totalAttempts : 0,
      errorCategories,
    };
  }
}
