# Deploy Agent Dispatch to Fly.io

This guide covers deploying the Agent Dispatch Messaging Protocol (ADMP) server to Fly.io with a custom domain.

## Prerequisites

- [Fly.io CLI installed](https://fly.io/docs/hands-on/install-flyctl/)
- Fly.io account and authenticated (`flyctl auth login`)
- Custom domain access (DNS configuration)

## Deployment Status

✅ **Currently Deployed**

- **App Name:** agentdispatch
- **Region:** Dallas, TX (dfw)
- **Current URL:** https://agentdispatch.fly.dev
- **Custom Domain:** agentdispatch.dev (DNS configuration required)
- **Status:** Running (1 machine)
- **Health Check:** ✅ Passing

---

## Quick Start

### 1. Deploy to Fly.io

```bash
# Deploy the application
flyctl deploy

# Check deployment status
flyctl status

# View logs
flyctl logs

# Open in browser
flyctl open
```

### 2. Configure Custom Domain

The app is configured to use **agentdispatch.dev** as the custom domain.

#### DNS Configuration Required

Add the following DNS records to your domain registrar:

**Option 1: Direct Connection (Recommended)**

```
A    @  →  66.241.124.13
AAAA @  →  2a09:8280:1::b2:7cdb:0
```

**Option 2: With CDN/Proxy (Cloudflare)**

```
AAAA @  →  2a09:8280:1::b2:7cdb:0  (proxied)
```

**Optional: DNS Challenge (for instant SSL)**

```
CNAME _acme-challenge.agentdispatch.dev  →  agentdispatch.dev.zjxr35x.flydns.net
```

#### Verify SSL Certificate

```bash
# Check certificate status
flyctl certs check agentdispatch.dev

# View certificate details
flyctl certs show agentdispatch.dev
```

Once DNS propagates (5-60 minutes), Fly.io will automatically provision a Let's Encrypt SSL certificate.

---

## Configuration

### Application Settings

The `fly.toml` file contains the application configuration:

```toml
app = 'agentdispatch'
primary_region = 'dfw'  # Dallas, Texas

[build]
  dockerfile = "Dockerfile"

[env]
  PORT = "8080"
  NODE_ENV = "production"
  STORAGE_BACKEND = "memory"
  # ... other environment variables
```

### Environment Variables

**Default Configuration:**
- **Storage Backend:** Memory (fast, non-persistent)
- **CORS:** Enabled for all origins
- **API Key:** Not required (set `API_KEY_REQUIRED=true` for production)

**Set Secrets:**

```bash
# For sensitive values (e.g., API keys)
flyctl secrets set MASTER_API_KEY=your-secret-key

# For Mech storage backend
flyctl secrets set MECH_APP_ID=your-app-id
flyctl secrets set MECH_API_KEY=your-api-key
flyctl secrets set MECH_API_SECRET=your-api-secret
flyctl secrets set STORAGE_BACKEND=mech
```

**View Secrets:**

```bash
flyctl secrets list
```

---

## Machine Configuration

**Current Setup:**
- **Region:** Dallas (dfw)
- **Memory:** 1 GB
- **CPU:** Shared 1x
- **Min Machines:** 0 (auto-stop when idle)
- **Auto-start:** Enabled

### Scale Application

```bash
# Scale to specific number of machines
flyctl scale count 2

# Scale vertically (more resources)
flyctl scale vm shared-cpu-2x --memory 2048

# View current scale
flyctl scale show
```

---

## Monitoring & Operations

### Health Checks

The application includes automatic health checks:

```bash
# Check via CLI
curl https://agentdispatch.fly.dev/health

# Response
{
  "status": "healthy",
  "timestamp": "2025-11-20T17:07:30.765Z",
  "version": "1.0.0"
}
```

### View Logs

```bash
# Tail logs in real-time
flyctl logs

# Filter by machine
flyctl logs --instance 17817939ce3e28

# View specific number of lines
flyctl logs -n 100
```

### Monitoring Dashboard

```bash
# Open Fly.io dashboard
flyctl open --dashboard

# View metrics
flyctl dashboard metrics
```

### Application Stats

```bash
# Get application statistics
curl https://agentdispatch.fly.dev/api/stats

# Response includes:
# - Registered agents count
# - Total messages
# - Queued messages
# - Uptime
```

---

## Deployment Workflow

### Update Application

```bash
# 1. Make code changes locally
git add .
git commit -m "feat: your changes"

# 2. Deploy to Fly.io
flyctl deploy

# 3. Verify deployment
flyctl status
flyctl logs

# 4. Test health endpoint
curl https://agentdispatch.dev/health
```

### Rollback Deployment

```bash
# List recent releases
flyctl releases

# Rollback to previous version
flyctl releases rollback
```

---

## Storage Backend Configuration

### Memory Backend (Default)

**Characteristics:**
- ⚡ Fast (87ms per operation)
- 📊 Non-persistent (data lost on restart)
- ✅ Good for development/testing

**No additional configuration required** - default setting.

### Mech Backend (Persistent)

**Characteristics:**
- 💾 Persistent storage
- 🌐 Slower (2,270ms per operation)
- ⚠️ Requires optimization before production use

**Configuration:**

```bash
# Set Mech credentials as secrets
flyctl secrets set STORAGE_BACKEND=mech
flyctl secrets set MECH_APP_ID=your-app-id
flyctl secrets set MECH_API_KEY=your-api-key
flyctl secrets set MECH_API_SECRET=your-api-secret

# Redeploy
flyctl deploy
```

**Note:** Review `PERFORMANCE-ROADMAP.md` before using Mech in production.

---

## Troubleshooting

### Application Won't Start

```bash
# Check logs for errors
flyctl logs

# SSH into machine
flyctl ssh console

# Check environment variables
flyctl config env
```

### Health Check Failing

```bash
# Test locally first
curl http://localhost:8080/health

# Check Fly.io health
flyctl checks list

# View specific machine logs
flyctl logs --instance <machine-id>
```

### SSL Certificate Issues

```bash
# Check certificate status
flyctl certs check agentdispatch.dev

# View DNS records
dig agentdispatch.dev
dig AAAA agentdispatch.dev

# Force certificate renewal
flyctl certs create agentdispatch.dev
```

### DNS Not Resolving

**Wait for propagation:** DNS changes can take 5-60 minutes.

```bash
# Check DNS propagation
dig @8.8.8.8 agentdispatch.dev
dig @1.1.1.1 agentdispatch.dev

# Check from multiple locations
https://www.whatsmydns.net/#A/agentdispatch.dev
```

### Performance Issues

```bash
# Check machine resources
flyctl status --all

# View resource usage
flyctl dashboard metrics

# Scale up if needed
flyctl scale vm shared-cpu-2x --memory 2048
```

---

## Cost Optimization

### Auto-Stop Machines

The app is configured to automatically stop when idle:

```toml
[http_service]
  auto_stop_machines = 'stop'
  auto_start_machines = true
  min_machines_running = 0
```

**Benefits:**
- No charges when app is idle
- Automatic restart on incoming requests
- Cold start: ~1-2 seconds

### Monitor Usage

```bash
# View billing dashboard
flyctl dashboard billing

# Check current usage
flyctl apps list --json | jq '.[] | select(.Name == "agentdispatch")'
```

---

## Security Best Practices

### 1. Enable API Key Authentication

```bash
# Set secrets
flyctl secrets set API_KEY_REQUIRED=true
flyctl secrets set MASTER_API_KEY=$(openssl rand -base64 32)

# Redeploy
flyctl deploy
```

### 2. Restrict CORS

Update `fly.toml`:

```toml
[env]
  CORS_ORIGIN = "https://yourdomain.com,https://anotherdomain.com"
```

### 3. Use Secrets for Sensitive Data

```bash
# Never put secrets in fly.toml [env] section
# Always use secrets for:
flyctl secrets set MASTER_API_KEY=...
flyctl secrets set MECH_API_KEY=...
flyctl secrets set MECH_API_SECRET=...
```

### 4. Enable Rate Limiting

See `CODE-REVIEW-GAP-ANALYSIS.md` for rate limiting implementation plan.

---

## CI/CD Integration

### GitHub Actions

Create `.github/workflows/fly-deploy.yml`:

```yaml
name: Deploy to Fly.io

on:
  push:
    branches: [main]

jobs:
  deploy:
    name: Deploy app
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - uses: superfly/flyctl-actions/setup-flyctl@master

      - name: Deploy to Fly.io
        run: flyctl deploy --remote-only
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```

**Setup:**

```bash
# Get your Fly.io API token
flyctl auth token

# Add to GitHub Secrets:
# Settings > Secrets > Actions > New repository secret
# Name: FLY_API_TOKEN
# Value: <your-token>
```

---

## Testing the Deployment

### Health Check

```bash
curl https://agentdispatch.dev/health
```

**Expected Response:**
```json
{
  "status": "healthy",
  "timestamp": "2025-11-20T17:07:30.765Z",
  "version": "1.0.0"
}
```

### Stats Endpoint

```bash
curl https://agentdispatch.dev/api/stats
```

**Expected Response:**
```json
{
  "agents": {
    "total": 0,
    "online": 0
  },
  "messages": {
    "total": 0,
    "queued": 0
  },
  "uptime": 123.456
}
```

### Register an Agent

```bash
curl -X POST https://agentdispatch.dev/api/agents/register \
  -H "Content-Type: application/json" \
  -d '{
    "agent_id": "agent://test-agent",
    "capabilities": ["messaging"],
    "public_key": "test_public_key_base64"
  }'
```

---

## Additional Resources

### Documentation

- **Fly.io Docs:** https://fly.io/docs/
- **ADMP Specification:** See `whitepaper/v1.md`
- **API Documentation:** https://agentdispatch.dev/api-docs (when deployed)
- **Performance Optimization:** `PERFORMANCE-ROADMAP.md`
- **Code Review Analysis:** `CODE-REVIEW-GAP-ANALYSIS.md`

### Fly.io Commands Reference

```bash
# App management
flyctl apps list
flyctl apps restart
flyctl apps destroy agentdispatch

# Deployment
flyctl deploy
flyctl deploy --remote-only
flyctl deploy --ha=false

# Monitoring
flyctl logs
flyctl status
flyctl checks list
flyctl dashboard metrics

# Scaling
flyctl scale count 2
flyctl scale vm shared-cpu-2x
flyctl scale memory 2048

# Secrets
flyctl secrets list
flyctl secrets set KEY=value
flyctl secrets unset KEY

# Certificates
flyctl certs list
flyctl certs create agentdispatch.dev
flyctl certs check agentdispatch.dev
flyctl certs delete agentdispatch.dev

# SSH access
flyctl ssh console
flyctl ssh console --app agentdispatch

# Regions
flyctl regions list
flyctl regions add sjc
flyctl regions remove sjc
```

---

## Support

### Get Help

- **Fly.io Community:** https://community.fly.io/
- **Fly.io Status:** https://status.fly.io/
- **GitHub Issues:** https://github.com/dundas/agentdispatch/issues

### Report Issues

```bash
# Capture deployment state for bug reports
flyctl status > fly-status.txt
flyctl logs --limit 100 > fly-logs.txt
```

---

## Summary

✅ **Deployment Complete**

- App: `agentdispatch`
- Region: Dallas (dfw)
- URL: https://agentdispatch.fly.dev
- Custom Domain: agentdispatch.dev (requires DNS configuration)
- Status: Running with health checks passing
- Storage: Memory backend (default)

**Next Steps:**

1. Configure DNS records for agentdispatch.dev
2. Wait for SSL certificate provisioning (5-60 minutes)
3. Test endpoints at https://agentdispatch.dev
4. Monitor logs and metrics
5. Consider Mech backend for persistence (after optimization)

---

**Deployed:** 2025-11-20
**Region:** Dallas, Texas (dfw)
**Version:** 1.0.0
