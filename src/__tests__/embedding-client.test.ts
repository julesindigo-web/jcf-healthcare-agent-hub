/**
 * EmbeddingClient unit tests — mocks `global.fetch` to exercise:
 *  - happy path (ok response, server fingerprint captured)
 *  - error status (graceful degrade, returns null)
 *  - network error (thrown in fetch)
 *  - timeout / AbortController
 *  - re-probe cooldown behaviour
 *  - instruction-aware query vs plain document embedding
 *  - RRF + cosine helpers
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EmbeddingClient,
  cosineSimilarity,
  rrfScore,
  validateEmbeddingUrl,
  DEFAULT_ALLOWED_EMBEDDING_HOSTS,
} from '../lib/embedding-client';
import { Logger } from '../lib/logger';

const URL = 'http://127.0.0.1:8742/api/embed';

function makeClient(overrides: Partial<{
  url: string;
  timeoutMs: number;
  reprobeMs: number;
  enabled: boolean;
}> = {}) {
  const logger = new Logger('error'); // silence info during tests
  return new EmbeddingClient({
    url: overrides.url ?? URL,
    timeoutMs: overrides.timeoutMs ?? 5000,
    reprobeMs: overrides.reprobeMs ?? 60000,
    enabled: overrides.enabled ?? true,
    logger,
  });
}

function okResponse(vectors: number[][], model = 'Qwen3-Embedding-0.6B'): Response {
  return new Response(
    JSON.stringify({
      status: 'ok',
      embeddings: vectors,
      model,
      backend: 'safetensors',
      dims: vectors[0]?.length ?? 0,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

function errorResponse(message: string): Response {
  return new Response(JSON.stringify({ status: 'error', message }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('EmbeddingClient', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // ── happy path ─────────────────────────────────────────────────────

  it('embedDocuments returns vectors on ok response', async () => {
    const vec = new Array(1024).fill(0).map((_, i) => (i === 0 ? 1 : 0));
    fetchSpy.mockResolvedValue(okResponse([vec]));

    const c = makeClient();
    const result = await c.embedDocuments(['hello']);

    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);
    expect(result![0]!.length).toBe(1024);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Verify body sent (no instruct for documents)
    const call = fetchSpy.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(call.body as string);
    expect(body.texts).toEqual(['hello']);
    expect(body.instruct).toBeUndefined();
  });

  it('embedQuery sends instruct field in body', async () => {
    const vec = new Array(1024).fill(0);
    fetchSpy.mockResolvedValue(okResponse([vec]));

    const c = makeClient();
    const result = await c.embedQuery('find auth flow', 'custom instruct');

    expect(result).toEqual(vec);
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.texts).toEqual(['find auth flow']);
    expect(body.instruct).toBe('custom instruct');
  });

  it('embedQuery uses defaultInstruct when none provided', async () => {
    const vec = new Array(4).fill(0.5);
    fetchSpy.mockResolvedValue(okResponse([vec]));

    const c = new EmbeddingClient({
      url: URL,
      timeoutMs: 1000,
      reprobeMs: 60000,
      enabled: true,
      logger: new Logger('error'),
      defaultInstruct: 'custom default',
    });

    await c.embedQuery('q');
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.instruct).toBe('custom default');
  });

  it('captures server fingerprint after first successful call', async () => {
    fetchSpy.mockResolvedValue(okResponse([[0.1, 0.2]], 'Qwen3-Embedding-0.6B'));

    const c = makeClient();
    await c.embedDocuments(['x']);

    const health = c.getHealth();
    expect(health.available).toBe(true);
    expect(health.model).toBe('Qwen3-Embedding-0.6B');
    expect(health.backend).toBe('safetensors');
    expect(health.dims).toBe(2);
  });

  // ── graceful degradation ───────────────────────────────────────────

  it('returns null when server responds with status=error', async () => {
    fetchSpy.mockResolvedValue(errorResponse('model load failed'));

    const c = makeClient();
    const result = await c.embedDocuments(['x']);

    expect(result).toBeNull();
    expect(c.getHealth().available).toBe(false);
    expect(c.getHealth().lastError).toBe('model load failed');
  });

  it('returns null on HTTP 500', async () => {
    fetchSpy.mockResolvedValue(new Response('internal error', { status: 500 }));

    const c = makeClient();
    const result = await c.embedDocuments(['x']);

    expect(result).toBeNull();
    expect(c.getHealth().lastError).toContain('500');
  });

  it('returns null when network throws', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));

    const c = makeClient();
    const result = await c.embedDocuments(['x']);

    expect(result).toBeNull();
    expect(c.getHealth().available).toBe(false);
    expect(c.getHealth().lastError).toContain('ECONNREFUSED');
  });

  it('returns null when enabled=false (bridge off)', async () => {
    const c = makeClient({ enabled: false });
    const result = await c.embedDocuments(['x']);
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ── cooldown after failure ─────────────────────────────────────────

  it('does not re-probe within reprobeMs window after failure', async () => {
    fetchSpy.mockResolvedValueOnce(errorResponse('down'));

    const c = makeClient({ reprobeMs: 10_000 });
    // First call fails and marks degraded
    await c.embedDocuments(['x']);
    expect(c.getHealth().available).toBe(false);

    // Second isAvailable() within cooldown should return false WITHOUT new fetch
    const avail = await c.isAvailable();
    expect(avail).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // no re-probe
  });

  it('isAvailable re-probes after reprobeMs elapses', async () => {
    fetchSpy.mockResolvedValueOnce(errorResponse('down'));

    const c = makeClient({ reprobeMs: 50 });
    await c.embedDocuments(['x']);
    expect(c.getHealth().available).toBe(false);

    // Wait past reprobe window (deterministic with fake timers)
    vi.advanceTimersByTime(80);

    // Now service recovered
    fetchSpy.mockResolvedValueOnce(okResponse([[0.5]]));
    const avail = await c.isAvailable();
    expect(avail).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2); // original + reprobe
  });

  it('invalidate() forces immediate re-probe on next call', async () => {
    fetchSpy.mockResolvedValueOnce(okResponse([[0.1]]));
    const c = makeClient();
    await c.embedDocuments(['x']);
    expect(c.getHealth().available).toBe(true);

    c.invalidate();

    fetchSpy.mockResolvedValueOnce(okResponse([[0.2]]));
    const avail = await c.isAvailable();
    expect(avail).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2); // original + forced re-probe
  });

  // ── batch + edge cases ─────────────────────────────────────────────

  it('embedDocuments with empty array returns [] without fetching', async () => {
    const c = makeClient();
    const result = await c.embedDocuments([]);
    expect(result).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('embedDocuments batches multiple texts in single fetch call', async () => {
    const vecs = [[0.1, 0.2], [0.3, 0.4], [0.5, 0.6]];
    fetchSpy.mockResolvedValue(okResponse(vecs));

    const c = makeClient();
    const result = await c.embedDocuments(['a', 'b', 'c']);

    expect(result).toEqual(vecs);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.texts).toEqual(['a', 'b', 'c']);
  });

  it('timeout aborts the request', async () => {
    // Simulate fetch that respects AbortSignal
    fetchSpy.mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        const signal = (init as RequestInit).signal!;
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    });

    const c = makeClient({ timeoutMs: 50 });
    // Start the embed call (it will hang on the mocked fetch)
    const promise = c.embedDocuments(['x']);
    // Advance fake timers so the AbortController's setTimeout fires
    await vi.advanceTimersByTimeAsync(60);
    const result = await promise;
    expect(result).toBeNull();
    expect(c.getHealth().lastError).toMatch(/abort/i);
  });
});

describe('cosineSimilarity', () => {
  it('returns 1 for identical unit vectors', () => {
    const v = [0.6, 0.8]; // unit vector (3-4-5 triangle)
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  it('returns 0 for orthogonal unit vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it('returns 0 for length-mismatched vectors (safe guard)', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0])).toBe(0);
  });

  it('computes dot product correctly', () => {
    // [0.6, 0.8] · [0.8, 0.6] = 0.48 + 0.48 = 0.96
    expect(cosineSimilarity([0.6, 0.8], [0.8, 0.6])).toBeCloseTo(0.96, 5);
  });
});

describe('rrfScore', () => {
  it('rank 1 yields higher score than rank 10 with k=60', () => {
    expect(rrfScore(1)).toBeGreaterThan(rrfScore(10));
  });

  it('k parameter modifies curve', () => {
    expect(rrfScore(1, 10)).toBeGreaterThan(rrfScore(1, 100));
  });

  it('rrfScore(1) = 1/61 with default k=60', () => {
    expect(rrfScore(1)).toBeCloseTo(1 / 61, 10);
  });
});

// ─────────────────────────────────────────────────────────────────────
// M12 — ADR-006 Phase C additions
//   * GET /api/embed/health probe
//   * POST /api/embed/warmup pre-warm
//   * embedDocuments batch chunking
// ─────────────────────────────────────────────────────────────────────

function healthResponse(overrides: Partial<{
  model: string;
  backend: string;
  dims: number;
  embedding_version: string;
  loaded: boolean;
  ready: boolean;
}> = {}): Response {
  return new Response(
    JSON.stringify({
      status: 'ok',
      model: overrides.model ?? 'Qwen3-Embedding-0.6B',
      backend: overrides.backend ?? 'safetensors',
      dims: overrides.dims ?? 1024,
      embedding_version:
        overrides.embedding_version ?? 'safetensors:Qwen3-Embedding-0.6B:1024',
      loaded: overrides.loaded ?? true,
      ready: overrides.ready ?? true,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

function warmupResponse(overrides: Partial<{
  duration_ms: number;
  embedding_version: string;
  model: string;
  backend: string;
  dims: number;
}> = {}): Response {
  return new Response(
    JSON.stringify({
      status: 'ok',
      duration_ms: overrides.duration_ms ?? 7300,
      embedding_version:
        overrides.embedding_version ?? 'safetensors:Qwen3-Embedding-0.6B:1024',
      model: overrides.model ?? 'Qwen3-Embedding-0.6B',
      backend: overrides.backend ?? 'safetensors',
      dims: overrides.dims ?? 1024,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

describe('EmbeddingClient — M12 /health probe', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('probe hits GET /api/embed/health (not POST /api/embed)', async () => {
    fetchSpy.mockResolvedValueOnce(healthResponse());
    const c = makeClient();
    const ok = await c.isAvailable();
    expect(ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchSpy.mock.calls[0]!;
    expect(calledUrl).toBe('http://127.0.0.1:8742/api/embed/health');
    expect((calledInit as RequestInit).method).toBe('GET');
  });

  it('probe captures embedding_version into health snapshot', async () => {
    fetchSpy.mockResolvedValueOnce(
      healthResponse({ embedding_version: 'safetensors:Qwen3:1024' })
    );
    const c = makeClient();
    await c.isAvailable();
    expect(c.embeddingVersion()).toBe('safetensors:Qwen3:1024');
    expect(c.getHealth().embeddingVersion).toBe('safetensors:Qwen3:1024');
  });

  it('probe marks degraded on HTTP 404 (server lacks /health)', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('not found', { status: 404 }));
    const c = makeClient();
    const ok = await c.isAvailable();
    expect(ok).toBe(false);
    expect(c.getHealth().available).toBe(false);
    expect(c.getHealth().lastError).toContain('404');
  });

  it('probe marks degraded on status=error response', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'error', message: 'boot' }), {
        status: 200,
      })
    );
    const c = makeClient();
    const ok = await c.isAvailable();
    expect(ok).toBe(false);
    expect(c.getHealth().lastError).toBe('boot');
  });

  it('probe marks degraded on network error', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const c = makeClient();
    const ok = await c.isAvailable();
    expect(ok).toBe(false);
    expect(c.getHealth().lastError).toContain('ECONNREFUSED');
  });
});

describe('EmbeddingClient — M12 preWarm', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('preWarm POSTs to /api/embed/warmup and returns reported duration', async () => {
    fetchSpy.mockResolvedValueOnce(warmupResponse({ duration_ms: 7295 }));
    const c = makeClient();
    const duration = await c.preWarm();
    expect(duration).toBe(7295);
    const [calledUrl, calledInit] = fetchSpy.mock.calls[0]!;
    expect(calledUrl).toBe('http://127.0.0.1:8742/api/embed/warmup');
    expect((calledInit as RequestInit).method).toBe('POST');
  });

  it('preWarm marks the client available + captures version on success', async () => {
    fetchSpy.mockResolvedValueOnce(
      warmupResponse({ embedding_version: 'safetensors:Qwen3:1024' })
    );
    const c = makeClient();
    expect(c.getHealth().available).toBeNull();
    await c.preWarm();
    expect(c.getHealth().available).toBe(true);
    expect(c.embeddingVersion()).toBe('safetensors:Qwen3:1024');
  });

  it('preWarm returns undefined on HTTP 500 without throwing', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('boom', { status: 500 })
    );
    const c = makeClient();
    const duration = await c.preWarm();
    expect(duration).toBeUndefined();
    // Bridge availability stays unknown — we don't claim degraded on
    // pre-warm failure; the next isAvailable() probe gets to decide.
    expect(c.getHealth().available).toBeNull();
  });

  it('preWarm returns undefined on status=error without throwing', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ status: 'error', message: 'model file missing' }),
        { status: 200 }
      )
    );
    const c = makeClient();
    const duration = await c.preWarm();
    expect(duration).toBeUndefined();
  });

  it('preWarm returns undefined when bridge disabled', async () => {
    const c = makeClient({ enabled: false });
    const duration = await c.preWarm();
    expect(duration).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('EmbeddingClient — M12 batch chunking', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('arrays larger than batchChunkSize are split into sub-batches', async () => {
    // Configure a small chunk size so we don't need a 100+ array.
    const logger = new Logger('error');
    const c = new EmbeddingClient({
      url: URL,
      timeoutMs: 5000,
      reprobeMs: 60000,
      enabled: true,
      logger,
      batchChunkSize: 3,
    });

    fetchSpy
      .mockResolvedValueOnce(okResponse([[1], [2], [3]]))
      .mockResolvedValueOnce(okResponse([[4], [5], [6]]))
      .mockResolvedValueOnce(okResponse([[7]]));

    const result = await c.embedDocuments(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(7);
    expect(result).toEqual([[1], [2], [3], [4], [5], [6], [7]]);
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    // Verify sub-batch boundaries
    const bodies = fetchSpy.mock.calls.map((call) =>
      JSON.parse((call[1] as RequestInit).body as string)
    );
    expect(bodies[0].texts).toEqual(['a', 'b', 'c']);
    expect(bodies[1].texts).toEqual(['d', 'e', 'f']);
    expect(bodies[2].texts).toEqual(['g']);
  });

  it('arrays at-or-below batchChunkSize use a single fetch', async () => {
    const logger = new Logger('error');
    const c = new EmbeddingClient({
      url: URL,
      timeoutMs: 5000,
      reprobeMs: 60000,
      enabled: true,
      logger,
      batchChunkSize: 5,
    });
    fetchSpy.mockResolvedValueOnce(okResponse([[1], [2], [3]]));
    const result = await c.embedDocuments(['x', 'y', 'z']);
    expect(result).not.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('any sub-batch failure returns null for the whole call', async () => {
    const logger = new Logger('error');
    const c = new EmbeddingClient({
      url: URL,
      timeoutMs: 5000,
      reprobeMs: 60000,
      enabled: true,
      logger,
      batchChunkSize: 2,
    });
    fetchSpy
      .mockResolvedValueOnce(okResponse([[1], [2]]))
      .mockResolvedValueOnce(errorResponse('mid-batch failure'));
    const result = await c.embedDocuments(['a', 'b', 'c', 'd']);
    expect(result).toBeNull();
    expect(c.getHealth().lastError).toBe('mid-batch failure');
  });

  it('default batchChunkSize is 100', async () => {
    // Implicit: makeClient() doesn't override batchChunkSize, so a
    // 50-element array should hit a single fetch.
    fetchSpy.mockResolvedValueOnce(
      okResponse(new Array(50).fill(0).map(() => [0]))
    );
    const c = makeClient();
    await c.embedDocuments(new Array(50).fill('x'));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// T3.1 — SSRF mitigation tests
// ─────────────────────────────────────────────────────────────────────

describe('validateEmbeddingUrl (T3.1 SSRF allowlist)', () => {
  it('accepts loopback IPv4 over http', () => {
    expect(() =>
      validateEmbeddingUrl('http://127.0.0.1:8742/api/embed', DEFAULT_ALLOWED_EMBEDDING_HOSTS)
    ).not.toThrow();
  });

  it('accepts literal "localhost" over http', () => {
    expect(() =>
      validateEmbeddingUrl('http://localhost:8742/api/embed', DEFAULT_ALLOWED_EMBEDDING_HOSTS)
    ).not.toThrow();
  });

  it('accepts loopback IPv6 with bracket notation', () => {
    expect(() =>
      validateEmbeddingUrl('http://[::1]:8742/api/embed', DEFAULT_ALLOWED_EMBEDDING_HOSTS)
    ).not.toThrow();
  });

  it('rejects private 10.x range (RFC1918) by default', () => {
    expect(() =>
      validateEmbeddingUrl('http://10.0.0.1:8742/api/embed', DEFAULT_ALLOWED_EMBEDDING_HOSTS)
    ).toThrow(/host "10\.0\.0\.1" not in allowedHosts/);
  });

  it('rejects AWS IMDS metadata endpoint by default', () => {
    expect(() =>
      validateEmbeddingUrl(
        'http://169.254.169.254/latest/meta-data/',
        DEFAULT_ALLOWED_EMBEDDING_HOSTS
      )
    ).toThrow(/host "169\.254\.169\.254" not in allowedHosts/);
  });

  it('rejects GCE metadata.google.internal by default', () => {
    expect(() =>
      validateEmbeddingUrl(
        'http://metadata.google.internal/computeMetadata/v1/',
        DEFAULT_ALLOWED_EMBEDDING_HOSTS
      )
    ).toThrow(/not in allowedHosts/);
  });

  it('rejects file:// scheme even with allowed host', () => {
    expect(() =>
      validateEmbeddingUrl('file:///etc/passwd', ['localhost', 'etc'])
    ).toThrow(/scheme "file:" not allowed/);
  });

  it('rejects ftp:// scheme', () => {
    expect(() =>
      validateEmbeddingUrl('ftp://127.0.0.1/secret', ['127.0.0.1'])
    ).toThrow(/scheme "ftp:" not allowed/);
  });

  it('rejects javascript: scheme (XSS-style SSRF chain)', () => {
    expect(() =>
      validateEmbeddingUrl('javascript:alert(1)', ['127.0.0.1'])
    ).toThrow(/scheme "javascript:" not allowed/);
  });

  it('rejects malformed URL', () => {
    expect(() =>
      validateEmbeddingUrl('not a url', DEFAULT_ALLOWED_EMBEDDING_HOSTS)
    ).toThrow(/malformed URL/);
  });

  it('rejects http://localhost when allowlist excludes it (DNS rebinding mitigation)', () => {
    // Operator narrowed allowlist to 127.0.0.1 only — "localhost" must NOT
    // implicitly match via DNS resolution.
    expect(() =>
      validateEmbeddingUrl('http://localhost:8742/api/embed', ['127.0.0.1'])
    ).toThrow(/host "localhost" not in allowedHosts/);
  });

  it('allows https scheme alongside http', () => {
    expect(() =>
      validateEmbeddingUrl('https://127.0.0.1:8742/api/embed', ['127.0.0.1'])
    ).not.toThrow();
  });

  it('accepts hostname matched against custom allowlist', () => {
    expect(() =>
      validateEmbeddingUrl('http://embed.internal:8080/v1/embed', ['embed.internal'])
    ).not.toThrow();
  });
});

describe('EmbeddingClient SSRF integration (T3.1)', () => {
  beforeEach(() => {
    delete process.env.JCF_EMBEDDING_ALLOWED_HOSTS;
  });

  it('constructor rejects non-allowlisted URL when enabled', () => {
    const logger = new Logger('error');
    expect(
      () =>
        new EmbeddingClient({
          url: 'http://10.0.0.1:8742/api/embed',
          timeoutMs: 5000,
          reprobeMs: 60000,
          enabled: true,
          logger,
        })
    ).toThrow(/SSRF mitigation/);
  });

  it('constructor skips validation when embedder is disabled', () => {
    const logger = new Logger('error');
    // A bad URL with embedder disabled must NOT throw — the operator has
    // explicitly turned the feature off so we don't care.
    expect(
      () =>
        new EmbeddingClient({
          url: 'http://10.0.0.1:8742/api/embed',
          timeoutMs: 5000,
          reprobeMs: 60000,
          enabled: false,
          logger,
        })
    ).not.toThrow();
  });

  it('constructor honours explicit allowedHosts override', () => {
    const logger = new Logger('error');
    expect(
      () =>
        new EmbeddingClient({
          url: 'http://embed.private.lan:8742/api/embed',
          timeoutMs: 5000,
          reprobeMs: 60000,
          enabled: true,
          logger,
          allowedHosts: ['embed.private.lan'],
        })
    ).not.toThrow();
  });

  it('constructor reads JCF_EMBEDDING_ALLOWED_HOSTS env var', () => {
    process.env.JCF_EMBEDDING_ALLOWED_HOSTS = 'embed.private.lan, 10.20.30.40';
    const logger = new Logger('error');
    expect(
      () =>
        new EmbeddingClient({
          url: 'http://10.20.30.40:8742/api/embed',
          timeoutMs: 5000,
          reprobeMs: 60000,
          enabled: true,
          logger,
        })
    ).not.toThrow();
  });

  it('config.allowedHosts wins over env var', () => {
    process.env.JCF_EMBEDDING_ALLOWED_HOSTS = '10.20.30.40';
    const logger = new Logger('error');
    expect(
      () =>
        new EmbeddingClient({
          url: 'http://127.0.0.1:8742/api/embed',
          timeoutMs: 5000,
          reprobeMs: 60000,
          enabled: true,
          logger,
          allowedHosts: ['127.0.0.1'], // explicit narrow allowlist
        })
    ).not.toThrow();
  });
});
