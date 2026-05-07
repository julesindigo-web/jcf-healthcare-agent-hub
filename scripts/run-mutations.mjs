#!/usr/bin/env node
/**
 * Minimal mutation testing runner for src/lib/feature-flags.ts (T3.6)
 *
 * Bypasses Stryker's ESM/plugin-auto-discovery hang on Windows.
 * Each mutation: patches file → runs npm test:mutate → restores file.
 * A "killed" mutant = tests detect the change (exit 1).
 * A "survived" mutant = tests miss the change (exit 0 with mutation).
 */

import fs from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TARGET = path.join(ROOT, 'src', 'lib', 'feature-flags.ts');

// ─────────────────────────────────────────────────────────────────────────
// Mutation definitions: { id, description, find (string), replace (string) }
// ─────────────────────────────────────────────────────────────────────────
const MUTATIONS = [
  {
    id: 'M01',
    desc: "=== '1'  →  !== '1'  (invert sqlCipher flag check)",
    find: "env.JCF_USE_SQLCIPHER === '1'",
    replace: "env.JCF_USE_SQLCIPHER !== '1'",
  },
  {
    id: 'M02',
    desc: "=== '1'  →  === '0'  (wrong value for sqlCipher check)",
    find: "env.JCF_USE_SQLCIPHER === '1'",
    replace: "env.JCF_USE_SQLCIPHER === '0'",
  },
  {
    id: 'M03',
    desc: 'trim() call removed on rawKey',
    find: 'rawKey.trim().length > 0',
    replace: 'rawKey.length > 0',
  },
  {
    id: 'M04',
    desc: 'null guard inverted: truthy key  →  falsy key',
    find: '(rawKey && rawKey.trim().length > 0)',
    replace: '(!rawKey || rawKey.trim().length === 0)',
  },
  {
    id: 'M05',
    desc: 'sqlCipherKey returns key even when empty (remove null guard)',
    find: 'const sqlCipherKey = (rawKey && rawKey.trim().length > 0) ? rawKey.trim() : null;',
    replace: 'const sqlCipherKey = rawKey ? rawKey.trim() : null;',
  },
  {
    id: 'M06',
    desc: 'Object.freeze() removed (flags no longer immutable)',
    find: 'return Object.freeze({ sqlCipher, sqlCipherKey });',
    replace: 'return { sqlCipher, sqlCipherKey };',
  },
  {
    id: 'M07',
    desc: 'sqlCipher always true (short-circuit)',
    find: 'const sqlCipher = env.JCF_USE_SQLCIPHER === \'1\';',
    replace: 'const sqlCipher = true;',
  },
  {
    id: 'M08',
    desc: 'sqlCipher always false (short-circuit)',
    find: 'const sqlCipher = env.JCF_USE_SQLCIPHER === \'1\';',
    replace: 'const sqlCipher = false;',
  },
  {
    id: 'M09',
    desc: 'sqlCipherKey always null (ignores key)',
    find: 'const sqlCipherKey = (rawKey && rawKey.trim().length > 0) ? rawKey.trim() : null;',
    replace: 'const sqlCipherKey = null;',
  },
  {
    id: 'M10',
    desc: 'rawKey not trimmed (preserves whitespace)',
    find: 'const sqlCipherKey = (rawKey && rawKey.trim().length > 0) ? rawKey.trim() : null;',
    replace: 'const sqlCipherKey = (rawKey && rawKey.trim().length > 0) ? rawKey : null;',
  },
];

// ─────────────────────────────────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────────────────────────────────
async function runMutations() {
  const original = await fs.readFile(TARGET, 'utf-8');
  const results = [];

  console.log(`\n🧬 Mutation Testing — src/lib/feature-flags.ts`);
  console.log(`   ${MUTATIONS.length} mutants | baseline: npm run test:mutate\n`);

  // Dry-run baseline (must pass before mutations)
  try {
    execSync('npm run test:mutate', { cwd: ROOT, stdio: 'pipe' });
    console.log('✅ Baseline PASS — proceeding with mutations\n');
  } catch {
    console.error('❌ Baseline FAILED — fix tests before running mutations');
    process.exit(1);
  }

  for (const m of MUTATIONS) {
    if (!original.includes(m.find)) {
      results.push({ ...m, status: 'SKIP', reason: 'pattern not found in source' });
      console.log(`⏭  ${m.id} SKIP  — ${m.desc}`);
      continue;
    }

    const mutated = original.replace(m.find, m.replace);
    await fs.writeFile(TARGET, mutated, 'utf-8');

    let killed = false;
    try {
      execSync('npm run test:mutate', { cwd: ROOT, stdio: 'pipe' });
      // Tests passed → mutant SURVIVED
      killed = false;
    } catch {
      // Tests failed → mutant KILLED ✅
      killed = true;
    }

    await fs.writeFile(TARGET, original, 'utf-8'); // always restore

    const status = killed ? 'KILLED' : 'SURVIVED';
    results.push({ ...m, status });
    const icon = killed ? '✅' : '⚠️ ';
    console.log(`${icon} ${m.id} ${status.padEnd(8)} — ${m.desc}`);
  }

  // ── Summary ────────────────────────────────────────────────────────────
  const killed = results.filter(r => r.status === 'KILLED').length;
  const survived = results.filter(r => r.status === 'SURVIVED').length;
  const skipped = results.filter(r => r.status === 'SKIP').length;
  const tested = killed + survived;
  const score = tested > 0 ? Math.round((killed / tested) * 100) : 0;

  console.log('\n─────────────────────────────────────────────────────');
  console.log(`Mutation Score: ${score}%  (${killed}/${tested} killed, ${skipped} skipped)`);

  if (survived > 0) {
    console.log('\nSurvived mutants (need stronger tests):');
    results.filter(r => r.status === 'SURVIVED').forEach(r =>
      console.log(`  ⚠️  ${r.id}: ${r.desc}`)
    );
  }

  if (score < 50) {
    console.error(`\n❌ Mutation score ${score}% below break threshold (50%)`);
    process.exit(1);
  } else if (score < 60) {
    console.warn(`\n⚠️  Mutation score ${score}% below low threshold (60%)`);
    process.exit(0);
  } else if (score < 80) {
    console.log(`\n🟡 Mutation score ${score}% below high threshold (80%) — acceptable`);
  } else {
    console.log(`\n🟢 Mutation score ${score}% meets high threshold (≥80%)`);
  }

  // Write JSON results
  const outPath = path.join(ROOT, 'coverage', 'mutation-report-feature-flags.json');
  await fs.mkdir(path.join(ROOT, 'coverage'), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify({ target: TARGET, score, results }, null, 2));
  console.log(`\nFull report: coverage/mutation-report-feature-flags.json`);
}

runMutations().catch(err => {
  console.error('Mutation runner error:', err);
  process.exit(1);
});
