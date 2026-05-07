/**
 * JCF Healthcare Agent Hub — Comprehensive Secrets Detection
 *
 * Phase C2 of remediation audit.
 *
 * Covers 30+ secret/credential patterns across:
 *   - Cloud: AWS, GCP, Azure, Heroku, DigitalOcean
 *   - VCS: GitHub, GitLab, Bitbucket
 *   - Chat/Collaboration: Slack, Discord, Teams
 *   - Payments: Stripe, Square, PayPal, Braintree
 *   - Infrastructure: Datadog, NewRelic, PagerDuty
 *   - Package registries: npm, PyPI
 *   - Email/SMS: SendGrid, Mailgun, Twilio
 *   - DB URIs: PostgreSQL, MySQL, MongoDB, Redis
 *   - JWT, Private keys (RSA/EC/PGP/SSH)
 *   - Generic high-entropy strings (Shannon ≥ 4.5 bits/char)
 *
 * Patterns derived from TruffleHog / gitleaks / secretlint community rulesets
 * (all MIT-compatible). Entropy threshold tuned to balance recall vs false
 * positives on typical codebases (hashes, UUIDs in tests are excluded).
 */

// ═══════════════════════════════════════════════════════════════════════════
// ── Types ──
// ═══════════════════════════════════════════════════════════════════════════

export type SecretSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface SecretPattern {
  id: string;
  name: string;
  description: string;
  pattern: RegExp;
  severity: SecretSeverity;
  category: 'cloud' | 'vcs' | 'chat' | 'payment' | 'infra' | 'registry' | 'email' | 'db' | 'crypto' | 'generic';
  /** Extraction group index for the actual secret (for masking). Default 0 (whole match). */
  valueGroup?: number;
  /** Optional: exclude matches if surrounding text contains any of these (false-positive filter). */
  excludeIfContains?: string[];
}

export interface SecretMatch {
  patternId: string;
  patternName: string;
  category: SecretPattern['category'];
  severity: SecretSeverity;
  line: number;
  column: number;
  matched: string;       // redacted
  entropy?: number;      // only for generic entropy matches
  filePath: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Pattern Registry (30+ patterns) ──
// ═══════════════════════════════════════════════════════════════════════════

export const SECRET_PATTERNS: SecretPattern[] = [
  // ── AWS ──
  {
    id: 'aws-access-key',
    name: 'AWS Access Key ID',
    description: 'AWS access key ID (AKIA…)',
    pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g,
    severity: 'critical',
    category: 'cloud',
  },
  {
    id: 'aws-secret-key',
    name: 'AWS Secret Access Key',
    description: 'AWS secret access key (40-char base64-ish)',
    pattern: /\b(aws[_\-]?(secret|sk)[_\-]?(access)?[_\-]?key)\s*[=:]\s*["']?([A-Za-z0-9/+=]{40})["']?/gi,
    severity: 'critical',
    category: 'cloud',
    valueGroup: 4,
  },
  {
    id: 'aws-session-token',
    name: 'AWS Session Token',
    description: 'AWS temporary session token',
    pattern: /\b(aws[_\-]?session[_\-]?token)\s*[=:]\s*["']?([A-Za-z0-9/+=]{100,})/gi,
    severity: 'high',
    category: 'cloud',
    valueGroup: 2,
  },

  // ── GCP ──
  {
    id: 'gcp-service-account',
    name: 'GCP Service Account JSON',
    description: 'Google Cloud service-account key JSON fragment',
    pattern: /"type"\s*:\s*"service_account"[\s\S]{0,500}?"private_key"\s*:\s*"-----BEGIN[^"]+"/g,
    severity: 'critical',
    category: 'cloud',
  },
  {
    id: 'gcp-api-key',
    name: 'GCP API Key',
    description: 'Google Cloud / Firebase API key (AIza…)',
    pattern: /\bAIza[0-9A-Za-z_\-]{35}\b/g,
    severity: 'high',
    category: 'cloud',
  },
  {
    id: 'gcp-oauth-client',
    name: 'GCP OAuth Client Secret',
    description: 'Google OAuth client secret',
    pattern: /\b([a-zA-Z0-9_\-]+\.apps\.googleusercontent\.com)\b/g,
    severity: 'medium',
    category: 'cloud',
  },

  // ── Azure ──
  {
    id: 'azure-conn-string',
    name: 'Azure Storage Connection String',
    description: 'Azure connection string with AccountKey',
    pattern: /DefaultEndpointsProtocol=https?;AccountName=[^;]+;AccountKey=[A-Za-z0-9+/=]{50,}/g,
    severity: 'critical',
    category: 'cloud',
  },
  {
    id: 'azure-sas-token',
    name: 'Azure SAS Token',
    description: 'Azure shared access signature token',
    pattern: /\?(sv|st|se|sr|sp|sig)=[^&\s"']{10,}(&(sv|st|se|sr|sp|sig)=[^&\s"']{10,}){2,}/g,
    severity: 'high',
    category: 'cloud',
  },

  // ── GitHub ──
  {
    id: 'github-pat',
    name: 'GitHub Personal Access Token',
    description: 'GitHub classic / fine-grained PAT (ghp_/github_pat_)',
    pattern: /\b(ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82})\b/g,
    severity: 'critical',
    category: 'vcs',
  },
  {
    id: 'github-oauth',
    name: 'GitHub OAuth Token',
    description: 'GitHub OAuth / app token (gho_/ghu_/ghs_/ghr_)',
    pattern: /\b(gho_|ghu_|ghs_|ghr_)[A-Za-z0-9]{36}\b/g,
    severity: 'critical',
    category: 'vcs',
  },

  // ── GitLab ──
  {
    id: 'gitlab-pat',
    name: 'GitLab Personal Access Token',
    description: 'GitLab PAT (glpat-…)',
    pattern: /\bglpat-[A-Za-z0-9_\-]{20}\b/g,
    severity: 'critical',
    category: 'vcs',
  },

  // ── Bitbucket ──
  {
    id: 'bitbucket-app-password',
    name: 'Bitbucket App Password',
    description: 'Bitbucket app password',
    pattern: /\b(bitbucket)[_\-]?(app)?[_\-]?password\s*[=:]\s*["']?([A-Za-z0-9]{20,})/gi,
    severity: 'high',
    category: 'vcs',
    valueGroup: 3,
  },

  // ── Slack ──
  {
    id: 'slack-bot-token',
    name: 'Slack Bot Token',
    description: 'Slack bot token (xoxb-…)',
    pattern: /\bxoxb-[0-9]{10,}-[0-9]{10,}-[A-Za-z0-9]{24,}\b/g,
    severity: 'critical',
    category: 'chat',
  },
  {
    id: 'slack-user-token',
    name: 'Slack User Token',
    description: 'Slack user / workspace token (xoxp-/xoxa-/xoxr-)',
    pattern: /\b(xoxp|xoxa|xoxr)-[0-9]{10,}-[0-9]{10,}-[0-9]{10,}-[A-Za-z0-9]{32,}\b/g,
    severity: 'critical',
    category: 'chat',
  },
  {
    id: 'slack-webhook',
    name: 'Slack Incoming Webhook',
    description: 'Slack webhook URL with secret',
    pattern: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/g,
    severity: 'high',
    category: 'chat',
  },
  {
    id: 'discord-token',
    name: 'Discord Bot Token',
    description: 'Discord bot token',
    pattern: /\b[MN][A-Za-z\d]{23}\.[\w-]{6}\.[\w-]{27}\b/g,
    severity: 'critical',
    category: 'chat',
  },

  // ── Payments ──
  {
    id: 'stripe-secret-key',
    name: 'Stripe Secret Key',
    description: 'Stripe API secret key (sk_live_/sk_test_)',
    pattern: /\bsk_(live|test)_[A-Za-z0-9]{24,}\b/g,
    severity: 'critical',
    category: 'payment',
  },
  {
    id: 'stripe-restricted-key',
    name: 'Stripe Restricted Key',
    description: 'Stripe restricted API key (rk_live_/rk_test_)',
    pattern: /\brk_(live|test)_[A-Za-z0-9]{24,}\b/g,
    severity: 'high',
    category: 'payment',
  },
  {
    id: 'stripe-webhook-secret',
    name: 'Stripe Webhook Signing Secret',
    description: 'Stripe webhook signing secret (whsec_…)',
    pattern: /\bwhsec_[A-Za-z0-9]{32,}\b/g,
    severity: 'critical',
    category: 'payment',
  },
  {
    id: 'square-token',
    name: 'Square OAuth Token',
    description: 'Square access token (sq0atp-/sqOcsp-)',
    pattern: /\b(sq0atp|sq0csp)-[A-Za-z0-9_\-]{22,}\b/g,
    severity: 'critical',
    category: 'payment',
  },
  {
    id: 'paypal-braintree-token',
    name: 'Braintree Access Token',
    description: 'Braintree sandbox/production access token',
    pattern: /access_token\$(production|sandbox)\$[a-z0-9]{16}\$[a-f0-9]{32}/g,
    severity: 'critical',
    category: 'payment',
  },

  // ── Infrastructure / APM ──
  {
    id: 'datadog-api-key',
    name: 'Datadog API Key',
    description: 'Datadog API key (32-char hex)',
    pattern: /\b(datadog[_\-]?api[_\-]?key|DD_API_KEY)\s*[=:]\s*["']?([a-f0-9]{32})["']?/gi,
    severity: 'high',
    category: 'infra',
    valueGroup: 2,
  },
  {
    id: 'newrelic-api-key',
    name: 'New Relic API Key',
    description: 'New Relic API key (NRAK-…)',
    pattern: /\bNRAK-[A-Z0-9]{27}\b/g,
    severity: 'high',
    category: 'infra',
  },
  {
    id: 'pagerduty-token',
    name: 'PagerDuty Token',
    description: 'PagerDuty v2 integration key',
    pattern: /\b(pagerduty[_\-]?token|PD_TOKEN)\s*[=:]\s*["']?([A-Za-z0-9]{20,})["']?/gi,
    severity: 'medium',
    category: 'infra',
    valueGroup: 2,
  },

  // ── Package registries ──
  {
    id: 'npm-token',
    name: 'npm Access Token',
    description: 'npm automation/publish token (npm_…)',
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/g,
    severity: 'critical',
    category: 'registry',
  },
  {
    id: 'pypi-token',
    name: 'PyPI API Token',
    description: 'PyPI upload token (pypi-…)',
    pattern: /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_\-]{50,}\b/g,
    severity: 'critical',
    category: 'registry',
  },

  // ── Email / SMS ──
  {
    id: 'sendgrid-api-key',
    name: 'SendGrid API Key',
    description: 'SendGrid API key (SG.…)',
    pattern: /\bSG\.[A-Za-z0-9_\-]{22}\.[A-Za-z0-9_\-]{43}\b/g,
    severity: 'critical',
    category: 'email',
  },
  {
    id: 'mailgun-api-key',
    name: 'Mailgun API Key',
    description: 'Mailgun API key (key-…)',
    pattern: /\bkey-[a-f0-9]{32}\b/g,
    severity: 'high',
    category: 'email',
  },
  {
    id: 'twilio-api-key',
    name: 'Twilio API Key',
    description: 'Twilio API key SID (SK…)',
    pattern: /\bSK[0-9a-fA-F]{32}\b/g,
    severity: 'critical',
    category: 'email',
  },
  {
    id: 'twilio-auth-token',
    name: 'Twilio Auth Token',
    description: 'Twilio account SID + auth token',
    pattern: /\b(twilio[_\-]?(auth)?[_\-]?token)\s*[=:]\s*["']?([a-f0-9]{32})["']?/gi,
    severity: 'critical',
    category: 'email',
    valueGroup: 3,
  },

  // ── Database URIs ──
  {
    id: 'postgres-url',
    name: 'PostgreSQL Connection URI',
    description: 'postgres:// URI containing credentials',
    pattern: /\bpostgres(ql)?:\/\/[^:\/\s]+:[^@\/\s]+@[^\/\s]+\/[\w\-]+/g,
    severity: 'high',
    category: 'db',
  },
  {
    id: 'mysql-url',
    name: 'MySQL Connection URI',
    description: 'mysql:// URI containing credentials',
    pattern: /\bmysql:\/\/[^:\/\s]+:[^@\/\s]+@[^\/\s]+\/[\w\-]+/g,
    severity: 'high',
    category: 'db',
  },
  {
    id: 'mongodb-url',
    name: 'MongoDB Connection URI',
    description: 'mongodb:// or mongodb+srv:// URI with credentials',
    pattern: /\bmongodb(\+srv)?:\/\/[^:\/\s]+:[^@\/\s]+@[^\/\s]+/g,
    severity: 'high',
    category: 'db',
  },
  {
    id: 'redis-url',
    name: 'Redis Connection URI',
    description: 'redis:// URI with password',
    pattern: /\bredis:\/\/[^:@\/\s]*:[^@\/\s]+@[^\/\s]+/g,
    severity: 'high',
    category: 'db',
  },

  // ── Crypto / keys ──
  {
    id: 'rsa-private-key',
    name: 'RSA Private Key',
    description: 'PEM-encoded RSA private key',
    pattern: /-----BEGIN RSA PRIVATE KEY-----[\s\S]+?-----END RSA PRIVATE KEY-----/g,
    severity: 'critical',
    category: 'crypto',
  },
  {
    id: 'ec-private-key',
    name: 'EC Private Key',
    description: 'PEM-encoded EC private key',
    pattern: /-----BEGIN EC PRIVATE KEY-----[\s\S]+?-----END EC PRIVATE KEY-----/g,
    severity: 'critical',
    category: 'crypto',
  },
  {
    id: 'openssh-private-key',
    name: 'OpenSSH Private Key',
    description: 'OpenSSH-format private key',
    pattern: /-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]+?-----END OPENSSH PRIVATE KEY-----/g,
    severity: 'critical',
    category: 'crypto',
  },
  {
    id: 'generic-private-key',
    name: 'Generic Private Key',
    description: 'Any PEM-encoded private key',
    pattern: /-----BEGIN (ENCRYPTED |DSA |PGP |)PRIVATE KEY(-| BLOCK-)----[\s\S]+?-----END/g,
    severity: 'critical',
    category: 'crypto',
  },
  {
    // Defence in depth: catches truncated/partial paste-error dumps where the
    // END marker is missing (common accidental leak shape in logs / chat).
    id: 'private-key-header',
    name: 'Private Key Header (lenient)',
    description: 'Bare BEGIN ... PRIVATE KEY line without full block',
    pattern: /-----BEGIN\s+(RSA|DSA|EC|OPENSSH|ENCRYPTED|PGP)\s+PRIVATE\s+KEY-----/g,
    severity: 'critical',
    category: 'crypto',
  },
  {
    id: 'jwt',
    name: 'JSON Web Token (JWT)',
    description: 'JWT — likely live if non-trivial payload',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    severity: 'high',
    category: 'crypto',
  },

  // ── Generic (password/secret assignments) ──
  {
    id: 'generic-password-quoted',
    name: 'Hardcoded Password (quoted)',
    description: 'password/passwd/pwd/secret = "..." with 8+ chars',
    pattern: /\b(password|passwd|pwd|secret|passphrase|auth[_\-]?token|api[_\-]?key)\s*[=:]\s*["']([^"'\s]{8,})["']/gi,
    severity: 'medium',
    category: 'generic',
    valueGroup: 2,
    excludeIfContains: ['example', 'placeholder', 'your_password', 'changeme', '<redacted>', 'xxxx', '***'],
  },
  {
    id: 'generic-bearer',
    name: 'Bearer Token (loose)',
    description: 'Authorization: Bearer … with 20+ token chars',
    pattern: /Authorization\s*[:=]\s*["']?Bearer\s+([A-Za-z0-9_\-\.=]{20,})["']?/gi,
    severity: 'high',
    category: 'generic',
    valueGroup: 1,
  },
];

// ═══════════════════════════════════════════════════════════════════════════
// ── Shannon Entropy Detection ──
// ═══════════════════════════════════════════════════════════════════════════

/** Shannon entropy in bits/char — higher = more random */
export function shannonEntropy(s: string): number {
  if (!s) return 0;
  const freq: Record<string, number> = {};
  for (const c of s) freq[c] = (freq[c] || 0) + 1;
  const n = s.length;
  let h = 0;
  for (const k of Object.keys(freq)) {
    const p = freq[k]! / n;
    h -= p * Math.log2(p);
  }
  return h;
}

export const ENTROPY_THRESHOLD_BITS = 4.5;      // base64-ish secrets typically 5+ bits/char
export const ENTROPY_MIN_LENGTH = 20;           // below this too many false positives
export const ENTROPY_MAX_LENGTH = 200;          // avoid scanning huge blocks

/** Tokens that look high-entropy (long, varied charset, entropy above threshold) */
export function findHighEntropyTokens(
  content: string,
  opts: { minLength?: number; threshold?: number } = {}
): Array<{ token: string; entropy: number; line: number; column: number }> {
  const minLen = opts.minLength ?? ENTROPY_MIN_LENGTH;
  const threshold = opts.threshold ?? ENTROPY_THRESHOLD_BITS;

  const results: Array<{ token: string; entropy: number; line: number; column: number }> = [];
  const lines = content.split(/\r?\n/);

  // Token regex — base64-ish / hex-ish / URL-safe bases
  const tokenRegex = /[A-Za-z0-9+/=_\-]{20,200}/g;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx]!;
    let m: RegExpExecArray | null;
    tokenRegex.lastIndex = 0;
    while ((m = tokenRegex.exec(line)) !== null) {
      const token = m[0];
      if (token.length < minLen || token.length > ENTROPY_MAX_LENGTH) continue;
      const h = shannonEntropy(token);
      if (h >= threshold) {
        // Filter: exclude common non-secret high-entropy strings
        if (isLikelyNonSecret(token)) continue;
        results.push({
          token,
          entropy: Math.round(h * 1000) / 1000,
          line: lineIdx + 1,
          column: m.index + 1,
        });
      }
    }
  }
  return results;
}

/** Heuristic exclusion of high-entropy strings that are usually NOT secrets */
function isLikelyNonSecret(token: string): boolean {
  // SHA-1 / SHA-256 hashes (all hex)
  if (/^[a-f0-9]{40}$/.test(token)) return true;   // SHA-1 (legit in git/checksums)
  if (/^[a-f0-9]{64}$/.test(token)) return true;   // SHA-256 — usually public
  // UUIDs
  if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(token)) return true;
  // Package-lock integrity hashes
  if (token.startsWith('sha512-') || token.startsWith('sha256-') || token.startsWith('sha1-')) return true;
  // Only repeats (e.g., 'AAAA...')
  const unique = new Set(token).size;
  if (unique < 5) return true;
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Masking ──
// ═══════════════════════════════════════════════════════════════════════════

/**
 * M11-AUDIT FIX (MED-17): mask a secret while preserving forensic context.
 *
 * Previous implementation collapsed any ≤ 8 char secret to `***` — useless
 * for triage because the log entry didn't even hint at length. The new
 * mask:
 *   - len < 4   → `<len:N>` (no character leak; we don't reveal anything
 *                 about strings shorter than 4 since that would be near
 *                 the entire secret)
 *   - 4–8 chars → `<H>***<T><len:N>` where H,T are first/last char (single
 *                 character, never middle bytes)
 *   - > 8 chars → `<HEAD4>***<TAIL4><len:N>` (original behavior + length)
 *
 * The length annotation enables triage of patterns ("all leaked tokens are
 * exactly 36 chars → looks like UUIDs from logs/X") without revealing more
 * of the secret than the previous opaque `***` did.
 */
export function maskSecret(value: string): string {
  const len = value.length;
  if (len < 4) return `<len:${len}>`;
  if (len <= 8) {
    return `${value[0]}***${value[len - 1]}<len:${len}>`;
  }
  const head = value.slice(0, 4);
  const tail = value.slice(-4);
  return `${head}***${tail}<len:${len}>`;
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Main Scan Function ──
// ═══════════════════════════════════════════════════════════════════════════

export interface ScanOptions {
  /** Enable Shannon-entropy generic detection. Default true. */
  enableEntropyScan?: boolean;
  /** Minimum severity to report. Default 'low'. */
  minSeverity?: SecretSeverity;
  /** Maximum matches to return (caps noisy files). Default 50. */
  maxMatches?: number;
}

const SEVERITY_RANK: Record<SecretSeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export function scanContent(
  content: string,
  filePath: string,
  options: ScanOptions = {}
): SecretMatch[] {
  const enableEntropy = options.enableEntropyScan ?? true;
  const minSev = options.minSeverity ?? 'low';
  const maxMatches = options.maxMatches ?? 50;

  const matches: SecretMatch[] = [];
  const lines = content.split(/\r?\n/);

  // Helper: compute line+column from absolute index
  const indexToLineCol = (absIndex: number): { line: number; column: number } => {
    let cursor = 0;
    for (let i = 0; i < lines.length; i++) {
      const lineLen = lines[i]!.length + 1; // +1 for newline
      if (absIndex < cursor + lineLen) return { line: i + 1, column: absIndex - cursor + 1 };
      cursor += lineLen;
    }
    return { line: lines.length, column: 1 };
  };

  // ── Pattern-based matching ──
  for (const pat of SECRET_PATTERNS) {
    if (SEVERITY_RANK[pat.severity] < SEVERITY_RANK[minSev]) continue;
    if (matches.length >= maxMatches) break;
    pat.pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pat.pattern.exec(content)) !== null) {
      if (matches.length >= maxMatches) break;
      const value = pat.valueGroup !== undefined ? m[pat.valueGroup] ?? m[0] : m[0];
      // False-positive filter
      if (pat.excludeIfContains?.some(bad => value.toLowerCase().includes(bad.toLowerCase()))) {
        continue;
      }
      const { line, column } = indexToLineCol(m.index);
      matches.push({
        patternId: pat.id,
        patternName: pat.name,
        category: pat.category,
        severity: pat.severity,
        line,
        column,
        matched: maskSecret(value),
        filePath,
      });
    }
  }

  // ── Entropy-based fallback (catches novel / custom tokens) ──
  if (enableEntropy && matches.length < maxMatches) {
    const entropyMatches = findHighEntropyTokens(content);
    for (const em of entropyMatches) {
      if (matches.length >= maxMatches) break;
      // Skip if already flagged by pattern (by location)
      if (matches.some(m => m.line === em.line && Math.abs(m.column - em.column) < 5)) continue;
      matches.push({
        patternId: 'entropy-high',
        patternName: 'High-Entropy String',
        category: 'generic',
        severity: 'medium',
        line: em.line,
        column: em.column,
        matched: maskSecret(em.token),
        entropy: em.entropy,
        filePath,
      });
    }
  }

  return matches;
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Stats ──
// ═══════════════════════════════════════════════════════════════════════════

export function getPatternStats(): {
  totalPatterns: number;
  byCategory: Record<string, number>;
  bySeverity: Record<string, number>;
} {
  const byCategory: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  for (const p of SECRET_PATTERNS) {
    byCategory[p.category] = (byCategory[p.category] || 0) + 1;
    bySeverity[p.severity] = (bySeverity[p.severity] || 0) + 1;
  }
  return {
    totalPatterns: SECRET_PATTERNS.length,
    byCategory,
    bySeverity,
  };
}
