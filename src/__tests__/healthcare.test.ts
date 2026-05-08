/**
 * Healthcare module test suite — 100% coverage for src/healthcare
 *
 * Mocks all side-effectful dependencies:
 *   - withAudit    (audit/RBAC wrapper)
 *   - validatePath (path-guard)
 *   - fsGetMetadata (metadata helper)
 *   - scanContent  (secrets-detection, used by compliance)
 *   - fs (Node built-in, for FHIR file ops)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock audit wrapper ──
vi.mock('../handlers/shared/audit.js', () => ({
  withAudit: vi.fn(async (_ctx, _action, _filePath, fn) => fn()),
}));

// ── Mock path guard ──
vi.mock('../handlers/shared/path-guard.js', () => ({
  validatePath: vi.fn((_ctx, p) => p),
}));

// ── Mock metadata helper ──
vi.mock('../handlers/shared/metadata.js', () => ({
  fsGetMetadata: vi.fn().mockResolvedValue({ size: 123, mtime: new Date() }),
}));

// ── Mock Node's fs module (static import: 'node:fs') ──
// IMPORTANT: vi.mock factory is hoisted — cannot reference top-level vars.
// Use vi.fn() inline; get references via vi.mocked() after import.
vi.mock('node:fs', () => ({
  promises: {
    readFile: vi.fn(),
    unlink: vi.fn(),
    readdir: vi.fn(),
    mkdir: vi.fn(),
    writeFile: vi.fn(),
  },
}));

// ── Imports (after mocks) ──
import * as A2A from '../healthcare/a2a-router.js';
import * as Clinical from '../healthcare/clinical.js';
import * as Compliance from '../healthcare/compliance.js';
import * as Fhir from '../healthcare/fhir.js';
import * as Synthetic from '../healthcare/synthetic.js';
import { promises as _fsPromises } from 'node:fs';

// Typed mock references (resolved after vi.mock hoisting)
const fsReadFileMock = vi.mocked(_fsPromises.readFile);
const fsUnlinkMock = vi.mocked(_fsPromises.unlink);
const fsReaddirMock = vi.mocked(_fsPromises.readdir);
const fsMkdirMock = vi.mocked(_fsPromises.mkdir);
const fsWriteFileMock = vi.mocked(_fsPromises.writeFile);

// ── Helper: minimal fhir context ──
const createMockCtx = (overrides = {}) => ({
  db: {
    addVersion: vi.fn().mockResolvedValue(undefined),
    setFileMetadata: vi.fn().mockResolvedValue(undefined),
    deleteFileMetadata: vi.fn().mockResolvedValue(undefined),
    queryAudits: vi.fn().mockReturnValue([]),
  },
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  fsReadFileMock.mockResolvedValue('{}');
  fsUnlinkMock.mockResolvedValue(undefined);
  fsReaddirMock.mockResolvedValue([]);
  fsMkdirMock.mockResolvedValue(undefined);
  fsWriteFileMock.mockResolvedValue(undefined);
});

/* ===== A2A ROUTER ===== */
describe('Healthcare — A2A Router', () => {
  it('exports schemas for all 5 tools', () => {
    expect(A2A.a2aSchemas).toBeDefined();
    expect(A2A.a2aSchemas.a2aRouteMessage).toBeDefined();
    expect(A2A.a2aSchemas.a2aAgentCard).toBeDefined();
    expect(A2A.a2aSchemas.a2aDiscoverAgents).toBeDefined();
    expect(A2A.a2aSchemas.a2aSendTask).toBeDefined();
    expect(A2A.a2aSchemas.a2aGetTaskStatus).toBeDefined();
  });

  it('a2aAgentCard returns server capabilities', async () => {
    const result = await A2A.a2aAgentCard({} as any, {});
    expect(result.name).toBe('JCF Healthcare Agent Hub');
    expect(result.hipaaCompliant).toBe(true);
    expect(result.capabilities).toContain('fhir_crud');
  });

  it('a2aDiscoverAgents returns all agents', async () => {
    const result = await A2A.a2aDiscoverAgents(createMockCtx() as any, {});
    expect(result.agentCount).toBeGreaterThan(0);
    expect(result.agents[0]).toHaveProperty('agentId');
  });

  it('a2aDiscoverAgents filters by capability', async () => {
    const result = await A2A.a2aDiscoverAgents(createMockCtx() as any, { capability: 'lab_order' });
    expect(result.agents.every((a: any) => a.capabilities.includes('lab_order'))).toBe(true);
  });

  it('a2aSendTask creates a queued task', async () => {
    const result = await A2A.a2aSendTask(createMockCtx() as any, {
      taskType: 'lab_order',
      targetAgentId: 'lab-agent-v1',
      patientIdHash: 'hash123',
      payload: { test: 'CBC' },
      priority: 'urgent',
    });
    expect(result.taskId).toMatch(/^task-/);
    expect(result.status).toBe('queued');
    expect(result.estimatedCompletionMinutes).toBe(30);
  });

  it('a2aGetTaskStatus returns not_found for unknown task', async () => {
    const result = await A2A.a2aGetTaskStatus(createMockCtx() as any, { taskId: 'nonexistent' });
    expect(result.status).toBe('not_found');
  });

  it('a2aGetTaskStatus returns task for known task', async () => {
    const sendResult = await A2A.a2aSendTask(createMockCtx() as any, {
      taskType: 'lab_order',
      targetAgentId: 'lab-agent-v1',
      patientIdHash: 'h',
      payload: {},
      priority: 'routine',
    });
    const statusResult = await A2A.a2aGetTaskStatus(createMockCtx() as any, { taskId: sendResult.taskId });
    expect(statusResult.status).toBe('queued');
    expect(statusResult.taskType).toBe('lab_order');
  });

  it('routes to known agent (lab-agent-v1)', async () => {
    const result = await A2A.a2aRouteMessage(createMockCtx() as any, {
      message: { from: 'alice', to: 'lab-agent-v1', protocol: 'a2a', payload: {} },
      routingMode: 'direct',
    });
    expect(result.delivered).toBe(true);
    expect(result.targetAgentFound).toBe(true);
    expect(result.messageId).toMatch(/^a2a-/);
  });

  it('routes to unknown agent (not found in registry)', async () => {
    const result = await A2A.a2aRouteMessage(createMockCtx() as any, {
      message: { from: 'alice', to: 'bob', protocol: 'a2a', payload: {} },
      routingMode: 'direct',
    });
    expect(result.delivered).toBe(false);
    expect(result.route).toBe('direct:bob');
  });

  it('routes broadcast (unknown target)', async () => {
    const result = await A2A.a2aRouteMessage(createMockCtx() as any, {
      message: { from: 'a', to: 'all', protocol: 'a2a', payload: {} },
      routingMode: 'broadcast',
    });
    expect(result.route).toBe('broadcast:all');
  });

  it('routes by capability (unknown target)', async () => {
    const result = await A2A.a2aRouteMessage(createMockCtx() as any, {
      message: { from: 'a', to: 'xray', protocol: 'a2a', payload: {} },
      routingMode: 'capability',
    });
    expect(result.route).toBe('capability:xray');
  });
});

/* ===== CLINICAL ===== */
describe('Healthcare — Clinical Decision Support', () => {
  it('exports schemas', () => {
    expect(Clinical.clinicalSchemas).toBeDefined();
    expect(Object.keys(Clinical.clinicalSchemas)).toHaveLength(6);
  });

  describe('clinicalAssess', () => {
    it('flags missing HbA1c for diabetes', async () => {
      const result = await Clinical.clinicalAssess({} as any, {
        patientId: 'p1',
        conditions: ['E11.9'],
        medications: [],
        labs: [],
      });
      expect(result.risks.some((r: string) => r.includes('Uncontrolled diabetes') && r.includes('HbA1c'))).toBe(true);
      expect(result.recommendations.some((r: string) => r.includes('HbA1c') || r.includes('3 months'))).toBe(true);
    });

    it('detects warfarin + ibuprofen interaction [MAJOR]', async () => {
      const result = await Clinical.clinicalAssess({} as any, {
        patientId: 'p2',
        conditions: [],
        medications: [
          { name: 'Warfarin', dose: '5mg', frequency: 'daily' },
          { name: 'Ibuprofen', dose: '200mg', frequency: 'prn' },
        ],
        labs: [],
      });
      expect(result.risks.some((r: string) => r.includes('Warfarin + NSAID: high bleeding risk'))).toBe(true);
      expect(result.recommendations.some((r: string) => r.includes('acetaminophen'))).toBe(true);
    });

    it('no issues for healthy patient with no conditions', async () => {
      const result = await Clinical.clinicalAssess({} as any, {
        patientId: 'p3',
        conditions: [],
        medications: [{ name: 'Multivitamin', dose: '1', frequency: 'daily' }],
        labs: [],
      });
      expect(result.risks).toEqual([]);
      expect(result.recommendations).toEqual([]);
    });

    it('returns conditionsAssessed and medicationsChecked', async () => {
      const result = await Clinical.clinicalAssess({} as any, {
        patientId: 'p4',
        conditions: ['I10'],
        medications: [{ name: 'Lisinopril', dose: '10mg', frequency: 'daily' }],
        labs: [],
      });
      expect(result.conditionsAssessed).toBe(1);
      expect(result.medicationsChecked).toBe(1);
    });
  });

  describe('carePlanCreate', () => {
    it('creates a care plan', async () => {
      const result = await Clinical.carePlanCreate({} as any, {
        patientId: 'p1',
        goals: ['Goal1'],
        interventions: [
          { type: 'medication', description: 'Drug X', durationDays: 10 },
          { type: 'lifestyle', description: 'Exercise' },
        ],
      });
      expect(result.planId).toMatch(/^cp-/);
      expect(result.timeline).toHaveLength(2);
      expect(result.timeline[0].estimatedDurationDays).toBe(10);
      expect(result.timeline[1].estimatedDurationDays).toBe(7);
    });
  });

  describe('medicationCheck', () => {
    it('detects duplicate medication', async () => {
      const result = await Clinical.medicationCheck({} as any, {
        current: [{ name: 'Aspirin', dose: '81mg', frequency: 'daily' }],
        proposed: [{ name: 'Aspirin', dose: '81mg', frequency: 'daily' }],
      });
      expect(result.conflicts).toContain('Duplicate medication: Aspirin already in current list');
    });

     it('detects lisinopril + spironolactone interaction', async () => {
       const result = await Clinical.medicationCheck({} as any, {
         current: [{ name: 'Spironolactone', dose: '25mg', frequency: 'daily' }],
         proposed: [{ name: 'Lisinopril', dose: '10mg', frequency: 'daily' }],
       });
       // Uses DRUG_INTERACTIONS array — label format: "DrugA + DrugB: <risk description>"
       expect(result.interactions.some((i: string) =>
         i.toLowerCase().includes('lisinopril') && i.toLowerCase().includes('spironolactone')
       )).toBe(true);
     });

    it('no issues', async () => {
      const result = await Clinical.medicationCheck({} as any, {
        current: [{ name: 'Metformin', dose: '500mg', frequency: 'bid' }],
        proposed: [{ name: 'Glipizide', dose: '5mg', frequency: 'daily' }],
      });
      expect(result.conflicts).toEqual([]);
      expect(result.interactions).toEqual([]);
    });
  });

  describe('labInterp', () => {
    it('interprets low value', async () => {
      const result = await Clinical.labInterp({} as any, {
        tests: [{ code: 'A1C', value: 5.0, unit: '%', referenceRange: { low: 5.5, high: 6.5 } }],
      });
      expect(result.interpretations[0].status).toBe('LOW');
    });

    it('interprets high value', async () => {
      const result = await Clinical.labInterp({} as any, {
        tests: [{ code: 'A1C', value: 8.0, unit: '%', referenceRange: { low: 5.5, high: 6.5 } }],
      });
      expect(result.interpretations[0].status).toBe('HIGH');
    });

    it('interprets normal value', async () => {
      const result = await Clinical.labInterp({} as any, {
        tests: [{ code: 'A1C', value: 6.0, unit: '%', referenceRange: { low: 5.5, high: 6.5 } }],
      });
      expect(result.interpretations[0].status).toBe('NORMAL');
    });

    it('returns UNKNOWN when no reference range', async () => {
      const result = await Clinical.labInterp({} as any, {
        tests: [{ code: 'A1C', value: 6.0, unit: '%' }],
      });
      expect(result.interpretations[0].status).toBe('UNKNOWN');
    });
  });

  describe('riskCalculate', () => {
    it('calculates low risk', async () => {
      const result = await Clinical.riskCalculate({} as any, { age: 40, conditions: ['I10'], labs: [] });
      expect(result.score).toBe(1);
      expect(result.category).toBe('low');
    });

    it('calculates medium risk', async () => {
      const result = await Clinical.riskCalculate({} as any, {
        age: 70,
        conditions: ['E11.9', 'I10', 'J45.909'],
        labs: [],
      });
      expect(result.score).toBe(4);
      expect(result.category).toBe('medium');
    });

    it('calculates high risk', async () => {
      const result = await Clinical.riskCalculate({} as any, {
        age: 80,
        conditions: ['A', 'B', 'C', 'D', 'E'],
        labs: [],
      });
      expect(result.category).toBe('high');
    });
  });

  describe('guidelineLookup', () => {
    it('returns known guidelines', async () => {
      const result = await Clinical.guidelineLookup({} as any, { condition: 'E11.9' });
      expect(result.recommendations).toContain('Annual dilated eye exam');
    });

    it('returns default for unknown', async () => {
      const result = await Clinical.guidelineLookup({} as any, { condition: 'Z00.0' });
      expect(result.recommendations).toContain('No specific guideline found for this condition');
    });
  });
});

/* ===== HIPAA COMPLIANCE ===== */
describe('Healthcare — HIPAA Compliance', () => {
  it('exports schemas', () => {
    expect(Compliance.complianceSchemas).toBeDefined();
    expect(Object.keys(Compliance.complianceSchemas)).toHaveLength(5);
  });

  describe('hipaaAuditReport', () => {
    it('uses defaults for dates', async () => {
      const ctx = createMockCtx();
      const result = await Compliance.hipaaAuditReport(ctx as any, {});
      expect(result.period).toHaveProperty('start');
      expect(result.period).toHaveProperty('end');
      expect(result.totalAccessEvents).toBe(0);
    });

    it('accepts custom date range', async () => {
      const ctx = createMockCtx();
      const result = await Compliance.hipaaAuditReport(ctx as any, {
        startDate: '2025-01-01T00:00:00Z',
        endDate: '2025-12-31T23:59:59Z',
      });
      expect(result.period.start).toBe('2025-01-01T00:00:00Z');
      expect(result.period.end).toBe('2025-12-31T23:59:59Z');
    });
  });

  describe('consentManage', () => {
    it('creates consent', async () => {
      const result = await Compliance.consentManage({} as any, {
        patientIdHash: 'h123',
        purpose: 'treatment',
        grantedBy: 'doc',
      });
      expect(result.consentId).toMatch(/^consent-/);
      expect(result.status).toBe('active');
    });
  });

   describe('phiDetection', () => {
     it('returns safe when no matches', async () => {
       const result = await Compliance.phiDetection({} as any, {
         content: 'clean text',
         filePath: 'clean.txt',
         sensitivityLevel: 'medium',
       });
       expect(result.phiCount).toBe(0);
       expect(result.safe).toBe(true);
     });

     it('detects SSN pattern (high sensitivity)', async () => {
       const result = await Compliance.phiDetection({} as any, {
         content: 'Patient SSN: 123-45-6789 found',
         sensitivityLevel: 'high',
       });
       expect(result.phiCount).toBeGreaterThan(0);
       expect(result.matches[0].type).toBe('SSN');
       expect(result.matches[0].value).toBe('[REDACTED:SSN]');
     });

     it('detects email pattern (medium sensitivity)', async () => {
       const result = await Compliance.phiDetection({} as any, {
         content: 'Contact: john.doe@hospital.com',
         sensitivityLevel: 'medium',
       });
       expect(result.phiCount).toBeGreaterThan(0);
       expect(result.matches[0].type).toBe('email');
     });

     it('excludes low-severity patterns at high threshold', async () => {
       const result = await Compliance.phiDetection({} as any, {
         content: 'zip: 90210',
         sensitivityLevel: 'high',
       });
       expect(result.safe).toBe(true);
     });
   });

  describe('accessLog', () => {
    it('defaults limit to 100', async () => {
      const ctx = createMockCtx();
      const result = await Compliance.accessLog(ctx as any, { action: 'read' });
      expect(result.limit).toBe(100);
      expect(result.events).toEqual([]);
    });
  });

  describe('breachAssess', () => {
    it('assesses low (1 resource, no sensitive data)', async () => {
      const ctx = createMockCtx();
      const result = await Compliance.breachAssess(ctx as any, {
        incidentType: 'test',
        affectedResources: [{ resourceType: 'R', resourceId: '1', patientIdHash: 'abc' }],
        description: 'x',
        containsSensitiveData: false,
      });
      expect(result.riskLevel).toBe('low');
    });

    it('assesses medium (10 resources, no sensitive data)', async () => {
      const ctx = createMockCtx();
      const result = await Compliance.breachAssess(ctx as any, {
        incidentType: 'test',
        affectedResources: Array(10).fill({ resourceType: 'R', resourceId: '1', patientIdHash: 'abc' }),
        description: 'x',
        containsSensitiveData: false,
      });
      expect(result.riskLevel).toBe('medium');
    });

    it('assesses high when containsSensitiveData + multiple resources', async () => {
      const ctx = createMockCtx();
      const result = await Compliance.breachAssess(ctx as any, {
        incidentType: 'test',
        affectedResources: Array(5).fill({ resourceType: 'R', resourceId: '1', patientIdHash: 'hash' }),
        description: 'x',
        containsSensitiveData: true,
      });
      expect(result.riskLevel).toBe('high');
      expect(result.requiresNotification).toBe(true);
    });

    it('assesses critical for large breaches with sensitive data', async () => {
      const ctx = createMockCtx();
      const result = await Compliance.breachAssess(ctx as any, {
        incidentType: 'test',
        affectedResources: Array(15).fill({ resourceType: 'R', resourceId: '1', patientIdHash: 'hash' }),
        description: 'x',
        containsSensitiveData: true,
      });
      expect(result.riskLevel).toBe('critical');
    });
  });
});

/* ===== FHIR ENGINE ===== */
describe('Healthcare — FHIR Engine', () => {
  it('exports schemas with 8 entries', () => {
    expect(Fhir.fhirSchemas).toBeDefined();
    expect(Object.keys(Fhir.fhirSchemas)).toHaveLength(8);
  });

  const baseCtx = createMockCtx();

  describe('fhirCreate', () => {
    it('creates a resource and writes to filesystem', async () => {
      const resource = { id: 'pat1', resourceType: 'Patient', name: [{ text: 'John' }] };
      const result = await Fhir.fhirCreate(baseCtx as any, {
        resourceType: 'Patient',
        resource,
        author: 'alice',
      });
      expect(result).toMatchObject({ id: 'pat1', location: 'fhir://local/Patient/pat1' });
      expect(fsMkdirMock).toHaveBeenCalledTimes(1);
      expect(fsWriteFileMock).toHaveBeenCalledTimes(1);
      expect(baseCtx.db.addVersion).toHaveBeenCalledTimes(1);
      expect(baseCtx.db.setFileMetadata).toHaveBeenCalledTimes(1);
    });

    it('throws if resource id is missing or not a string', async () => {
      const resource = { resourceType: 'Patient', name: [{ text: 'John' }] };
      await expect(Fhir.fhirCreate(baseCtx as any, {
        resourceType: 'Patient',
        resource,
        author: 'alice',
      })).rejects.toThrow(/FHIR resource must have a string 'id' field/);
    });

    it('rolls back file and throws when addVersion fails', async () => {
      baseCtx.db.addVersion.mockRejectedValueOnce(new Error('DB failure'));
      const resource = { id: 'pat1', resourceType: 'Patient', name: [{ text: 'John' }] };
      await expect(Fhir.fhirCreate(baseCtx as any, {
        resourceType: 'Patient',
        resource,
        author: 'alice',
      })).rejects.toThrow('DB failure');
      expect(fsUnlinkMock).toHaveBeenCalledOnce();
    });
  });

   describe('fhirRead', () => {
     it('reads JSON file', async () => {
       // JCF-7: fhirRead now validates resource. Provide a valid Patient
       // with all required fields (name, gender, birthDate) so validation passes.
       fsReadFileMock.mockResolvedValueOnce(JSON.stringify({
         id: 'pat1',
         resourceType: 'Patient',
         name: [{ text: 'John' }],
         gender: 'male',
         birthDate: '2000-01-01',
       }));
        const result = await Fhir.fhirRead(baseCtx as any, { resourceType: 'Patient', id: 'pat1' });
        expect(result.resource.id).toBe('pat1');
      });

      it('throws when FHIR validation fails', async () => {
        // Resource missing required field 'name' for Patient
        const invalidResource = {
          id: 'pat1',
          resourceType: 'Patient',
          gender: 'male',
          birthDate: '2000-01-01',
        };
        fsReadFileMock.mockResolvedValueOnce(JSON.stringify(invalidResource));
        await expect(Fhir.fhirRead(baseCtx as any, {
          resourceType: 'Patient',
          id: 'pat1',
        })).rejects.toThrow(/FHIR validation failed/);
      });
    });

  describe('fhirUpdate', () => {
    it('updates resource', async () => {
      const resource = { id: 'pat1', resourceType: 'Patient' };
      const result = await Fhir.fhirUpdate(baseCtx as any, {
        resourceType: 'Patient',
        id: 'pat1',
        resource,
        message: 'update',
      });
      expect(result.id).toBe('pat1');
    });

    it('rolls back file and throws when addVersion fails on update', async () => {
      baseCtx.db.addVersion.mockRejectedValueOnce(new Error('DB failure'));
      const resource = { id: 'pat1', resourceType: 'Patient', name: [{ text: 'John' }] };
      await expect(Fhir.fhirUpdate(baseCtx as any, {
        resourceType: 'Patient',
        id: 'pat1',
        resource,
        message: 'update',
      })).rejects.toThrow('DB failure');
      expect(fsUnlinkMock).toHaveBeenCalledOnce();
    });
  });

  describe('fhirDelete', () => {
    it('deletes resource file', async () => {
      const result = await Fhir.fhirDelete(baseCtx as any, { resourceType: 'Patient', id: 'pat1' });
      expect(result.success).toBe(true);
      expect(fsUnlinkMock).toHaveBeenCalledTimes(1);
    });

    it('propagates error when unlink fails with non-ENOENT', async () => {
      const accessError = new Error('access denied') as any;
      accessError.code = 'EACCES';
      fsUnlinkMock.mockRejectedValueOnce(accessError);
      await expect(Fhir.fhirDelete(baseCtx as any, {
        resourceType: 'Patient',
        id: 'pat1',
      })).rejects.toThrow('access denied');
    });
  });

  describe('fhirSearch', () => {
    it('returns all resources without params and includes pagination info', async () => {
      (fsReaddirMock as any).mockResolvedValueOnce(['c1.json', 'c2.json']);
      fsReadFileMock
        .mockResolvedValueOnce(JSON.stringify({ id: 'c1' }))
        .mockResolvedValueOnce(JSON.stringify({ id: 'c2' }));
      const result = await Fhir.fhirSearch(baseCtx as any, { resourceType: 'Condition', limit: 100, offset: 0 });
      expect(result.total).toBe(2);
      expect(result.resources).toHaveLength(2);
      expect(result).toHaveProperty('offset');
      expect(result).toHaveProperty('limit');
    });

    it('returns empty result when directory not found', async () => {
      (fsReaddirMock as any).mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      const result = await Fhir.fhirSearch(baseCtx as any, { resourceType: 'Missing', limit: 100, offset: 0 });
      expect(result.total).toBe(0);
      expect(result.resources).toEqual([]);
    });

    it('filters by query params', async () => {
      (fsReaddirMock as any).mockResolvedValueOnce(['o1.json']);
      fsReadFileMock.mockResolvedValueOnce(JSON.stringify({ code: 'A1C', status: 'final' }));
      const result = await Fhir.fhirSearch(baseCtx as any, {
        resourceType: 'Observation',
        params: { code: 'A1C' },
        limit: 100,
        offset: 0,
      });
      expect(result.resources).toHaveLength(1);
      expect(result.resources[0].code).toBe('A1C');
    });

    it('throws when readdir fails with non-ENOENT error', async () => {
      const err = new Error('readdir failure') as any;
      err.code = 'EIO';
      fsReaddirMock.mockRejectedValueOnce(err);
      await expect(Fhir.fhirSearch(baseCtx as any, {
        resourceType: 'Condition',
        limit: 100,
        offset: 0,
      })).rejects.toThrow('readdir failure');
    });
  });

   describe('fhirBatch', () => {
     it('handles mixed ops', async () => {
       // JCF-7: fhirRead validates resources. Use a valid Patient resource.
       const validPatient = {
         id: 'pat1',
         resourceType: 'Patient',
         name: [{ text: 'John' }],
         gender: 'male',
         birthDate: '2000-01-01',
       };
       // Simulate in-memory filesystem for the batch sequence:
       // - writeFile (create) stores content
       // - readFile returns the stored content
       // - deleteFile reads then removes (handled by mock)
       const fileMap = new Map<string, string>();
        (fsWriteFileMock as any).mockImplementation(async (p: string, content: string) => {
          fileMap.set(p, content);
        });
        (fsReadFileMock as any).mockImplementation(async (p: string) => {
          const c = fileMap.get(p);
          if (c === undefined) throw new Error('ENOENT');
          return c;
        });

       const result = await Fhir.fhirBatch(baseCtx as any, {
         operations: [
           { op: 'create', resourceType: 'Patient', resource: validPatient },
           { op: 'read', resourceType: 'Patient', id: 'pat1' },
           { op: 'update', resourceType: 'Patient', id: 'pat1', resource: validPatient },
           { op: 'delete', resourceType: 'Patient', id: 'pat1' },
         ],
      });
       expect(result.results).toHaveLength(4);
       result.results.forEach(r => expect(r.success).toBe(true));
     });

    it('continues on individual failure', async () => {
      // Simulate readFile failure; the read operation should fail while create succeeds
      fsReadFileMock.mockRejectedValueOnce(new Error('missing'));
      const result = await Fhir.fhirBatch(baseCtx as any, {
        operations: [
          { op: 'read', resourceType: 'Patient', id: 'missing' },
          { op: 'create', resourceType: 'Patient', resource: { id: 'p2', resourceType: 'Patient' } },
        ],
      });
      expect(result.results[0].success).toBe(false);
      expect(result.results[1].success).toBe(true);
    });

    it('returns error result for unknown operation', async () => {
      const validPatient = {
        id: 'pat1',
        resourceType: 'Patient',
        name: [{ text: 'John' }],
        gender: 'male',
        birthDate: '2000-01-01',
      };
      const result = await Fhir.fhirBatch(baseCtx as any, {
        operations: [
          { op: 'create', resourceType: 'Patient', resource: validPatient },
          { op: 'foo' as any, resourceType: 'Patient', id: 'pat1' }, // unknown op
        ],
      });
      expect(result.results).toHaveLength(2);
      expect(result.results[0].success).toBe(true);
      expect(result.results[1].success).toBe(false);
      expect(result.results[1].error).toMatch(/Unknown op: foo/);
    });
  });

  describe('fhirValidate', () => {
    it('validates complete Patient', async () => {
      const result = await Fhir.fhirValidate({} as any, {
        resourceType: 'Patient',
        resource: {
          id: 'p1',
          resourceType: 'Patient',
          name: [{ text: 'John' }],
          gender: 'male',
          birthDate: '2000-01-01',
        },
      });
      expect(result.valid).toBe(true);
      expect(result.missing).toEqual([]);
    });

    it('detects missing required fields for Patient', async () => {
      const result = await Fhir.fhirValidate({} as any, {
        resourceType: 'Patient',
        resource: { id: 'p1', resourceType: 'Patient' },
      });
      expect(result.valid).toBe(false);
      expect(result.missing).toContain('name');
      expect(result.missing).toContain('gender');
      expect(result.missing).toContain('birthDate');
    });

    it('Observation requires status and code (valueQuantity no longer required)', async () => {
      const result = await Fhir.fhirValidate({} as any, {
        resourceType: 'Observation',
        resource: { id: 'o1', resourceType: 'Observation' },
      });
      expect(result.valid).toBe(false);
      expect(result.missing).toContain('status');
      expect(result.missing).toContain('code');
    });

    it('Procedure validates correctly', async () => {
      const result = await Fhir.fhirValidate({} as any, {
        resourceType: 'Procedure',
        resource: { id: 'p1', resourceType: 'Procedure' },
      });
      expect(result.valid).toBe(false);
      expect(result.missing).toContain('status');
    });

    it('unknown resourceType passes', async () => {
      const result = await Fhir.fhirValidate({} as any, {
        resourceType: 'Foo',
        resource: { foo: 'bar' },
      });
      expect(result.valid).toBe(true);
    });
  });

  describe('fhirCapability', () => {
    it('returns static capability info', async () => {
      const result = await Fhir.fhirCapability({} as any, {});
      expect(result.fhirVersion).toBe('R4');
      expect(result.resourceTypes).toContain('Patient');
      expect(result.resourceTypes).toContain('Procedure');
      expect(result.operations).toContain('batch');
      expect(result.implementation).toContain('JCF Healthcare Agent Hub');
      expect(result.storageBackend).toContain('filesystem');
    });
  });
});

/* ===== SYNTHETIC DATA GENERATION ===== */
describe('Healthcare — Synthetic Data Generation', () => {
  it('exports schemas', () => {
    expect(Synthetic.syntheticSchemas).toBeDefined();
    expect(Object.keys(Synthetic.syntheticSchemas)).toHaveLength(4);
  });

  describe('syntheticPatientGen', () => {
    it('generates one patient with defaults', async () => {
      const result = await Synthetic.syntheticPatientGen({} as any, {
        count: 1,
        minAge: 0,
        maxAge: 120,
      });
      expect(result.patients).toHaveLength(1);
      const p = result.patients[0];
      expect(p.resourceType).toBe('Patient');
      expect(p.id).toMatch(/^syn-/);
      expect(['male', 'female', 'other']).toContain(p.gender);
      expect(p.birthDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('generates multiple with constraints', async () => {
      const result = await Synthetic.syntheticPatientGen({} as any, {
        count: 5,
        minAge: 30,
        maxAge: 30,
        gender: 'female',
      });
      expect(result.patients).toHaveLength(5);
      expect(result.patients.every(p => p.gender === 'female')).toBe(true);
    });
  });

  describe('syntheticConditionGen', () => {
    it('generates condition with default diabetes code', async () => {
      const result = await Synthetic.syntheticConditionGen({} as any, { patientId: 'p1' });
      const c = result.condition;
      expect(c.resourceType).toBe('Condition');
      expect(c.code.coding[0].code).toBe('E11.9');
      expect(c.subject.reference).toBe('Patient/p1');
    });

    it('uses custom conditionCode', async () => {
      const result = await Synthetic.syntheticConditionGen({} as any, { patientId: 'p2', conditionCode: 'I10' });
      expect(result.condition.code.coding[0].code).toBe('I10');
    });
  });

  describe('syntheticObservationGen', () => {
    it('generates observation', async () => {
      const result = await Synthetic.syntheticObservationGen({} as any, {
        patientId: 'p1',
        loincCode: '2339-0',
        value: 5.5,
        unit: 'mg/dL',
      });
      const obs = result.observation;
      expect(obs.resourceType).toBe('Observation');
      expect(obs.code.coding[0].code).toBe('2339-0');
      expect(obs.valueQuantity.value).toBe(5.5);
    });
  });

  describe('syntheticBundleGen', () => {
    it('creates bundle with patient, condition, observation', async () => {
      const result = await Synthetic.syntheticBundleGen({} as any, {
        patientId: 'p1',
        conditions: ['E11.9'],
        observations: [{ loincCode: '2339-0', value: 6.0, unit: '%' }],
      });
      const bundle = result.bundle;
      expect(bundle.resourceType).toBe('Bundle');
      expect(bundle.type).toBe('collection');
      expect(bundle.entry).toHaveLength(3);
      expect(bundle.entry[0].resource.resourceType).toBe('Patient');
      expect(bundle.entry[1].resource.resourceType).toBe('Condition');
      expect(bundle.entry[2].resource.resourceType).toBe('Observation');
    });
  });
});
