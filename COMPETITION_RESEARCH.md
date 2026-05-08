# Competition Research Synthesis — Hosting & Marketplace Submission

> **Date:** May 8, 2026  
> **Purpose:** Comprehensive research for JCF Healthcare Agent Hub competition submission  
> **Sources:** 8 web research articles on hosting platforms + MCP marketplace requirements

---

## Executive Summary

**Hosting Platform Recommendation:** **Render** (with Railway as backup)  
**Marketplace Strategy:** Multi-registry approach (Official Registry → Glama → MCP.so → MCP Market)  
**Critical Path:** 8.5-13.5 hours total deployment timeline

---

## Part 1: Hosting Platform Research

### Platform Comparison Matrix

| Feature | Render | Railway | Fly.io |
|---|---|---|---|
| **Free Tier** | 750 hrs/mo (sleeps after 15 min) | 30-day trial ($5 credit) | 2-hour trial only |
| **Min Paid Tier** | $7/mo (512MB RAM, 0.5 vCPU) | $5/mo (usage-based) | ~$2/mo (per-second billing) |
| **Cold Start** | 30-60s (free tier) | None (Hobby+) | ~100ms (suspend mode) |
| **Managed PostgreSQL** | $7/mo extra | Included in usage | Manual setup |
| **Managed Redis** | $10/mo | Included in usage | External (Upstash) |
| **Deployment Difficulty** | LOW (GitHub auto-deploy) | LOW (GitHub auto-deploy) | MEDIUM (requires flyctl CLI) |
| **Multi-Region** | No | No | Yes (35+ regions) |
| **Best For** | Simple deploy, predictable pricing | Stateful/SSE, monorepos | stdio servers, cost optimization |

### Detailed Analysis

#### Render (RECOMMENDED)

**Pros:**
- Easiest GitHub-to-deploy workflow (one-click from repo)
- No CLI required, purely web-based
- Predictable flat pricing ($7/mo for always-on)
- Managed Redis available ($10/mo)
- Automatic TLS and custom domains
- Excellent for hackathon timeline

**Cons:**
- Free tier sleeps after 15 min (unusable for production)
- Cold starts on free tier (30-60s timeout risk)
- No multi-region deployment
- Scaling gets expensive quickly ($25/mo for 2GB RAM)

**Cost for Our Use Case:**
- Web Service: $7/mo (512MB RAM, 0.5 vCPU) - **MINIMUM VIABLE**
- PostgreSQL: $7/mo (1GB storage)
- Redis: $10/mo (25MB free tier insufficient)
- **Total: ~$24/mo**

**Verdict:** **BEST CHOICE** for hackathon timeline - fastest deployment path, sufficient for demo.

---

#### Railway (BACKUP OPTION)

**Pros:**
- Usage-based pricing (pay only what you use)
- One-click databases (PostgreSQL, MySQL, Redis, MongoDB)
- Excellent monorepo support (deploy multiple services from subdirectories)
- Zero cold starts on paid plans
- Native Redis included
- Best developer experience

**Cons:**
- No permanent free tier (30-day trial only)
- Recent pricing changes (potential cost uncertainty)
- Single-region deployment
- App can sleep if no outbound traffic for 10 min on Free plan

**Cost for Our Use Case:**
- Compute: $5/mo (Hobby plan with $5 credits)
- PostgreSQL: Included in usage
- Redis: Included in usage
- **Total: ~$5-10/mo** (highly variable based on usage)

**Verdict:** **EXCELLENT BACKUP** - better long-term economics, slightly more complex setup.

---

#### Fly.io (NOT RECOMMENDED FOR HACKATHON)

**Pros:**
- Per-second billing (near-zero idle cost via auto-suspend)
- Firecracker VM isolation (strong security)
- 35+ global regions (edge deployment)
- Suspend mode resumes in ~100ms
- `fly mcp launch` one-liner for stdio servers

**Cons:**
- No free tier (post-Oct 2024)
- Requires flyctl CLI (more complex setup)
- No managed Redis (must use Upstash externally)
- Stateful MCP requires single-machine deployment
- Beta tooling (`fly mcp` is experimental)

**Cost for Our Use Case:**
- Compute: ~$2-4/mo (shared CPU, 256MB RAM)
- PostgreSQL: ~$10/mo (volume)
- Redis: External (Upstash ~$5/mo)
- **Total: ~$17-19/mo**

**Verdict:** **SKIP FOR HACKATHON** - too complex for timeline, better for production optimization.

---

### Hosting Decision Matrix

| Criterion | Render | Railway | Fly.io | Winner |
|---|---|---|---|---|
| Deployment Speed | 5 min | 5 min | 15 min | Render/Railway |
| Setup Complexity | Very Low | Low | Medium | Render |
| Cost Predictability | High | Low | Medium | Render |
| Free Tier Availability | Yes (limited) | Trial only | No | Render |
| Cold Start Risk | High (free) | None | Low | Railway |
| Managed Databases | Yes | Yes | Partial | Railway |
| Documentation Quality | Good | Minimal | Good (beta) | Render |
| MCP-Specific Docs | Platform-only | Minimal | Good (beta) | Fly.io |

**FINAL RECOMMENDATION:**

1. **Primary Choice:** Render ($24/mo) - fastest deployment, predictable cost
2. **Backup Choice:** Railway ($5-10/mo) - better economics, excellent DX
3. **Not Recommended:** Fly.io - too complex for hackathon timeline

---

## Part 2: MCP Marketplace Research

### Marketplace Landscape

Based on research from 33 platforms (April 2026 field report), the distribution strategy should prioritize:

**Tier 1 (Essential):**
1. **Official MCP Registry** - Upstream source everyone drinks from
2. **Glama** - Auto-indexes GitHub repos, security scorecards, daily updates
3. **MCP.so** - Manual submit form, auto-pulls README
4. **MCP Market** - Manual review before listing

**Tier 2 (Optional):**
5. **PulseMCP** - Auto-indexes, weekly visitor counts
6. **FastMCP** - Manual submit form
7. **Cline Marketplace** - Requires GitHub issue submission

**Tier 3 (Skip for Hackathon):**
8. **Smithery** - Payment rail (not needed for demo)
9. **MCPize** - Monetization platform (not needed for demo)

---

### Submission Requirements Checklist

Every registry requires the same metadata with cosmetic differences. Prepare once, submit to all:

**Required Metadata:**
- [x] **Name:** "JCF Healthcare Agent Hub" (short, product-scoped)
- [x] **Description:** "59-tool MCP server for healthcare AI - FHIR R4, Clinical Decision Support, HIPAA Compliance, A2A Bridge, Synthetic Data Generation" (under 160 chars)
- [x] **Tool Count:** 59 tools (31 base + 28 healthcare)
- [x] **Transport Type:** Streamable HTTP
- [x] **Auth Method:** None (or API key if we add authentication)
- [x] **Tool List:** Explicit list of all 59 tools with one-line descriptions
- [x] **Example Usage:** MCP config snippet for Claude Desktop/Cursor
- [x] **Homepage:** https://github.com/[username]/jcf-healthcare-agent-hub
- [x] **Repository:** Public git URL (required for most registries)
- [x] **License:** MIT-like (verify actual license in package.json)
- [x] **Contact:** Maintainer email or issue tracker

**Validation Requirements:**
- [ ] MCP spec compliance (JSON-RPC 2.0 handshake)
- [ ] `initialize` request response under 5ms warm
- [ ] Security scanning (SSRF vulnerability check)
- [ ] README quality (install guide, working examples)
- [ ] License verification (MIT/Apache 2.0 preferred)

---

### Submission Order (Critical Path)

**Phase 1: Preparation (1 hour)**
1. Verify MCP spec compliance with MCP Inspector
2. Prepare metadata document (copy-paste ready)
3. Create MCP config snippet for Claude Desktop
4. Verify README has install guide
5. Check license type in package.json

**Phase 2: Official Registry (30 minutes)**
1. Install mcp-publisher CLI: `brew install mcp-publisher`
2. Authenticate: `mcp-publisher login github`
3. Create server.json with reverse-DNS naming (io.github.[username]/jcf-healthcare-agent-hub)
4. Publish: `mcp-publisher publish`
5. Retry if needed (high traffic delays common)

**Phase 3: Auto-Indexing (3-7 days wait)**
1. Ensure public GitHub repo with proper MCP manifest
2. Wait for Glama to auto-index (3-7 days)
3. Verify Glama listing appears
4. If not indexed in 7 days, submit manually at glama.ai/mcp/connectors

**Phase 4: Manual Submissions (30 minutes)**
1. Submit to MCP.so via web form (2 minutes)
2. Submit to MCP Market via web form (2 minutes)
3. Submit to FastMCP via web form (2 minutes)
4. Email hello@pulsemcp.com to accelerate PulseMCP indexing (optional)

**Phase 5: Optional Enhancements (if time permits)**
1. Create VS Code extension (no approval queue)
2. Write dev.to article
3. Post to r/mcp subreddit
4. Show HN when ready

---

### Security Requirements

**Critical Finding:** Over 1/3 of public MCP servers have SSRF vulnerabilities. Users are starting to filter on security scorecards.

**Our Security Status:**
- ✅ SSRF protection implemented (PathValidator blocks URL-scheme paths)
- ✅ Secrets scanning (30+ patterns)
- ✅ RBAC security (documented limitation for demo)
- ✅ Audit logging (immutable SQLite trail)

**Action:** Highlight security features in marketplace submissions to stand out.

---

## Part 3: Deployment Strategy

### Render Deployment Steps

**Prerequisites:**
- [ ] GitHub repository public
- [ ] Render account created
- [ ] Environment variables documented in .env.example

**Deployment Process:**

1. **Create New Web Service** (5 minutes)
   - Connect GitHub repository
   - Select "Node" as runtime
   - Build command: `npm install && npm run build`
   - Start command: `npm start`

2. **Configure Environment Variables** (5 minutes)
   - Add all variables from .env.example
   - Set `NODE_ENV=production`
   - Configure database paths (use Render PostgreSQL)

3. **Add PostgreSQL Database** (5 minutes)
   - Create PostgreSQL instance
   - Get connection string
   - Update environment variable `DATABASE_URL`

4. **Add Redis** (5 minutes)
   - Create Redis instance
   - Get connection string
   - Update environment variable `REDIS_URL`

5. **Deploy and Test** (10 minutes)
   - Trigger deployment
   - Monitor build logs
   - Test health endpoint
   - Verify MCP handshake

6. **Configure Custom Domain** (optional, 10 minutes)
   - Add custom domain in Render dashboard
   - Update DNS records
   - Verify SSL certificate

**Total Estimated Time:** 40 minutes

---

### Railway Deployment Steps (Backup)

**Prerequisites:**
- [ ] GitHub repository public
- [ ] Railway account created
- [ ] Railway CLI installed (optional)

**Deployment Process:**

1. **Create New Project** (3 minutes)
   - Connect GitHub repository
   - Select root directory
   - Railway auto-detects Node runtime

2. **Configure Service** (5 minutes)
   - Set build command: `npm install && npm run build`
   - Set start command: `npm start`
   - Add environment variables

3. **Add PostgreSQL** (2 minutes)
   - Click "Add Database" → PostgreSQL
   - Railway auto-provisions and links
   - Environment variable auto-populated

4. **Add Redis** (2 minutes)
   - Click "Add Database" → Redis
   - Railway auto-provisions and links
   - Environment variable auto-populated

5. **Deploy and Test** (10 minutes)
   - Railway auto-deploys on push
   - Monitor build logs
   - Test health endpoint
   - Verify MCP handshake

**Total Estimated Time:** 22 minutes (faster than Render!)

---

## Part 4: Integration Testing Strategy

### Test Coverage Matrix

| Category | Tools | Priority | Test Cases |
|---|---|---|---|
| **FHIR R4** | 8 tools | HIGH | Create, read, update, delete, search, batch, validate, capability |
| **Clinical CDS** | 6 tools | HIGH | Drug interactions, risk assessment, guidelines, lab interpretation |
| **HIPAA** | 5 tools | HIGH | PHI detection, audit trails, breach assessment, consent management |
| **Synthetic Data** | 4 tools | MEDIUM | Patient generation, condition generation, observation generation |
| **A2A Bridge** | 5 tools | MEDIUM | Agent discovery, task routing, message passing |
| **Base Intelligence** | 31 tools | MEDIUM | Cognitive index, semantic search, impact analysis |

### Testing Workflow

**Phase 1: Smoke Tests (30 minutes)**
1. Test MCP handshake (initialize request)
2. Test health endpoint
3. Test tool listing (list_tools request)
4. Test one tool from each category

**Phase 2: FHIR Operations (1 hour)**
1. Create synthetic patient
2. Create condition for patient
3. Search for patient by ID
4. Update patient data
5. Batch create multiple resources
6. Validate resource against FHIR spec
7. Delete test resources

**Phase 3: Clinical CDS (1 hour)**
1. Test drug interaction checking (warfarin + digoxin)
2. Test risk calculation (age + conditions)
3. Test guideline lookup (diabetes)
4. Test lab interpretation (A1C)
5. Test care plan creation

**Phase 4: HIPAA Compliance (1 hour)**
1. Test PHI detection (SSN, DOB, phone patterns)
2. Test access log query
3. Test breach assessment
4. Test consent management
5. Test HIPAA audit report generation

**Phase 5: A2A Coordination (30 minutes)**
1. Test agent discovery
2. Test task submission with priority
3. Test task status polling
4. Test message routing
5. Test agent card declaration

**Total Testing Time:** 4 hours

---

## Part 5: Demo Video Strategy

### Video Structure (3-5 minutes)

**Section 1: Introduction (30 seconds)**
- Title card: "JCF Healthcare Agent Hub"
- Problem statement: Healthcare AI needs domain intelligence
- Solution overview: 59 tools for FHIR, CDS, HIPAA, Synthetic Data, A2A

**Section 2: FHIR Operations (1 minute)**
- Show MCP server connecting to Claude Desktop
- Create synthetic patient
- Add condition to patient
- Search for patient
- Update patient data
- Validate against FHIR spec

**Section 3: Clinical Decision Support (1 minute)**
- Show drug interaction checking
- Show risk assessment
- Show guideline lookup
- Show lab interpretation

**Section 4: HIPAA Compliance (30 seconds)**
- Show PHI detection in text
- Show audit trail query
- Show breach assessment

**Section 5: A2A Coordination (30 seconds)**
- Show agent discovery
- Show task routing to specialist agents
- Show message passing

**Section 6: Conclusion (30 seconds)**
- Summary of capabilities
- Call to action (try it yourself)
- Links to GitHub and marketplace

### Recording Tools

- **Screen Recording:** OBS Studio (free)
- **Voiceover:** Audacity (free) or built-in recording
- **Music:** YouTube Audio Library (royalty-free)
- **Editing:** DaVinci Resolve (free) or CapCut (free)

---

## Part 6: Devpost Submission Strategy

### Project Description Template

```
JCF Healthcare Agent Hub — The AI Agent That Analyzes Healthcare System Changes Before Deployment

OVERVIEW
JCF Healthcare Agent Hub is a production-grade MCP server with 59 tools (31 base + 28 healthcare-specific) that enables AI language models to interact directly with healthcare systems. It serves as a bridge between AI agents (Claude, GPT-4, Gemini, etc.) and clinical infrastructure.

KEY FEATURES
• FHIR R4 Resource Engine (8 tools) — Full CRUD + validation + batch operations for Patient, Condition, Observation, Procedure, MedicationRequest, Encounter, AllergyIntolerance
• Clinical Decision Support (6 tools) — Drug interaction screening (15+ pairs), multi-factor risk scoring, clinical guideline lookup (15+ conditions)
• HIPAA Compliance (5 tools) — PHI detection (10 pattern types), audit trails, breach notification assessment, consent management
• Synthetic Data Generation (4 tools) — FHIR-compliant PHI-safe patient, condition, observation, and bundle generation for testing
• A2A Agent Bridge (5 tools) — W3C Agent2Agent protocol implementation for multi-agent clinical workflows
• Base Intelligence (31 tools) — Cognitive index, semantic search, impact analysis, version control, security, secrets scanning, self-healing

TECHNICAL SPECS
• Protocol: Model Context Protocol (MCP) SDK 1.29.0
• FHIR Version: R4
• Database: SQLite (better-sqlite3)
• Language: TypeScript (ESM), Node.js 18+
• Test Coverage: 2382 tests passing (0 failures), 85%+ statements, 89%+ functions
• Security: RBAC, secrets scanning (30+ patterns), SSRF protection, audit logging

IMPACT
• Medication error prevention through drug interaction screening
• Workflow efficiency through FHIR automation
• Patient safety through clinical risk assessment
• Interoperability through FHIR R4 standard
• HIPAA compliance through built-in safeguards

LINKS
• GitHub: https://github.com/[username]/jcf-healthcare-agent-hub
• Marketplace: [URL after submission]
• Demo Video: [YouTube URL]
```

### Screenshots Needed

1. MCP server connecting to Claude Desktop
2. FHIR resource creation interface
3. Drug interaction checking result
4. PHI detection in action
5. A2A agent coordination
6. Test suite results (2382 passing)
7. Architecture diagram

---

## Part 7: Risk Mitigation

### Risk 1: Hosting Deployment Failure

**Probability:** LOW  
**Impact:** HIGH  
**Mitigation:** Have Railway as backup; both platforms have similar deployment workflows

### Risk 2: Marketplace Rejection

**Probability:** MEDIUM  
**Impact:** HIGH  
**Mitigation:** Ensure all metadata is complete, test MCP spec compliance, highlight security features

### Risk 3: Integration Issues

**Probability:** MEDIUM  
**Impact:** MEDIUM  
**Mitigation:** Test integration early, have 4-hour testing window before submission

### Risk 4: Time Constraints

**Probability:** HIGH  
**Impact:** HIGH  
**Mitigation:** Prioritize critical path, defer nice-to-have features, use Render for fastest deployment

### Risk 5: Demo Video Issues

**Probability:** LOW  
**Impact:** MEDIUM  
**Mitigation:** Script video in advance, practice recording, have backup recording tools

---

## Part 8: Updated Timeline

**Phase 1: Hosting Setup** (2-4 hours)
- Research hosting platforms: ✅ COMPLETE (this document)
- Choose hosting platform: Render (primary) + Railway (backup)
- Configure environment variables
- Deploy MCP server
- Test deployment end-to-end

**Phase 2: Prompt Opinion Registration** (30 minutes)
- Create Prompt Opinion account
- Complete platform onboarding
- Verify MCP server compatibility
- Prepare submission materials

**Phase 3: Marketplace Publication** (1 hour)
- Prepare metadata document
- Submit to Official MCP Registry
- Wait for Glama auto-indexing (3-7 days - can proceed in parallel)
- Submit to MCP.so, MCP Market, FastMCP

**Phase 4: Integration Testing** (4 hours)
- Smoke tests (30 min)
- FHIR operations (1 hour)
- Clinical CDS (1 hour)
- HIPAA compliance (1 hour)
- A2A coordination (30 min)

**Phase 5: Demo Video Recording** (2-3 hours)
- Script demo scenario
- Record demo
- Edit and polish
- Upload to YouTube

**Phase 6: Devpost Submission** (1-2 hours)
- Create Devpost project
- Write project description
- Add screenshots and video
- Link all resources
- Submit before deadline

**Total Estimated Time:** 10.5-14.5 hours (excluding Glama auto-indexing wait time)

---

## Conclusion

This research synthesis provides a comprehensive roadmap for competition submission. The recommended strategy is:

1. **Deploy to Render** ($24/mo) for fastest deployment
2. **Use Railway as backup** if Render fails
3. **Submit to 4 marketplaces** (Official Registry, Glama, MCP.so, MCP Market)
4. **Allocate 4 hours** for comprehensive integration testing
5. **Create 3-5 minute demo video** showcasing all key features
6. **Submit to Devpost** with complete documentation

**Critical Success Factors:**
- Complete metadata preparation before any submission
- MCP spec compliance verification
- Security feature highlighting (SSRF protection, secrets scanning)
- Comprehensive testing before marketplace submission
- Professional demo video with clear value proposition

**Next Immediate Action:** Begin Render deployment setup (Todo #2)

---

*Research conducted May 8, 2026 using transcendent-research-synthesis workflow*
