import { describe, it, expect, beforeEach } from 'vitest';
import { ConfigManager } from '../lib/config';
import { Logger } from '../lib/logger';
import { SERVER_NAME, SERVER_VERSION } from '../version';

describe('ConfigManager', () => {
  let manager: ConfigManager;
  let logger: Logger;

  beforeEach(() => {
    logger = new Logger('error');
    manager = new ConfigManager(logger);
  });

  describe('initialization', () => {
    it('should create config manager with logger', () => {
      expect(manager).toBeDefined();
      expect(manager.logger).toBe(logger);
    });

    it('should get default config with canonical version from package.json', () => {
      const config = manager.getConfig();
      expect(config).toBeDefined();
      expect(config.serverName).toBe(SERVER_NAME);
      expect(config.serverVersion).toBe(SERVER_VERSION);
      expect(config.serverVersion).toMatch(/^\d+\.\d+\.\d+/); // semver-shaped
    });

    it('should get enabled features', () => {
      const features = manager.getEnabledFeatures();
      expect(Array.isArray(features)).toBe(true);
      expect(features.length).toBeGreaterThan(0);
    });

    it('should have default security settings', () => {
      const config = manager.getConfig();
      expect(config.enableRBAC).toBe(true);
      expect(config.enableSecretsScan).toBe(true);
      expect(config.enableAuditLog).toBe(true);
    });

    it('should have default cache settings', () => {
      const config = manager.getConfig();
      expect(config.cacheMaxSize).toBeGreaterThan(0);
      expect(config.cacheTTL).toBeGreaterThan(0);
    });

    it('should get database path', () => {
      const dbPath = manager.getDatabasePath();
      expect(typeof dbPath).toBe('string');
      expect(dbPath.length).toBeGreaterThan(0);
    });
  });

  describe('configuration defaults', () => {
    it('should have versioning enabled by default', () => {
      const config = manager.getConfig();
      expect(config.enableVersioning).toBe(true);
    });

    it('should have semantic search enabled by default', () => {
      const config = manager.getConfig();
      expect(config.enableSemanticSearch).toBe(true);
    });

    it('should have dependency tracking enabled by default', () => {
      const config = manager.getConfig();
      expect(config.enableDependencyTracking).toBe(true);
    });

    it('should have self-healing enabled by default', () => {
      const config = manager.getConfig();
      expect(config.enableSelfHealing).toBe(true);
    });

    it('should have reasonable file size limit', () => {
      const config = manager.getConfig();
      expect(config.maxFileSize).toBeGreaterThan(0);
    });
  });

  describe('environment overrides (SEC-01)', () => {
    beforeEach(() => {
      // Clean environment
      delete process.env.MCP_FS_ENABLERBAC;
      delete process.env.MCP_FS_ENABLE_RBAC;
      delete process.env.MCP_FS_MAXFILESIZE;
      delete process.env.MCP_FS_FOO_BAR;
    });

    it('blocks security-critical override via direct env var (no underscore)', async () => {
      process.env.MCP_FS_ENABLERBAC = '0';
      const mgr = new ConfigManager(new Logger('error'));
      await mgr.initialize();
      expect(mgr.getConfig().enableRBAC).toBe(true);
      delete process.env.MCP_FS_ENABLERBAC;
    });

    it('blocks security-critical override via snake_case env var', async () => {
      process.env.MCP_FS_ENABLE_RBAC = '0';
      const mgr = new ConfigManager(new Logger('error'));
      await mgr.initialize();
      expect(mgr.getConfig().enableRBAC).toBe(true);
      delete process.env.MCP_FS_ENABLE_RBAC;
    });

    it('ignores unknown config keys', async () => {
      process.env.MCP_FS_FOO_BAR = '123';
      const mgr = new ConfigManager(new Logger('error'));
      await mgr.initialize();
      expect((mgr.getConfig() as any).fooBar).toBeUndefined();
      delete process.env.MCP_FS_FOO_BAR;
    });

    it('allows non-critical overrides (e.g., maxFileSize)', async () => {
      process.env.MCP_FS_MAXFILESIZE = '204800';
      const mgr = new ConfigManager(new Logger('error'));
      await mgr.initialize();
      expect(mgr.getConfig().maxFileSize).toBe(204800);
      delete process.env.MCP_FS_MAXFILESIZE;
    });
  });

});

  describe('env var override security (SEC-01)', () => {
    beforeEach(() => {
      // Clear env before each test
      delete process.env.MCP_FS_ENABLE_RBAC;
      delete process.env.MCP_FS_ENABLERBAC;
      delete process.env.MCP_FS_ALLOWEDDIRECTORIES;
      delete process.env.MCP_FS_ENABLE_FOO;
    });

    it('should block underscore variant of security-critical keys', async () => {
      // Set underscore variant: MCP_FS_ENABLE_RBAC = false
      process.env.MCP_FS_ENABLE_RBAC = 'false';
      // Reinitialize config to pick up env
      const newLogger = new Logger('error');
      const newManager = new ConfigManager(newLogger);
      await newManager.initialize();
      const cfg = newManager.getConfig();
      // Despite env var, enableRBAC should remain default true
      expect(cfg.enableRBAC).toBe(true);
    });

    it('should block direct security-critical key overrides', async () => {
      process.env.MCP_FS_ENABLERBAC = 'false';
      const newLogger = new Logger('error');
      const newManager = new ConfigManager(newLogger);
      await newManager.initialize();
      const cfg = newManager.getConfig();
      expect(cfg.enableRBAC).toBe(true);
    });

     it('should block security-critical allowedDirectories override', async () => {
       process.env.MCP_FS_ALLOWEDDIRECTORIES = '["/tmp"]';
       const newLogger = new Logger('error');
       const newManager = new ConfigManager(newLogger);
       await newManager.initialize();
       const cfg = newManager.getConfig();
       // allowedDirectories should remain default (empty), not overridden
       expect(cfg.allowedDirectories).toEqual([]);
     });

    it('should ignore completely unknown keys', async () => {
       process.env.MCP_FS_ENABLE_FOO = 'bar';
       const newLogger = new Logger('error');
       const newManager = new ConfigManager(newLogger);
       await newManager.initialize();
       const cfg = newManager.getConfig();
       expect((cfg as any).enableFoo).toBeUndefined();
     });
  });
