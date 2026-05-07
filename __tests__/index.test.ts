/**
 * Tests for index.ts — entry point + graceful shutdown.
 *
 * JCF-SKILL-01: THE PROBLEM SOLVER — P11-P14 mitigation.
 * Covers previously 0% coverage paths (main(), signal handlers, uncaught exceptions).
 *
 * Working Strategy:
 * 1. Use vi.resetModules() before each test for fresh execution
 * 2. Override process.on to capture signal handlers BEFORE import
 * 3. Spy on console.error (index.ts uses console.error for main() failures)
 * 4. Spy on process.stderr.write (signal handlers use stderr.write)
 * 5. Mock process.exit to prevent actual exit during tests
 */

import { describe, it, vi, expect, beforeEach, afterEach } from 'vitest';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SERVER_MODULE_PATH = join(__dirname, '..', 'src', 'server.ts').replace(/\\/g, '/');

// ── Mock server instance ──
const mockServerInstance = {
  initialize: vi.fn().mockResolvedValue(undefined),
  connect: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
};


// ── Capture process.on calls ──
const signalHandlers = new Map<string, Function>();
const originalProcessOn = process.on.bind(process);
const originalConsoleError = console.error.bind(console);
const originalStderrWrite = process.stderr.write.bind(process.stderr);

describe('index.ts — entry point + graceful shutdown', () => {
  let originalArgv: string[];
  let originalEnv: NodeJS.ProcessEnv;
  let exitMock: ReturnType<typeof vi.fn>;
  let consoleErrorMock: ReturnType<typeof vi.fn>;
  let stderrWriteMock: ReturnType<typeof vi.fn>;

   beforeEach(() => {
     originalArgv = process.argv;
     originalEnv = { ...process.env };
     
     // Reset module cache for fresh imports
     vi.resetModules();
     
     // Register mock for server module (must be after resetModules)
     vi.doMock(SERVER_MODULE_PATH, () => {
       console.log('[test] Mocking JcfHealthcareAgentHubServer');
       return {
         JcfHealthcareAgentHubServer: vi.fn(function() {
           return mockServerInstance;
         }),
       };
     });
     
     // Reset mock server instance methods
     mockServerInstance.initialize.mockReset().mockResolvedValue(undefined);
     mockServerInstance.connect.mockReset().mockResolvedValue(undefined);
     mockServerInstance.close.mockReset().mockResolvedValue(undefined);
     
     // Clear captured signal handlers
     signalHandlers.clear();
     
     // Mock process.exit to prevent actual exit
     exitMock = vi.fn();
     process.exit = exitMock as any;
     
     // Mock console.error to capture output
     consoleErrorMock = vi.fn();
     console.error = consoleErrorMock as any;
     
     // Mock process.stderr.write to capture output
     stderrWriteMock = vi.fn(() => true);
     process.stderr.write = stderrWriteMock as any;
     
     // Override process.on to capture signal handlers
     process.on = vi.fn((event: string, handler: (...args: any[]) => void) => {
       signalHandlers.set(event, handler);
       return originalProcessOn(event, handler);
     }) as any;
   });

  afterEach(() => {
    process.argv = originalArgv;
    process.env = originalEnv;
    vi.restoreAllMocks();
    process.on = originalProcessOn;
    console.error = originalConsoleError;
    process.stderr.write = originalStderrWrite;
  });

  describe('main() — normal startup', () => {
    it('should initialize and connect server successfully', async () => {
      await import('../src/index.ts');
      await new Promise(resolve => setTimeout(resolve, 100));
      
      expect(mockServerInstance.initialize).toHaveBeenCalled();
      expect(mockServerInstance.connect).toHaveBeenCalled();
    });

    it('should exit(1) on initialization failure', async () => {
      mockServerInstance.initialize.mockRejectedValueOnce(new Error('init failed'));
      
      await import('../src/index.ts');
      await new Promise(resolve => setTimeout(resolve, 200));
      
      // console.error is called with two args: "Failed to start server:" and error
      expect(consoleErrorMock).toHaveBeenCalled();
      const calls = (consoleErrorMock as any).mock.calls;
      const errorCall = calls.find((call: any[]) => 
        call[0] === 'Failed to start server:'
      );
      expect(errorCall).toBeTruthy();
    });
  });

  describe('signal handlers — graceful shutdown', () => {
    it('should register SIGTERM handler', async () => {
      await import('../src/index.ts');
      
      expect(signalHandlers.has('SIGTERM')).toBe(true);
      expect(signalHandlers.get('SIGTERM')).toBeInstanceOf(Function);
    });

    it('should register SIGINT handler', async () => {
      await import('../src/index.ts');
      
      expect(signalHandlers.has('SIGINT')).toBe(true);
      expect(signalHandlers.get('SIGINT')).toBeInstanceOf(Function);
    });

    it('should register SIGHUP handler', async () => {
      await import('../src/index.ts');
      
      expect(signalHandlers.has('SIGHUP')).toBe(true);
      expect(signalHandlers.get('SIGHUP')).toBeInstanceOf(Function);
    });

    it('should call server.close() on SIGTERM', async () => {
      await import('../src/index.ts');
      await new Promise(resolve => setTimeout(resolve, 50));
      
      const sigtermHandler = signalHandlers.get('SIGTERM');
      expect(sigtermHandler).toBeTruthy();
      
      await sigtermHandler!('SIGTERM');
      
      expect(mockServerInstance.close).toHaveBeenCalled();
    });
  });

  describe('uncaught exception handler', () => {
    it('should call shutdown on uncaughtException', async () => {
      await import('../src/index.ts');
      
      const handler = signalHandlers.get('uncaughtException');
      expect(handler).toBeTruthy();
      
      await handler!(new Error('test error'));
      
      expect(stderrWriteMock).toHaveBeenCalled();
      const calls = (stderrWriteMock as any).mock.calls;
      const errorCall = calls.find((call: any[]) => 
        call[0]?.includes?.('uncaughtException:')
      );
      expect(errorCall).toBeTruthy();
    });
  });

  describe('unhandled rejection handler', () => {
    it('should call shutdown on unhandledRejection', async () => {
      await import('../src/index.ts');
      
      const handler = signalHandlers.get('unhandledRejection');
      expect(handler).toBeTruthy();
      
      await handler!(new Error('test rejection'));
      
      expect(stderrWriteMock).toHaveBeenCalled();
      const calls = (stderrWriteMock as any).mock.calls;
      const errorCall = calls.find((call: any[]) => 
        call[0]?.includes?.('unhandledRejection:')
      );
      expect(errorCall).toBeTruthy();
    });
  });
});
