/**
 * Live smoke test for Qwen3 integration:
 *   1. Probe /api/embed directly with a test payload.
 *   2. Exercise EmbeddingClient against the live endpoint.
 *   3. Verify graceful fallback when embedding unavailable.
 *
 * This intentionally does NOT require the endpoint to be healthy — it reports
 * the observed state and demonstrates the client's behaviour either way.
 */
import { EmbeddingClient } from '../dist/lib/embedding-client.js';
import { Logger } from '../dist/lib/logger.js';

const URL = 'http://127.0.0.1:8742/api/embed';

function line(label, value) {
  console.log(`  ${label.padEnd(24)} ${value}`);
}

async function main() {
  console.log('─'.repeat(70));
  console.log(' Qwen3 Embedding Bridge — Live Smoke Test');
  console.log('─'.repeat(70));

  // Phase 1: raw endpoint probe
  console.log('\n[1] Raw /api/embed probe');
  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts: ['hello world'] }),
    });
    const json = await res.json();
    line('HTTP status', res.status);
    line('status field', json.status);
    if (json.status === 'ok') {
      line('model', json.model);
      line('backend', json.backend);
      line('dims', json.dims);
      line('vector[0..2]', JSON.stringify(json.embeddings[0].slice(0, 3)));
      line('vector length', json.embeddings[0].length);
    } else {
      line('error message', (json.message || '').slice(0, 100));
    }
  } catch (err) {
    line('FAILED', err.message);
  }

  // Phase 2: EmbeddingClient
  console.log('\n[2] EmbeddingClient behaviour');
  const client = new EmbeddingClient({
    url: URL,
    timeoutMs: 30000,
    reprobeMs: 60000,
    enabled: true,
    logger: new Logger('error'),
  });

  const available = await client.isAvailable();
  line('isAvailable()', String(available));

  if (available) {
    const docVec = await client.embedDocuments(['async function getUserById(id: string)']);
    line('embedDocuments()', docVec ? `${docVec.length} vec(s), ${docVec[0].length}d` : 'null');

    const qVec = await client.embedQuery('find the function that retrieves users');
    line('embedQuery()', qVec ? `${qVec.length}d vector` : 'null');
  } else {
    line('Graceful fallback', 'OK — client returned false without crashing');
    const v = await client.embedDocuments(['x']);
    line('embedDocuments()', v === null ? 'null (expected)' : JSON.stringify(v).slice(0, 50));
  }

  // Phase 3: health snapshot
  console.log('\n[3] Health snapshot');
  const h = client.getHealth();
  line('available', String(h.available));
  line('enabled', String(h.enabled));
  if (h.model) line('model', h.model);
  if (h.backend) line('backend', h.backend);
  if (h.dims) line('dims', h.dims);
  if (h.lastError) line('lastError', h.lastError.slice(0, 80));

  console.log('\n─'.repeat(70));
  console.log(available ? ' ✅ Qwen3 bridge LIVE — JCF will use hybrid retrieval' : ' ⚠  Qwen3 bridge DEGRADED — JCF gracefully falls back to tf-idf');
  console.log('─'.repeat(70));
}

main().catch(e => {
  console.error('Smoke test failed:', e);
  process.exit(1);
});
