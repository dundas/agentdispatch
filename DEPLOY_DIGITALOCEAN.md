# Digital Ocean Deployment Guide

This guide covers deploying Agent Dispatch to Digital Ocean using various methods.

## Table of Contents

1. [App Platform (Recommended - Easiest)](#option-1-app-platform-recommended)
2. [Container Registry + Droplet](#option-2-container-registry--droplet)
3. [Kubernetes (DOKS)](#option-3-kubernetes-doks)
4. [Cost Comparison](#cost-comparison)

---

## Prerequisites

1. **Digital Ocean Account**
   - Sign up at https://www.digitalocean.com
   - Add payment method

2. **Install doctl CLI** (Optional but recommended)
   ```bash
   # macOS
   brew install doctl

   # Authenticate
   doctl auth init
   ```

3. **Docker installed locally**
   - For building and pushing images

---

## Option 1: App Platform (Recommended)

**Best for:** Quick deployment, managed hosting, automatic scaling

App Platform is Digital Ocean's managed platform (similar to Heroku). It handles everything automatically.

### Method A: Deploy from GitHub (Easiest)

1. **Push your code to GitHub** (already done ✓)

2. **Create App via Web UI**
   - Go to https://cloud.digitalocean.com/apps
   - Click "Create App"
   - Select "GitHub" as source
   - Authorize Digital Ocean to access your repository
   - Select `dundas/agentdispatch` repository
   - Select branch: `main` (or your feature branch)
   - Auto-detect will find your Dockerfile

3. **Configure the App**
   - **Name:** `admp-server`
   - **Region:** Choose closest to your users (e.g., `nyc3`, `sfo3`, `lon1`)
   - **Plan:** Basic (512MB RAM, $5/month) or Professional ($12/month)
   - **Environment Variables:** Add if needed
     ```
     NODE_ENV=production
     PORT=8080
     ```

4. **Configure HTTP Routes**
   - Port: `8080`
   - HTTP Port: `8080`
   - Health Check Path: `/health`

5. **Deploy**
   - Click "Create Resources"
   - Wait 3-5 minutes for build and deployment
   - You'll get a URL like: `https://admp-server-xxxxx.ondigitalocean.app`

### Method B: Deploy via doctl CLI

```bash
# Create app.yaml configuration
cat > app.yaml <<EOF
name: admp-server
region: nyc3

services:
  - name: web
    github:
      repo: dundas/agentdispatch
      branch: main
      deploy_on_push: true

    dockerfile_path: Dockerfile

    http_port: 8080

    health_check:
      http_path: /health
      initial_delay_seconds: 5
      period_seconds: 30

    instance_count: 1
    instance_size_slug: basic-xxs  # 512MB RAM, $5/month

    envs:
      - key: NODE_ENV
        value: production
      - key: PORT
        value: "8080"

    routes:
      - path: /
EOF

# Create the app
doctl apps create --spec app.yaml

# Get app ID and monitor deployment
doctl apps list
doctl apps logs <app-id> --follow
```

### App Platform Features

- ✅ **Automatic HTTPS** with SSL certificate
- ✅ **Auto-scaling** based on traffic
- ✅ **Zero-downtime deployments**
- ✅ **Health checks** and auto-restart
- ✅ **Built-in monitoring** and logs
- ✅ **Auto-deploy on git push**

### Update/Redeploy

```bash
# Via CLI
doctl apps create-deployment <app-id>

# Or just push to GitHub - auto-deploys
git push origin main
```

---

## Option 2: Container Registry + Droplet

**Best for:** More control, lower cost for single instance, custom configuration

### Step 1: Create Container Registry

```bash
# Via CLI
doctl registry create admp-registry

# Or via Web UI
# https://cloud.digitalocean.com/registry
```

### Step 2: Build and Push Image

```bash
# Login to registry
doctl registry login

# Build image
docker build -t agent-dispatch:latest .

# Tag for Digital Ocean registry
docker tag agent-dispatch:latest \
  registry.digitalocean.com/admp-registry/agent-dispatch:latest

# Push to registry
docker push registry.digitalocean.com/admp-registry/agent-dispatch:latest
```

### Step 3: Create Droplet

```bash
# Create a Docker-ready droplet
doctl compute droplet create admp-server \
  --image docker-20-04 \
  --size s-1vcpu-1gb \
  --region nyc3 \
  --ssh-keys $(doctl compute ssh-key list --format ID --no-header) \
  --wait

# Get droplet IP
doctl compute droplet list
```

### Step 4: Deploy Container on Droplet

```bash
# SSH into droplet
ssh root@<droplet-ip>

# Login to Digital Ocean registry
doctl registry login

# Pull and run container
docker pull registry.digitalocean.com/admp-registry/agent-dispatch:latest

docker run -d \
  --name admp-server \
  --restart unless-stopped \
  -p 80:8080 \
  -e NODE_ENV=production \
  registry.digitalocean.com/admp-registry/agent-dispatch:latest

# Verify it's running
curl http://localhost/health
```

### Step 5: Configure Firewall

```bash
# Create firewall (allow HTTP/HTTPS)
doctl compute firewall create \
  --name admp-firewall \
  --inbound-rules "protocol:tcp,ports:80,sources:addresses:0.0.0.0/0,sources:addresses:::/0 protocol:tcp,ports:443,sources:addresses:0.0.0.0/0,sources:addresses:::/0 protocol:tcp,ports:22,sources:addresses:0.0.0.0/0" \
  --outbound-rules "protocol:tcp,ports:all,destinations:addresses:0.0.0.0/0,destinations:addresses:::/0 protocol:udp,ports:all,destinations:addresses:0.0.0.0/0,destinations:addresses:::/0" \
  --droplet-ids <droplet-id>
```

### Step 6: Add SSL with Nginx (Optional)

```bash
# Install Nginx and Certbot
apt update
apt install -y nginx certbot python3-certbot-nginx

# Configure Nginx reverse proxy
cat > /etc/nginx/sites-available/admp <<EOF
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

ln -s /etc/nginx/sites-available/admp /etc/nginx/sites-enabled/
nginx -t
systemctl restart nginx

# Get SSL certificate
certbot --nginx -d your-domain.com
```

### Update Deployment

```bash
# Build and push new image
docker build -t agent-dispatch:latest .
docker tag agent-dispatch:latest \
  registry.digitalocean.com/admp-registry/agent-dispatch:latest
docker push registry.digitalocean.com/admp-registry/agent-dispatch:latest

# SSH into droplet
ssh root@<droplet-ip>

# Pull and restart
docker pull registry.digitalocean.com/admp-registry/agent-dispatch:latest
docker stop admp-server
docker rm admp-server
docker run -d \
  --name admp-server \
  --restart unless-stopped \
  -p 80:8080 \
  -e NODE_ENV=production \
  registry.digitalocean.com/admp-registry/agent-dispatch:latest
```

---

## Option 3: Kubernetes (DOKS)

**Best for:** High availability, auto-scaling, multiple environments

### Step 1: Create Kubernetes Cluster

```bash
# Create cluster
doctl kubernetes cluster create admp-cluster \
  --region nyc3 \
  --version 1.28.2-do.0 \
  --node-pool "name=worker-pool;size=s-2vcpu-2gb;count=2" \
  --wait

# Get kubeconfig
doctl kubernetes cluster kubeconfig save admp-cluster
```

### Step 2: Push Image to Registry

```bash
# Same as Option 2 - build and push to Digital Ocean registry
doctl registry login
docker build -t agent-dispatch:latest .
docker tag agent-dispatch:latest \
  registry.digitalocean.com/admp-registry/agent-dispatch:latest
docker push registry.digitalocean.com/admp-registry/agent-dispatch:latest
```

### Step 3: Create Kubernetes Manifests

**deployment.yaml**
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: admp-server
  labels:
    app: admp-server
spec:
  replicas: 2
  selector:
    matchLabels:
      app: admp-server
  template:
    metadata:
      labels:
        app: admp-server
    spec:
      containers:
      - name: admp-server
        image: registry.digitalocean.com/admp-registry/agent-dispatch:latest
        ports:
        - containerPort: 8080
        env:
        - name: NODE_ENV
          value: "production"
        - name: PORT
          value: "8080"
        resources:
          requests:
            memory: "256Mi"
            cpu: "250m"
          limits:
            memory: "512Mi"
            cpu: "500m"
        livenessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 30
        readinessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 10
```

**service.yaml**
```yaml
apiVersion: v1
kind: Service
metadata:
  name: admp-service
spec:
  type: LoadBalancer
  selector:
    app: admp-server
  ports:
    - protocol: TCP
      port: 80
      targetPort: 8080
```

### Step 4: Deploy

```bash
# Apply manifests
kubectl apply -f deployment.yaml
kubectl apply -f service.yaml

# Wait for load balancer IP
kubectl get service admp-service --watch

# Get external IP
kubectl get service admp-service
```

### Step 5: Update Deployment

```bash
# Build and push new image
docker build -t agent-dispatch:latest .
docker tag agent-dispatch:latest \
  registry.digitalocean.com/admp-registry/agent-dispatch:v1.0.1
docker push registry.digitalocean.com/admp-registry/agent-dispatch:v1.0.1

# Update deployment
kubectl set image deployment/admp-server \
  admp-server=registry.digitalocean.com/admp-registry/agent-dispatch:v1.0.1

# Or use rolling update
kubectl rollout status deployment/admp-server
```

---

## Cost Comparison

### App Platform
- **Basic (512MB):** $5/month
- **Professional (1GB):** $12/month
- **Includes:** HTTPS, auto-scaling, monitoring, logs
- **Best for:** Production with low-medium traffic

### Droplet + Container Registry
- **Droplet (1GB):** $6/month
- **Container Registry:** $5/month (1 repository)
- **Total:** $11/month
- **Best for:** Development, testing, low traffic

### Kubernetes (DOKS)
- **Cluster:** Free (control plane)
- **Worker Nodes (2x 2GB):** $24/month
- **Container Registry:** $5/month
- **Load Balancer:** $12/month
- **Total:** $41/month
- **Best for:** High availability, multiple services, production scale

---

## Recommended Approach

**For Quick Start & Production:**
→ **Option 1: App Platform** ($5-12/month)
- Easiest setup (5 minutes)
- Automatic HTTPS and SSL
- Auto-scaling built-in
- Zero-downtime deployments
- Auto-deploy on git push

**For Cost-Conscious Development:**
→ **Option 2: Droplet + Registry** ($11/month)
- More control
- Manual scaling
- Requires SSL setup

**For Enterprise/Scale:**
→ **Option 3: Kubernetes** ($41+/month)
- High availability
- Auto-scaling
- Multi-environment support

---

## Environment Variables

For production deployments, configure these environment variables:

```bash
# Required
NODE_ENV=production
PORT=8080

# Optional - CORS
CORS_ORIGIN=https://your-frontend-domain.com

# Optional - Security
API_KEY_REQUIRED=true
MASTER_API_KEY=your-secure-key-here

# Optional - Heartbeat & Timeouts
HEARTBEAT_INTERVAL_MS=60000
HEARTBEAT_TIMEOUT_MS=300000
MESSAGE_TTL_SEC=86400
CLEANUP_INTERVAL_MS=60000

# Optional - Limits
MAX_MESSAGE_SIZE_KB=256
MAX_MESSAGES_PER_AGENT=1000
```

---

## Monitoring & Logs

### App Platform
```bash
# View logs
doctl apps logs <app-id> --follow

# View metrics in web UI
# https://cloud.digitalocean.com/apps/<app-id>/metrics
```

### Droplet
```bash
# View container logs
ssh root@<droplet-ip>
docker logs -f admp-server

# View resource usage
docker stats admp-server
```

### Kubernetes
```bash
# View logs
kubectl logs -f deployment/admp-server

# View pod status
kubectl get pods
kubectl describe pod <pod-name>

# View metrics
kubectl top pods
kubectl top nodes
```

---

## Custom Domain Setup

### App Platform
1. Go to app settings → Domains
2. Add your domain (e.g., `api.yourdomain.com`)
3. Add CNAME record in your DNS:
   ```
   api.yourdomain.com → admp-server-xxxxx.ondigitalocean.app
   ```

### Droplet
1. Point A record to droplet IP:
   ```
   api.yourdomain.com → <droplet-ip>
   ```
2. Configure SSL with Certbot (see Option 2, Step 6)

### Kubernetes
1. Get load balancer IP: `kubectl get service admp-service`
2. Point A record to load balancer IP:
   ```
   api.yourdomain.com → <load-balancer-ip>
   ```

---

## Backup & Recovery

### App Platform
- Automatic backups managed by Digital Ocean
- Rollback to previous deployment in UI

### Droplet
```bash
# Create snapshot
doctl compute droplet-action snapshot <droplet-id> --snapshot-name admp-backup

# Create automated backups (weekly)
doctl compute droplet create admp-server \
  --enable-backups \
  # ... other options
```

### Kubernetes
```bash
# Use Velero for backups
# https://velero.io/docs/

# Or export manifests
kubectl get deployment admp-server -o yaml > backup-deployment.yaml
kubectl get service admp-service -o yaml > backup-service.yaml
```

---

## Next Steps

1. **Choose deployment method** (App Platform recommended)
2. **Set up monitoring** (built-in for App Platform)
3. **Configure custom domain** and SSL
4. **Set environment variables** for production
5. **Test health endpoint:** `curl https://your-domain.com/health`
6. **Test API docs:** `https://your-domain.com/docs`
7. **Run test suite** against production: `./test-docker-api.sh`

---

## Troubleshooting

### App Platform not starting
- Check logs: `doctl apps logs <app-id>`
- Verify Dockerfile builds locally
- Check health check path is `/health`

### Droplet container won't start
- Check logs: `docker logs admp-server`
- Verify port 8080 is exposed: `docker ps`
- Check firewall rules: `doctl compute firewall list`

### Kubernetes pods crashing
- Check logs: `kubectl logs <pod-name>`
- Check resource limits: `kubectl describe pod <pod-name>`
- Verify image pull: `kubectl get events`

---

## Support

For deployment issues:
- Digital Ocean Docs: https://docs.digitalocean.com
- ADMP Issues: https://github.com/dundas/agentdispatch/issues
- Community: https://www.digitalocean.com/community
