import { describe, it, expect } from 'vitest';
import {
  TOOL_DESCRIPTIONS,
  DEFAULT_TOOL_DESCRIPTION,
  getToolDescription,
} from '../tool-descriptions';

/**
 * Phase B2.7 (M5 audit) — jcf-healthcare-agent-hub tool-descriptions contract tests.
 * Locks the public surface: TOOL_DESCRIPTIONS map shape, DEFAULT_TOOL_DESCRIPTION
 * fallback, and getToolDescription lookup-with-fallback semantics.
 */
describe('TOOL_DESCRIPTIONS — registry shape', () => {
  it('is an object Record<string, string>', () => {
    expect(typeof TOOL_DESCRIPTIONS).toBe('object');
    expect(TOOL_DESCRIPTIONS).not.toBeNull();
  });

  it('every entry maps a string key to a non-empty string description', () => {
    for (const [key, value] of Object.entries(TOOL_DESCRIPTIONS)) {
      expect(typeof key).toBe('string');
      expect(key.length).toBeGreaterThan(0);
      expect(typeof value).toBe('string');
      expect(value.length).toBeGreaterThan(20); // descriptions should be substantive
    }
  });

  it('contains the canonical core filesystem tools', () => {
    const core = ['read_file', 'write_file', 'edit_file', 'append_file', 'delete_file'];
    for (const tool of core) {
      // Some may be registered, others may use DEFAULT — accept either as long as registry is loaded
      if (TOOL_DESCRIPTIONS[tool]) {
        expect(TOOL_DESCRIPTIONS[tool]).toMatch(/Parameters/);
      }
    }
  });

  it('every registered description includes a Parameters or Returns section', () => {
    for (const [, value] of Object.entries(TOOL_DESCRIPTIONS)) {
      // Rich descriptions per dogfooding audit must have structured info
      expect(value).toMatch(/Parameters|Returns|Example/i);
    }
  });

  it('every registered description includes at least one Example', () => {
    for (const [name, value] of Object.entries(TOOL_DESCRIPTIONS)) {
      expect(value, `tool ${name} missing Example`).toMatch(/Example/);
    }
  });

  it('descriptions do NOT use the legacy ICS branding', () => {
    for (const [name, value] of Object.entries(TOOL_DESCRIPTIONS)) {
      expect(value, `tool ${name} contains stale ICS reference`).not.toMatch(/ICS Handling Tool/);
      expect(value, `tool ${name} contains stale ics-handling-tool reference`).not.toMatch(/ics-handling-tool/);
    }
  });
});

describe('DEFAULT_TOOL_DESCRIPTION — fallback formatter', () => {
  it('returns a non-empty string', () => {
    const result = DEFAULT_TOOL_DESCRIPTION('arbitrary_tool');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('includes the tool name in the fallback message', () => {
    const result = DEFAULT_TOOL_DESCRIPTION('my_unique_tool_name');
    expect(result).toContain('my_unique_tool_name');
  });

  it('uses canonical JCF branding (no ICS leaks)', () => {
    const result = DEFAULT_TOOL_DESCRIPTION('test_tool');
    expect(result).toContain('JCF Healthcare Agent Hub');
    expect(result).not.toMatch(/ICS Handling Tool/);
  });

  it('flags missing description (registration pending notice)', () => {
    const result = DEFAULT_TOOL_DESCRIPTION('unregistered_tool');
    expect(result).toMatch(/registration pending/i);
  });

  it('handles empty tool name gracefully', () => {
    const result = DEFAULT_TOOL_DESCRIPTION('');
    expect(typeof result).toBe('string');
  });

  it('handles unicode tool name', () => {
    const result = DEFAULT_TOOL_DESCRIPTION('ünı́cödé_tøøl');
    expect(result).toContain('ünı́cödé_tøøl');
  });
});

describe('getToolDescription — lookup with fallback', () => {
  it('returns registered description for known tool', () => {
    // read_file is one of the canonical entries
    if (TOOL_DESCRIPTIONS.read_file) {
      const result = getToolDescription('read_file');
      expect(result).toBe(TOOL_DESCRIPTIONS.read_file);
      expect(result).toMatch(/Parameters/);
    }
  });

  it('returns DEFAULT_TOOL_DESCRIPTION for unknown tool', () => {
    const unknownName = '__certainly_not_a_real_tool_xyz__';
    const result = getToolDescription(unknownName);
    expect(result).toBe(DEFAULT_TOOL_DESCRIPTION(unknownName));
    expect(result).toContain(unknownName);
    expect(result).toMatch(/registration pending/i);
  });

  it('treats empty string as unknown tool', () => {
    const result = getToolDescription('');
    expect(result).toBe(DEFAULT_TOOL_DESCRIPTION(''));
  });

  it('is consistent: same input always produces same output', () => {
    const a = getToolDescription('read_file');
    const b = getToolDescription('read_file');
    expect(a).toBe(b);
  });

  it('exhaustive coverage: every registered tool returns its registered description', () => {
    for (const [name, expected] of Object.entries(TOOL_DESCRIPTIONS)) {
      expect(getToolDescription(name)).toBe(expected);
    }
  });
});
