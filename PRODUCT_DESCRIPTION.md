# JCF Healthcare Agent Hub — Product Description

## What It Is

JCF Healthcare Agent Hub is a **standalone Model Context Protocol (MCP) server** that enables AI language models to interact directly with healthcare systems. It serves as a bridge between AI agents (Claude, GPT-4, Gemini, etc.) and clinical infrastructure.

## Core Value Proposition

Healthcare AI agents need:
1. **Structured clinical data access** (FHIR R4/R5 resources)
2. **Clinical intelligence** (drug interaction checks, risk assessment, care planning)
3. **Compliance guarantees** (HIPAA audit trails, PHI detection)
4. **Agent-to-agent coordination** (routing to specialized healthcare agents)
5. **Safe testing data** (synthetic PHI-free patient generation)

JCF Healthcare Agent Hub delivers all five in a single MCP server with 59 tools.

## Technical Specifications

- **Protocol:** Model Context Protocol (MCP) SDK 1.29.0
- **FHIR Version:** R4 (R5 compatible)
- **Database:** SQLite (better-sqlite3) for audit logs and version history
- **Storage:** Filesystem-backed FHIR resource store with SQLite versioning
- **Language:** TypeScript (ESM), Node.js 18+
- **Test Coverage:** Vitest with 100% L+B+F target
- **Logging:** Pino structured logging
- **Validation:** Zod schema validation on all tool inputs

## Tool Categories

### FHIR R4 Engine (8 tools)
Full CRUD + batch + validation + capability declaration for 7 resource types:
Patient, Condition, Observation, Procedure, MedicationRequest, Encounter, AllergyIntolerance

### Clinical Decision Support (6 tools)
Rule-based CDS with 15+ drug interaction checks, 9 condition assessment rules, guidelines for 15+ conditions (ADA, JNC8, GINA, KDIGO, Framingham), and multi-factor risk scoring.

### HIPAA Compliance (5 tools)
PHI detection (10 pattern types per HIPAA Safe Harbor §164.514(b)(2)), real audit trail queries, breach notification assessment with 500-affected threshold calculation, consent management.

### Synthetic Data Generation (4 tools)
FHIR-compliant PHI-safe synthetic patients, conditions (ICD-10 coded), LOINC observations, and complete clinical bundles for testing.

### A2A Bridge (5 tools)
W3C Agent2Agent protocol draft-01 implementation: agent card declaration, static registry of 4 healthcare sub-agents (Lab, Pharmacy, Radiology, Referral), priority task queuing, and message routing.

## Architecture Decisions

- **ADR-H001**: JCF Constitutional enforcement removed — healthcare hub is domain-specific; the enforcement layer is not relevant to clinical users
- **ADR-H002**: FHIR storage via filesystem + SQLite versioning — resources are readable files with full change history
- **ADR-H003**: Simplified diagnostics — `ping` tool only, no enforcement gates

## Target Users

- Healthcare AI developers building clinical decision support
- EHR integration engineers connecting AI agents to FHIR APIs
- Healthcare IT teams building A2A clinical workflows
- Researchers needing synthetic clinical data generation
- Compliance teams auditing AI access to PHI
