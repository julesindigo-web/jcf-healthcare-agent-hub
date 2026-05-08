# JCF Healthcare Agent Hub

> **Standalone MCP Server for Healthcare AI** — FHIR R4 · Clinical Decision Support · HIPAA Compliance · A2A Bridge · Synthetic Data

---

## Overview

**JCF Healthcare Agent Hub** is a production-grade [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that gives AI agents (Claude, GPT, Gemini, etc.) direct access to healthcare infrastructure. Built on top of the JCF handling tool engine, extended with 28 healthcare-specific tools.

**Version:** `2.1.0-healthcare`  
**Tools:** 59 total (31 base file intelligence + 28 healthcare)  
**Protocol:** MCP SDK 1.29.0 · FHIR R4 · A2A draft-01  
**Tests:** 2382 passing (0 failures)  
**Coverage:** 85%+ statements, 89%+ functions  

---

## Healthcare Tools (28)

| Category | Count | Tools |
|---|---|---|
| **FHIR R4** | 8 | `fhir_create`, `fhir_read`, `fhir_update`, `fhir_delete`, `fhir_search`, `fhir_batch`, `fhir_validate`, `fhir_capability` |
| **Clinical CDS** | 6 | `clinical_assess`, `care_plan_create`, `medication_check`, `lab_interp`, `risk_calculate`, `guideline_lookup` |
| **HIPAA Compliance** | 5 | `hipaa_audit_report`, `consent_manage`, `phi_detection`, `access_log`, `breach_assess` |
| **Synthetic Data** | 4 | `synthetic_patient_gen`, `synthetic_condition_gen`, `synthetic_observation_gen`, `synthetic_bundle_gen` |
| **A2A Bridge** | 5 | `a2a_agent_card`, `a2a_discover_agents`, `a2a_send_task`, `a2a_get_task_status`, `a2a_route_message` |

---

## Quick Start

### Prerequisites
- Node.js 18+
- npm 9+

### Install & Build

```bash
git clone <repo-url>
cd jcf-healthcare-agent-hub
npm install
npm run build
```

### Configure MCP Client

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "jcf-healthcare": {
      "command": "node",
      "args": ["/path/to/jcf-healthcare-agent-hub/dist/index.js"],
      "env": {
        "JCF_HANDLING_TOOL_HOME": "/path/to/jcf-healthcare-agent-hub",
        "JCF_HANDLING_TOOL_DATA_DIR": "/path/to/jcf-healthcare-agent-hub/data"
      }
    }
  }
}
```

**Windsurf** (`~/.codeium/windsurf/mcp_config.json`):
```json
{
  "mcpServers": {
    "jcf-healthcare-agent-hub": {
      "command": "node",
      "args": ["C:/Users/TUF/HACKATHON/jcf-healthcare-agent-hub/dist/index.js"],
      "env": {
        "JCF_HANDLING_TOOL_HOME": "C:/Users/TUF/HACKATHON/jcf-healthcare-agent-hub",
        "JCF_HANDLING_TOOL_DATA_DIR": "C:/Users/TUF/HACKATHON/jcf-healthcare-agent-hub/data",
        "MCP_SERVER_NAME": "jcf-healthcare-agent-hub",
        "MCP_SERVER_VERSION": "2.1.0-healthcare"
      }
    }
  }
}
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `JCF_HANDLING_TOOL_HOME` | Auto-detected | Server install root |
| `JCF_HANDLING_TOOL_DATA_DIR` | `<home>/data` | Database & FHIR store root |
| `EMBEDDING_ENDPOINT` | `http://localhost:11434/api/embeddings` | Ollama embedding endpoint (optional) |

---

## Key Features

### FHIR R4 Resource Engine
- Full CRUD for Patient, Condition, Observation, Procedure, MedicationRequest, Encounter, AllergyIntolerance
- Resources stored as JSON files in `data/fhir-store/` + versioned in SQLite
- Paginated search with param filtering
- Parallel batch operations with two-phase commit
- Semantic validation per FHIR R4 specification

### Clinical Decision Support
- 15+ drug interaction checks (warfarin, digoxin, metformin, statins, etc.)
- 9 condition-based assessment rules (E11.9, I10, N18.3, J45.909, F32.9, E78.5)
- Clinical guidelines for 15+ conditions (ADA diabetes, JNC8 hypertension, GINA asthma, KDIGO CKD)
- Risk score calculation with age stratification
- JSON Schema validation for all inputs/outputs

### HIPAA Compliance
- PHI detection with 10 pattern types (SSN, DOB, phone, email, MRN, NPI, address, etc.)
- Real audit trail from SQLite database
- Breach assessment with HIPAA notification threshold calculation (500+ affected)
- Consent management with expiry tracking
- Access logging with PHI event filtering

### A2A Bridge (Agent-to-Agent)
- Agent card declaration per W3C A2A draft-01
- Static healthcare agent registry (Lab, Pharmacy, Radiology, Referral agents)
- Task queue with priority routing (routine/urgent/stat)
- Message routing with agent discovery
- In-memory task store (documented as hackathon demo)

### Synthetic Data
- PHI-safe FHIR-compliant patient generation
- Realistic condition codes (ICD-10), LOINC observations
- Bundle generation for testing
- Faker-based generation with configurable demographics

### Base File Intelligence (31 tools)
- Cognitive Index Engine (3-layer: skeleton → contracts → fingerprints)
- Node-Level Knowledge Graph with typed edges
- Pattern Detection (11 categories + semantic compression)
- Type Flow Analyzer (trace data through codebase)
- Impact Analysis (direct + transitive dependencies)
- Semantic Search (tf-idf + Qwen3-Embedding RRF)
- Content Versioning (content-hash addressing + rollback)
- RBAC Security (role-based policies)
- Secrets Scanning (30+ patterns)
- Audit Logging (immutable SQLite trail)
- Self-Healing (AERS auto-recovery)

---

## Architecture

```
src/
├── healthcare/        ← Healthcare domain (28 tools)
│   ├── fhir.ts       ← FHIR R4 resource engine
│   ├── clinical.ts   ← CDS rules engine
│   ├── compliance.ts ← HIPAA audit & PHI detection
│   ├── synthetic.ts  ← Synthetic data generation
│   └── a2a-router.ts ← A2A bridge
├── handlers/          ← Base tool handlers (31 tools)
│   ├── filesystem.ts
│   ├── search.ts
│   ├── versioning.ts
│   ├── dependencies.ts
│   ├── operations.ts
│   ├── intelligence.ts
│   └── diagnostics.ts
├── lib/               ← Core infrastructure
│   ├── cognitive-index.ts
│   ├── node-knowledge-graph.ts
│   ├── pattern-detector.ts
│   ├── type-flow-analyzer.ts
│   ├── code-intelligence.ts
│   ├── security.ts
│   ├── database.ts
│   ├── cache.ts
│   └── vector-db.ts
├── registry.ts        ← Tool registry (59 tools)
└── server.ts          ← MCP server orchestration
```

---

## Development

```bash
npm test              # Run all tests (2382 tests)
npm run build         # TypeScript compile
npm run dev           # Watch mode
npm run lint          # Type check only
```

---

## ADR Decisions

| ADR | Decision |
|---|---|
| ADR-H001 | Constitutional enforcement removed — healthcare domain only |
| ADR-H002 | FHIR storage via filesystem + SQLite versioning |
| ADR-H003 | ping-only diagnostics, no enforcement gates |
| ADR-H004 | A2A in-memory task store — hackathon demo, not persistent |
| ADR-H005 | A2A static agent registry — no dynamic registration |

---

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

### Critical Path (8.5-13.5 hours)
1. Secure hosting (2-4 hrs)
2. Prompt Opinion registration (30 min)
3. Integration testing (2-3 hrs)
4. Marketplace publication (1 hr)
5. Demo video recording (2-3 hrs)
6. Devpost submission (1-2 hrs)

---

*JCF Healthcare Agent Hub · v2.1.0-healthcare · MIT-like license · Built on JCF Handling Tool engine*
