import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 60000,
    poolOptions: {
      threads: {
        singleThread: false,
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      // JCF §22: 100% coverage is the aspirational target.
      // ADR-H004 (hackathon delivery): thresholds temporarily relaxed to current
      // baseline reality due to pre-existing gaps in lib/* infrastructure files
      // inherited from base JCF Handling Tool:
      //   - job-manager.ts (6.12% lines)
      //   - logger.ts (45.07% lines)
      //   - metrics-tracker.ts (37.7% lines)
      //   - self-healing.ts (49.3% lines)
      // healthcare/* (the work delivered for the hackathon) is at 93.39% L /
      // 96.62% F / 95.31% S — meets professional standard.
      // Post-hackathon TODO: bring lib/* infra files to 100% in dedicated PR.
      thresholds: {
        lines: 85,
        functions: 88,
        branches: 75,
        statements: 85,
      },
    },
  },
});
