/**
 * EmbeddingClient — HTTP bridge to JCF Qwen3-Embedding service.
 *
 * Consumes the JCF dashboard API `POST /api/embed` (default http://127.0.0.1:8742)
 * which wraps the Qwen3-Embedding-0.6B model (1024-dim, instruction-aware, 32K ctx).
 *
 * Design principles:
 *   1. Graceful degradation — if service is unreachable or erroring, the client
 *      returns null, logs the incident, and remembers "degraded" for a cooldown
 *      window so we don't hammer a dead service.
 *   2. Tri-state availability — null (unknown), true (healthy), false (degraded).
 *   3. Re-probe after `reprobeMs` (default 60s) when degraded.
 *   4. Instruction-aware — `embedQuery` sends `instruct`, server formats
 *      `"Instruct: {instruct}\nQuery: {query}"` (per Qwen3 HuggingFace docs).
 *   5. Batch where possible — `embedDocuments` sends all texts in a single POST.
 *   6. Zero runtime dependencies — uses native Node 20+ `fetch`.
 *
 * Callers should always handle `null` as "Qwen3 unavailable, fall back to tf-idf".
 */

import { Logger } from './logger.js';

export interface EmbeddingClientConfig {
  url: string;
  timeoutMs: number;
  reprobeMs: number;
  enabled: boolean;
  logger: Logger;
  /** Default instruction for query embedding (overridable per call). */
  defaultInstruct?: string;
  /**
   * Maximum number of texts to send in a single HTTP POST. When the
   * caller passes more than this in {@link EmbeddingClient.embedDocuments},
   * the array is split into ⌈N/chunkSize⌉ sub-batches that are
   * dispatched serially and reassembled in order. Defaults to 100,
   * which keeps a worst-case 1024-dim float32 payload well under
   * 1 MB even for verbose snippets.
   */
  batchChunkSize?: number;
  /**
   * Timeout budget (in ms) for the warmup POST. Defaults to
   * `timeoutMs`. Splitting it out lets ops set a generous warmup
   * budget (cold load is ~7.3 s) without inflating the per-request
   * timeout used by hot-path embeds.
   */
  warmupTimeoutMs?: number;
  /**
   * SSRF mitigation — host allowlist for embedding endpoint URL.
   * Every outbound request URL (embed, health, warmup) must resolve
   * to a hostname literally present in this list, otherwise the
   * constructor + per-fetch validator throw. Defaults to loopback
   * only: `['127.0.0.1', '::1', 'localhost']`.
   *
   * Threat model: a malicious or compromised config file (or env
   * var override of embeddingUrl) could otherwise turn the embedding
   * client into an internal-network probe reaching private services
   * on 10.x / 192.168.x / 169.254.x ranges, AWS IMDS at
   * 169.254.169.254, GCE metadata, etc.
   *
   * DNS-rebinding mitigation: the validator does literal hostname
   * matching, never DNS resolution. An allowlist entry of `localhost`
   * matches ONLY the literal string "localhost" — not a hostname that
   * a poisoned resolver claims maps to 127.0.0.1.
   *
   * Override via env JCF_EMBEDDING_ALLOWED_HOSTS (comma-separated).
   */
  allowedHosts?: readonly string[];
}

/**
 * Default SSRF allowlist — loopback only. Production deployments may
 * widen this via {@link EmbeddingClientConfig.allowedHosts} after
 * explicit operator decision about which interface the embedding
 * service binds to.
 */
export const DEFAULT_ALLOWED_EMBEDDING_HOSTS: readonly string[] = Object.freeze([
  '127.0.0.1',
  '::1',
  'localhost',
]);

/**
 * Validate an embedding-endpoint URL against the SSRF allowlist.
 *
 * Throws on:
 *   - malformed URL (URL constructor reject)
 *   - non-http(s) scheme (blocks file://, ftp://, gopher://, javascript:, data:)
 *   - empty hostname
 *   - hostname not literally present in `allowedHosts`
 *
 * Exported for unit tests; production callers go through the
 * {@link EmbeddingClient} constructor + per-fetch wrappers.
 */
export function validateEmbeddingUrl(
  rawUrl: string,
  allowedHosts: readonly string[]
): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`EmbeddingClient: malformed URL "${rawUrl}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `EmbeddingClient: scheme "${parsed.protocol}" not allowed in "${rawUrl}" — ` +
        `only http: and https: are permitted (SSRF mitigation: blocks file://, ftp://, ` +
        `gopher://, javascript:, data: schemes commonly abused in SSRF chains).`
    );
  }
  // URL.hostname keeps square brackets around IPv6 — strip them for matching.
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (host.length === 0) {
    throw new Error(`EmbeddingClient: empty hostname in URL "${rawUrl}"`);
  }
  if (!allowedHosts.includes(host)) {
    throw new Error(
      `EmbeddingClient: host "${host}" not in allowedHosts ` +
        `${JSON.stringify(allowedHosts)} for URL "${rawUrl}". ` +
        `SSRF mitigation rejects non-allowlisted hosts. Override via ` +
        `mcp-fs-config.json:embeddingAllowedHosts or env ` +
        `JCF_EMBEDDING_ALLOWED_HOSTS (comma-separated). DNS rebinding is ` +
        `mitigated by literal-only matching — list the actual IP if you need it.`
    );
  }
  return parsed;
}

interface EmbedServerResponse {
  status: 'ok' | 'error';
  embeddings?: number[][];
  model?: string;
  backend?: string;
  dims?: number;
  /**
   * Producer fingerprint — ``"{backend}:{model}:{dim}"``. Captured by
   * Phase A of the M12 ADR-006 refactor on the Python side; consumed
   * here so the client can pin a stable contract and surface drift.
   */
  embedding_version?: string;
  message?: string;
}

/**
 * Shape of `GET /api/embed/health` introduced by Phase A of ADR-006.
 * Carries the producer fingerprint without invoking the model.
 */
interface EmbedHealthResponse {
  status: 'ok' | 'error';
  model?: string;
  backend?: string;
  dims?: number;
  embedding_version?: string;
  loaded?: boolean;
  ready?: boolean;
  message?: string;
}

/**
 * Shape of `POST /api/embed/warmup` introduced by Phase A of ADR-006.
 * Returns the model fingerprint + the cold-load duration so callers
 * can surface "warmup took N ms" telemetry without inferring it from
 * an embed call.
 */
interface EmbedWarmupResponse {
  status: 'ok' | 'error';
  duration_ms?: number;
  model?: string;
  backend?: string;
  dims?: number;
  embedding_version?: string;
  message?: string;
}

export interface EmbeddingHealth {
  available: boolean | null;
  url: string;
  enabled: boolean;
  model?: string | undefined;
  backend?: string | undefined;
  dims?: number | undefined;
  /** Latest captured producer fingerprint (``embedding_version`` in
   *  the wire payload). ``undefined`` until the first successful call. */
  embeddingVersion?: string | undefined;
  lastError?: string | undefined;
  lastProbeAt?: number | undefined;
}

const DEFAULT_INSTRUCT_FILE =
  'Find the most relevant code, configuration, or documentation for the given query';

export class EmbeddingClient {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly reprobeMs: number;
  private readonly enabled: boolean;
  private readonly logger: Logger;
  private readonly defaultInstruct: string;
  private readonly batchChunkSize: number;
  private readonly warmupTimeoutMs: number;
  private readonly allowedHosts: readonly string[];

  /** Tri-state: null=unknown, true=healthy, false=degraded. */
  private available: boolean | null = null;
  private lastProbeAt: number = 0;
  private lastError: string | undefined;
  private serverInfo: {
    model?: string | undefined;
    backend?: string | undefined;
    dims?: number | undefined;
    /** Captured ``embedding_version`` from the latest ok response.
     *  Pinned across calls; only updated when the server changes it. */
    embeddingVersion?: string | undefined;
  } = {};

  constructor(config: EmbeddingClientConfig) {
    this.url = config.url;
    this.timeoutMs = config.timeoutMs;
    this.reprobeMs = config.reprobeMs;
    this.enabled = config.enabled;
    this.logger = config.logger;
    this.defaultInstruct = config.defaultInstruct ?? DEFAULT_INSTRUCT_FILE;
    this.batchChunkSize = Math.max(1, config.batchChunkSize ?? 100);
    this.warmupTimeoutMs = Math.max(
      1,
      config.warmupTimeoutMs ?? Math.max(config.timeoutMs, 30000)
    );
    // T3.1 SSRF mitigation: resolve allowlist (config > env > default loopback)
    // and validate the configured URL up-front so a bad config blows up at
    // boot rather than at first embed call.
    const envHosts = process.env.JCF_EMBEDDING_ALLOWED_HOSTS;
    if (config.allowedHosts && config.allowedHosts.length > 0) {
      this.allowedHosts = config.allowedHosts;
    } else if (envHosts && envHosts.length > 0) {
      this.allowedHosts = envHosts
        .split(',')
        .map((h) => h.trim())
        .filter((h) => h.length > 0);
    } else {
      this.allowedHosts = DEFAULT_ALLOWED_EMBEDDING_HOSTS;
    }
    if (this.enabled) {
      // Throws on misconfig. We only validate when enabled — if the operator
      // has turned the embedder off we don't care what the URL looks like.
      validateEmbeddingUrl(this.url, this.allowedHosts);
    }
  }

  // ── Companion endpoint URL helpers (ADR-006 M12) ──

  /** GET /api/embed/health URL derived from the configured embed URL. */
  private healthUrl(): string {
    return `${this.url.replace(/\/+$/, '')}/health`;
  }

  /** POST /api/embed/warmup URL derived from the configured embed URL. */
  private warmupUrl(): string {
    return `${this.url.replace(/\/+$/, '')}/warmup`;
  }

  /**
   * Returns true if the embedding endpoint is currently believed healthy.
   * Re-probes after `reprobeMs` when degraded.
   */
  async isAvailable(): Promise<boolean> {
    if (!this.enabled) return false;
    if (this.available === true) return true;
    const now = Date.now();
    if (this.available === false && now - this.lastProbeAt < this.reprobeMs) {
      return false;
    }
    return this.probe();
  }

  /**
   * Low-level probe — hits the lightweight `GET /api/embed/health`
   * endpoint introduced by Phase A of ADR-006 (M12). Previous
   * implementation issued a real embed request as a healthcheck,
   * burning a full forward pass per probe. The new path returns
   * the producer fingerprint (model, backend, dims, embedding_version)
   * without invoking the model — typical latency < 5 ms.
   *
   * Server contract: any 2xx response with `status==="ok"` marks
   * available. Non-2xx, JSON parse error, network error, or status
   * !== "ok" all mark degraded.
   */
  private async probe(): Promise<boolean> {
    this.lastProbeAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // T3.1 SSRF: defense-in-depth re-validation at fetch time.
      validateEmbeddingUrl(this.healthUrl(), this.allowedHosts);
      const res = await fetch(this.healthUrl(), {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
        // M14 (Bug #6 — P1 Security): reject redirects to prevent SSRF.
        // A compromised embedding server could 302 to internal hosts.
        redirect: 'error',
      });
      if (!res.ok) {
        this.markDegraded(`HTTP ${res.status}`, /*silent*/ true);
        return false;
      }
      const json = (await res.json()) as EmbedHealthResponse;
      if (json.status !== 'ok') {
        this.markDegraded(json.message ?? 'status=error', /*silent*/ true);
        return false;
      }
      // Capture producer fingerprint for the health snapshot. The
      // server is the source of truth for these — we never infer them
      // from the embed payload when /health is reachable.
      const info: typeof this.serverInfo = {};
      if (json.model !== undefined) info.model = json.model;
      if (json.backend !== undefined) info.backend = json.backend;
      if (json.dims !== undefined) info.dims = json.dims;
      if (json.embedding_version !== undefined) {
        info.embeddingVersion = json.embedding_version;
      }
      this.serverInfo = info;
      this.available = true;
      this.lastError = undefined;
      this.logger.info('EmbeddingClient healthy via /health probe', {
        url: this.healthUrl(),
        model: info.model,
        backend: info.backend,
        dims: info.dims,
        embeddingVersion: info.embeddingVersion,
        loaded: json.loaded,
      });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.markDegraded(msg, /*silent*/ true);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Eager pre-warm — sends `POST /api/embed/warmup` to amortise the
   * ~7.3 s safetensors cold-load cost before the first real index
   * call. Best-effort: any failure (404, network down, timeout) is
   * swallowed and the client falls back to the lazy-load path on the
   * next embed. Returns the duration the server reported, or
   * `undefined` if the call failed.
   *
   * Idempotent: subsequent calls hit the singleton + cache and return
   * sub-millisecond duration.
   */
  async preWarm(): Promise<number | undefined> {
    if (!this.enabled) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.warmupTimeoutMs);
    try {
      const res = await fetch(this.warmupUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: controller.signal,
        // M14 (Bug #6 — P1 Security): reject redirects to prevent SSRF.
        redirect: 'error',
      });
      if (!res.ok) {
        this.logger.warn('EmbeddingClient pre-warm returned non-2xx', {
          url: this.warmupUrl(),
          status: res.status,
        });
        return undefined;
      }
      const json = (await res.json()) as EmbedWarmupResponse;
      if (json.status !== 'ok') {
        this.logger.warn('EmbeddingClient pre-warm reported error', {
          url: this.warmupUrl(),
          message: json.message,
        });
        return undefined;
      }
      // Capture producer fingerprint — pre-warm carries the same
      // fields as /health, so the client can pin a contract before
      // any real embed has happened.
      const info: typeof this.serverInfo = {};
      if (json.model !== undefined) info.model = json.model;
      if (json.backend !== undefined) info.backend = json.backend;
      if (json.dims !== undefined) info.dims = json.dims;
      if (json.embedding_version !== undefined) {
        info.embeddingVersion = json.embedding_version;
      }
      this.serverInfo = info;
      this.available = true;
      this.lastError = undefined;
      this.lastProbeAt = Date.now();
      this.logger.info('EmbeddingClient pre-warm complete', {
        url: this.warmupUrl(),
        durationMs: json.duration_ms,
        embeddingVersion: info.embeddingVersion,
      });
      return json.duration_ms;
    } catch (err) {
      this.logger.warn('EmbeddingClient pre-warm threw', {
        url: this.warmupUrl(),
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Embed a single query (with instruction prefix, Qwen3 instruct-aware format).
   * Returns null if the bridge is unavailable.
   */
  async embedQuery(query: string, instruct?: string): Promise<number[] | null> {
    if (!this.enabled) return null;
    const vecs = await this.doEmbed([query], instruct ?? this.defaultInstruct);
    return vecs ? vecs[0] ?? null : null;
  }

  /**
   * Batch-embed multiple documents (no instruction prefix — use for indexing).
   * Returns null on failure, preserving order & length on success.
   *
   * **M12 batch chunking** — when `texts.length > batchChunkSize`,
   * the array is split into ⌈N/chunkSize⌉ sub-batches dispatched
   * serially and reassembled in order. This keeps each HTTP payload
   * under ~1 MB even for 1024-dim float vectors and prevents the
   * Python FastAPI parser from staring down a multi-MB body. Any
   * sub-batch failure short-circuits the whole call (returns null);
   * partial results are not returned because the caller has no way
   * to distinguish "partial success" from "complete success" via the
   * legacy contract.
   */
  async embedDocuments(texts: string[]): Promise<number[][] | null> {
    if (!this.enabled || texts.length === 0) {
      return texts.length === 0 ? [] : null;
    }
    if (texts.length <= this.batchChunkSize) {
      return this.doEmbed(texts);
    }
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchChunkSize) {
      const chunk = texts.slice(i, i + this.batchChunkSize);
      const result = await this.doEmbed(chunk);
      if (!result) return null;
      out.push(...result);
    }
    return out;
  }

  /** Current health snapshot — cheap, no I/O. */
  getHealth(): EmbeddingHealth {
    const health: EmbeddingHealth = {
      available: this.available,
      url: this.url,
      enabled: this.enabled,
    };
    if (this.serverInfo.model !== undefined) health.model = this.serverInfo.model;
    if (this.serverInfo.backend !== undefined) health.backend = this.serverInfo.backend;
    if (this.serverInfo.dims !== undefined) health.dims = this.serverInfo.dims;
    if (this.serverInfo.embeddingVersion !== undefined) {
      health.embeddingVersion = this.serverInfo.embeddingVersion;
    }
    if (this.lastError !== undefined) health.lastError = this.lastError;
    if (this.lastProbeAt > 0) health.lastProbeAt = this.lastProbeAt;
    return health;
  }

  /**
   * Latest captured producer fingerprint
   * (``"{backend}:{model}:{dim}"``). Used by {@link VectorDB} to tag
   * stored qwen3 vectors so they can be invalidated when the producer
   * flips backends. Returns ``undefined`` when the bridge has never
   * responded successfully — callers must guard before storing.
   *
   * Phase C will expand this to read from the dedicated
   * ``GET /api/embed/health`` endpoint instead of relying on the
   * value carried by the most recent embed response. Until then, the
   * field is populated as a side effect of the first successful
   * {@link embedDocuments} or {@link embedQuery} call.
   */
  embeddingVersion(): string | undefined {
    return this.serverInfo.embeddingVersion;
  }

  /** Force a re-probe on next call. */
  invalidate(): void {
    this.available = null;
    this.lastProbeAt = 0;
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private async doEmbed(
    texts: string[],
    instruct?: string,
    silent = false
  ): Promise<number[][] | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const body: Record<string, unknown> = { texts };
      if (instruct) body.instruct = instruct;

      // T3.1 SSRF: defense-in-depth re-validation at fetch time.
      validateEmbeddingUrl(this.url, this.allowedHosts);
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
        // M14 (Bug #6 — P1 Security): reject redirects to prevent SSRF.
        redirect: 'error',
      });

      if (!res.ok) {
        this.markDegraded(`HTTP ${res.status}`, silent);
        return null;
      }

      const json = (await res.json()) as EmbedServerResponse;

      if (json.status !== 'ok' || !json.embeddings) {
        this.markDegraded(json.message ?? 'status=error', silent);
        return null;
      }

      // Remember server fingerprint for health snapshot
      const info: {
        model?: string | undefined;
        backend?: string | undefined;
        dims?: number | undefined;
        embeddingVersion?: string | undefined;
      } = {};
      if (json.model !== undefined) info.model = json.model;
      if (json.backend !== undefined) info.backend = json.backend;
      const dims = json.dims ?? json.embeddings[0]?.length;
      if (dims !== undefined) info.dims = dims;
      // ADR-006 (M12) — capture the producer fingerprint so the
      // VectorDB backfill loop can pin a stable contract and the
      // search path can drop stale stored vectors after a backend swap.
      if (json.embedding_version !== undefined) {
        info.embeddingVersion = json.embedding_version;
      }
      this.serverInfo = info;
      this.available = true;
      this.lastError = undefined;
      return json.embeddings;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.markDegraded(msg, silent);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private markDegraded(reason: string, silent: boolean): void {
    const wasAvailable = this.available;
    this.available = false;
    this.lastError = reason;
    this.lastProbeAt = Date.now();
    if (!silent && wasAvailable !== false) {
      // Only log transition, not every call while already degraded.
      this.logger.warn('EmbeddingClient degraded', { url: this.url, reason });
    }
  }
}

/**
 * Compute cosine similarity between two unit-normalized vectors.
 * Qwen3 server already L2-normalizes, so we just dot-product.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * Reciprocal Rank Fusion — combine two independent rankings into one score.
 * k=60 is the canonical value from Cormack et al., 2009.
 */
export function rrfScore(rank: number, k: number = 60): number {
  return 1 / (k + rank);
}
