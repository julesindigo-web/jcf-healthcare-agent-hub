import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../lib/database';
import { Logger } from '../lib/logger';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

describe('Database', () => {
  let db: Database;
  let logger: Logger;
  let dbPath: string;
  let tempDir: string;

  beforeEach(async () => {
    logger = new Logger('error');
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-test-'));
    dbPath = path.join(tempDir, 'test-db.json');
    db = new Database(dbPath, logger);
    await db.initialize();
  });

  afterEach(async () => {
    // Phase F1: close DB first so SQLite WAL/SHM files release their locks
    try { db.close(); } catch { /* ignore */ }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('file metadata', () => {
    it('should set and get file metadata', async () => {
      const metadata = {
        path: '/test/file.txt',
        size: 100,
        modified: new Date(),
        created: new Date(),
        mode: '644',
        language: 'text',
      };

      await db.setFileMetadata(metadata);
      const retrieved = db.getFileMetadata('/test/file.txt');

      expect(retrieved).not.toBeNull();
      expect(retrieved?.path).toBe('/test/file.txt');
      expect(retrieved?.size).toBe(100);
    });

    it('should return null for non-existent file', () => {
      const metadata = db.getFileMetadata('/nonexistent/file.txt');
      expect(metadata).toBeNull();
    });

    it('should update existing metadata', async () => {
      const metadata1 = {
        path: '/test/file.txt',
        size: 100,
        modified: new Date(),
        created: new Date(),
        mode: '644',
      };

      await db.setFileMetadata(metadata1);

      const metadata2 = {
        path: '/test/file.txt',
        size: 200,
        modified: new Date(),
        created: metadata1.created,
        mode: '644',
      };

      await db.setFileMetadata(metadata2);

      const retrieved = db.getFileMetadata('/test/file.txt');
      expect(retrieved?.size).toBe(200);
    });

    it('should delete file metadata', async () => {
      const metadata = {
        path: '/test/file.txt',
        size: 100,
        modified: new Date(),
        created: new Date(),
        mode: '644',
      };

      await db.setFileMetadata(metadata);
      await db.deleteFileMetadata('/test/file.txt');

      const retrieved = db.getFileMetadata('/test/file.txt');
      expect(retrieved).toBeNull();
    });
  });

  describe('version history', () => {
    it('should add version to history', async () => {
      await db.addVersion('/test/file.txt', 'hash1', 'author1', 'message1', 100);

      const versions = db.getVersions('/test/file.txt');
      expect(versions).toHaveLength(1);
      expect(versions[0].hash).toBe('hash1');
      expect(versions[0].author).toBe('author1');
      expect(versions[0].message).toBe('message1');
    });

    it('should maintain multiple versions', async () => {
      await db.addVersion('/test/file.txt', 'hash1', 'author1', 'message1', 100);
      await db.addVersion('/test/file.txt', 'hash2', 'author2', 'message2', 200);
      await db.addVersion('/test/file.txt', 'hash3', 'author3', 'message3', 300);

      const versions = db.getVersions('/test/file.txt');
      expect(versions).toHaveLength(3);
      // Most recent first
      expect(versions[0].hash).toBe('hash3');
    });

    it('should return empty array for file without versions', () => {
      const versions = db.getVersions('/nonexistent/file.txt');
      expect(versions).toEqual([]);
    });
  });

  describe('audit logging', () => {
    it('should record audit event', async () => {
      await db.recordAudit({
        userId: 'user1',
        action: 'read',
        path: '/test/file.txt',
        result: 'success',
      });

      const events = db.queryAudits({});
      expect(events).toHaveLength(1);
      expect(events[0].userId).toBe('user1');
      expect(events[0].action).toBe('read');
    });

    it('should filter audit events by user', async () => {
      await db.recordAudit({ userId: 'user1', action: 'read', path: '/test/file.txt', result: 'success' });
      await db.recordAudit({ userId: 'user2', action: 'write', path: '/test/file.txt', result: 'success' });

      const events = db.queryAudits({ userId: 'user1' });
      expect(events).toHaveLength(1);
      expect(events[0].userId).toBe('user1');
    });

    it('should filter audit events by action', async () => {
      await db.recordAudit({ userId: 'user1', action: 'read', path: '/test/file.txt', result: 'success' });
      await db.recordAudit({ userId: 'user1', action: 'write', path: '/test/file.txt', result: 'success' });

      const events = db.queryAudits({ action: 'write' });
      expect(events).toHaveLength(1);
      expect(events[0].action).toBe('write');
    });

    it('should limit audit results', async () => {
      for (let i = 0; i < 5; i++) {
        await db.recordAudit({ userId: 'user1', action: 'read', path: '/test/file.txt', result: 'success' });
      }

      const events = db.queryAudits({ limit: 3 });
      expect(events).toHaveLength(3);
    });
  });

  describe('persistence', () => {
    it('should persist data to disk', async () => {
      const metadata = {
        path: '/test/file.txt',
        size: 100,
        modified: new Date(),
        created: new Date(),
        mode: '644',
      };

      await db.setFileMetadata(metadata);
      await db.save(); // Explicitly wait for save to complete

      const db2 = new Database(dbPath, logger);
      try {
        await db2.initialize();
        const retrieved = db2.getFileMetadata('/test/file.txt');
        expect(retrieved).not.toBeNull();
        expect(retrieved?.path).toBe('/test/file.txt');
      } finally {
        // Close to release WAL/SHM locks before afterEach rm
        db2.close();
      }
    });

    it('should get all tracked files', async () => {
      await db.setFileMetadata({ path: '/test/file1.txt', size: 100, modified: new Date(), created: new Date(), mode: '644' });
      await db.setFileMetadata({ path: '/test/file2.txt', size: 200, modified: new Date(), created: new Date(), mode: '644' });

      const files = db.getAllFiles();
      expect(files).toHaveLength(2);
      expect(files).toContain('/test/file1.txt');
      expect(files).toContain('/test/file2.txt');
    });
  });

  describe('statistics', () => {
    it('should return database stats', () => {
      const stats = db.getStats();
      expect(stats).toHaveProperty('fileCount');
      expect(stats).toHaveProperty('versionCount');
      expect(stats).toHaveProperty('auditCount');
      expect(stats).toHaveProperty('sizeBytes');
    });
  });
});
