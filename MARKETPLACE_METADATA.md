# MCP Server Metadata — Copy-Paste Ready

## Basic Information

**Name:** JCF Healthcare Agent Hub

**Description:** 59-tool MCP server for healthcare AI — FHIR R4, Clinical Decision Support, HIPAA Compliance, A2A Bridge, Synthetic Data Generation

**Long Description:**
JCF Healthcare Agent Hub is a production-grade MCP server with 59 tools (31 base + 28 healthcare-specific) that enables AI language models to interact directly with healthcare systems. It serves as a bridge between AI agents (Claude, GPT-4, Gemini, etc.) and clinical infrastructure.

**Tool Count:** 59 tools

**Transport Type:** Streamable HTTP

**Auth Method:** None (open access for demo)

**Homepage:** https://github.com/[your-username]/jcf-healthcare-agent-hub

**Repository:** https://github.com/[your-username]/jcf-healthcare-agent-hub

**License:** MIT

**Contact:** [your-email@example.com]

---

## Tool Categories

### FHIR R4 Engine (8 tools)
- fhir_create — Create FHIR resources with validation
- fhir_read — Read FHIR resources by ID
- fhir_update — Update FHIR resources with two-phase commit
- fhir_delete — Delete FHIR resources
- fhir_search — Search FHIR resources with parameters
- fhir_batch — Execute batch FHIR operations
- fhir_validate — Validate resources against FHIR R4 specification
- fhir_capability — Check server capabilities

### Clinical Decision Support (6 tools)
- clinical_assess — Assess patient condition against rules
- care_plan_create — Generate care plans
- medication_check — Drug interaction screening (15+ pairs)
- lab_interp — Laboratory result interpretation
- risk_calculate — Multi-factor risk scoring
- guideline_lookup — Clinical guideline lookup (15+ conditions)

### HIPAA Compliance (5 tools)
- hipaa_audit_report — Generate HIPAA compliance audit report
- consent_manage — Manage patient consent records
- phi_detection — Detect PHI in content (10 pattern types)
- access_log — Query access log for compliance
- breach_assess — Assess data breach impact

### Synthetic Data Generation (4 tools)
- synthetic_patient_gen — Generate synthetic FHIR patients
- synthetic_condition_gen — Generate synthetic conditions
- synthetic_observation_gen — Generate synthetic observations
- synthetic_bundle_gen — Generate synthetic FHIR bundles

### A2A Agent Bridge (5 tools)
- a2a_agent_card — Declare agent capabilities
- a2a_discover_agents — Discover registered agents
- a2a_send_task — Send healthcare task to agent
- a2a_get_task_status — Poll task completion status
- a2a_route_message — Route A2A messages between agents

### Base Intelligence (31 tools)
- Cognitive index, semantic search, impact analysis, version control, security, secrets scanning, self-healing, batch operations, audit logging, coherence checking, circular dependency detection, pattern detection, semantic doc drift detection, type flow tracing, knowledge subgraph extraction, module contracts, unit fingerprints, project skeleton, semantic search, semantic neighbors, semantic pre-edit guard, semantic impact analysis, semantic version search, health check, ping, get enabled features, get intelligence stats, get semantic substrate stats

---

## Example MCP Config for Claude Desktop

```json
{
  "mcpServers": {
    "jcf-healthcare-agent-hub": {
      "url": "https://your-project-name.railway.app/mcp",
      "transport": "http"
    }
  }
}
```

## Example MCP Config for Cursor

```json
{
  "mcpServers": {
    "jcf-healthcare-agent-hub": {
      "url": "https://your-project-name.railway.app/mcp"
    }
  }
}
```

## Example MCP Config for Windsurf

```json
{
  "mcpServers": {
    "jcf-healthcare-agent-hub": {
      "url": "https://your-project-name.railway.app/mcp"
    }
  }
}
```

---

## Security Features

- SSRF protection (PathValidator blocks URL-scheme paths)
- Secrets scanning (30+ patterns)
- RBAC security (documented for demo)
- Audit logging (immutable SQLite trail)
- PHI detection (10 pattern types)
- HIPAA compliance tools

---

## Technical Specs

- Protocol: Model Context Protocol (MCP) SDK 1.29.0
- FHIR Version: R4
- Database: SQLite (better-sqlite3)
- Language: TypeScript (ESM), Node.js 18+
- Test Coverage: 2382 tests passing (0 failures), 85%+ statements, 89%+ functions
- Security: RBAC, secrets scanning (30+ patterns), SSRF protection, audit logging
