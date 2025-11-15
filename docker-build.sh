#!/bin/bash

# ADMP Docker Build Script
# Builds and optionally runs the Agent Dispatch container

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "🐳 Agent Dispatch - Docker Build Script"
echo "========================================"
echo ""

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo -e "${RED}❌ Docker is not installed${NC}"
    echo "Please install Docker Desktop from https://www.docker.com/products/docker-desktop"
    exit 1
fi

# Check if Docker daemon is running
if ! docker info &> /dev/null; then
    echo -e "${YELLOW}⚠️  Docker daemon is not running${NC}"
    echo ""
    echo "Please start Docker Desktop:"
    echo "  • macOS: Open Docker Desktop from Applications"
    echo "  • Linux: sudo systemctl start docker"
    echo "  • Windows: Start Docker Desktop"
    echo ""
    echo "Then run this script again."
    exit 1
fi

echo -e "${GREEN}✓ Docker is running${NC}"
echo ""

# Get version from package.json
VERSION=$(node -p "require('./package.json').version")
IMAGE_NAME="agent-dispatch"
IMAGE_TAG="${VERSION}"

# Parse command line arguments
BUILD_ONLY=false
RUN_CONTAINER=false
USE_COMPOSE=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --build-only)
            BUILD_ONLY=true
            shift
            ;;
        --run)
            RUN_CONTAINER=true
            shift
            ;;
        --compose)
            USE_COMPOSE=true
            shift
            ;;
        *)
            echo "Unknown option: $1"
            echo "Usage: $0 [--build-only] [--run] [--compose]"
            exit 1
            ;;
    esac
done

if [ "$USE_COMPOSE" = true ]; then
    echo "📦 Building with Docker Compose..."
    echo ""
    docker-compose build
    echo ""
    echo -e "${GREEN}✓ Docker Compose build complete${NC}"
    echo ""
    echo "To start the service:"
    echo "  docker-compose up -d"
    echo ""
    echo "To view logs:"
    echo "  docker-compose logs -f"
    exit 0
fi

# Build the image
echo "🔨 Building Docker image: ${IMAGE_NAME}:${IMAGE_TAG}"
echo ""

docker build \
    --tag "${IMAGE_NAME}:${IMAGE_TAG}" \
    --tag "${IMAGE_NAME}:latest" \
    .

echo ""
echo -e "${GREEN}✓ Docker image built successfully${NC}"
echo ""
echo "Image tags:"
echo "  • ${IMAGE_NAME}:${IMAGE_TAG}"
echo "  • ${IMAGE_NAME}:latest"
echo ""

if [ "$BUILD_ONLY" = true ]; then
    echo "Build complete. Use --run to start the container."
    exit 0
fi

# Stop and remove existing container if running
if docker ps -a | grep -q admp-server; then
    echo "🛑 Stopping existing container..."
    docker stop admp-server 2>/dev/null || true
    docker rm admp-server 2>/dev/null || true
    echo ""
fi

if [ "$RUN_CONTAINER" = true ]; then
    echo "🚀 Starting container..."
    echo ""

    docker run -d \
        --name admp-server \
        -p 8080:8080 \
        -e NODE_ENV=production \
        --restart unless-stopped \
        "${IMAGE_NAME}:latest"

    echo ""
    echo -e "${GREEN}✓ Container started successfully${NC}"
    echo ""
    echo "Container: admp-server"
    echo "Ports:     8080:8080"
    echo ""
    echo "Waiting for server to be ready..."
    sleep 3

    # Check health
    if curl -s http://localhost:8080/health > /dev/null; then
        echo -e "${GREEN}✓ Server is healthy${NC}"
        echo ""
        echo "🎉 Agent Dispatch is running!"
        echo ""
        echo "API Endpoints:"
        echo "  • API:    http://localhost:8080/api"
        echo "  • Docs:   http://localhost:8080/docs"
        echo "  • Health: http://localhost:8080/health"
        echo ""
        echo "Container Management:"
        echo "  • View logs:      docker logs -f admp-server"
        echo "  • Stop container: docker stop admp-server"
        echo "  • Remove:         docker rm admp-server"
        echo ""
    else
        echo -e "${YELLOW}⚠️  Server not responding yet${NC}"
        echo "Check logs with: docker logs admp-server"
    fi
else
    echo "Build complete!"
    echo ""
    echo "To run the container:"
    echo "  $0 --run"
    echo ""
    echo "Or use Docker Compose:"
    echo "  docker-compose up -d"
fi
