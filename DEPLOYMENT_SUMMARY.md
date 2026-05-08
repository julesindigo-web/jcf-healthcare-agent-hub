# Deployment Summary — Koyeb & Render

> **Primary:** Koyeb (Free Tier)  
> **Backup:** Render (Free Tier)  
> **Architecture:** MCP stdio server with HTTP wrapper (child processes + SQLite)

---

## Quick Comparison

| Feature | Koyeb Free | Render Free |
|---------|-----------|-------------|
| **RAM** | 512MB | 512MB |
| **CPU** | 0.1 vCPU | 0.1 CPU |
| **Storage** | 2GB SSD ✅ | ❌ None |
| **Scale-to-zero** | 1 hour | 15 minutes |
| **Bandwidth** | 100GB/month | 100GB/month |
| **Persistent DB** | ✅ SQLite works | ❌ DB resets on spin-down |
| **Keep-alive** | Every 30min | Every 10min |
| **Cold Start** | ~30-60s | ~30-60s |
| **Setup** | koyeb.yaml | render.yaml |
| **Credit Card** | Not required | Not required |

---

## Recommendation: Koyeb (Primary)

**Why Koyeb is better for this MCP server:**

1. ✅ **Persistent storage included** - SQLite database survives spin-down
2. ✅ **Longer scale-to-zero window** - 1 hour vs 15 minutes (less aggressive keep-alive)
3. ✅ **Better for MCP connections** - Fewer disconnections
4. ✅ **Data persistence** - Vector embeddings, cognitive index retained

**Deploy to Koyeb first.** Use Render only if Koyeb fails.

---

## Deployment Files

### Koyeb Configuration
- **File:** `koyeb.yaml`
- **Region:** Washington DC (or Frankfurt)
- **Instance:** Free (512MB RAM, 0.1 vCPU)
- **Health Check:** `/health` every 30s

### Render Configuration
- **File:** `render.yaml`
- **Region:** Oregon (or choose closest)
- **Instance:** Free (512MB RAM, 0.1 CPU)
- **Health Check:** `/health`

### Docker Configuration
- **File:** `Dockerfile` (multi-stage build)
- **Base Image:** `node:20-alpine`
- **Health Check:** Built-in Docker health check
- **Data Directory:** `/app/data` (auto-created)

---

## Pre-Deployment Checklist

### Repository Preparation
- [x] `koyeb.yaml` created and committed
- [x] `render.yaml` created and committed
- [x] `Dockerfile` updated with multi-stage build
- [x] `.dockerignore` created (exclude unnecessary files)
- [x] `.gitignore` verified (deployment files included)

### Code Verification
- [ ] TypeScript compiles without errors: `npm run build`
- [ ] HTTP server works locally: `npm run start:http`
- [ ] Health endpoint responds: `curl http://localhost:8080/health`
- [ ] MCP endpoint responds: `curl -X POST http://localhost:8080/mcp`

### Environment Variables
```bash
# Required for both platforms
PORT=8080
NODE_ENV=production
JCF_HEALTHCARE_AGENT_HUB_HOME=/app
JCF_HEALTHCARE_AGENT_HUB_DATA_DIR=/app/data
```

---

## Deployment Steps

### Option 1: Koyeb (Primary)

1. **Create Koyeb Account**
   - Go to https://www.koyeb.com
   - Sign up with GitHub
   - No credit card required

2. **Deploy via Dashboard**
   - Click "Create Web Service"
   - Select GitHub repository
   - Choose branch: `main`
   - Region: Washington DC
   - Instance: Free
   - Deploy

3. **Or Deploy via CLI**
   ```bash
   npm install -g @koyeb/cli
   koyeb login
   koyeb service create --git github.com/julesindigo-web/jcf-healthcare-agent-hub
   ```

4. **Verify Deployment**
   ```bash
   curl https://your-service.koyeb.app/health
   ```

**Full Guide:** See [KOYEB_DEPLOYMENT_GUIDE.md](./KOYEB_DEPLOYMENT_GUIDE.md)

---

### Option 2: Render (Backup)

1. **Create Render Account**
   - Go to https://render.com
   - Sign up with GitHub
   - No credit card required

2. **Deploy via Dashboard**
   - Click "New" → "Web Service"
   - Select GitHub repository
   - Choose branch: `main`
   - Region: Oregon
   - Instance: Free
   - Deploy

3. **Or Deploy via Blueprint**
   - Push `render.yaml` to repository
   - In Render, click "New" → "Blueprint"
   - Select repository and branch
   - Apply blueprint

4. **Verify Deployment**
   ```bash
   curl https://jcf-healthcare-agent-hub.onrender.com/health
   ```

**Full Guide:** See [RENDER_DEPLOYMENT_GUIDE.md](./RENDER_DEPLOYMENT_GUIDE.md)

---

## Post-Deployment Configuration

### Keep-Alive Monitoring

**Koyeb (every 30 minutes):**
```bash
# Use cron job or external monitoring
*/30 * * * * curl https://your-service.koyeb.app/health
```

**Render (every 10 minutes recommended):**
```bash
# Use uptime monitoring service
# UptimeRobot: https://uptimerobot.com (free, checks every 5 min)
```

### Client-Side Auto-Reconnection

Implement in MCP client:

```typescript
async function connectWithRetry(url: string, maxRetries = 5) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const client = await createMCPClient(url);
      console.log('Connected successfully');
      return client;
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      console.log(`Connection failed, retrying in ${i * 2}s...`);
      await sleep(i * 2000);
    }
  }
}
```

---

## Known Limitations

### Resource Constraints (Both Platforms)
- **512MB RAM** - May be tight for 59 tools + cognitive index
- **0.1 CPU** - Slow response for heavy operations
- **Single instance** - No horizontal scaling on free tier

### Scale-to-Zero Impact
- **Koyeb:** 1 hour inactivity → cold start ~30-60s
- **Render:** 15 minutes inactivity → cold start ~30-60s
- **Impact:** MCP connections disconnected, need auto-reconnection

### Storage Limitations
- **Koyeb:** 2GB SSD sufficient for SQLite + embeddings
- **Render:** No persistent storage on free tier → DB resets on spin-down
  - **Workaround:** Use Render Postgres (free, 30-day expiry) or upgrade to paid

---

## Troubleshooting

### Deployment Fails

**Koyeb:**
- Check Dockerfile syntax
- Verify koyeb.yaml format
- View build logs in Koyeb dashboard

**Render:**
- Check package.json scripts
- Verify TypeScript compilation
- View build logs in Render dashboard

### Health Check Fails

**Common causes:**
1. HTTP server not listening on PORT 8080
2. /health endpoint not implemented
3. Port conflict
4. Build artifacts missing

**Solutions:**
- Check application logs in dashboard
- Verify PORT environment variable
- Ensure `dist/http-server.js` exists

### Service Unresponsive

**Koyeb/Render:**
- Service scaled to zero (cold start)
- Wait 30-60 seconds for wake-up
- Send request to trigger wake-up

**Prevention:**
- Set up keep-alive monitoring
- Implement client auto-reconnection

### Database Issues

**Koyeb:**
- SQLite should work with persistent storage
- Check /app/data directory permissions

**Render:**
- SQLite resets on spin-down (no persistent storage)
- Use Render Postgres instead:
  - Add Postgres instance in Render dashboard
  - Set DATABASE_URL environment variable
  - Update code to use Postgres instead of SQLite

---

## Upgrade Path (If Free Tier Insufficient)

### Koyeb Upgrade
- **Eco Instance:** eSmall ($5.36/mo, 1GB RAM, 0.5 vCPU)
- **Benefits:** More resources, no scale-to-zero
- **When to upgrade:** Resource limits hit, need always-on

### Render Upgrade
- **Starter Tier:** $7/mo (512MB RAM, 0.5 CPU, persistent disks)
- **Benefits:** Persistent storage, no spin-down
- **When to upgrade:** Need persistent database, always-on

---

## Monitoring

### Platform Dashboards

**Koyeb:**
- Metrics: CPU, RAM, network
- Logs: Application logs
- Events: Deployment history

**Render:**
- Metrics: CPU, RAM, response time
- Logs: Real-time application logs
- Events: Deployment history

### External Monitoring

**Free services:**
- UptimeRobot (https://uptimerobot.com) - Checks every 5 min
- Better Uptime (https://betteruptime.com) - Free tier
- Pingdom (https://pingdom.com) - Free basic monitoring

---

## Cost Summary

### Free Tier (Both Platforms)
- **Cost:** $0/month
- **RAM:** 512MB
- **CPU:** 0.1
- **Storage:** Koyeb 2GB, Render none
- **Bandwidth:** 100GB/month

### Paid Tier (If Needed)
- **Koyeb Eco:** $5.36/mo (1GB RAM, 0.5 vCPU)
- **Render Starter:** $7/mo (512MB RAM, 0.5 CPU, persistent disks)

---

## Decision Tree

```
Start
  │
  ├─ Need free deployment?
  │   └─ Yes → Try Koyeb first (better storage + scale-to-zero)
  │           └─ If Koyeb fails → Try Render as backup
  │
  ├─ Need persistent database?
  │   └─ Yes → Koyeb (SQLite works) or Render + Postgres
  │
  ├─ Need always-on (no spin-down)?
  │   └─ Yes → Upgrade to paid tier (Koyeb Eco or Render Starter)
  │
  └─ Need more resources?
      └─ Yes → Upgrade to paid tier
```

---

## Next Steps

1. ✅ **Deploy to Koyeb** (primary)
   - Follow [KOYEB_DEPLOYMENT_GUIDE.md](./KOYEB_DEPLOYMENT_GUIDE.md)
   - Test health endpoint
   - Test MCP endpoint

2. ✅ **Set up keep-alive** (every 30 min for Koyeb)
   - Use cron job or external monitoring
   - Prevent scale-to-zero during active use

3. ✅ **Implement auto-reconnection** (client-side)
   - Handle cold starts gracefully
   - Retry logic for MCP connections

4. ⚠️ **Monitor resource usage**
   - Watch RAM/CPU in dashboard
   - Upgrade if limits hit

5. ⚠️ **Backup plan: Render**
   - Prepare Render deployment as fallback
   - Test Render deployment
   - Document switch procedure

---

## Emergency Rollback

If deployment fails:

**Koyeb:**
```bash
koyeb service redeploy jcf-healthcare-agent-hub --revision <previous-revision>
```

**Render:**
- Go to service → Events
- Select previous successful deployment
- Click "Redeploy"

**Git rollback:**
```bash
git revert HEAD
git push origin main
# Platform will auto-deploy rollback
```

---

## Contact & Support

**Koyeb:**
- Docs: https://www.koyeb.com/docs
- Community: https://community.koyeb.com
- Support: support@koyeb.com

**Render:**
- Docs: https://render.com/docs
- Community: https://community.render.com
- Support: support@render.com
