# Programmatic Deployment Scripts

This directory contains scripts for programmatically deploying ADMP to Digital Ocean App Platform using the API.

## Overview

Instead of manually deploying via the web UI or CLI, you can fully automate deployments using:
- **Node.js** - For JavaScript/TypeScript projects
- **Python** - For Python projects or data pipelines
- **Shell** - For bash scripts and CI/CD
- **GitHub Actions** - For automated CI/CD on every push

## Prerequisites

1. **Digital Ocean API Token**
   ```bash
   # Get a token from: https://cloud.digitalocean.com/account/api/tokens
   export DIGITALOCEAN_TOKEN="dop_v1_xxxxxxxxxxxx"
   ```

2. **GitHub OAuth Connection** (one-time setup)
   - Connect GitHub at: https://cloud.digitalocean.com/apps/new
   - Authorize Digital Ocean to access your repositories
   - This is required for App Platform to pull code from GitHub

## Usage

### Option 1: Node.js (deploy-to-digitalocean.js)

**Features:**
- Full API client with async/await
- Create, update, deploy apps
- Update environment variables
- Monitor deployment status
- Wait for deployment completion

**Run:**
```bash
export DIGITALOCEAN_TOKEN="dop_v1_..."
node scripts/deploy-to-digitalocean.js
```

**Use as a module:**
```javascript
import {
  listApps,
  createApp,
  updateEnvironmentVariables,
  waitForDeployment
} from './scripts/deploy-to-digitalocean.js';

// List all apps
const apps = await listApps();

// Update env vars
await updateEnvironmentVariables(appId, {
  FEATURE_FLAG: 'true',
  API_VERSION: 'v2'
});
```

---

### Option 2: Python (deploy-to-digitalocean.py)

**Features:**
- Clean Python API client using `requests`
- Object-oriented design
- Type hints for better IDE support
- Error handling with HTTP exceptions

**Install dependencies:**
```bash
pip install requests pyyaml
```

**Run:**
```bash
export DIGITALOCEAN_TOKEN="dop_v1_..."
python scripts/deploy-to-digitalocean.py
```

**Use as a module:**
```python
from scripts.deploy_to_digitalocean import DigitalOceanAPI

api = DigitalOceanAPI(token)

# Create app
app = api.create_app(spec)

# Update env vars
api.update_env_vars(app['id'], {
    'FEATURE_FLAG': 'true',
    'API_VERSION': 'v2'
})

# Deploy and wait
deployment = api.create_deployment(app['id'], force_rebuild=True)
api.wait_for_deployment(app['id'], deployment['id'])
```

---

### Option 3: Shell Script (deploy-to-digitalocean.sh)

**Features:**
- Pure bash using `curl` and `jq`
- No dependencies except standard tools
- Perfect for CI/CD pipelines
- Works in any Unix-like environment

**Requirements:**
```bash
# macOS
brew install jq

# Ubuntu/Debian
apt-get install jq curl

# Alpine
apk add jq curl
```

**Run:**
```bash
export DIGITALOCEAN_TOKEN="dop_v1_..."
chmod +x scripts/deploy-to-digitalocean.sh
./scripts/deploy-to-digitalocean.sh
```

---

### Option 4: GitHub Actions (Recommended for CI/CD)

**Features:**
- Automatic deployment on push to main
- Manual trigger with environment selection
- Health checks after deployment
- Deployment summary in GitHub UI

**Setup:**

1. **Add secret to GitHub:**
   - Go to: https://github.com/dundas/agentdispatch/settings/secrets/actions
   - Click "New repository secret"
   - Name: `DIGITALOCEAN_TOKEN`
   - Value: Your Digital Ocean API token

2. **Workflow is already configured** at:
   ```
   .github/workflows/deploy-digitalocean.yml
   ```

3. **Auto-deploy:**
   - Every push to `main` branch triggers deployment
   - Status shown in GitHub Actions tab

4. **Manual deploy:**
   - Go to Actions → Deploy to Digital Ocean
   - Click "Run workflow"
   - Select environment (production/staging)

**View deployment status:**
```bash
# In GitHub UI
https://github.com/dundas/agentdispatch/actions

# Via CLI
gh run list --workflow=deploy-digitalocean.yml
gh run watch
```

---

## API Reference

### Digital Ocean App Platform API

**Base URL:** `https://api.digitalocean.com/v2`

**Authentication:**
```bash
Authorization: Bearer dop_v1_xxxxxxxxxxxxx
```

### Common Endpoints

#### List Apps
```bash
GET /apps

# Response
{
  "apps": [
    {
      "id": "app-id-123",
      "spec": {...},
      "live_url": "https://admp-server-xxxxx.ondigitalocean.app"
    }
  ]
}
```

#### Create App
```bash
POST /apps
Content-Type: application/json

{
  "spec": {
    "name": "admp-server",
    "region": "nyc",
    "services": [...]
  }
}
```

#### Update App
```bash
PUT /apps/{app_id}
Content-Type: application/json

{
  "spec": {
    "name": "admp-server",
    ...
  }
}
```

#### Create Deployment
```bash
POST /apps/{app_id}/deployments
Content-Type: application/json

{
  "force_build": true
}
```

#### Get Deployment Status
```bash
GET /apps/{app_id}/deployments/{deployment_id}

# Response
{
  "deployment": {
    "id": "deployment-id",
    "phase": "ACTIVE",  # or BUILDING, DEPLOYING, ERROR
    "progress": {
      "steps_total": 5,
      "steps_successful": 5
    }
  }
}
```

---

## Environment Variables

### Setting Env Vars Programmatically

**In app spec:**
```json
{
  "services": [{
    "envs": [
      {
        "key": "NODE_ENV",
        "value": "production",
        "scope": "RUN_TIME",
        "type": "GENERAL"
      },
      {
        "key": "API_KEY",
        "value": "secret-value",
        "scope": "RUN_TIME",
        "type": "SECRET"  // Encrypted
      }
    ]
  }]
}
```

**Update existing app:**
```javascript
// Get current spec
const app = await api.request('GET', `/apps/${appId}`);
const spec = app.app.spec;

// Modify env vars
spec.services[0].envs.push({
  key: 'NEW_VAR',
  value: 'new_value',
  scope: 'RUN_TIME'
});

// Update app
await api.request('PUT', `/apps/${appId}`, { spec });
```

### Env Var Scopes

- **RUN_TIME**: Available when app is running (most common)
- **BUILD_TIME**: Available during Docker build
- **RUN_AND_BUILD_TIME**: Available in both phases

### Env Var Types

- **GENERAL**: Regular environment variable (visible in UI)
- **SECRET**: Encrypted value (hidden in UI, secure)

---

## Deployment Phases

Apps go through these phases during deployment:

1. **PENDING_BUILD** - Queued for build
2. **BUILDING** - Building Docker image
3. **PENDING_DEPLOY** - Build complete, queued for deploy
4. **DEPLOYING** - Deploying to infrastructure
5. **ACTIVE** - Deployed and running ✅
6. **ERROR** - Deployment failed ❌
7. **CANCELED** - Deployment canceled ⚠️

---

## Examples

### Example 1: Deploy with custom environment

```bash
# Node.js
export DIGITALOCEAN_TOKEN="dop_v1_..."
export APP_ENV="staging"
node scripts/deploy-to-digitalocean.js

# Python
DIGITALOCEAN_TOKEN="dop_v1_..." \
APP_ENV="staging" \
python scripts/deploy-to-digitalocean.py

# Shell
DIGITALOCEAN_TOKEN="dop_v1_..." \
./scripts/deploy-to-digitalocean.sh
```

### Example 2: Update single env var

```javascript
// Node.js
import { updateEnvironmentVariables } from './scripts/deploy-to-digitalocean.js';

await updateEnvironmentVariables('app-id-123', {
  FEATURE_ENABLED: 'true',
  MAX_CONNECTIONS: '1000'
});
```

```python
# Python
from scripts.deploy_to_digitalocean import DigitalOceanAPI

api = DigitalOceanAPI(token)
api.update_env_vars('app-id-123', {
    'FEATURE_ENABLED': 'true',
    'MAX_CONNECTIONS': '1000'
})
```

### Example 3: Deploy specific branch

Modify the spec in the script:
```javascript
const appSpec = {
  // ...
  services: [{
    github: {
      repo: 'dundas/agentdispatch',
      branch: 'develop',  // Changed from 'main'
      deploy_on_push: true
    },
    // ...
  }]
};
```

### Example 4: Blue-green deployment

```javascript
// Create new app with different name
const greenSpec = {
  name: 'admp-server-green',  // New instance
  // ... same config as blue
};

const greenApp = await createApp(greenSpec);
await waitForDeployment(greenApp.id, greenApp.active_deployment.id);

// Test green deployment
// If successful, update DNS or load balancer to point to green
// Then delete blue instance
```

---

## Monitoring & Logs

### View logs programmatically

```bash
# Using doctl
doctl apps logs <app-id> --type BUILD --follow
doctl apps logs <app-id> --type DEPLOY --follow
doctl apps logs <app-id> --type RUN --follow

# Using API
curl -H "Authorization: Bearer $TOKEN" \
  "https://api.digitalocean.com/v2/apps/{app_id}/logs?type=RUN&follow=true"
```

### Health checks

```bash
# After deployment
curl https://your-app-url.ondigitalocean.app/health

# Expected response
{"status":"healthy"}
```

---

## Troubleshooting

### Common Issues

1. **401 Unauthorized**
   - Check token is valid: `doctl auth list`
   - Token needs Read + Write scopes
   - Re-create token if needed

2. **GitHub not authenticated**
   - Connect GitHub once via web UI
   - Go to: https://cloud.digitalocean.com/apps/new
   - Authorize Digital Ocean

3. **Deployment stuck in BUILDING**
   - Check logs: `doctl apps logs <app-id> --type BUILD`
   - Verify Dockerfile builds locally
   - Check for Docker image size limits

4. **Health check failing**
   - Verify `/health` endpoint returns 200
   - Check `http_port` matches app port (8080)
   - Increase `initial_delay_seconds` if app needs more time

---

## Cost Monitoring

```bash
# Using doctl
doctl apps tier list
doctl apps tier instance-size list

# API
curl -H "Authorization: Bearer $TOKEN" \
  https://api.digitalocean.com/v2/apps/tiers
```

**Current pricing:**
- Basic (512MB): $5/month
- Professional (1GB): $12/month
- Professional (2GB): $24/month

---

## Security Best Practices

1. **Never commit tokens to git**
   ```bash
   # Use environment variables
   export DIGITALOCEAN_TOKEN="..."

   # Or use .env file (git-ignored)
   echo "DIGITALOCEAN_TOKEN=dop_v1_..." >> .env.local
   ```

2. **Use SECRET type for sensitive env vars**
   ```javascript
   {
     key: 'DATABASE_URL',
     value: 'postgres://...',
     type: 'SECRET'  // Encrypted
   }
   ```

3. **Rotate tokens regularly**
   - Create new token monthly
   - Delete old tokens

4. **Use GitHub Secrets for CI/CD**
   - Never expose tokens in workflow files
   - Use encrypted secrets only

---

## Next Steps

1. ✅ Choose your deployment method (Node.js/Python/Shell/GitHub Actions)
2. ✅ Get Digital Ocean API token
3. ✅ Connect GitHub (one-time via web UI)
4. ✅ Run deployment script
5. ✅ Monitor deployment status
6. ✅ Verify health endpoint
7. ✅ Set up auto-deploy with GitHub Actions (optional)

**Happy deploying! 🚀**
