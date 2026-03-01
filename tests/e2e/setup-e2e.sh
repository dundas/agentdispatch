#!/bin/bash
# Setup script for E2E tests
# Run before executing E2E test suite

set -e

echo "🔧 Setting up ADMP E2E test environment..."

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Check if server is running
check_server() {
    echo -n "Checking if ADMP server is running... "
    if curl -s http://localhost:3008/health > /dev/null 2>&1; then
        echo -e "${GREEN}✓${NC}"
        return 0
    else
        echo -e "${RED}✗${NC}"
        return 1
    fi
}

# Check if mech-storage is configured
check_mech_storage() {
    echo -n "Checking Mech Storage configuration... "
    if [ -z "$MECH_STORAGE_BASE_URL" ] || [ -z "$MECH_STORAGE_API_KEY" ]; then
        echo -e "${YELLOW}⚠${NC}"
        echo "  Warning: Mech Storage not configured. Will use in-memory storage."
        export STORAGE_BACKEND=memory
        return 1
    else
        echo -e "${GREEN}✓${NC}"
        return 0
    fi
}

# Setup database tables
setup_tables() {
    echo "Setting up database tables..."
    if [ "$STORAGE_BACKEND" != "memory" ]; then
        npm run setup || {
            echo -e "${RED}Failed to setup tables${NC}"
            exit 1
        }
    fi
    echo -e "${GREEN}✓ Tables ready${NC}"
}

# Generate test keypairs
generate_keypairs() {
    echo "Generating test Ed25519 keypairs..."
    
    mkdir -p tests/e2e/.keys
    
    # Generate keypair for sender
    if [ ! -f "tests/e2e/.keys/sender-private.pem" ]; then
        openssl genpkey -algorithm Ed25519 -out tests/e2e/.keys/sender-private.pem 2>/dev/null
        openssl pkey -in tests/e2e/.keys/sender-private.pem -pubout -out tests/e2e/.keys/sender-public.pem 2>/dev/null
        echo -e "${GREEN}✓ Sender keypair generated${NC}"
    else
        echo -e "${YELLOW}⚠ Using existing sender keypair${NC}"
    fi
    
    # Generate keypair for recipient
    if [ ! -f "tests/e2e/.keys/recipient-private.pem" ]; then
        openssl genpkey -algorithm Ed25519 -out tests/e2e/.keys/recipient-private.pem 2>/dev/null
        openssl pkey -in tests/e2e/.keys/recipient-private.pem -pubout -out tests/e2e/.keys/recipient-public.pem 2>/dev/null
        echo -e "${GREEN}✓ Recipient keypair generated${NC}"
    else
        echo -e "${YELLOW}⚠ Using existing recipient keypair${NC}"
    fi
}

# Create test environment file
create_test_env() {
    if [ ! -f ".env.test" ]; then
        echo "Creating .env.test..."
        cat > .env.test << 'EOF'
# ADMP E2E Test Environment

# Server Configuration
PORT=3008
NODE_ENV=test

# Mech Storage (or use memory backend)
STORAGE_BACKEND=memory
# MECH_STORAGE_BASE_URL=https://storage.mechdna.net
# MECH_STORAGE_API_KEY=key_test_xxx...
# MECH_STORAGE_APP_ID=app_test_xxx...

# Mailgun (test domain)
MAILGUN_API_KEY=test-key
MAILGUN_DOMAIN=agents.test.example.com
MAILGUN_SIGNING_KEY=test-signing-key

# Cloudflare Worker
CLOUDFLARE_WORKER_SECRET=test-shared-secret

# Worker Configuration
WORKER_POLL_INTERVAL=1000

# MCP Configuration
AGENT_ID=test
AGENT_DOMAIN=test.example.com
EOF
        echo -e "${GREEN}✓ Created .env.test${NC}"
    else
        echo -e "${YELLOW}⚠ Using existing .env.test${NC}"
    fi
}

# Main setup flow
main() {
    echo ""
    echo "╔════════════════════════════════════════════════════════════╗"
    echo "║         ADMP E2E Test Environment Setup                    ║"
    echo "╚════════════════════════════════════════════════════════════╝"
    echo ""
    
    # Load environment
    if [ -f ".env.test" ]; then
        export $(cat .env.test | grep -v '^#' | xargs)
    fi
    
    # Check dependencies
    echo "Checking dependencies..."
    
    if ! command -v bun &> /dev/null; then
        echo -e "${RED}✗ Bun not found. Please install: https://bun.sh${NC}"
        exit 1
    fi
    echo -e "${GREEN}✓ Bun installed${NC}"
    
    if ! command -v node &> /dev/null; then
        echo -e "${RED}✗ Node.js not found${NC}"
        exit 1
    fi
    echo -e "${GREEN}✓ Node.js installed${NC}"
    
    if ! command -v openssl &> /dev/null; then
        echo -e "${YELLOW}⚠ OpenSSL not found. Skipping keypair generation.${NC}"
    else
        echo -e "${GREEN}✓ OpenSSL installed${NC}"
    fi
    
    echo ""
    
    # Setup steps
    create_test_env
    check_mech_storage
    
    if ! check_server; then
        echo ""
        echo -e "${YELLOW}Server not running. Please start it first:${NC}"
        echo "  Terminal 1: npm run dev"
        echo "  Terminal 2: bun test tests/e2e/e2e.test.js"
        echo ""
        exit 1
    fi
    
    if command -v openssl &> /dev/null; then
        generate_keypairs
    fi
    
    echo ""
    echo "╔════════════════════════════════════════════════════════════╗"
    echo "║                    ✅ Setup Complete!                      ║"
    echo "╚════════════════════════════════════════════════════════════╝"
    echo ""
    echo "Run tests:"
    echo "  bun test tests/e2e/e2e.test.js"
    echo ""
    echo "Run specific suite:"
    echo "  bun test tests/e2e/e2e.test.js --test-name-pattern 'Suite 1'"
    echo ""
    echo "Run full lifecycle test:"
    echo "  bun test tests/e2e/e2e.test.js --test-name-pattern '7.1'"
    echo ""
}

main
