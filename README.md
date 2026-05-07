# JCF Healthcare Agent Hub

> **Standalone MCP Server for Healthcare AI** — FHIR R4/R5 · Clinical Decision Support · HIPAA Compliance · A2A Bridge · Synthetic Data

---

## Overview

**JCF Healthcare Agent Hub** is a production-grade [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that gives AI agents (Claude, GPT, Gemini, etc.) direct access to healthcare infrastructure. Built on top of the JCF Healthcare Agent Hub engine, extended with 28 healthcare-specific tools.

**Version:** `2.1.0-healthcare`  
**Tools:** 59 total (31 base file intelligence + 28 healthcare)  
**Protocol:** MCP SDK 1.29.0 · FHIR R4 · A2A draft-01  

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
        "JCF_HANDLING_TOOL_HOME": "/path/to/jcf-healthcare-agent-hub"
      }
    }
  }
}
```

**VS Code / Windsurf** (`.windsurf/mcp.json` or `.vscode/mcp.json`):
```json
{
  "servers": {
    "jcf-healthcare": {
      "command": "node",
      "args": ["/path/to/jcf-healthcare-agent-hub/dist/index.js"]
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
- Parallel batch operations

### Clinical Decision Support
- 15+ drug interaction checks (warfarin, digoxin, metformin, statins, etc.)
- 9 condition-based assessment rules (E11.9, I10, N18.3, J45.909, F32.9, E78.5)
- Clinical guidelines for 15+ conditions (ADA, JNC8, GINA, KDIGO)
- Risk score calculation with age stratification

### HIPAA Compliance
- PHI detection with 10 pattern types (SSN, DOB, phone, email, MRN, NPI, address, etc.)
- Real audit trail from SQLite database
- Breach assessment with HIPAA notification threshold calculation (500 affected rule)
- Consent management with expiry tracking

### A2A Bridge (Agent-to-Agent)
- Agent card declaration per W3C A2A draft-01
- Static healthcare agent registry (Lab, Pharmacy, Radiology, Referral agents)
- Task queue with priority routing (routine/urgent/stat)
- Message routing with agent discovery

### Synthetic Data
- PHI-safe FHIR-compliant patient generation
- Realistic condition codes (ICD-10), LOINC observations
- Bundle generation for testing

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
├── lib/               ← Core infrastructure
├── registry.ts        ← Tool registry (59 tools)
└── server.ts          ← MCP server orchestration
```

---

## Development

```bash
npm test              # Run all tests with coverage
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

---

*JCF Healthcare Agent Hub · v2.1.0-healthcare · MIT-like license · Built on JCF Handling Tool engine*
