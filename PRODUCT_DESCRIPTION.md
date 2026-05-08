# JCF Healthcare Agent Hub — Product Description

## What It Is

JCF Healthcare Agent Hub is a **standalone Model Context Protocol (MCP) server** that enables AI language models to interact directly with healthcare systems. It serves as a bridge between AI agents (Claude, GPT-4, Gemini, etc.) and clinical infrastructure.

## Core Value Proposition

Healthcare AI agents need:
1. **Structured clinical data access** (FHIR R4 resources)
2. **Clinical intelligence** (drug interaction checks, risk assessment, care planning)
3. **Compliance guarantees** (HIPAA audit trails, PHI detection)
4. **Agent-to-agent coordination** (routing to specialized healthcare agents)
5. **Safe testing data** (synthetic PHI-free patient generation)

JCF Healthcare Agent Hub delivers all five in a single MCP server with 59 tools.

## Technical Specifications

- **Protocol:** Model Context Protocol (MCP) SDK 1.29.0
- **FHIR Version:** R4
- **Database:** SQLite (better-sqlite3) for audit logs and version history
- **Storage:** Filesystem-backed FHIR resource store with SQLite versioning
- **Language:** TypeScript (ESM), Node.js 18+
- **Test Coverage:** 2382 tests passing (0 failures), 85%+ statements, 89%+ functions
- **Logging:** Pino structured logging
- **Validation:** Zod schema validation on all tool inputs

## Tool Categories

### FHIR R4 Engine (8 tools)
Full CRUD + batch + validation + capability declaration for 7 resource types:
Patient, Condition, Observation, Procedure, MedicationRequest, Encounter, AllergyIntolerance

**Features:**
- Two-phase commit with compensation for transactional integrity
- Semantic validation per FHIR R4 specification
- Filesystem-based storage with SQLite versioning
- Paginated search with parameter filtering

### Clinical Decision Support (6 tools)
Rule-based CDS with 15+ drug interaction checks, 9 condition assessment rules, guidelines for 15+ conditions (ADA diabetes, JNC8 hypertension, GINA asthma, KDIGO CKD, Framingham), and multi-factor risk scoring.

**Features:**
- 15 drug interaction pairs (warfarin, digoxin, metformin, statins, etc.)
- 9 ICD-10 condition rules with age-stratified risk scoring
- 15+ clinical guidelines lookup
- JSON Schema validation for all inputs/outputs

### HIPAA Compliance (5 tools)
PHI detection (10 pattern types per HIPAA Safe Harbor §164.514(b)(2)), real audit trail queries, breach notification assessment with 500-affected threshold calculation, consent management.

**Features:**
- 10 PHI pattern types (SSN, DOB, phone, email, MRN, NPI, address, etc.)
- Real-time audit trail from SQLite database
- Breach assessment with HIPAA notification threshold
- Consent management with expiry tracking
- Access logging with PHI event filtering

### Synthetic Data Generation (4 tools)
FHIR-compliant PHI-safe synthetic patients, conditions (ICD-10 coded), LOINC observations, and complete clinical bundles for testing.

**Features:**
- Faker-based generation (FHIR-compliant)
- Zero real PHI — all data is synthetic
- Configurable count and demographic parameters
- Bundle generation for complete clinical scenarios

### A2A Bridge (5 tools)
W3C Agent2Agent protocol draft-01 implementation: agent card declaration, static registry of 4 healthcare sub-agents (Lab, Pharmacy, Radiology, Referral), priority task queuing, and message routing.

**Features:**
- W3C A2A draft-01 specification compliance
- In-memory task store (documented as hackathon demo)
- Static agent registry (Lab, Pharmacy, Radiology, Referral)
- Priority-based task queue (routine/urgent/stat)

### Base File Intelligence (31 tools)
Cognitive index engine, semantic search, dependency tracking, impact analysis, version control, security, and self-healing.

**Features:**
- 3-layer cognitive index (skeleton → contracts → fingerprints)
- Node-Level Knowledge Graph with typed edges
- Pattern detection (11 categories + semantic compression)
- Type flow analyzer (trace data through codebase)
- Impact analysis (direct + transitive dependencies)
- Semantic search (tf-idf + Qwen3-Embedding RRF)
- Content versioning (content-hash addressing + rollback)
- RBAC security (role-based policies)
- Secrets scanning (30+ patterns)
- Audit logging (immutable SQLite trail)
- Self-healing (AERS auto-recovery)

## Architecture Decisions

- **ADR-H001**: JCF Constitutional enforcement removed — healthcare hub is domain-specific; the enforcement layer is not relevant to clinical users
- **ADR-H002**: FHIR storage via filesystem + SQLite versioning — resources are readable files with full change history
- **ADR-H003**: Simplified diagnostics — `ping` tool only, no enforcement gates
- **ADR-H004**: A2A in-memory task store — hackathon demo, not persistent
- **ADR-H005**: A2A static agent registry — no dynamic registration

## Target Users

- Healthcare AI developers building clinical decision support
- EHR integration engineers connecting AI agents to FHIR APIs
- Healthcare IT teams building A2A clinical workflows
- Researchers needing synthetic clinical data generation
- Compliance teams auditing AI access to PHI

## Competition Readiness

**Agents Assemble: The Healthcare AI Endgame Hackathon**

### Stage One Requirements (Pass/Fail)
- ✅ MCP server implementation (59 tools, Path A)
- ⏳ Marketplace publication (pending hosting)
- ⏳ Prompt Opinion integration (pending)
- ✅ Synthetic/de-identified data only (no PHI)

### Stage Two Scoring Criteria
- **AI Factor:** LLM reasoning for complex clinical decisions (drug interactions, risk assessment)
- **Potential Impact:** Medication error prevention, workflow efficiency, HIPAA compliance
- **Feasibility:** Standards-based (MCP, FHIR, A2A), production-ready security

---

*JCF Healthcare Agent Hub · v2.1.0-healthcare · MIT-like license*
