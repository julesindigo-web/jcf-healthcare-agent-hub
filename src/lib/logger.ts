import pino from 'pino';
import { PerformanceObserver, performance } from 'perf_hooks';

/**
 * JCF-Grade Structured Logger
 *
 * Features:
 * - Multi-level logging with color coding
 * - Performance metrics tracking
 * - Audit trail with context
 * - JSON output for machine parsing
 * - Human-readable console output with colors
 */
interface LogContext {
  timestamp?: string;
  uptime?: number;
  [key: string]: unknown;
}

export class Logger {
  private logger: pino.Logger;
  private readonly startTime: number;
  private metrics: Map<string, number[]> = new Map();

  constructor(level: pino.Level = 'info') {
    this.startTime = performance.now();

    this.logger = pino({
      level,
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level (label) {
          return { level: label };
        },
      },
      hooks: {
        // Add performance metrics to each log entry
        logMethod: (inputArgs: unknown[]) => {
          const firstArg = inputArgs[0];
          if (typeof firstArg === 'object' && firstArg !== null) {
            const context = firstArg as LogContext;
            context.timestamp = new Date().toISOString();
            context.uptime = performance.now() - this.startTime;
          }
          return inputArgs;
        },
      },
    });

    // Setup performance observer for automatic metric collection
    this.setupPerformanceObserver();
  }

  private setupPerformanceObserver(): void {
    try {
      const obs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this.recordMetric(entry.name, entry.duration);
        }
      });
      obs.observe({ entryTypes: ['measure'] });
    } catch {
      // PerformanceObserver not supported in this environment
    }
  }

  /**
   * Record a performance metric
   */
  recordMetric(name: string, value: number): void {
    const existing = this.metrics.get(name) || [];
    existing.push(value);
    this.metrics.set(name, existing);
  }

  /**
   * Get performance statistics for a metric
   */
  getMetricStats(name: string): { count: number; avg: number; max: number; min: number } | null {
    const values = this.metrics.get(name);
    if (!values || values.length === 0) return null;

    const sum = values.reduce((a, b) => a + b, 0);
    return {
      count: values.length,
      avg: sum / values.length,
      max: Math.max(...values),
      min: Math.min(...values),
    };
  }

  /**
   * Log with context
   */
  info(message: string, context?: Record<string, unknown>): void {
    if (context) {
      this.logger.info(message, context);
    } else {
      this.logger.info(message);
    }
  }

  debug(message: string, context?: Record<string, unknown>): void {
    if (context) {
      this.logger.debug(message, context);
    } else {
      this.logger.debug(message);
    }
  }

  warn(message: string, context?: Record<string, unknown>): void {
    if (context) {
      this.logger.warn(message, context);
    } else {
      this.logger.warn(message);
    }
  }

  error(message: string, error?: Error, context?: Record<string, unknown>): void {
    const logContext: Record<string, unknown> = {
      ...context,
      error: {
        name: error?.name,
        message: error?.message,
        stack: error?.stack,
      },
    };
    this.logger.error(message, logContext);
  }

  /**
   * Audit log - for security and compliance events
   */
  audit(event: string, actor: string, resource: string, action: string, outcome: 'success' | 'failure', metadata?: Record<string, unknown>): void {
    this.logger.info({
      type: 'audit',
      event,
      actor,
      resource,
      action,
      outcome,
      timestamp: new Date().toISOString(),
      metadata,
    }, `AUDIT: ${event}`);
  }

  /**
   * Child logger with bound context (for component-scoped logging)
   */
  child(context: Record<string, unknown>): pino.Logger {
    return this.logger.child(context);
  }

  /**
   * Flush logs (ensure all pending logs are written)
   */
  async flush(): Promise<void> {
    return new Promise((resolve) => {
      this.logger.flush(() => resolve());
    });
  }

  /**
   * Get all performance metrics
   */
  getAllMetrics(): Map<string, { count: number; avg: number; max: number; min: number }> {
    const result = new Map<string, { count: number; avg: number; max: number; min: number }>();
    for (const [name, values] of this.metrics) {
      if (values.length > 0) {
        const sum = values.reduce((a, b) => a + b, 0);
        result.set(name, {
          count: values.length,
          avg: sum / values.length,
          max: Math.max(...values),
          min: Math.min(...values),
        });
      }
    }
    return result;
  }
}

// Singleton instance for global logging
let globalLogger: Logger | null = null;

/**
 * Initialize global logger
 */
export function initLogger(level?: pino.Level): Logger {
  if (!globalLogger) {
    globalLogger = new Logger(level);
  }
  return globalLogger;
}

/**
 * Get global logger instance
 */
export function getLogger(): Logger {
  if (!globalLogger) {
    globalLogger = initLogger();
  }
  return globalLogger;
}
