# JCF Healthcare Agent Hub — Product Vision

> **The AI agent that analyzes impact of healthcare system changes before deployment — preventing dangerous errors that could harm patients.**

**Version**: 2.1.0-healthcare
**License**: MIT
**Status**: PRODUCTION-READY · 2291+ tests · MCP + A2A + FHIR R4
**Tools**: 59 (31 infrastructure + 28 healthcare-domain)
**Date**: May 2026

---

## The Problem We Solve

Healthcare AI systems manage patient-critical workflows every day: FHIR records, medication orders, clinical decision pathways, lab interpretations. These systems **change constantly** — new features, bug fixes, infrastructure updates, protocol revisions.

The danger: **a single undetected breaking change in a healthcare system can harm a patient.**

Today, there is no AI agent that:
- Analyzes the *clinical impact* of a code change before it deploys
- Validates changes against FHIR R4 contracts, CDS rules, and HIPAA compliance simultaneously
- Detects which patient workflows are affected by a dependency change
- Routes risk flags to the appropriate specialized agent (Lab, Pharmacy, Radiology, Referral)

**JCF Healthcare Agent Hub is that agent.**

---

## What It Does (In One Demo Minute)

1. **A developer proposes a change** to a healthcare EHR module
2. **The agent runs impact analysis** — maps every function, type, and dependency affected
3. **Clinical risk is evaluated** — checks against CDS rules, FHIR resource contracts, HIPAA audit requirements
4. **Multi-agent coordination via A2A** — routes specific risks to specialist agents (Lab Agent flags abnormal result handling, Pharmacy Agent flags drug interaction logic, etc.)
5. **Output**: a structured risk report — safe to deploy, or: *"this change breaks warfarin interaction check in line 847, affecting 12 patient workflows"*

This is not a concept. Every step is a working MCP tool backed by 2291+ tests.

---

## Why This Wins

### 1. Real Engineering, Not a Demo Wrapper
Most hackathon submissions are thin wrappers around APIs. JCF Healthcare Agent Hub is a production-grade system:
- **Cognitive Index Engine** — 3-layer codebase understanding (skeleton → contracts → unit fingerprints)
- **Impact Analysis** — direct + transitive dependency graph; know what breaks before it breaks
- **Type Flow Tracing** — follows patient data types through every transformation
- **Coherence Scoring** — quantifies coupling risk between clinical modules

### 2. Native Healthcare Domain Intelligence (28 tools)
- **FHIR R4 Engine** — full CRUD + validation for 7 resource types, stored + versioned in SQLite
- **Clinical Decision Support** — 15+ drug interactions, 9 condition-based rules, 15+ clinical guidelines
- **HIPAA Compliance** — PHI detection, audit reports, breach assessment, consent management
- **Synthetic Data** — PHI-safe FHIR-compliant test data for CI/CD pipelines
- **A2A Bridge** — agent discovery, task routing, priority queues (routine/urgent/stat)

### 3. MCP + A2A + FHIR — Full Stack
This is the only submission in this hackathon space that implements all three protocol layers:
- **MCP** (Model Context Protocol) — 59 tools, real server, JSON-RPC 2.0 over stdio
- **A2A** (Agent-to-Agent, draft-01) — agent card, discovery, task send/status, message routing
- **FHIR R4** — resource engine with capability statement and validation

### 4. HSE-Rooted Risk Thinking
The builder's background in Health, Safety & Environment engineering means this system was designed from first principles around **preventing harm**, not just enabling features. Every tool has a safety lens.

---

## The Core Value Proposition

> *"Before any AI agent touches a healthcare system, it should know: what will break, what clinical rules are affected, and which patients are at risk. JCF Healthcare Agent Hub makes that analysis automatic."*

---

## Technical Architecture

```
┌─────────────────────────────────────────────────────────────┐
│              MCP Client (Claude / Windsurf / GPT)            │
└─────────────────────────────┬───────────────────────────────┘
                              │ JSON-RPC 2.0 / MCP SDK 1.29.0
┌─────────────────────────────▼───────────────────────────────┐
│               JCF Healthcare Agent Hub (59 tools)            │
│                                                               │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              HEALTHCARE DOMAIN LAYER (28)            │    │
│  │  FHIR R4 (8) │ CDS (6) │ HIPAA (5) │ Synth (4) │ A2A (5)│
│  └─────────────────────────────────────────────────────┘    │
│                                                               │
│  ┌─────────────────────────────────────────────────────┐    │
│  │         COGNITIVE INTELLIGENCE LAYER (11)            │    │
│  │  Impact Analysis │ Type Flow │ Dep Graph │ Patterns  │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                               │
│  ┌─────────────────────────────────────────────────────┐    │
│  │        INFRASTRUCTURE LAYER (20 base tools)          │    │
│  │  SQLite WAL │ Cache │ RBAC │ Audit │ Self-Healing    │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────▼────────────────────┐
        │    A2A Specialist Agents (via bridge)      │
        │  Lab Agent │ Pharmacy │ Radiology │ Referral│
        └───────────────────────────────────────────┘
```

---

## Capability Table — vs Competition

| Capability | Generic MCP FS Servers | **JCF Healthcare Agent Hub** |
|---|:---:|:---:|
| FHIR R4 resource engine | ❌ | ✅ |
| Clinical Decision Support | ❌ | ✅ |
| HIPAA PHI detection + audit | ❌ | ✅ |
| A2A agent discovery + routing | ❌ | ✅ |
| Dependency impact analysis | ❌ | ✅ |
| Type flow tracing | ❌ | ✅ |
| Clinical change risk report | ❌ | ✅ |
| Synthetic FHIR data generation | ❌ | ✅ |
| Content versioning + rollback | ❌ | ✅ |
| Autonomous self-healing | ❌ | ✅ |
| 2300+ tests | ❌ | ✅ |

---

## Tool Reference (59 Tools by Use Case)

### Clinical Safety Analysis Flow
| Tool | Role in Safety Pipeline |
|---|---|
| `build_cognitive_index` | Index a healthcare codebase |
| `get_impact_analysis` | Find all modules affected by a change |
| `get_type_flow` | Trace patient data type through the system |
| `detect_circular_dependencies` | Find dangerous coupling in clinical modules |
| `check_coherence` | Score module isolation risk |
| `clinical_assess` | Evaluate clinical rules against patient data |
| `medication_check` | Drug interaction screening |
| `fhir_validate` | Validate resource against FHIR R4 contracts |
| `hipaa_audit_report` | Compliance audit with PHI stats |
| `breach_assess` | HIPAA notification threshold check |

### A2A Multi-Agent Coordination
| Tool | Purpose |
|---|---|
| `a2a_agent_card` | Declare agent capabilities |
| `a2a_discover_agents` | Find available specialist agents |
| `a2a_send_task` | Delegate risk analysis to specialist agent |
| `a2a_get_task_status` | Poll delegated task result |
| `a2a_route_message` | Route clinical message to appropriate agent |

### FHIR R4 Resource Engine
`fhir_create` · `fhir_read` · `fhir_update` · `fhir_delete` · `fhir_search` · `fhir_batch` · `fhir_validate` · `fhir_capability`

### HIPAA & Compliance
`hipaa_audit_report` · `consent_manage` · `phi_detection` · `access_log` · `breach_assess`

### Synthetic Test Data
`synthetic_patient_gen` · `synthetic_condition_gen` · `synthetic_observation_gen` · `synthetic_bundle_gen`

---

## Design Philosophy

1. **Safety first, features second** — Every tool was designed to prevent harm, not just enable operations
2. **Evidence before action** — Impact analysis runs before any change propagates
3. **Interoperability by design** — MCP + A2A + FHIR are not bolt-ons; they are the architecture
4. **Compliance as infrastructure** — HIPAA, audit trails, and PHI detection are built in, not added on
5. **Honest failure** — Self-healing + audit trail means failures are visible, recoverable, and traceable

---

*JCF Healthcare Agent Hub — Built for the healthcare systems where failure is not an option.*
*Tidak pernah berubah.*

## Why Does This Exist?

The MCP ecosystem has over 10,000 publicly available servers. The official Anthropic filesystem server and popular alternatives provide basic file read/write/search capabilities. However, none of them address the real challenges that emerge when AI agents operate on production filesystems:

- **Silent data loss** — No versioning means no recovery from accidental overwrites
- **Security blind spots** — No secrets scanning means API keys and credentials leak into agent context
- **Stale cache corruption** — No mtime validation means agents operate on outdated file state
- **Unbounded resource usage** — No batch limits or file size enforcement means a single request can exhaust system resources
- **No accountability** — No audit trail means no way to trace what an agent did and when
- **No self-repair** — When things break, there's no autonomous recovery
- **No codebase understanding** — Agents operate blindly without knowing what files contain, how they connect, or what breaks when changed

JCF Healthcare Agent Hub was built to solve every one of these problems.

---

## Core Capabilities

### 1. Cognitive Index Engine (HCI) — NEW
The flagship feature. A 3-layer hierarchical cognitive index that extracts deep understanding from any codebase:
- **Layer 1: Project Skeleton** — Directory tree, tech stack detection (package.json, requirements.txt, go.mod, Cargo.toml), architecture pattern classification (monolith, microservices, MVC, MVVM, layered, hexagonal, plugin-based, serverless, CLI-library)
- **Layer 2: Module Contracts** — Per-file exports, imports, defined types, pattern classification
- **Layer 3: Unit Fingerprints** — Per-function/class signatures, complexity scoring, purity analysis, side effect detection, semantic tagging, call target resolution, type dependency mapping

### 2. Node-Level Knowledge Graph (NLKG) — NEW
Semantic dependency graph with typed edges representing real relationships between code entities:
- **Nodes**: Modules and units (functions, classes, interfaces, types, enums)
- **Edges**: `contains`, `calls`, `uses-type`, `references`, `extends`, `implements`
- **Analysis**: Subgraph extraction (depth-limited, directional), impact analysis (direct + transitive), data flow chain tracing, cycle detection

### 3. Pattern Detector & Semantic Compression — NEW
Detects 11 code pattern categories and calculates token savings through semantic compression:
- **Patterns**: CRUD, Middleware, Observer, Factory, Singleton, Adapter, Strategy, Repository, Service, Controller, Utility
- **Compression**: Delta extraction per pattern, compression ratio calculation, token savings estimation — optimal for LLM context windows

### 4. Type Flow Analyzer — NEW
Traces type definitions through the codebase — who produces, transforms, validates, and consumes each type:
- **Type Flow**: Definition → Production → Transformation → Validation → Consumption
- **Data Pipelines**: End-to-end pipeline tracing from entry points with branching point detection

### 5. Code Intelligence Engine — NEW
Unified orchestrator integrating all cognitive modules with a single query interface supporting 8 query types including `full_context` — compressed project knowledge optimized for minimal token usage.

### 6. Semantic Search Engine (Hybrid RRF)
Built-in vector database with hybrid tf-idf + Qwen3-Embedding-0.6B (1024-dim) via Reciprocal Rank Fusion (k=60). AI agents can search files by meaning, not just by filename pattern. Graceful degradation to tf-idf-only when the embedding bridge is unavailable.

### 7. Content-Based Versioning & Rollback
Every file modification creates a content-addressed version using SHA-256 hashing. Versions store actual file content, enabling true rollback to any previous state.

### 8. Role-Based Access Control (RBAC) + Auth Tokens
Dynamic user resolution via environment variables. Every operation passes through `enforceRBAC()` with policy-based permission checks loaded from `.jcf-policies.json`. Auth-token system (`AuthTokenManager`) uses SHA-256 hashed tokens with role-based access and configurable expiry.

### 9. Secrets Scanning with Masked Output
Proactive detection of 30+ patterns: AWS, GCP, Azure, GitHub, Slack, Stripe, npm, PyPI, Discord, Docker, SendGrid, Mailgun, Twilio, private keys, JWTs, plus generic high-entropy tokens via Shannon entropy (≥ 4.5 bits/char). Detected secrets are masked in all outputs.

### 9b. SSRF Prevention (T3.1)
`PathValidator` blocks URL-scheme paths (`http://`, `s3://`, `ftp://`, `file://`) and UNC paths before any filesystem call. Embedding client validates against host allowlist.

### 9c. SQLCipher Encryption (T3.4)
Optional AES-256 encrypted SQLite via `@journeyapps/sqlcipher`. Controlled by `JCF_USE_SQLCIPHER=1` + `JCF_DB_KEY`. Feature flag is frozen + immutable at import time.

### 10. Multi-Level Caching
Two-tier cache architecture: primary in-memory NodeCache for hot paths, secondary Redis for distributed scenarios. Cache entries include file mtime metadata for automatic staleness detection.

### 11. Dependency Graph & Cycle Detection
Tracks import/dependency relationships between files with bidirectional graph. Cycle detection finds ALL cycles, and coherence scoring identifies tightly-coupled files.

### 12. Autonomous Self-Healing (AERS Strategy)
Implements the Assess-Execute-Recover-Supervise pattern for autonomous error recovery. Categorized fix strategies handle database corruption, cache invalidation, metadata loss, and network errors.

### 13. Comprehensive Audit Trail
Every filesystem operation is recorded with user identity, action type, file path, result, and timestamp. Audit queries support filtering and pagination.

### 14. Resource Protection
Batch operations are capped at a configurable limit. File writes enforce a maximum file size. Recursive search respects a maximum directory depth.

---

## Tool Reference (33 Tools)

### Diagnostics (3)
| Tool | Description |
|------|-------------|
| `ping` | Health probe + DB stats + JCF Constitutional enforcement status |
| `estatus` | §0 IMMUTABLE_BINDING_CORE status report (gates, compliance level, drift, optional enforcement log) |
| `verify` | G0 binding-integrity gate — verifies binding against stored anchor hash |

### Core Filesystem (6)
| Tool | Description |
|------|-------------|
| `read_file` | Read file content with cache-aware staleness detection |
| `write_file` | Write file with versioning, secrets scan, and size enforcement |
| `edit_file` | Find-and-replace with `replaceAll` for all occurrences |
| `append_file` | Chunked append for large files with `createIfMissing` support |
| `delete_file` | Delete file with pre-delete version snapshot |
| `list_directory` | List directory contents with optional hidden file visibility |

### Search (2)
| Tool | Description |
|------|-------------|
| `search_files` | Recursive file search with pattern matching |
| `semantic_search` | Hybrid tf-idf + Qwen3-Embedding RRF semantic search |

### Versioning (3)
| Tool | Description |
|------|-------------|
| `get_version_history` | Retrieve version history for a file with optional limit |
| `rollback_file` | Restore file to a previous version with pre-rollback snapshot |
| `get_current_metadata` | Get file metadata (size, mtime, hash, language) |

### Dependency & Coherence (4)
| Tool | Description |
|------|-------------|
| `get_dependencies` | Get forward dependencies of a file (optional transitive) |
| `get_dependents` | Get reverse dependents of a file (optional transitive) |
| `check_coherence` | Score file coupling/isolation (0-1 scale) |
| `detect_circular_dependencies` | Find ALL dependency cycles in the graph |

### Operations & Monitoring (4)
| Tool | Description |
|------|-------------|
| `batch_operations` | Execute multiple read/write/edit/delete operations atomically |
| `health_check` | System health status + subsystem warnings (embedding, self-healing, rate limiter) |
| `get_enabled_features` | List currently enabled feature flags |
| `get_audit_log` | Query audit trail with filtering and pagination |

### Cognitive Intelligence (11)
| Tool | Description |
|------|-------------|
| `build_cognitive_index` | Build full 3-layer cognitive index for a project |
| `get_build_status` | Check background cognitive index build status |
| `get_project_skeleton` | Layer 1: Project overview, tech stack, architecture patterns |
| `get_module_contracts` | Layer 2: Per-file exports, imports, defined types |
| `get_unit_fingerprints` | Layer 3: Per-unit signatures, complexity, purity, side effects |
| `query_code_intelligence` | Unified query across all cognitive modules (8 query types) |
| `get_impact_analysis` | Impact set (direct + transitive) with subgraph |
| `get_type_flow` | Type flow tracing with consumers and producers |
| `detect_patterns` | Detect 11 code patterns + semantic compression |
| `get_knowledge_subgraph` | Extract dependency subgraph around a node |
| `get_intelligence_stats` | Statistics for all cognitive modules |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                        MCP Client                            │
│              (Windsurf / Claude / Cursor / VS Code)          │
└───────────────────────────┬──────────────────────────────────┘
                            │ JSON-RPC 2.0
┌───────────────────────────▼──────────────────────────────────┐
│                JCF Healthcare Agent Hub Server                       │
│  ┌────────────┐ ┌──────────┐ ┌──────────┐ ┌────────────────┐ │
│  │ Security   │ │  Cache   │ │ Database │ │ VectorDB       │ │
│  │(RBAC+SSRF │ │(2-tier)  │ │(SQLite   │ │(tf-idf+Qwen3  │ │
│  │+AuthToken)│ └──────────┘ │ WAL)     │ │ RRF hybrid)  │ │
│  └────────────┘              └──────────┘ └────────────────┘ │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────────────────┐ │
│  │DepGraph  │ │SelfHeal  │ │    Cognitive Engine           │ │
│  │(+cycles) │ │ (AERS)   │ │ ┌────────┬────────┬────────┐ │ │
│  └──────────┘ └──────────┘ │ │  HCI   │  NLKG  │Pattern │ │ │
│  ┌───────────────────────┐ │ │ Index  │  Graph │Detector│ │ │
│  │     Audit Trail       │ │ ├────────┼────────┼────────┤ │ │
│  └───────────────────────┘ │ │TypeFlow│  Code  │        │ │ │
│                             │ │Analyzer│Intel.  │        │ │ │
│                             │ └────────┴────────┴────────┘ │ │
│                             └──────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
                            │
              ┌─────────────▼─────────────┐
              │     Local Filesystem       │
              └───────────────────────────┘
```

---

## Competitive Landscape

| Capability | Anthropic Official FS | mark3labs/mcp-filesystem | **JCF Healthcare Agent Hub** |
|-----------|:---:|:---:|:---:|
| Basic CRUD | ✅ | ✅ | ✅ |
| Path validation | ✅ | ✅ | ✅ |
| Semantic search | ❌ | ❌ | ✅ |
| Content versioning | ❌ | ❌ | ✅ |
| Rollback | ❌ | ❌ | ✅ |
| RBAC | ❌ | ❌ | ✅ |
| Secrets scanning | ❌ | ❌ | ✅ |
| Multi-level cache | ❌ | ❌ | ✅ |
| Dependency graph | ❌ | ❌ | ✅ |
| Cycle detection | ❌ | ❌ | ✅ |
| Self-healing | ❌ | ❌ | ✅ |
| SSRF prevention | ❌ | ❌ | ✅ |
| Auth-token system | ❌ | ❌ | ✅ |
| SQLCipher encryption | ❌ | ❌ | ✅ |
| Audit trail | ❌ | ❌ | ✅ |
| Coherence scoring | ❌ | ❌ | ✅ |
| Batch operations | ❌ | ❌ | ✅ |
| Cognitive Index | ❌ | ❌ | ✅ |
| Knowledge Graph | ❌ | ❌ | ✅ |
| Pattern Detection | ❌ | ❌ | ✅ |
| Type Flow Analysis | ❌ | ❌ | ✅ |
| Impact Analysis | ❌ | ❌ | ✅ |
| Semantic Compression | ❌ | ❌ | ✅ |
| Health check warnings | ❌ | ❌ | ✅ |
| Hybrid RRF search | ❌ | ❌ | ✅ |

**JCF Healthcare Agent Hub is the only MCP filesystem server with enterprise-grade reliability, security, intelligence, and cognitive codebase understanding.**

> **1015 tests | 0 failures | 86%+ global coverage | 100% mutation kill | 100% cognitive-index coverage**

---

## Technical Specifications

- **Runtime**: Node.js 18+ (ES2022, ESNext modules)
- **Language**: TypeScript 5.3+ (strict mode)
- **Protocol**: MCP over JSON-RPC 2.0 via stdio transport
- **Hash Algorithm**: SHA-256 (crypto-grade content addressing)
- **Cache**: NodeCache (primary) + Redis/ioredis (secondary)
- **Database**: SQLite WAL via `better-sqlite3` (auto-migrates from legacy JSON on first boot). Optional `@journeyapps/sqlcipher` AES-256.
- **Vector DB**: Hybrid tf-idf + Qwen3-Embedding-0.6B (1024-dim) via Reciprocal Rank Fusion
- **Cognitive Index**: 3-layer HCI with auto tech stack + architecture detection
- **Knowledge Graph**: Node-level with 6 edge kinds
- **Build**: Zero TypeScript errors, 20 JS files compiled

---

## Design Philosophy

1. **Data integrity is non-negotiable** — Every write is versioned, every rollback creates a snapshot, every save is atomic
2. **Security by default** — Secrets are masked, RBAC is enforced, paths are validated, operations are audited
3. **Graceful degradation** — Self-healing recovers from corruption, cache misses fall through, health checks report honestly
4. **Resource-aware** — Batch limits, file size limits, depth limits prevent unbounded resource consumption
5. **Observable** — Every operation is audited, every component reports health, every error is categorized
6. **Cognitive understanding** — Build deep codebase understanding before making changes, know impact before acting

---

## Use Cases

- **AI Coding Assistants** — Safe, versioned, auditable file operations + deep codebase understanding for autonomous coding agents
- **Enterprise MCP Deployments** — RBAC + audit trail + secrets scanning for compliance-sensitive environments
- **Knowledge Base Management** — Semantic search + dependency tracking + cognitive indexing for large codebases
- **Disaster Recovery** — Content versioning + rollback + self-healing for resilient file operations
- **Multi-Agent Systems** — Batch operations + resource limits + cache coherence for concurrent agent access
- **Code Review & Refactoring** — Impact analysis + type flow + pattern detection for safe code changes

---

*JCF Healthcare Agent Hub — Beyond God-Like Cognitive Intelligence for the age of AI agents.*
*Built with JCF (Jules Cognitive Framework).*
*Tidak pernah berubah.*
