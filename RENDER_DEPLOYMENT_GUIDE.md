# Render Deployment Guide — JCF Healthcare Agent Hub

> **Platform:** Render (Free Tier)  
> **Architecture Compatibility:** ✅ Full MCP support (child processes + SQLite)  
> **Spin-Down:** 15 minutes inactivity  
> **Free Tier Specs:** 512MB RAM, 0.1 CPU, 750 hours/month, 100GB bandwidth

---

## Prerequisites

- ✅ GitHub repository with code pushed
- ✅ Render account (free, no credit card required)
- ✅ Node.js 20+ (local development)

---

## Deployment Steps

### 1. Prepare Repository

```bash
# Ensure render.yaml is in your repository root
cd jcf-healthcare-agent-hub
git add render.yaml
git commit -m "feat: add Render deployment configuration"
git push origin main
```

### 2. Create Render Account

1. Go to [https://render.com](https://render.com)
2. Sign up with GitHub (recommended) or email
3. No credit card required for free tier
4. Verify email address

### 3. Connect GitHub Repository

**Option A: Via Render Dashboard (GUI)**

1. Login to Render dashboard
2. Click **New** → **Web Service**
3. Authorize Render to access your GitHub
4. Select repository: `julesindigo-web/jcf-healthcare-agent-hub`
5. Select branch: `main`
6. Click **Connect**

**Option B: Via Render Blueprint (render.yaml)**

1. Push `render.yaml` to your repository
2. In Render dashboard, click **New** → **Blueprint**
3. Select your repository and branch
4. Render will auto-detect the blueprint
5. Click **Apply Blueprint**

### 4. Configure Deployment

**Build Settings:**
- **Environment:** Node
- **Build Command:** `npm install && npm run build`
- **Start Command:** `npm run start:http`

**Instance Settings:**
- **Instance Type:** Free (512MB RAM, 0.1 CPU)
- **Region:** Oregon (or choose closest to your users)
- **Instances:** 1

**Environment Variables:**
```bash
PORT=8080
NODE_ENV=production
JCF_HEALTHCARE_AGENT_HUB_HOME=/opt/render/project/src
JCF_HEALTHCARE_AGENT_HUB_DATA_DIR=/opt/render/project/src/data
```

**Advanced Settings:**
- **Health Check Path:** `/health`
- **Auto-Deploy:** Enabled (deploy on git push)

### 5. Deploy

Click **Create Web Service** in the dashboard.

Render will:
1. Clone your repository
2. Run `npm install`
3. Run `npm run build`
4. Start the service with `npm run start:http`
5. Run health checks

### 6. Monitor Deployment

Watch the deployment logs in the Render dashboard:

1. Navigate to your service
2. Click **Events** tab
3. Click on the latest deployment
4. View real-time logs

**Expected logs:**
```
Cloning repository...
Installing dependencies...
Building TypeScript...
Starting HTTP server...
Service is listening on port 8080
Health check passed
```

### 7. Access Your Service

Once deployment is successful, Render will provide:
- **Public URL:** `https://jcf-healthcare-agent-hub.onrender.com`
- **Health endpoint:** `https://jcf-healthcare-agent-hub.onrender.com/health`
- **MCP endpoint:** `https://jcf-healthcare-agent-hub.onrender.com/mcp`

Test the deployment:

```bash
# Test health endpoint
curl https://jcf-healthcare-agent-hub.onrender.com/health

# Expected response:
# {"status":"healthy","server":"jcf-healthcare-agent-hub","version":"2.1.0-healthcare","timestamp":"2026-05-09T..."}
```

---

## Spin-Down Behavior

**Important:** Render free tier spins down after **15 minutes of inactivity**.

### Impact on MCP Server

- ✅ **HTTP requests** will trigger auto-wake-up (~30-60 seconds cold start)
- ⚠️ **Persistent MCP connections** will be disconnected after 15 minutes
- ⚠️ **Client auto-reconnection** is required for production use
- ⚠️ **More aggressive than Koyeb** (15 min vs 1 hour)

### Mitigation Strategies

**1. Keep-Alive Script (Recommended)**

Add a cron job to ping the service every 10 minutes:

```bash
# Add to your CI/CD or external monitoring
*/10 * * * * curl https://jcf-healthcare-agent-hub.onrender.com/health
```

**2. Use Uptime Monitoring**

Free uptime monitoring services:
- [UptimeRobot](https://uptimerobot.com) - Free, checks every 5 minutes
- [Better Uptime](https://betteruptime.com) - Free tier available
- [Pingdom](https://pingdom.com) - Free basic monitoring

**3. Client-Side Auto-Reconnection**

Implement reconnection logic in your MCP client:

```typescript
// Example auto-reconnection logic
async function connectWithRetry(url: string, maxRetries = 5) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const client = await createMCPClient(url);
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

## Environment Variables

### Required for Production

```bash
# Server configuration
PORT=8080
NODE_ENV=production

# JCF paths (Render-specific)
JCF_HEALTHCARE_AGENT_HUB_HOME=/opt/render/project/src
JCF_HEALTHCARE_AGENT_HUB_DATA_DIR=/opt/render/project/src/data
```

### Optional (Add in Render Dashboard)

```bash
# Logging
LOG_LEVEL=info

# Embedding service (optional, degrades gracefully if unavailable)
EMBEDDING_ENDPOINT=http://your-embedding-service/api/embed
EMBEDDING_TIMEOUT_MS=30000

# Security (SQLCipher encryption)
JCF_USE_SQLCIPHER=1
JCF_DB_KEY=your-hex-encoded-32-byte-key
```

---

## Troubleshooting

### Deployment Fails

**Error:** Build failed
- **Check:** package.json has correct `build` and `start:http` scripts
- **Check:** TypeScript compiles without errors
- **Solution:** View build logs in Render dashboard

**Error:** Install failed
- **Cause:** Native module compilation (better-sqlite3)
- **Solution:** Ensure Node.js version matches (20+)
- **Check:** Dockerfile uses `node:20-alpine`

**Error:** Health check failed
- **Check:** HTTP server is listening on PORT 8080
- **Check:** /health endpoint returns 200
- **Solution:** Check application logs in dashboard

### Service Unresponsive

**Error:** Connection timeout / 504
- **Cause:** Service spun down (cold start)
- **Solution:** Wait 30-60 seconds for wake-up
- **Prevention:** Implement keep-alive ping (every 10 min recommended)

**Error:** Spun down message in logs
- **Cause:** No traffic for 15 minutes
- **Solution:** Send a request to wake up
- **Prevention:** Use uptime monitoring service

### Database Issues

**Error:** SQLite database locked
- **Cause:** Concurrent write attempts
- **Solution:** Render free tier has single instance, so this shouldn't happen
- **Check:** Database file permissions in /opt/render/project/src/data

**Error:** Database not found
- **Cause:** Data directory not persistent
- **Solution:** Render free tier doesn't have persistent disks by default
- **Workaround:** Use Render Postgres (free tier) instead of SQLite, or upgrade to paid tier for persistent disks

---

## Resource Limits (Free Tier)

| Resource | Limit | Impact |
|----------|-------|--------|
| RAM | 512 MB | May be tight for 59 tools + cognitive index |
| CPU | 0.1 CPU | Slow response for heavy operations |
| Compute Hours | 750/month | ~1 instance full-time |
| Bandwidth | 100 GB/month | Generous for MCP traffic |
| Spin-Down | 15 minutes | Requires aggressive keep-alive |
| Persistent Storage | ❌ Not included | Database resets on spin-down |

**Critical Limitation:** Render free tier does NOT include persistent storage. SQLite database will be lost when service spins down.

**Workarounds:**
1. Use Render Postgres (free tier, 30-day expiry)
2. Upgrade to paid tier for persistent disks
3. Use external database (Supabase, Neon, etc.)

---

## Upgrade to Paid (If Needed)

If free tier limits are insufficient:

1. Go to Render dashboard
2. Navigate to your service
3. Click **Settings** → **Change Instance Type**
4. Select **Starter** ($7/month, 512MB RAM, 0.5 CPU)
5. Add persistent disk if needed

**Benefits of paid tier:**
- More CPU (0.5 vs 0.1)
- Persistent storage disks
- No spin-down (always-on)
- Better performance for cognitive index operations

---

## CI/CD Integration

### GitHub Actions (Optional)

Create `.github/workflows/render-deploy.yml`:

```yaml
name: Deploy to Render

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Deploy to Render
        uses: thomas-xl/deploy-to-render@v1.0.0
        with:
          service-id: ${{ secrets.RENDER_SERVICE_ID }}
          api-key: ${{ secrets.RENDER_API_KEY }}
          wait-for-success: true
```

Add `RENDER_SERVICE_ID` and `RENDER_API_KEY` to GitHub repository secrets.

---

## Monitoring

### Render Dashboard

- **Metrics tab:** CPU, RAM, response time
- **Logs tab:** Application logs (real-time)
- **Events tab:** Deployment history

### Health Check

```bash
# Continuous health monitoring
watch -n 30 curl https://jcf-healthcare-agent-hub.onrender.com/health
```

### External Monitoring

Set up uptime monitoring:
- UptimeRobot: Check `/health` every 5 minutes
- Get alerts via email/Slack when service goes down

---

## Rollback

If deployment fails:

**Via Dashboard:**
1. Go to service → Events
2. Find previous successful deployment
3. Click **Redeploy**

**Via Git:**
```bash
# Revert to previous commit
git revert HEAD
git push origin main

# Render will auto-deploy the rollback
```

---

## Cost Summary

**Free Tier:** $0/month
- 512MB RAM, 0.1 CPU
- 750 compute hours/month
- 100GB bandwidth
- Spin-down after 15 minutes
- ❌ No persistent storage

**Starter Tier (if upgrade needed):** $7/month
- 512MB RAM, 0.5 CPU
- Persistent storage disks available
- No spin-down (always-on)

---

## Comparison: Koyeb vs Render

| Feature | Koyeb Free | Render Free |
|---------|-----------|-------------|
| RAM | 512MB | 512MB |
| CPU | 0.1 vCPU | 0.1 CPU |
| Storage | 2GB SSD | ❌ None |
| Scale-to-zero | 1 hour | 15 minutes |
| Bandwidth | 100GB | 100GB |
| Persistent DB | ✅ Yes | ❌ No |
| Cold Start | ~30-60s | ~30-60s |
| Keep-alive needed | Every 30min | Every 10min |

**Recommendation:** Koyeb is better for MCP server due to:
- Longer scale-to-zero window (1 hour vs 15 minutes)
- Persistent storage included (SQLite works)
- Less aggressive keep-alive requirements

---

## Next Steps

1. ✅ Deploy to Render free tier (as backup)
2. ✅ Test health endpoint
3. ✅ Test MCP endpoint with sample request
4. ✅ Set up uptime monitoring (every 5-10 minutes)
5. ⚠️ Implement client auto-reconnection for spin-down
6. ⚠️ Consider using Render Postgres instead of SQLite (free tier, 30-day expiry)
7. ⚠️ Consider upgrade to Starter tier if persistent storage needed

---

## Alternative: Koyeb (Primary)

If Render's spin-down (15 min) or lack of persistent storage is problematic, see [KOYEB_DEPLOYMENT_GUIDE.md](./KOYEB_DEPLOYMENT_GUIDE.md) for primary deployment instructions.
