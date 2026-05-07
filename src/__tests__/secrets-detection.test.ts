import { describe, it, expect } from 'vitest';
import {
  SECRET_PATTERNS,
  scanContent,
  shannonEntropy,
  findHighEntropyTokens,
  maskSecret,
  getPatternStats,
  ENTROPY_THRESHOLD_BITS,
} from '../lib/secrets-detection';

describe('shannonEntropy', () => {
  it('returns 0 for empty string', () => {
    expect(shannonEntropy('')).toBe(0);
  });

  it('returns 0 for single unique char', () => {
    expect(shannonEntropy('aaaaaa')).toBe(0);
  });

  it('returns positive entropy for varied string', () => {
    expect(shannonEntropy('abcd')).toBeGreaterThan(0);
  });

  it('high-entropy base64-ish string exceeds threshold', () => {
    // Simulated base64 token — high entropy
    const token = 'AKIA1234567890ABCDEFGHIJ+_/=XyZ';
    expect(shannonEntropy(token)).toBeGreaterThanOrEqual(ENTROPY_THRESHOLD_BITS - 1);
  });
});

describe('maskSecret', () => {
  it('M11-AUDIT FIX (MED-17): masks tiny secrets with length only (no char leak)', () => {
    // < 4 chars → just the length annotation, no chars at all
    expect(maskSecret('abc')).toBe('<len:3>');
    expect(maskSecret('a')).toBe('<len:1>');
    expect(maskSecret('')).toBe('<len:0>');
  });

  it('M11-AUDIT FIX (MED-17): 4-8 char secrets reveal only first + last char + length', () => {
    // Single-char head + tail + length annotation
    expect(maskSecret('1234567')).toBe('1***7<len:7>');
    expect(maskSecret('abcd')).toBe('a***d<len:4>');
    expect(maskSecret('12345678')).toBe('1***8<len:8>');
  });

  it('keeps 4-char head + 4-char tail for longer secrets, includes length', () => {
    const m = maskSecret('ABCDEFGHIJKLMNOP');
    expect(m).toContain('ABCD');
    expect(m).toContain('MNOP');
    expect(m).toContain('***');
    expect(m).toContain('<len:16>');
  });

  it('never leaks middle bytes regardless of input length', () => {
    // Property: for any input, the middle bytes (5..len-5 for len>8) must
    // never appear in the mask. This prevents accidental partial-secret
    // disclosure.
    const longSecret = 'PUBLIC1234INTERNAL_PRIVATE_DATA_HIDDEN_PUBLIC2';
    const masked = maskSecret(longSecret);
    expect(masked).not.toContain('INTERNAL_PRIVATE');
    expect(masked).not.toContain('HIDDEN');
    expect(masked).toContain('PUBL'); // head (first 4)
    expect(masked).toContain('LIC2'); // tail (last 4, case-preserving)
  });
});

describe('Pattern coverage', () => {
  it('has at least 30 distinct patterns (audit target H-3)', () => {
    expect(SECRET_PATTERNS.length).toBeGreaterThanOrEqual(30);
  });

  it('covers all major cloud providers', () => {
    const ids = SECRET_PATTERNS.map(p => p.id);
    expect(ids).toContain('aws-access-key');
    expect(ids).toContain('gcp-api-key');
    expect(ids).toContain('azure-conn-string');
  });

  it('covers payment gateways', () => {
    const ids = SECRET_PATTERNS.map(p => p.id);
    expect(ids).toContain('stripe-secret-key');
    expect(ids).toContain('stripe-webhook-secret');
  });

  it('covers chat tokens', () => {
    const ids = SECRET_PATTERNS.map(p => p.id);
    expect(ids).toContain('slack-bot-token');
    expect(ids).toContain('discord-token');
  });

  it('covers DB URIs', () => {
    const ids = SECRET_PATTERNS.map(p => p.id);
    expect(ids).toContain('postgres-url');
    expect(ids).toContain('mongodb-url');
  });

  it('every pattern has required fields', () => {
    for (const p of SECRET_PATTERNS) {
      expect(p.id).toBeTruthy();
      expect(p.name).toBeTruthy();
      expect(p.pattern).toBeInstanceOf(RegExp);
      expect(['critical', 'high', 'medium', 'low']).toContain(p.severity);
      expect(['cloud','vcs','chat','payment','infra','registry','email','db','crypto','generic']).toContain(p.category);
    }
  });
});

describe('scanContent — AWS', () => {
  it('detects AWS access key ID', () => {
    const matches = scanContent('AKIAIOSFODNN7EXAMPLE', 'test.txt');
    expect(matches.some(m => m.patternId === 'aws-access-key')).toBe(true);
  });

  it('detects AWS secret key assignment', () => {
    const content = `aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"`;
    const matches = scanContent(content, 'test.env');
    expect(matches.some(m => m.patternId === 'aws-secret-key')).toBe(true);
  });
});

describe('scanContent — GitHub', () => {
  it('detects ghp_ token', () => {
    const matches = scanContent('ghp_' + 'A'.repeat(36), 'test.txt');
    expect(matches.some(m => m.patternId === 'github-pat')).toBe(true);
  });

  it('detects gho_ OAuth token', () => {
    const matches = scanContent('gho_' + 'X'.repeat(36), 'test.txt');
    expect(matches.some(m => m.patternId === 'github-oauth')).toBe(true);
  });
});

describe('scanContent — Slack', () => {
  it('detects xoxb bot token', () => {
    const content = 'xoxb-TEST-TOKEN-FAKE-1234567890-abcdefghijklmnop';
    const matches = scanContent(content, 'config.json');
    expect(matches.some(m => m.patternId === 'slack-bot-token')).toBe(true);
  });

  it('detects Slack webhook URL', () => {
    const content = 'https://hooks.slack.com/services/T01234ABC/B01234DEF/AbCdEfGhIjKlMnOp';
    const matches = scanContent(content, 'config.json');
    expect(matches.some(m => m.patternId === 'slack-webhook')).toBe(true);
  });
});

describe('scanContent — Stripe', () => {
  it('detects sk_live_ key', () => {
    const content = 'const key = "sk_live_' + 'A'.repeat(24) + '"';
    const matches = scanContent(content, 'test.ts');
    expect(matches.some(m => m.patternId === 'stripe-secret-key')).toBe(true);
  });

  it('detects Stripe webhook signing secret', () => {
    const content = 'whsec_' + 'X'.repeat(40);
    const matches = scanContent(content, 'test.env');
    expect(matches.some(m => m.patternId === 'stripe-webhook-secret')).toBe(true);
  });
});

describe('scanContent — npm', () => {
  it('detects npm access token', () => {
    const content = 'npm_' + 'X'.repeat(36);
    const matches = scanContent(content, '.npmrc');
    expect(matches.some(m => m.patternId === 'npm-token')).toBe(true);
  });
});

describe('scanContent — Database URIs', () => {
  it('detects postgres URL with credentials', () => {
    const content = 'postgres://user:password@localhost:5432/mydb';
    const matches = scanContent(content, 'config.env');
    expect(matches.some(m => m.patternId === 'postgres-url')).toBe(true);
  });

  it('detects MongoDB URI', () => {
    const content = 'mongodb+srv://user:pass@cluster.mongodb.net/dbname';
    const matches = scanContent(content, 'config.env');
    expect(matches.some(m => m.patternId === 'mongodb-url')).toBe(true);
  });
});

describe('scanContent — Private keys', () => {
  it('detects RSA private key PEM', () => {
    const content = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEpAIBAAKCAQEA...',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const matches = scanContent(content, 'key.pem');
    expect(matches.some(m => m.patternId === 'rsa-private-key')).toBe(true);
  });

  it('detects OpenSSH private key', () => {
    const content = [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'b3BlbnNzaC1rZXktdjEAAA...',
      '-----END OPENSSH PRIVATE KEY-----',
    ].join('\n');
    const matches = scanContent(content, 'id_ed25519');
    expect(matches.some(m => m.patternId === 'openssh-private-key')).toBe(true);
  });
});

describe('scanContent — generic hardcoded password', () => {
  it('detects quoted password assignment', () => {
    const content = 'password = "myS3cur3P@ssw0rd"';
    const matches = scanContent(content, 'config.ts');
    expect(matches.some(m => m.patternId === 'generic-password-quoted')).toBe(true);
  });

  it('excludes placeholder values', () => {
    const content = 'password = "your_password"';
    const matches = scanContent(content, 'config.ts');
    expect(matches.some(m => m.patternId === 'generic-password-quoted')).toBe(false);
  });
});

describe('scanContent — Shannon entropy fallback', () => {
  it('flags novel high-entropy tokens', () => {
    // 40-char varied base64ish string (not matching any specific pattern)
    const token = 'XyZ01aBcDeFg+/=hIjKlMnOpQrStUvWxYzaBcDeF2';
    const matches = scanContent(`customKey=${token}`, 'secrets.txt');
    const entropyMatch = matches.find(m => m.patternId === 'entropy-high');
    expect(entropyMatch).toBeDefined();
    if (entropyMatch) {
      expect(entropyMatch.entropy).toBeGreaterThanOrEqual(ENTROPY_THRESHOLD_BITS);
    }
  });

  it('does not flag SHA-1 hashes (UUID-like hex) as secrets', () => {
    const content = 'commitHash = "da39a3ee5e6b4b0d3255bfef95601890afd80709"';
    const entropyMatches = findHighEntropyTokens(content);
    expect(entropyMatches.length).toBe(0);
  });

  it('does not flag UUIDs as secrets', () => {
    const content = 'id = "550e8400-e29b-41d4-a716-446655440000"';
    const entropyMatches = findHighEntropyTokens(content);
    expect(entropyMatches.length).toBe(0);
  });
});

describe('scanContent — safe content', () => {
  it('returns empty for clean files', () => {
    const content = 'const x = 42;\nconsole.log("hello");\n// just a comment\n';
    const matches = scanContent(content, 'clean.ts');
    expect(matches.length).toBe(0);
  });
});

describe('getPatternStats', () => {
  it('reports totals and distributions', () => {
    const stats = getPatternStats();
    expect(stats.totalPatterns).toBe(SECRET_PATTERNS.length);
    expect(Object.keys(stats.byCategory).length).toBeGreaterThanOrEqual(8);
    expect(Object.keys(stats.bySeverity).length).toBeGreaterThanOrEqual(3);
  });
});

describe('scanContent — severity + max matches', () => {
  it('respects minSeverity filter', () => {
    const content = 'const x = 42;\npassword = "mediumS3cret!"';
    const high = scanContent(content, 'x.ts', { minSeverity: 'high' });
    expect(high.every(m => ['high', 'critical'].includes(m.severity))).toBe(true);
  });

  it('respects maxMatches cap', () => {
    const content = Array.from({ length: 50 }, () => 'AKIAIOSFODNN7EXAMPLE').join('\n');
    const capped = scanContent(content, 'x.env', { maxMatches: 5 });
    expect(capped.length).toBeLessThanOrEqual(5);
  });
});
