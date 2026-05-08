# JCF Healthcare Agent Hub - User Guide

> **Type**: Production-Grade MCP Server | **Tools**: 59 (31 base + 28 healthcare) | **Version**: 2.1.0-healthcare

---

## Table of Contents

1. [Introduction](#introduction)
2. [Key Features](#key-features)
3. [System Architecture](#system-architecture)
4. [Tool Reference](#tool-reference)
5. [Configuration](#configuration)
6. [Advanced Usage](#advanced-usage)
7. [Security](#security)
8. [Troubleshooting](#troubleshooting)
9. [Best Practices](#best-practices)
10. [IDE Integration](#ide-integration)

---

## Introduction

### What is JCF Healthcare Agent Hub?

**JCF Healthcare Agent Hub** is a production-grade Model Context Protocol (MCP) server providing intelligent, secure, self-healing filesystem operations **plus comprehensive healthcare domain tools**. Built with JCF (Jules Cognitive Framework), this server delivers enterprise capabilities far beyond standard marketplace implementations.

### Healthcare Domain Capabilities

This server extends the base JCF handling tool with healthcare-specific functionality:

- **FHIR R4 Resource Engine** — Full CRUD, validation, capability checking, batch operations
- **Clinical Decision Support (CDS)** — Drug interaction checks, risk assessment, guideline lookup
- **HIPAA Compliance** — PHI detection, audit trail, breach assessment, consent management
- **Synthetic Data Generation** — FHIR-compliant, PHI-safe synthetic patients/conditions/observations
- **A2A Agent Bridge** — Agent-to-agent communication per W3C draft-01 specification

### Advantages vs Standard Filesystem

| Aspect | Standard MCP Filesystem | JCF Healthcare Agent Hub |
|--------|------------------------|--------------------------|
| Search | Pattern matching only | **Semantic search** with tf-idf vectors |
| Security | Basic path validation | **RBAC policies** + secrets scanning |
| Audit | None | **Comprehensive audit trail** |
| Versioning | None | **Content-based versioning** |
| Performance | No caching | **Multi-level cache** |
| Dependencies | None | **Dependency graph** + coherence scoring |
| Reliability | No recovery | **Self-healing** with AERS |
| Operations | Single file | **Batch operations** with atomicity |
| Codebase Understanding | None | **Cognitive Index + Knowledge Graph + Pattern Detection + Type Flow** |
| Impact Analysis | None | **Node-level impact analysis** |
| Type Intelligence | None | **Type flow tracing** + data pipeline analysis |
| Pattern Recognition | None | **11 pattern categories** + semantic compression |
| **Healthcare Tools** | None | **FHIR R4 + CDS + HIPAA + Synthetic + A2A (28 tools)** |

---

## Key Features

### 1. Semantic Search (`semantic_search`)
Hybrid tf-idf + Qwen3-Embedding-0.6B (1024-dim) via Reciprocal Rank Fusion (k=60). Graceful degradation to tf-idf-only if embedding bridge unavailable. Finds files by conceptual similarity.

```json
{ "query": "authentication middleware", "limit": 10, "threshold": 0.3 }
```

### 2. RBAC Security + Auth Tokens
Role-Based Access Control with per-directory policies + auth-token system (SHA-256 hashed, role-based, expiry).

### 3. Secrets Scanning (30+ patterns)
Detects 30+ patterns: AWS, GCP, Azure, GitHub, Slack, Stripe, npm, PyPI, Discord, Docker, SendGrid, Mailgun, Twilio, private keys, JWTs, plus Shannon entropy filter (≥ 4.5 bits/char).

### 4. Audit Logging
Every operation recorded in immutable database.

### 5. Version Control
Automatic snapshot on every file modification with content-hash addressing. Rollback to previous versions.

### 6. Dependency Tracking
Builds real-time dependency graph from import statements. Circular dependency detection.

### 7. Self-Healing (AERS)
Automatic recovery using Application Error Response Strategy.

### 8. Cognitive Intelligence
Deep cognitive understanding of codebase:

- **Cognitive Index Engine (HCI)** — 3-layer hierarchical index: Project Skeleton → Module Contracts → Unit Fingerprints
- **Node-Level Knowledge Graph (NLKG)** — Semantic dependency graph with typed edges
- **Pattern Detector** — Detects 11 pattern categories + semantic compression
- **Type Flow Analyzer** — Trace type definitions through codebase
- **Code Intelligence Engine** — Unified orchestrator with single query interface

### 9. FHIR R4 Resource Engine (NEW)
Full FHIR R4 resource management with 8 tools:

- `fhir_create` — Create FHIR resources
- `fhir_read` — Read FHIR resources
- `fhir_update` — Update FHIR resources
- `fhir_delete` — Delete FHIR resources
- `fhir_search` — Search FHIR resources
- `fhir_batch` — Batch FHIR operations
- `fhir_validate` — Validate FHIR resources
- `fhir_capability` — Check server capabilities

**Features:**
- Two-phase commit with compensation for transactional integrity
- Semantic validation per FHIR R4 specification
- Filesystem-based storage with SQLite versioning
- Support for all major FHIR resource types (Patient, Observation, Condition, Medication, etc.)

### 10. Clinical Decision Support (NEW)
6 CDS tools for clinical workflows:

- `clinical_assess` — Assess patient condition against rules
- `care_plan_create` — Generate care plans
- `medication_check` — Drug interaction detection
- `lab_interp` — Laboratory result interpretation
- `risk_calculate` — Risk score calculation
- `guideline_lookup` — Clinical guideline lookup

**Features:**
- 15 drug interaction pairs (warfarin, digoxin, metformin, statins, etc.)
- 9 ICD-10 condition rules with age-stratified risk scoring
- 15+ clinical guidelines (ADA diabetes, JNC8 hypertension, GINA asthma, KDIGO CKD)
- JSON Schema validation for inputs/outputs

### 11. HIPAA Compliance (NEW)
5 compliance tools for healthcare security:

- `hipaa_audit_report` — Generate HIPAA audit reports
- `consent_manage` — Manage patient consent
- `phi_detection` — Detect PHI in content
- `access_log` — Query access logs
- `breach_assess` — Assess breach severity

**Features:**
- 10 PHI pattern types (SSN, DOB, phone, email, MRN, NPI, address, etc.)
- Real-time audit trail from SQLite database
- Breach assessment with HIPAA notification threshold (500+ affected)

### 12. Synthetic Data Generation (NEW)
4 tools for PHI-safe synthetic data:

- `synthetic_patient_gen` — Generate synthetic patients
- `synthetic_condition_gen` — Generate synthetic conditions
- `synthetic_observation_gen` — Generate synthetic observations
- `synthetic_bundle_gen` — Generate synthetic FHIR bundles

**Features:**
- Faker-based generation (FHIR-compliant)
- Zero real PHI — all data is synthetic
- Configurable count and demographic parameters

### 13. A2A Agent Bridge (NEW)
5 tools for agent-to-agent communication:

- `a2a_agent_card` — Declare agent capabilities
- `a2a_discover_agents` — Discover available agents
- `a2a_send_task` — Send tasks to agents
- `a2a_get_task_status` — Query task status
- `a2a_route_message` — Route messages to agents

**Features:**
- W3C A2A draft-01 specification compliance
- In-memory task store for hackathon demo
- Static agent registry (Lab, Pharmacy, Radiology, Referral agents)
- Priority-based task queue (routine/urgent/stat)

---

## System Architecture

```
                    MCP Client (supports MCP protocol)
                              |
                              v
              +-------------------------------+
              |    JcfHealthcareAgentHub     |
              |    59 Tools Registered       |
              |    (31 base + 28 healthcare) |
              +---------------+---------------+
                              |
    +---------+-------+-------+-----+--------+----------+-----------+
    |         |       |           |        |          |               |
    v         v       v           v        v          v               v
+--------+ +------+ +-------+ +------+ +--------+ +---------+ +------------+
| Logger | |Config| |  DB   | |Cache | |VectorDB| | Security | | Cognitive  |
| (pino) | |(Zod) | |(SQLite| |(MLC) | |(hybrid | |(RBAC    | |  Engine    |
|        | |      | | WAL)  | |      | | RRF)   | |+SSRF    | |            |
|        | |      | |       | |      | |        | |+Auth)   | |            |
+--------+ +------+ +-------+ +------+ +--------+ +---------+ |            |
                                                        |     | HCI Index  |
                                                        v     | NLKG       |
                                                  +----------+ | Pattern   |
                                                  |DepGraph  | | Detector  |
                                                  |+Self Heal| | TypeFlow  |
                                                  +----------+ +------------+
                                                        |
                                                        v
                                              +---------------------+
                                              |  Healthcare Module  |
                                              |  FHIR + CDS + HIPAA |
                                              |  + Synthetic + A2A  |
                                              +---------------------+
```

### Core Components

| Component | Function |
|-----------|---------|
| **Logger** | Structured logging with pino |
| **Config** | Configuration management with Zod validation |
| **Database** | SQLite WAL via `better-sqlite3` (auto-migrate from legacy JSON). Optional SQLCipher AES-256. |
| **Cache** | Multi-level caching (NodeCache + QuickLRU + optional Redis) |
| **VectorDB** | Hybrid tf-idf + Qwen3-Embedding-0.6B (1024-dim) via RRF |
| **Security** | RBAC + auth tokens + secrets scanning (30+) + SSRF prevention + path hardening |
| **DependencyGraph** | Dependency tracking + coherence scoring |
| **SelfHealing** | AERS auto-recovery |
| **CognitiveIndexEngine** | 3-layer HCI: Skeleton → Contracts → Fingerprints |
| **NodeLevelKnowledgeGraph** | Semantic dependency graph |
| **PatternDetector** | Pattern detection + semantic compression |
| **TypeFlowAnalyzer** | Type flow tracing + data pipeline analysis |
| **CodeIntelligenceEngine** | Unified orchestrator |
| **HealthcareModule** | FHIR R4 engine + CDS + HIPAA compliance + Synthetic data + A2A bridge |

---

## Tool Reference

> **Total**: 59 tools across 12 categories (31 base + 28 healthcare).

### Base Tools (31)

#### Diagnostics (1 Tool)

**D1. `ping`**
Health probe + DB stats.

```json
{}
```

**Response**: `{ status, server, version, db_path, stats, timestamp }`

---

#### Filesystem Operations (6 Tools)

**1. `read_file`**
Read file content with automatic caching.
```json
{ "path": "c:/project/src/main.ts", "offset": 1, "limit": 200 }
```

**2. `write_file`**
Write/create file with versioning and secrets scan.
```json
{ "path": "c:/project/src/config.ts", "content": "...", "author": "system", "message": "Initial" }
```

**3. `edit_file`**
Apply textual edits with versioning.
```json
{ "path": "c:/project/src/main.ts", "edits": [{ "oldText": "old", "newText": "new" }] }
```

**4. `append_file`**
Append content to file, optional createIfMissing.
```json
{ "path": "c:/project/log.txt", "content": "new line\n", "createIfMissing": true }
```

**5. `delete_file`**
Delete with version preservation.
```json
{ "path": "c:/project/src/old-file.ts" }
```

**6. `list_directory`**
List directory contents.
```json
{ "path": "c:/project/src", "includeHidden": false }
```

---

#### Search (2 Tools)

**7. `search_files`**
Pattern-based search with glob.
```json
{ "pattern": "**/*.ts", "baseDir": "c:/project" }
```

**8. `semantic_search`**
Vector similarity search.
```json
{ "query": "authentication middleware token validation", "limit": 10, "threshold": 0.3 }
```

---

#### Versioning (3 Tools)

**9. `get_version_history`**
File version timeline.
```json
{ "path": "c:/project/src/main.ts", "limit": 10 }
```

**10. `rollback_file`**
Restore to specific version.
```json
{ "path": "c:/project/src/main.ts", "versionId": "abc123" }
```

**11. `get_current_metadata`**
File analysis: language, symbols, imports, complexity.
```json
{ "path": "c:/project/src/main.ts" }
```

---

#### Dependencies (4 Tools)

**12. `get_dependencies`**
Forward dependency extraction.
```json
{ "path": "c:/project/src/main.ts", "transitive": false }
```

**13. `get_dependents`**
Reverse dependency lookup.
```json
{ "path": "c:/project/src/utils.ts", "transitive": true }
```

**14. `check_coherence`**
Coupling analysis + risk assessment.
```json
{ "path": "c:/project/src/main.ts" }
```

**15. `detect_circular_dependencies`**
Find circular dependencies in project.
```json
{}
```

---

#### Operations (4 Tools)

**16. `batch_operations`**
Atomic batch processing with rollback.
```json
{
  "operations": [
    { "type": "write", "path": "a.txt", "content": "1" },
    { "type": "write", "path": "b.txt", "content": "2" },
    { "type": "delete", "path": "old.txt" }
  ]
}
```

**17. `health_check`**
System health + metrics + subsystem warnings.
```json
{}
```

**18. `get_enabled_features`**
List all active features.
```json
{}
```

**19. `get_audit_log`**
Query audit events.
```json
{ "action": "write_file", "limit": 10 }
```

---

#### Cognitive Intelligence (11 Tools)

**20. `build_cognitive_index`**
Build full cognitive index for project. First step before using other cognitive tools.

```json
{ "rootPath": "c:/project" }
```

**Process:**
1. Layer 1: Project Skeleton — directory tree, tech stack, architecture patterns
2. Layer 2: Module Contracts — exports, imports, defined types per file
3. Layer 3: Unit Fingerprints — per-function/class signatures, complexity, purity, side effects
4. Build Node-Level Knowledge Graph from index
5. Detect patterns and calculate compression
6. Analyze type flows and data pipelines

**Response:** Full statistics — modules, units, estimated token cost

**21. `get_project_skeleton`**
Get Layer 1 project skeleton.
```json
{}
```

**Response:** Directory tree, tech stack, architecture patterns, entry points, config files

**22. `get_module_contracts`**
Get Layer 2 module contracts.
```json
{ "filePaths": ["c:/project/src/main.ts"] }
```

**Response:** Per-file exports, imports, defined types, pattern classification

**23. `get_unit_fingerprints`**
Get Layer 3 unit fingerprints with optional filters.
```json
{
  "filePaths": ["c:/project/src/"],
  "patternTypes": ["query", "command"],
  "maxComplexity": 10
}
```

**Response:** Per-unit signatures, complexity, purity, side effects, semantic tags, call targets, type dependencies

**24. `query_code_intelligence`**
Unified query interface — single tool for all cognitive modules.

```json
{
  "type": "full_context",
  "target": "c:/project/src/auth.ts",
  "depth": 2
}
```

**Query Types:**
| Type | Description |
|------|-------------|
| `skeleton` | Project skeleton overview |
| `contracts` | Module contracts (filtered) |
| `fingerprints` | Unit fingerprints (filtered) |
| `impact` | Impact analysis for target node |
| `flow` | Type flow for target type |
| `patterns` | Detected patterns + compression |
| `subgraph` | Knowledge subgraph around target |
| `full_context` | **Compressed full project knowledge** — optimal for LLM context |

**25. `get_impact_analysis`**
Impact set (direct + transitive) + subgraph for node.
```json
{ "nodeId": "module:c:/project/src/auth.ts", "depth": 2 }
```

**Response:** Direct dependents, transitive dependents, subgraph visualization

**26. `get_type_flow`**
Type flow + consumers + producers for specific type.
```json
{ "typeName": "UserSession" }
```

**Response:** Type flow (definition → production → transformation → validation → consumption), consumers, producers

**27. `detect_patterns`**
Detect code patterns + semantic compression.
```json
{}
```

**11 Pattern Categories:**
| Category | Description |
|----------|-------------|
| `crud` | Create/Read/Update/Delete operations |
| `middleware` | Request/response pipeline handlers |
| `observer` | Event subscription/notification |
| `factory` | Object creation patterns |
| `singleton` | Single instance patterns |
| `adapter` | Interface adaptation |
| `strategy` | Pluggable algorithm selection |
| `repository` | Data access abstraction |
| `service` | Business logic layer |
| `controller` | Request routing/handling |
| `utility` | Pure, side-effect-free functions |

**Response:** Patterns detected, compression ratio, token savings

**28. `get_knowledge_subgraph`**
Extract subgraph from knowledge graph.
```json
{ "nodeId": "module:c:/project/src/auth.ts", "depth": 2 }
```

**Response:** Nodes, edges, entry points, boundary nodes, stats

**29. `get_intelligence_stats`**
Statistics for all cognitive modules.
```json
{}
```

**Response:** Cognitive index stats, NLKG stats, pattern stats, type flow stats

---

### Healthcare Tools (28)

#### FHIR R4 (8 Tools)

**H1. `fhir_create`**
Create a FHIR resource.
```json
{
  "resourceType": "Patient",
  "resource": {
    "id": "pat1",
    "name": [{ "family": "Smith", "given": ["John"] }],
    "gender": "male",
    "birthDate": "2000-01-01"
  }
}
```

**H2. `fhir_read`**
Read a FHIR resource by ID.
```json
{ "resourceType": "Patient", "id": "pat1" }
```

**H3. `fhir_update`**
Update a FHIR resource.
```json
{
  "resourceType": "Patient",
  "id": "pat1",
  "resource": { "gender": "female" }
}
```

**H4. `fhir_delete`**
Delete a FHIR resource.
```json
{ "resourceType": "Patient", "id": "pat1" }
```

**H5. `fhir_search`**
Search FHIR resources with parameters.
```json
{
  "resourceType": "Patient",
  "parameters": { "name": "Smith" }
}
```

**H6. `fhir_batch`**
Execute batch FHIR operations.
```json
{
  "operations": [
    { "op": "create", "resourceType": "Patient", "resource": {...} },
    { "op": "read", "resourceType": "Patient", "id": "pat1" }
  ]
}
```

**H7. `fhir_validate`**
Validate a FHIR resource.
```json
{
  "resourceType": "Patient",
  "resource": { "gender": "male" }
}
```

**H8. `fhir_capability`**
Check server capabilities.
```json
{ "resourceType": "Patient" }
```

---

#### Clinical Decision Support (6 Tools)

**C1. `clinical_assess`**
Assess patient condition against rules.
```json
{
  "patient": {
    "age": 65,
    "conditions": ["I10", "E11.9"],
    "medications": ["warfarin", "metformin"]
  }
}
```

**Response:** Risk assessment with recommendations

**C2. `care_plan_create`**
Generate care plan.
```json
{
  "patientId": "pat1",
  "conditions": ["I10", "E11.9"],
  "goals": ["blood pressure control", "glucose management"]
}
```

**C3. `medication_check`**
Check drug interactions.
```json
{
  "medications": ["warfarin", "aspirin", "metformin"]
}
```

**Response:** Interaction warnings with severity levels

**C4. `lab_interp`**
Interpret laboratory results.
```json
{
  "test": "HbA1c",
  "value": 7.5,
  "unit": "%"
}
```

**C5. `risk_calculate`**
Calculate risk score.
```json
{
  "patient": {
    "age": 65,
    "conditions": ["I10", "E11.9"],
    "labs": { "HbA1c": 7.5, "creatinine": 1.2 }
  }
}
```

**C6. `guideline_lookup`**
Lookup clinical guideline.
```json
{ "guideline": "ADA_diabetes_2023" }
```

---

#### HIPAA Compliance (5 Tools)

**HC1. `hipaa_audit_report`**
Generate HIPAA audit report.
```json
{ "startDate": "2026-01-01", "endDate": "2026-01-31" }
```

**HC2. `consent_manage`**
Manage patient consent.
```json
{
  "patientId": "pat1",
  "action": "grant",
  "consentType": "research"
}
```

**HC3. `phi_detection`**
Detect PHI in content.
```json
{ "content": "Patient John Smith, SSN 123-45-6789" }
```

**Response:** Detected PHI patterns with locations

**HC4. `access_log`**
Query access logs.
```json
{ "patientId": "pat1", "limit": 10 }
```

**HC5. `breach_assess`**
Assess breach severity.
```json
{ "affectedCount": 500, "dataTypes": ["PHI", "SSN"] }
```

**Response:** Breach severity + HIPAA notification requirement

---

#### Synthetic Data (4 Tools)

**S1. `synthetic_patient_gen`**
Generate synthetic patients.
```json
{ "count": 10, "demographics": { "ageRange": [18, 80] } }
```

**S2. `synthetic_condition_gen`**
Generate synthetic conditions.
```json
{ "count": 20, "icd10Codes": ["I10", "E11.9", "J45"] }
```

**S3. `synthetic_observation_gen`**
Generate synthetic observations.
```json
{ "count": 50, "patientIds": ["pat1", "pat2"] }
```

**S4. `synthetic_bundle_gen`**
Generate synthetic FHIR bundles.
```json
{ "count": 5, "resourceTypes": ["Patient", "Observation", "Condition"] }
```

---

#### A2A Bridge (5 Tools)

**A1. `a2a_agent_card`**
Declare agent capabilities.
```json
{
  "agentId": "lab-agent",
  "name": "Laboratory Agent",
  "capabilities": ["lab_order", "lab_result"]
}
```

**A2. `a2a_discover_agents`**
Discover available agents.
```json
{}
```

**Response:** List of registered agents with capabilities

**A3. `a2a_send_task`**
Send task to agent.
```json
{
  "agentId": "lab-agent",
  "taskId": "task-123",
  "task": { "type": "lab_order", "parameters": {...} },
  "priority": "urgent"
}
```

**A4. `a2a_get_task_status`**
Query task status.
```json
{ "taskId": "task-123" }
```

**Response:** Task status (pending/running/completed/failed)

**A5. `a2a_route_message`**
Route message to agent.
```json
{
  "agentId": "lab-agent",
  "message": { "type": "inquiry", "content": "..." }
}
```

---

## Configuration

### File: `mcp-fs-config.json`

```json
{
  "allowedDirectories": [],
  "forbiddenPaths": [
    "c:/Windows",
    "c:/Program Files",
    "c:/Program Files (x86)",
    "c:/System Volume Information",
    "c:/$Recycle.Bin",
    "c:/ProgramData/Microsoft/Windows"
  ],
  "maxFileSize": 104857600,
  "cacheMaxSize": 1000,
  "cacheTTL": 300000,
  "enableVersioning": true,
  "enableSemanticSearch": true,
  "enableRBAC": true,
  "enableSecretsScan": true,
  "enableAuditLog": true,
  "enableDependencyTracking": true,
  "enableSelfHealing": true
}
```

### File: `data/jcf-policies.json` (RBAC)

```json
[
  {
    "path": "/**",
    "roles": {
      "admin": {
        "permissions": ["read", "write", "delete", "admin"]
      },
      "user": {
        "permissions": ["read", "write"]
      },
      "guest": {
        "permissions": ["read"]
      }
    }
  }
]
```

### Configuration Parameters

| Parameter | Default | Description |
|-----------|---------|-----------|
| `allowedDirectories` | [] | Allowed directories for access |
| `forbiddenPaths` | System paths | Blocked paths (Windows system directories) |
| `maxFileSize` | 100MB | Maximum file size |
| `cacheMaxSize` | 1000 | Number of items in cache |
| `cacheTTL` | 5 min | Cache time-to-live in ms |
| `enableVersioning` | true | Enable versioning |
| `enableSemanticSearch` | true | Enable semantic search |
| `enableRBAC` | true | Enable RBAC |
| `enableSecretsScan` | true | Enable secrets scanning |
| `enableAuditLog` | true | Enable audit logging |
| `enableDependencyTracking` | true | Enable dependency graph |
| `enableSelfHealing` | true | Enable self-healing |

---

## Advanced Usage

### Cognitive Intelligence Workflow

1. **Build Index** — Run `build_cognitive_index` with project rootPath
2. **Explore** — Use `get_project_skeleton` for overview
3. **Deep Dive** — Use `get_module_contracts` and `get_unit_fingerprints` for details
4. **Analyze** — Use `get_impact_analysis` to understand change impact
5. **Trace Types** — Use `get_type_flow` to understand data flow
6. **Detect Patterns** — Use `detect_patterns` for architecture identification
7. **Query All** — Use `query_code_intelligence` type `full_context` for compressed knowledge

### FHIR Resource Workflow

1. **Create Patient** — Use `fhir_create` with Patient resource
2. **Add Conditions** — Use `fhir_create` with Condition resources
3. **Add Observations** — Use `fhir_create` with Observation resources
4. **Validate** — Use `fhir_validate` to check compliance
5. **Search** — Use `fhir_search` to find resources
6. **Batch Operations** — Use `fhir_batch` for multiple operations
7. **Check Capabilities** — Use `fhir_capability` to verify server support

### Clinical Decision Support Workflow

1. **Assess Patient** — Use `clinical_assess` with patient data
2. **Check Medications** — Use `medication_check` for drug interactions
3. **Interpret Labs** — Use `lab_interp` for lab results
4. **Calculate Risk** — Use `risk_calculate` for risk scoring
5. **Lookup Guidelines** — Use `guideline_lookup` for clinical guidelines
6. **Create Care Plan** — Use `care_plan_create` for care planning

### A2A Agent Workflow

1. **Discover Agents** — Use `a2a_discover_agents` to find available agents
2. **Send Task** — Use `a2a_send_task` to assign work
3. **Check Status** — Use `a2a_get_task_status` to monitor progress
4. **Route Messages** — Use `a2a_route_message` for agent communication

### Semantic Search Best Practices

1. **Use descriptive queries**: "user authentication login flow" better than "auth"
2. **Set threshold appropriately**:
   - 0.8+ = exact match
   - 0.5-0.8 = related
   - 0.3-0.5 = loosely related
3. **Use limit for performance**: Default 10 is optimal

### Dependency Analysis

**Coherence Score Interpretation:**
- 0.0-0.3: Low coupling (good)
- 0.3-0.7: Medium coupling
- 0.7-1.0: High coupling (needs refactoring)

---

## Security

### Path Validation
All paths validated and normalized. NFC normalization + `path.relative` boundary check + `..` segment detection + NUL-byte rejection + symlink-escape resolution. Case-insensitive on Windows.

### SSRF Prevention (T3.1)
`PathValidator` blocks URL-scheme paths (`http://`, `s3://`, `ftp://`, `file://`) and UNC paths (`\\host\share`) before filesystem call. Embedding client validates against host allowlist.

### Auth-Token System (T3.2)
`AuthTokenManager` with SHA-256 hashed tokens, role-based access, expiry, and `withAudit` middleware. Format: `jcf_tok_<role>_<32-byte-hex>`. Never stores raw tokens.

### Secrets Detection (30+ patterns)
Before write, file scanned for 30+ patterns including AWS, GCP, Azure, GitHub, Slack, Stripe, npm, PyPI, Discord, Docker, private keys, JWTs, plus Shannon entropy filter.

### SQLCipher Encryption (T3.4)
Optional AES-256 encrypted SQLite via `@journeyapps/sqlcipher`. Enable with:
```bash
export JCF_USE_SQLCIPHER=1
export JCF_DB_KEY="<64-hex-char-key>"
```

### Audit Trail
All operations recorded with timestamp, actor, action, result, path. Audit log immutable in indexed SQLite table.

### HIPAA Compliance
- PHI detection with 10 pattern types
- Real-time audit trail
- Breach assessment with HIPAA notification threshold
- Consent management
- Access logging

---

## Troubleshooting

### Error: "Module not found"
**Solution**: Ensure all imports have `.js` extensions:
```typescript
import { Server } from "./server.js";  // Correct
```

### Error: "Permission denied"
**Solution**: Add path to `allowedDirectories` in `mcp-fs-config.json`.

### Error: "No cognitive index built yet"
**Solution**: Run `build_cognitive_index` first before using other cognitive tools.

### Server won't start
**Solution**: Validate JSON config: `node -e "JSON.parse(require('fs').readFileSync('mcp-fs-config.json'))"`

### FHIR validation error
**Solution**: Check FHIR resource structure against FHIR R4 specification. Use `fhir_validate` before create/update.

### Drug interaction check returns no results
**Solution**: Ensure medication names match the 15 interaction pairs in the system (warfarin, digoxin, metformin, statins, etc.)

### A2A agent not found
**Solution**: Use `a2a_discover_agents` to list available agents. For hackathon demo, agents are statically registered (Lab, Pharmacy, Radiology, Referral).

---

## Best Practices

1. **Build Cognitive Index first** before using cognitive tools
2. **Use `full_context` query** to get compressed project knowledge
3. **Enable Versioning** for production — always track changes
4. **Limit allowedDirectories** — don't use `/` or `*`
5. **Monitor Audit Log** regularly
6. **Use Batch Operations** for multiple file operations
7. **Check Dependencies** before refactor with `check_coherence`
8. **Use Impact Analysis** before changing heavily-imported files
9. **Validate FHIR resources** before create/update operations
10. **Use synthetic data only** for competition/demo purposes (never real PHI)

---

## IDE Integration

This MCP server supports clients that implement the MCP (Model Context Protocol) protocol. Basic configuration:

### Windsurf / Codeium

File: `~/.codeium/windsurf/mcp_config.json` (Windows: `C:\Users\<username>\.codeium\windsurf\mcp_config.json`)

```json
{
  "mcpServers": {
    "jcf-healthcare-agent-hub": {
      "command": "node",
      "args": ["C:/Users/TUF/HACKATHON/jcf-healthcare-agent-hub/dist/index.js"],
      "env": {
        "JCF_HANDLING_TOOL_HOME": "C:/Users/TUF/HACKATHON/jcf-healthcare-agent-hub",
        "JCF_HANDLING_TOOL_DATA_DIR": "C:/Users/TUF/HACKATHON/jcf-healthcare-agent-hub/data"
      }
    }
  }
}
```

### Cursor

File: `~/.cursor/mcp.json` (Windows: `C:\Users\<username>\.cursor\mcp.json`)

```json
{
  "mcpServers": {
    "jcf-healthcare-agent-hub": {
      "command": "node",
      "args": ["C:/Users/TUF/HACKATHON/jcf-healthcare-agent-hub/dist/index.js"],
      "env": {
        "JCF_HANDLING_TOOL_HOME": "C:/Users/TUF/HACKATHON/jcf-healthcare-agent-hub",
        "JCF_HANDLING_TOOL_DATA_DIR": "C:/Users/TUF/HACKATHON/jcf-healthcare-agent-hub/data"
      }
    }
  }
}
```

### VS Code

File: `%APPDATA%/Code/User/mcp.json` (Windows: `C:\Users\<username>\AppData\Roaming\Code\User\mcp.json`)

```json
{
  "servers": {
    "jcf-healthcare-agent-hub": {
      "command": "node",
      "args": ["C:/Users/TUF/HACKATHON/jcf-healthcare-agent-hub/dist/index.js"],
      "type": "stdio",
      "env": {
        "JCF_HANDLING_TOOL_HOME": "C:/Users/TUF/HACKATHON/jcf-healthcare-agent-hub",
        "JCF_HANDLING_TOOL_DATA_DIR": "C:/Users/TUF/HACKATHON/jcf-healthcare-agent-hub/data"
      }
    }
  }
}
```

### Claude Desktop

File: `%APPDATA%/Claude/claude_desktop_config.json` (Windows: `C:\Users\<username>\AppData\Roaming\Claude\claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "jcf-healthcare-agent-hub": {
      "command": "node",
      "args": ["C:/Users/TUF/HACKATHON/jcf-healthcare-agent-hub/dist/index.js"],
      "env": {
        "JCF_HANDLING_TOOL_HOME": "C:/Users/TUF/HACKATHON/jcf-healthcare-agent-hub",
        "JCF_HANDLING_TOOL_DATA_DIR": "C:/Users/TUF/HACKATHON/jcf-healthcare-agent-hub/data"
      }
    }
  }
}
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `JCF_HANDLING_TOOL_HOME` | Yes | Absolute path to project root |
| `JCF_HANDLING_TOOL_DATA_DIR` | Yes | Absolute path to data directory |
| `MCP_FS_USER_ID` | No | User ID for RBAC (default: "default-user") |
| `MCP_FS_USER_ROLE` | No | User role for RBAC (default: "user") |
| `MCP_FS_AUTH_TOKEN` | No | Auth token for token-based authentication |

---

*Generated by JCF Agent v3.0 - Sovereign Engineering Intelligence*

> Last updated: 2026-05-08 | v2.1.0-healthcare | 2382 tests | 0 failures | 85%+ coverage | 59 tools
