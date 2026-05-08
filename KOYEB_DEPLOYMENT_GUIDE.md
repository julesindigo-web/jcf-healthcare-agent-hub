# Koyeb Deployment Guide — JCF Healthcare Agent Hub

> **Platform:** Koyeb (Free Tier)  
> **Architecture Compatibility:** ✅ Full MCP support (child processes + SQLite)  
> **Scale-to-Zero:** 1 hour inactivity  
> **Free Tier Specs:** 512MB RAM, 0.1 vCPU, 2GB SSD, 100GB egress

---

## Prerequisites

- ✅ GitHub repository with code pushed
- ✅ Koyeb account (free, no credit card required)
- ✅ Node.js 20+ (local development)

---

## Deployment Steps

### 1. Prepare Repository

```bash
# Ensure koyeb.yaml is in your repository root
cd jcf-healthcare-agent-hub
git add koyeb.yaml
git commit -m "feat: add Koyeb deployment configuration"
git push origin main
```

### 2. Create Koyeb Account

1. Go to [https://www.koyeb.com](https://www.koyeb.com)
2. Sign up with GitHub (recommended) or email
3. No credit card required for free tier
4. Verify email address

### 3. Connect GitHub Repository

**Option A: Via Koyeb Dashboard (GUI)**

1. Login to Koyeb dashboard
2. Click **Create Web Service**
3. Select **GitHub** as deployment source
4. Authorize Koyeb to access your GitHub
5. Select repository: `julesindigo-web/jcf-healthcare-agent-hub`
6. Select branch: `main`
7. Click **Continue**

**Option B: Via Koyeb CLI**

```bash
# Install Koyeb CLI
npm install -g @koyeb/cli

# Login
koyeb login

# Create service from GitHub
koyeb service create \
  --name jcf-healthcare-agent-hub \
  --git github.com/julesindigo-web/jcf-healthcare-agent-hub \
  --git-branch main \
  --region washington-dc \
  --instance-type free
```

### 4. Configure Deployment

**Build Settings:**
- **Build Type:** Dockerfile
- **Dockerfile:** `Dockerfile` (auto-detected)
- **Context:** `/` (repository root)

**Instance Settings:**
- **Instance Type:** Free (512MB RAM, 0.1 vCPU)
- **Region:** Washington DC (or Frankfurt)
- **Min Instances:** 1
- **Max Instances:** 1

**Environment Variables:**
```bash
PORT=8080
NODE_ENV=production
JCF_HEALTHCARE_AGENT_HUB_HOME=/app
JCF_HEALTHCARE_AGENT_HUB_DATA_DIR=/app/data
```

**Health Check:**
- **Path:** `/health`
- **Interval:** 30 seconds
- **Timeout:** 10 seconds
- **Retries:** 3

### 5. Deploy

Click **Deploy** button in the dashboard or run:

```bash
koyeb service deploy jcf-healthcare-agent-hub
```

### 6. Monitor Deployment

Watch the deployment logs in the Koyeb dashboard:

1. Navigate to your service
2. Click **Logs** tab
3. Look for successful build output
4. Wait for health check to pass

**Expected logs:**
```
Building Docker image...
Running npm install...
Running npm run build...
Starting HTTP server on port 8080...
Health check: http://localhost:8080/health
```

### 7. Access Your Service

Once deployment is successful, Koyeb will provide:
- **Public URL:** `https://your-service-name.koyeb.app`
- **Health endpoint:** `https://your-service-name.koyeb.app/health`
- **MCP endpoint:** `https://your-service-name.koyeb.app/mcp`

Test the deployment:

```bash
# Test health endpoint
curl https://your-service-name.koyeb.app/health

# Expected response:
# {"status":"healthy","server":"jcf-healthcare-agent-hub","version":"2.1.0-healthcare","timestamp":"2026-05-09T..."}
```

---

## Scale-to-Zero Behavior

**Important:** Koyeb free tier scales to zero after **1 hour of inactivity**.

### Impact on MCP Server

- ✅ **HTTP requests** will trigger auto-wake-up (~30-60 seconds cold start)
- ⚠️ **Persistent MCP connections** will be disconnected after 1 hour
- ⚠️ **Client auto-reconnection** is required for production use

### Mitigation Strategies

**1. Keep-Alive Script (Optional)**

Add a cron job to ping the service every 30 minutes:

```bash
# Add to your CI/CD or external monitoring
*/30 * * * * curl https://your-service-name.koyeb.app/health
```

**2. Client-Side Auto-Reconnection**

Implement reconnection logic in your MCP client:

```typescript
// Example auto-reconnection logic
async function connectWithRetry(url: string, maxRetries = 3) {
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

# JCF paths
JCF_HEALTHCARE_AGENT_HUB_HOME=/app
JCF_HEALTHCARE_AGENT_HUB_DATA_DIR=/app/data
```

### Optional (Add in Koyeb Dashboard)

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
- **Check:** Dockerfile syntax
- **Check:** package.json has correct scripts
- **Solution:** View build logs in Koyeb dashboard

**Error:** Health check failed
- **Check:** HTTP server is listening on PORT 8080
- **Check:** /health endpoint returns 200
- **Solution:** Check application logs in dashboard

### Service Unresponsive

**Error:** Connection timeout
- **Cause:** Service scaled to zero (cold start)
- **Solution:** Wait 30-60 seconds for wake-up
- **Prevention:** Implement keep-alive ping

**Error:** 504 Gateway Timeout
- **Cause:** MCP request took >30 seconds
- **Solution:** Optimize tool execution time
- **Note:** Timeout is configurable in http-server.ts

### Database Issues

**Error:** SQLite database locked
- **Cause:** Concurrent write attempts
- **Solution:** Koyeb free tier has single instance, so this shouldn't happen
- **Check:** Database file permissions in /app/data

---

## Resource Limits (Free Tier)

| Resource | Limit | Impact |
|----------|-------|--------|
| RAM | 512 MB | May be tight for 59 tools + cognitive index |
| CPU | 0.1 vCPU | Slow response for heavy operations |
| Storage | 2 GB SSD | Sufficient for SQLite + embeddings |
| Bandwidth | 100 GB/month | Generous for MCP traffic |
| Scale-to-zero | 1 hour | Requires auto-reconnection |

**Recommendation:** Monitor resource usage in Koyeb dashboard. Upgrade to Eco instance ($1.61/mo) if needed.

---

## Upgrade to Paid (If Needed)

If free tier limits are insufficient:

1. Go to Koyeb dashboard
2. Navigate to your service
3. Click **Settings** → **Instance**
4. Change instance type to `eSmall` (1GB RAM, 0.5 vCPU, $5.36/mo)
5. Redeploy

**Benefits of paid tier:**
- More RAM/CPU for 59 tools
- No scale-to-zero (always-on)
- Better performance for cognitive index operations

---

## CI/CD Integration

### GitHub Actions (Optional)

Create `.github/workflows/koyeb-deploy.yml`:

```yaml
name: Deploy to Koyeb

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Install Koyeb CLI
        run: npm install -g @koyeb/cli
        
      - name: Login to Koyeb
        run: koyeb login --api-token ${{ secrets.KOYEB_API_TOKEN }}
        
      - name: Deploy
        run: koyeb service deploy jcf-healthcare-agent-hub
```

Add `KOYEB_API_TOKEN` to GitHub repository secrets.

---

## Monitoring

### Koyeb Dashboard

- **Metrics tab:** CPU, RAM, network usage
- **Logs tab:** Application logs
- **Events tab:** Deployment history

### Health Check

```bash
# Continuous health monitoring
watch -n 30 curl https://your-service-name.koyeb.app/health
```

---

## Rollback

If deployment fails:

```bash
# Via CLI
koyeb service redeploy jcf-healthcare-agent-hub --revision <previous-revision-id>

# Via Dashboard
1. Go to service → Deployments
2. Select previous successful deployment
3. Click "Redeploy"
```

---

## Cost Summary

**Free Tier:** $0/month
- 512MB RAM, 0.1 vCPU, 2GB SSD
- 100GB egress
- Scale-to-zero after 1 hour

**Eco Instance (if upgrade needed):**
- eSmall: $5.36/mo (1GB RAM, 0.5 vCPU)
- eMicro: $2.68/mo (512MB RAM, 0.25 vCPU)
- No scale-to-zero

---

## Next Steps

1. ✅ Deploy to Koyeb free tier
2. ✅ Test health endpoint
3. ✅ Test MCP endpoint with sample request
4. ✅ Monitor resource usage
5. ⚠️ Implement client auto-reconnection for scale-to-zero
6. ⚠️ Consider upgrade to Eco instance if resource limits hit

---

## Alternative: Render (Backup)

If Koyeb doesn't work out, see [RENDER_DEPLOYMENT_GUIDE.md](./RENDER_DEPLOYMENT_GUIDE.md) for backup deployment instructions.
