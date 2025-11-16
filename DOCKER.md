# Docker Deployment Guide

This guide covers deploying Agent Dispatch using Docker and Docker Compose.

## Prerequisites

1. **Install Docker Desktop**
   - macOS: Download from [docker.com](https://www.docker.com/products/docker-desktop)
   - Linux: Follow [official installation guide](https://docs.docker.com/engine/install/)
   - Windows: Download from [docker.com](https://www.docker.com/products/docker-desktop)

2. **Start Docker Desktop**
   - macOS: Open Docker Desktop from Applications
   - Check status: `docker info`

## Quick Start

### Option 1: Docker Compose (Recommended)

The easiest way to run Agent Dispatch:

```bash
# Start the service
docker-compose up -d

# View logs
docker-compose logs -f

# Check status
docker-compose ps

# Stop the service
docker-compose down
```

The server will be available at:
- API: http://localhost:8080/api
- Docs: http://localhost:8080/docs
- Health: http://localhost:8080/health

### Option 2: Docker Build & Run

Build and run the container manually:

```bash
# Build the image
docker build -t agent-dispatch:latest .

# Run the container
docker run -d \
  --name admp-server \
  -p 8080:8080 \
  -e NODE_ENV=production \
  agent-dispatch:latest

# View logs
docker logs -f admp-server

# Stop the container
docker stop admp-server
docker rm admp-server
```

## Configuration

### Environment Variables

Configure the container using environment variables. Create a `.env` file or set them in `docker-compose.yml`:

```env
# Server
PORT=8080
NODE_ENV=production

# CORS
CORS_ORIGIN=*

# Security
API_KEY_REQUIRED=false
MASTER_API_KEY=

# Heartbeat & Expiry
HEARTBEAT_INTERVAL_MS=60000
HEARTBEAT_TIMEOUT_MS=300000
MESSAGE_TTL_SEC=86400
CLEANUP_INTERVAL_MS=60000

# Limits
MAX_MESSAGE_SIZE_KB=256
MAX_MESSAGES_PER_AGENT=1000
```

### Docker Compose Configuration

Edit `docker-compose.yml` to customize:

```yaml
version: '3.8'

services:
  admp-server:
    build: .
    container_name: admp-server
    ports:
      - "8080:8080"
    environment:
      - NODE_ENV=production
      - PORT=8080
      # Add more environment variables here
    restart: unless-stopped
```

## Health Checks

The container includes built-in health checks:

```bash
# Check health status
docker inspect --format='{{.State.Health.Status}}' admp-server

# View health check logs
docker inspect --format='{{range .State.Health.Log}}{{.Output}}{{end}}' admp-server
```

Health check configuration:
- **Interval**: 30 seconds
- **Timeout**: 3 seconds
- **Start Period**: 5 seconds
- **Retries**: 3

## Networking

### Connecting Multiple Containers

If you need to connect ADMP with other services:

```yaml
version: '3.8'

services:
  admp-server:
    build: .
    networks:
      - agent-network

  webhook-receiver:
    image: your-webhook-receiver
    networks:
      - agent-network
    environment:
      - ADMP_URL=http://admp-server:8080

networks:
  agent-network:
    driver: bridge
```

### Exposing to Host Network

To access from host machine or other containers:

```bash
docker run -d \
  --name admp-server \
  --network host \
  agent-dispatch:latest
```

## Persistence

ADMP currently uses in-memory storage. For production deployments with persistence, you'll need to add a database volume:

```yaml
services:
  admp-server:
    build: .
    volumes:
      - admp-data:/app/data

volumes:
  admp-data:
```

## Debugging

### View Container Logs

```bash
# Follow logs in real-time
docker logs -f admp-server

# View last 100 lines
docker logs --tail 100 admp-server

# View logs with timestamps
docker logs -t admp-server
```

### Execute Commands in Container

```bash
# Open shell in running container
docker exec -it admp-server sh

# Check Node.js version
docker exec admp-server node --version

# Test health endpoint
docker exec admp-server wget -qO- http://localhost:8080/health
```

### Inspect Container

```bash
# View container details
docker inspect admp-server

# View resource usage
docker stats admp-server

# View running processes
docker top admp-server
```

## Production Deployment

### Best Practices

1. **Use Specific Tags**: Don't use `latest` in production
   ```bash
   docker build -t agent-dispatch:1.0.0 .
   ```

2. **Set Resource Limits**:
   ```yaml
   services:
     admp-server:
       deploy:
         resources:
           limits:
             cpus: '1.0'
             memory: 512M
           reservations:
             cpus: '0.5'
             memory: 256M
   ```

3. **Enable Security Features**:
   ```yaml
   environment:
     - NODE_ENV=production
     - API_KEY_REQUIRED=true
     - MASTER_API_KEY=${MASTER_API_KEY}
   ```

4. **Use HTTPS with Reverse Proxy**:
   ```yaml
   services:
     nginx:
       image: nginx:alpine
       ports:
         - "443:443"
       volumes:
         - ./nginx.conf:/etc/nginx/nginx.conf
         - ./ssl:/etc/nginx/ssl
   ```

### Multi-Stage Build (Optimized)

For smaller production images, use multi-stage builds:

```dockerfile
# Build stage
FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

# Production stage
FROM node:18-alpine
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY src/ ./src/
COPY openapi.yaml ./
EXPOSE 8080
CMD ["node", "src/server.js"]
```

## Monitoring

### Container Metrics

```bash
# Real-time resource usage
docker stats admp-server

# Export metrics (for Prometheus)
docker inspect admp-server | jq '.[0].State'
```

### Health Check Endpoints

- **Health**: GET http://localhost:8080/health
- **Stats**: GET http://localhost:8080/api/stats
- **Metrics**: Structured logs (JSON) via `docker logs`

## Troubleshooting

### Container Won't Start

```bash
# Check logs for errors
docker logs admp-server

# Verify port is available
lsof -i :8080

# Check Docker daemon
docker info
```

### Health Check Failing

```bash
# Test health endpoint manually
docker exec admp-server wget -qO- http://localhost:8080/health

# Check container logs
docker logs --tail 50 admp-server
```

### Port Already in Use

```bash
# Find process using port
lsof -i :8080

# Use different port
docker run -p 8081:8080 agent-dispatch:latest
```

## CI/CD Integration

### GitHub Actions

```yaml
name: Docker Build

on:
  push:
    branches: [ main ]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Build Docker image
        run: docker build -t agent-dispatch:${{ github.sha }} .

      - name: Run tests
        run: docker run agent-dispatch:${{ github.sha }} npm test

      - name: Push to registry
        run: |
          echo ${{ secrets.DOCKER_PASSWORD }} | docker login -u ${{ secrets.DOCKER_USERNAME }} --password-stdin
          docker tag agent-dispatch:${{ github.sha }} yourusername/agent-dispatch:latest
          docker push yourusername/agent-dispatch:latest
```

## Cleanup

```bash
# Stop and remove container
docker stop admp-server
docker rm admp-server

# Remove image
docker rmi agent-dispatch:latest

# Clean up all unused containers, networks, images
docker system prune -a
```

## Next Steps

- Review [README.md](./README.md) for API documentation
- Check [openapi.yaml](./openapi.yaml) for API specification
- Visit http://localhost:8080/docs for interactive API documentation
