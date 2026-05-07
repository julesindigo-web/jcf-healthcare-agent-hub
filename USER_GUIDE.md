# JCF Healthcare Agent Hub - User Guide

> **Tipe**: Production-Grade MCP Server | **Tools**: 33 | **Versi**: dari `package.json` (SSOT)

---

## Daftar Isi

1. [Pendahuluan](#pendahuluan)
2. [Fitur Utama](#fitur-utama)
3. [Arsitektur Sistem](#arsitektur-sistem)
4. [Tool Reference](#tool-reference)
5. [Konfigurasi](#konfigurasi)
6. [Penggunaan Lanjutan](#penggunaan-lanjutan)
7. [Keamanan](#keamanan)
8. [Troubleshooting](#troubleshooting)
9. [Best Practices](#best-practices)
10. [Integrasi IDE](#integrasi-ide)

---

## Pendahuluan

### Apa itu JCF Healthcare Agent Hub?

**JCF Healthcare Agent Hub** adalah server Model Context Protocol (MCP) tingkat produksi yang menyediakan operasi filesystem cerdas, aman, self-healing, **dan pemahaman kognitif mendalam terhadap codebase**. Dibangun dengan JCF (Jules Cognitive Framework), server ini memberikan kemampuan enterprise yang jauh melampaui implementasi marketplace standar.

### Keunggulan vs Filesystem Standar

| Aspek | MCP Filesystem Standar | JCF Healthcare Agent Hub |
|-------|------------------------|-------------------|
| Search | Pattern matching saja | **Semantic search** dengan tf-idf vectors |
| Security | Validasi path dasar | **RBAC policies** + secrets scanning |
| Audit | Tidak ada | **Comprehensive audit trail** |
| Versioning | Tidak ada | **Content-based versioning** |
| Performance | No caching | **Multi-level cache** |
| Dependencies | Tidak ada | **Dependency graph** + coherence scoring |
| Reliability | No recovery | **Self-healing** dengan AERS |
| Operations | Single file | **Batch operations** dengan atomicity |
| Codebase Understanding | Tidak ada | **Cognitive Index + Knowledge Graph + Pattern Detection + Type Flow** |
| Impact Analysis | Tidak ada | **Node-level impact analysis** |
| Type Intelligence | Tidak ada | **Type flow tracing** + data pipeline analysis |
| Pattern Recognition | Tidak ada | **11 pattern categories** + semantic compression |

---

## Fitur Utama

### 1. Semantic Search (`semantic_search`)
Search berbasis hybrid tf-idf + Qwen3-Embedding-0.6B (1024-dim) via Reciprocal Rank Fusion (k=60). Graceful degradation ke tf-idf-only jika embedding bridge tidak tersedia. Menemukan file berdasarkan kesamaan konseptual.

```json
{ "query": "authentication middleware", "limit": 10, "threshold": 0.3 }
```

### 2. RBAC Security + Auth Tokens
Role-Based Access Control dengan kebijakan per-direktori + auth-token system (SHA-256 hashed, role-based, expiry).

### 3. Secrets Scanning (30+ patterns)
Mendeteksi 30+ pola: AWS, GCP, Azure, GitHub, Slack, Stripe, npm, PyPI, Discord, Docker, SendGrid, Mailgun, Twilio, private keys, JWTs, plus Shannon entropy filter (≥ 4.5 bits/char).

### 4. Audit Logging
Setiap operasi dicatat dalam database immutable.

### 5. Version Control
Snapshot otomatis pada setiap modifikasi file dengan content-hash addressing. Rollback ke versi sebelumnya.

### 6. Dependency Tracking
Membangun graph dependensi real-time dari import statements. Circular dependency detection.

### 7. Self-Healing (AERS)
Recovery otomatis menggunakan Application Error Response Strategy.

### 8. Cognitive Intelligence (NEW)
Sistem pemahaman kognitif mendalam terhadap codebase:

- **Cognitive Index Engine (HCI)** — 3-layer hierarchical index: Project Skeleton → Module Contracts → Unit Fingerprints
- **Node-Level Knowledge Graph (NLKG)** — Semantic dependency graph dengan typed edges
- **Pattern Detector** — Deteksi 11 pattern categories + semantic compression
- **Type Flow Analyzer** — Trace type definitions melalui codebase
- **Code Intelligence Engine** — Unified orchestrator dengan single query interface

---

## Arsitektur Sistem

```
                    MCP Client (support MCP protocol)
                              |
                              v
              +-------------------------------+
              |    JcfHandlingToolServer      |
              |    32 Tools Registered        |
              +---------------+---------------+
                              |
    +---------+-------+-------+-----+--------+----------+-----------+
    |         |       |           |        |          |               |
    v         v       v           v        v          v               v
+--------+ +------+ +-------+ +------+ +--------+ +---------+ +------------+
| Logger | |Config| |  DB   | |Cache | |VectorDB| |Security | | Cognitive  |
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
```

### Komponen Inti

| Komponen | Fungsi |
|----------|--------|
| **Logger** | Structured logging dengan pino |
| **Config** | Management konfigurasi dengan Zod validation |
| **Database** | SQLite WAL via `better-sqlite3` (auto-migrate dari legacy JSON). Optional SQLCipher AES-256. |
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

---

## Tool Reference

> **Total**: 33 tools across 7 categories.

### Diagnostics (3 Tools)

#### D1. `ping`
Health probe + DB stats + JCF Constitutional enforcement status.

```json
{}
```

**Response**: `{ status, server, version, db_path, stats, enforcement, timestamp }`. Field `enforcement` membawa `binding_active`, `anchor_hash`, `compliance_level`, `enforcement_depth`, `bypass_possible`, `override_possible`.

#### D2. `estatus`
Laporan status §0 IMMUTABLE_BINDING_CORE.

```json
{ "include_log": true, "log_limit": 10 }
```

**Response**: `{ enforcement_core, priority, status, gates, log_entries? }`. `status` membawa `binding_active`, `anchor_hash`, `compliance_level`, `drift_detected`, `resistance_signals`, `circumvention_attempts`. `log_entries` dibaca dari tabel `enforcement_log`.

#### D3. `verify`
Gate G0 binding-integrity — verifikasi binding terhadap stored anchor hash.

```json
{ "agents_md_path": "D:/.../PRIORITY-OMEGA-ALPHA-JCF-BIND.md" }
```

**Response**: `{ gate, result, path, canonical_source, anchor_hash, hash_match, immutability_check, enforcement_state }`. `result` adalah `"COMPLIANT"` atau `"HARD_RESET_EXECUTED"`.

---

### Core Filesystem Operations (7 Tools)

#### 1. `read_file`
Baca konten file dengan caching otomatis.
```json
{ "path": "c:/project/src/main.ts" }
```

#### 2. `write_file`
Tulis/buat file dengan versioning dan secrets scan.
```json
{ "path": "c:/project/src/config.ts", "content": "...", "author": "system", "message": "Initial" }
```

#### 3. `edit_file`
Apply textual edits dengan versioning.
```json
{ "path": "c:/project/src/main.ts", "edits": [{ "oldText": "old", "newText": "new" }] }
```

#### 4. `append_file`
Append konten ke file, opsi createIfMissing.
```json
{ "path": "c:/project/log.txt", "content": "new line\n", "createIfMissing": true }
```

#### 5. `delete_file`
Hapus dengan preservasi versi.
```json
{ "path": "c:/project/src/old-file.ts" }
```

#### 6. `list_directory`
List isi direktori.
```json
{ "path": "c:/project/src", "includeHidden": false }
```

#### 7. `search_files`
Pattern-based search dengan glob.
```json
{ "pattern": "**/*.ts", "baseDir": "c:/project" }
```

---

### Semantic Intelligence (1 Tool)

#### 8. `semantic_search`
Vector similarity search.
```json
{ "query": "authentication middleware token validation", "limit": 10, "threshold": 0.3 }
```

---

### Version Control (3 Tools)

#### 9. `get_version_history`
Timeline versi file.
```json
{ "path": "c:/project/src/main.ts", "limit": 10 }
```

#### 10. `rollback_file`
Restore ke versi tertentu.
```json
{ "path": "c:/project/src/main.ts", "versionId": "abc123" }
```

#### 11. `get_current_metadata`
Analisis file: language, symbols, imports, complexity.
```json
{ "path": "c:/project/src/main.ts" }
```

---

### Dependency & Coherence (4 Tools)

#### 12. `get_dependencies`
Forward dependency extraction.
```json
{ "path": "c:/project/src/main.ts", "transitive": false }
```

#### 13. `get_dependents`
Reverse dependency lookup.
```json
{ "path": "c:/project/src/utils.ts", "transitive": true }
```

#### 14. `check_coherence`
Coupling analysis + risk assessment.
```json
{ "path": "c:/project/src/main.ts" }
```

#### 15. `detect_circular_dependencies`
Temukan circular dependency dalam project.
```json
{}
```

---

### Operations & Monitoring (4 Tools)

#### 16. `batch_operations`
Atomic batch processing dengan rollback.
```json
{
  "operations": [
    { "type": "write", "path": "a.txt", "content": "1" },
    { "type": "write", "path": "b.txt", "content": "2" },
    { "type": "delete", "path": "old.txt" }
  ]
}
```

#### 17. `health_check`
System health + metrics + subsystem warnings (embedding unavailability, self-healing degradation, rate limiter stress).
```json
{}
```

#### 18. `get_enabled_features`
List semua fitur yang aktif.
```json
{}
```

#### 19. `get_audit_log`
Query audit events.
```json
{ "action": "write_file", "limit": 10 }
```

---

### Cognitive Intelligence (10 Tools)

#### 20. `build_cognitive_index`
Build full cognitive index untuk project. Ini adalah langkah pertama sebelum menggunakan tool kognitif lainnya.

```json
{ "rootPath": "c:/project" }
```

**Proses:**
1. Layer 1: Project Skeleton — directory tree, tech stack, architecture patterns
2. Layer 2: Module Contracts — exports, imports, defined types per file
3. Layer 3: Unit Fingerprints — per-function/class signatures, complexity, purity, side effects
4. Build Node-Level Knowledge Graph dari index
5. Detect patterns dan calculate compression
6. Analyze type flows dan data pipelines

**Response:** Statistik lengkap — modules, units, estimated token cost

#### 21. `get_project_skeleton`
Dapatkan Layer 1 project skeleton.
```json
{}
```

**Response:** Directory tree, tech stack, architecture patterns, entry points, config files

#### 22. `get_module_contracts`
Dapatkan Layer 2 module contracts.
```json
{ "filePaths": ["c:/project/src/main.ts"] }
```

**Response:** Per-file exports, imports, defined types, pattern classification

#### 23. `get_unit_fingerprints`
Dapatkan Layer 3 unit fingerprints dengan filter opsional.
```json
{
  "filePaths": ["c:/project/src/"],
  "patternTypes": ["query", "command"],
  "maxComplexity": 10
}
```

**Response:** Per-unit signatures, complexity, purity, side effects, semantic tags, call targets, type dependencies

#### 24. `query_code_intelligence`
Unified query interface — satu tool untuk semua modul kognitif.

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
| `full_context` | **Compressed full project knowledge** — optimal untuk LLM context |

#### 25. `get_impact_analysis`
Impact set (direct + transitive) + subgraph untuk node.
```json
{ "nodeId": "module:c:/project/src/auth.ts", "depth": 2 }
```

**Response:**
- `direct`: Node yang langsung bergantung pada target
- `transitive`: Node yang tidak langsung bergantung
- `subgraph`: Visualisasi subgraph sekitar node

#### 26. `get_type_flow`
Type flow + consumers + producers untuk type tertentu.
```json
{ "typeName": "UserSession" }
```

**Response:**
- `typeFlow`: Definition → Production → Transformation → Validation → Consumption
- `consumers`: Unit yang menggunakan type ini
- `producers`: Unit yang memproduksi type ini

#### 27. `detect_patterns`
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

#### 28. `get_knowledge_subgraph`
Extract subgraph dari knowledge graph.
```json
{ "nodeId": "module:c:/project/src/auth.ts", "depth": 2 }
```

**Response:** Nodes, edges, entry points, boundary nodes, stats

#### 29. `get_intelligence_stats`
Statistik semua modul kognitif.
```json
{}
```

**Response:** Cognitive index stats, NLKG stats, pattern stats, type flow stats

---

## Konfigurasi

### File: `mcp-fs-config.json`

```json
{
  "allowedDirectories": ["c:/Users/TUF/projects"],
  "maxFileSize": 104857600,
  "cacheMaxSize": 1000,
  "cacheTTL": 300000,
  "enableVersioning": true,
  "enableSemanticSearch": true,
  "enableRBAC": true,
  "enableSecretsScan": true,
  "enableAuditLog": true,
  "enableDependencyTracking": true,
  "enableSelfHealing": true,
  "enableCognitiveIndex": true,
  "enableNodeKnowledgeGraph": true,
  "enablePatternDetection": true,
  "enableTypeFlowAnalysis": true,
  "enableCodeIntelligence": true,
  "cognitiveIndexPath": ".jcf-cognitive-index.json"
}
```

### Penjelasan Konfigurasi

| Parameter | Default | Deskripsi |
|-----------|---------|-----------|
| `allowedDirectories` | [] | Direktori yang diizinkan untuk akses |
| `maxFileSize` | 100MB | Ukuran file maksimum |
| `cacheMaxSize` | 1000 | Jumlah item dalam cache |
| `cacheTTL` | 5 min | Time-to-live cache dalam ms |
| `enableVersioning` | true | Aktifkan versioning |
| `enableSemanticSearch` | true | Aktifkan semantic search |
| `enableRBAC` | true | Aktifkan RBAC |
| `enableSecretsScan` | true | Aktifkan secrets scanning |
| `enableAuditLog` | true | Aktifkan audit logging |
| `enableDependencyTracking` | true | Aktifkan dependency graph |
| `enableSelfHealing` | true | Aktifkan self-healing |
| `enableCognitiveIndex` | true | Aktifkan Cognitive Index Engine |
| `enableNodeKnowledgeGraph` | true | Aktifkan Node-Level Knowledge Graph |
| `enablePatternDetection` | true | Aktifkan Pattern Detector |
| `enableTypeFlowAnalysis` | true | Aktifkan Type Flow Analyzer |
| `enableCodeIntelligence` | true | Aktifkan Code Intelligence Engine |
| `cognitiveIndexPath` | .jcf-cognitive-index.json | Path untuk menyimpan cognitive index |

---

## Penggunaan Lanjutan

### Cognitive Intelligence Workflow

1. **Build Index** — Jalankan `build_cognitive_index` dengan rootPath project
2. **Explore** — Gunakan `get_project_skeleton` untuk overview
3. **Deep Dive** — Gunakan `get_module_contracts` dan `get_unit_fingerprints` untuk detail
4. **Analyze** — Gunakan `get_impact_analysis` untuk memahami dampak perubahan
5. **Trace Types** — Gunakan `get_type_flow` untuk memahami aliran data
6. **Detect Patterns** — Gunakan `detect_patterns` untuk identifikasi arsitektur
7. **Query All** — Gunakan `query_code_intelligence` type `full_context` untuk compressed knowledge

### Semantic Search Best Practices

1. **Gunakan query deskriptif**: "user authentication login flow" lebih baik dari "auth"
2. **Atur threshold sesuai kebutuhan**:
   - 0.8+ = exact match
   - 0.5-0.8 = related
   - 0.3-0.5 = loosely related
3. **Gunakan limit untuk performance**: Default 10 sudah optimal

### Dependency Analysis

**Interpretasi Coherence Score:**
- 0.0-0.3: Low coupling (baik)
- 0.3-0.7: Medium coupling
- 0.7-1.0: High coupling (perlu di-refactor)

---

## Keamanan

### Path Validation
Semua path divalidasi dan dinormalisasi. NFC normalization + `path.relative` boundary check + `..` segment detection + NUL-byte rejection + symlink-escape resolution. Case-insensitive di Windows.

### SSRF Prevention (T3.1)
`PathValidator` memblokir URL-scheme paths (`http://`, `s3://`, `ftp://`, `file://`) dan UNC paths (`\\host\share`) sebelum filesystem call. Embedding client memvalidasi terhadap host allowlist.

### Auth-Token System (T3.2)
`AuthTokenManager` dengan SHA-256 hashed tokens, role-based access, expiry, dan `withAudit` middleware. Format: `jcf_tok_<role>_<32-byte-hex>`. Never stores raw tokens.

### Secrets Detection (30+ patterns)
Sebelum write, file discan untuk 30+ pola termasuk AWS, GCP, Azure, GitHub, Slack, Stripe, npm, PyPI, Discord, Docker, private keys, JWTs, plus Shannon entropy filter.

### SQLCipher Encryption (T3.4)
Optional AES-256 encrypted SQLite via `@journeyapps/sqlcipher`. Aktifkan dengan:
```bash
export JCF_USE_SQLCIPHER=1
export JCF_DB_KEY="<64-hex-char-key>"
```

### Audit Trail
Semua operasi dicatat dengan timestamp, actor, action, result, path. Audit log immutable dalam tabel SQLite terindeks.

---

## Troubleshooting

### Error: "Module not found"
**Solusi**: Pastikan semua import memiliki ekstensi `.js`:
```typescript
import { Server } from "./server.js";  // Benar
```

### Error: "Permission denied"
**Solusi**: Tambah path ke `allowedDirectories` di `mcp-fs-config.json`.

### Error: "No cognitive index built yet"
**Solusi**: Jalankan `build_cognitive_index` terlebih dahulu sebelum menggunakan tool kognitif lainnya.

### Server tidak start
**Solusi**: Validasi JSON config: `node -e "JSON.parse(require('fs').readFileSync('mcp-fs-config.json'))"`

---

## Best Practices

1. **Build Cognitive Index dulu** sebelum menggunakan tool kognitif
2. **Gunakan `full_context` query** untuk mendapatkan compressed project knowledge
3. **Aktifkan Versioning** untuk production — selalu lacak perubahan
4. **Batasi allowedDirectories** — jangan gunakan `/` atau `*`
5. **Monitor Audit Log** secara reguler
6. **Gunakan Batch Operations** untuk multiple file operations
7. **Periksa Dependencies** sebelum refactor dengan `check_coherence`
8. **Gunakan Impact Analysis** sebelum mengubah file yang banyak di-import

---

## Integrasi IDE

Server MCP ini mendukung klien yang mendukung protokol MCP (Model Context Protocol). Konfigurasi dasar:

```json
{
  "mcpServers": {
    "jcf-healthcare-agent-hub": {
      "command": "node",
      "args": ["C:/path/to/jcf-healthcare-agent-hub/dist/index.js"],
      "env": { "MCP_SERVER_NAME": "jcf-healthcare-agent-hub" }
    }
  }
}
```

Lokasi file konfigurasi bervariasi tergantung klien:
- **Windsurf**: `~/.codeium/windsurf/mcp_config.json`
- **Cursor**: `~/.cursor/mcp.json`
- **VS Code**: `%APPDATA%/Code/User/mcp.json` (gunakan key `"servers"` dan tambahkan `"type": "stdio"`)
- **Claude Desktop**: `%APPDATA%/Claude/claude_desktop_config.json`

---

*Generated by JCF Agent v3.0 - Sovereign Engineering Intelligence*

> Last updated: 2026-04-30 | v2.1.0-JCF | 1015 tests | 0 failures | 86%+ coverage
