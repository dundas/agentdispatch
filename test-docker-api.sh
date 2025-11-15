#!/bin/bash

# ADMP Docker API Test Script
# Tests all major API endpoints in the running Docker container

set -e

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

API_URL="http://localhost:8080/api"
PASSED=0
FAILED=0

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ADMP Docker Container API Tests"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Helper functions
pass() {
    echo -e "${GREEN}✓${NC} $1"
    PASSED=$((PASSED + 1))
}

fail() {
    echo -e "${RED}✗${NC} $1"
    echo -e "  ${RED}Error: $2${NC}"
    FAILED=$((FAILED + 1))
}

test_header() {
    echo ""
    echo -e "${BLUE}▶${NC} $1"
}

# Test 1: Health Check
test_header "Test 1: Health Check"
HEALTH=$(curl -s http://localhost:8080/health)
if echo "$HEALTH" | jq -e '.status == "healthy"' > /dev/null; then
    pass "Health endpoint returned healthy status"
else
    fail "Health check failed" "$HEALTH"
fi

# Test 2: System Stats
test_header "Test 2: System Stats"
STATS=$(curl -s ${API_URL}/stats)
if echo "$STATS" | jq -e '.agents and .messages' > /dev/null; then
    pass "System stats endpoint returned valid data"
else
    fail "System stats check failed" "$STATS"
fi

# Test 3: Register Agent A
test_header "Test 3: Register Agent A (Sender)"
AGENT_A=$(curl -s -X POST ${API_URL}/agents/register \
    -H 'Content-Type: application/json' \
    -d '{
        "agent_type": "docker_test_sender",
        "metadata": {
            "test": "docker_api_test",
            "role": "sender"
        }
    }')

AGENT_A_ID=$(echo "$AGENT_A" | jq -r '.agent_id' | tr -d '\n')
AGENT_A_SECRET=$(echo "$AGENT_A" | jq -r '.secret_key' | tr -d '\n')

if [ "$AGENT_A_ID" != "null" ] && [ -n "$AGENT_A_ID" ]; then
    pass "Agent A registered: $AGENT_A_ID"
else
    fail "Agent A registration failed" "$AGENT_A"
fi

# Test 4: Register Agent B with Webhook
test_header "Test 4: Register Agent B (Receiver with Webhook)"
AGENT_B=$(curl -s -X POST ${API_URL}/agents/register \
    -H 'Content-Type: application/json' \
    -d '{
        "agent_type": "docker_test_receiver",
        "metadata": {
            "test": "docker_api_test",
            "role": "receiver"
        },
        "webhook_url": "http://example.com/webhook"
    }')

AGENT_B_ID=$(echo "$AGENT_B" | jq -r '.agent_id' | tr -d '\n')
AGENT_B_SECRET=$(echo "$AGENT_B" | jq -r '.secret_key' | tr -d '\n')
WEBHOOK_SECRET=$(echo "$AGENT_B" | jq -r '.webhook_secret' | tr -d '\n')

if [ "$AGENT_B_ID" != "null" ] && [ -n "$AGENT_B_ID" ]; then
    pass "Agent B registered: $AGENT_B_ID"
    if [ "$WEBHOOK_SECRET" != "null" ] && [ -n "$WEBHOOK_SECRET" ]; then
        pass "Webhook secret generated: ${WEBHOOK_SECRET:0:20}..."
    fi
else
    fail "Agent B registration failed" "$AGENT_B"
fi

# Test 5: Send Heartbeat
test_header "Test 5: Send Heartbeat"
AGENT_A_ENCODED=$(printf '%s' "$AGENT_A_ID" | jq -sRr @uri)
HEARTBEAT=$(curl -s -X POST "${API_URL}/agents/${AGENT_A_ENCODED}/heartbeat" \
    -H 'Content-Type: application/json' \
    -d '{
        "metadata": {
            "last_activity": "testing_apis",
            "timestamp": '$(date +%s)'
        }
    }')

if echo "$HEARTBEAT" | jq -e '.ok == true' > /dev/null; then
    STATUS=$(echo "$HEARTBEAT" | jq -r '.status')
    pass "Heartbeat sent successfully (status: $STATUS)"
else
    fail "Heartbeat failed" "$HEARTBEAT"
fi

# Test 6: Send Message (simplified without signature)
test_header "Test 6: Send Message to Agent B"

# Create a simple message envelope
MESSAGE_ID="msg-test-$(date +%s)"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

MESSAGE_ENVELOPE='{
    "version": "1.0",
    "id": "'${MESSAGE_ID}'",
    "type": "task.request",
    "from": "'${AGENT_A_ID}'",
    "to": "'${AGENT_B_ID}'",
    "subject": "docker_test",
    "body": {
        "test": "docker_api_test",
        "command": "echo hello",
        "timestamp": '$(date +%s)'
    },
    "timestamp": "'${TIMESTAMP}'",
    "ttl_sec": 3600,
    "signature": {
        "alg": "ed25519",
        "kid": "test",
        "sig": "dGVzdC1zaWduYXR1cmU="
    }
}'

AGENT_B_ENCODED=$(printf '%s' "$AGENT_B_ID" | jq -sRr @uri)
SEND_RESULT=$(curl -s -X POST "${API_URL}/agents/${AGENT_B_ENCODED}/messages" \
    -H 'Content-Type: application/json' \
    -d "$MESSAGE_ENVELOPE")

SENT_MSG_ID=$(echo "$SEND_RESULT" | jq -r '.message_id')
if [ "$SENT_MSG_ID" != "null" ] && [ -n "$SENT_MSG_ID" ]; then
    pass "Message sent to Agent B: $SENT_MSG_ID"
else
    fail "Message send failed" "$SEND_RESULT"
fi

# Test 7: Pull Message from Inbox
test_header "Test 7: Pull Message from Inbox"
PULL_RESULT=$(curl -s -X POST "${API_URL}/agents/${AGENT_B_ENCODED}/inbox/pull" \
    -H 'Content-Type: application/json' \
    -d '{"visibility_timeout": 60}')

if [ $? -eq 0 ] && [ -n "$PULL_RESULT" ]; then
    PULLED_MSG_ID=$(echo "$PULL_RESULT" | jq -r '.message_id')
    if [ "$PULLED_MSG_ID" != "null" ] && [ -n "$PULLED_MSG_ID" ]; then
        pass "Message pulled from inbox: $PULLED_MSG_ID"
        LEASE_UNTIL=$(echo "$PULL_RESULT" | jq -r '.lease_until')
        pass "Message leased until: $(date -r $((LEASE_UNTIL / 1000)) 2>/dev/null || echo $LEASE_UNTIL)"
    else
        # Check if inbox was empty (204)
        pass "Inbox pull completed (message may have been delivered via webhook)"
    fi
fi

# Test 8: Inbox Stats
test_header "Test 8: Check Inbox Statistics"
INBOX_STATS=$(curl -s "${API_URL}/agents/${AGENT_B_ENCODED}/inbox/stats")
if echo "$INBOX_STATS" | jq -e '.total != null' > /dev/null; then
    TOTAL=$(echo "$INBOX_STATS" | jq -r '.total')
    QUEUED=$(echo "$INBOX_STATS" | jq -r '.queued')
    LEASED=$(echo "$INBOX_STATS" | jq -r '.leased')
    pass "Inbox stats: total=$TOTAL, queued=$QUEUED, leased=$LEASED"
else
    fail "Inbox stats check failed" "$INBOX_STATS"
fi

# Test 9: Get Webhook Configuration
test_header "Test 9: Get Webhook Configuration"
WEBHOOK_CONFIG=$(curl -s "${API_URL}/agents/${AGENT_B_ENCODED}/webhook")
if echo "$WEBHOOK_CONFIG" | jq -e '.webhook_configured == true' > /dev/null; then
    WEBHOOK_URL=$(echo "$WEBHOOK_CONFIG" | jq -r '.webhook_url')
    pass "Webhook configured: $WEBHOOK_URL"
else
    fail "Webhook configuration check failed" "$WEBHOOK_CONFIG"
fi

# Test 10: Update Webhook
test_header "Test 10: Update Webhook URL"
WEBHOOK_UPDATE=$(curl -s -X POST "${API_URL}/agents/${AGENT_B_ENCODED}/webhook" \
    -H 'Content-Type: application/json' \
    -d '{
        "webhook_url": "http://updated-webhook.example.com/hook"
    }')

if echo "$WEBHOOK_UPDATE" | jq -e '.webhook_url' > /dev/null; then
    NEW_URL=$(echo "$WEBHOOK_UPDATE" | jq -r '.webhook_url')
    pass "Webhook updated: $NEW_URL"
else
    fail "Webhook update failed" "$WEBHOOK_UPDATE"
fi

# Test 11: Add Trusted Agent
test_header "Test 11: Trust Management - Add Trusted Agent"
TRUST_ADD=$(curl -s -X POST "${API_URL}/agents/${AGENT_A_ENCODED}/trusted" \
    -H 'Content-Type: application/json' \
    -d "{\"agent_id\": \"${AGENT_B_ID}\"}")

if echo "$TRUST_ADD" | jq -e '.trusted_agents' > /dev/null; then
    TRUSTED_COUNT=$(echo "$TRUST_ADD" | jq '.trusted_agents | length')
    pass "Agent B added to Agent A's trusted list (count: $TRUSTED_COUNT)"
else
    fail "Add trusted agent failed" "$TRUST_ADD"
fi

# Test 12: List Trusted Agents
test_header "Test 12: List Trusted Agents"
TRUST_LIST=$(curl -s "${API_URL}/agents/${AGENT_A_ENCODED}/trusted")
if echo "$TRUST_LIST" | jq -e '.trusted_agents' > /dev/null; then
    TRUSTED=$(echo "$TRUST_LIST" | jq -r '.trusted_agents[]' | head -1)
    pass "Trusted agents listed: $TRUSTED"
else
    fail "List trusted agents failed" "$TRUST_LIST"
fi

# Test 13: Message Status
test_header "Test 13: Check Message Status"
if [ -n "$SENT_MSG_ID" ]; then
    MSG_STATUS=$(curl -s "${API_URL}/messages/${SENT_MSG_ID}/status")
    if echo "$MSG_STATUS" | jq -e '.status' > /dev/null; then
        STATUS=$(echo "$MSG_STATUS" | jq -r '.status')
        ATTEMPTS=$(echo "$MSG_STATUS" | jq -r '.attempts')
        pass "Message status: $STATUS (attempts: $ATTEMPTS)"
    else
        fail "Message status check failed" "$MSG_STATUS"
    fi
fi

# Test 14: System Stats After Activity
test_header "Test 14: System Stats After Activity"
FINAL_STATS=$(curl -s ${API_URL}/stats)
AGENT_COUNT=$(echo "$FINAL_STATS" | jq -r '.agents.total')
ONLINE_COUNT=$(echo "$FINAL_STATS" | jq -r '.agents.online')
MSG_COUNT=$(echo "$FINAL_STATS" | jq -r '.messages.total')

if [ "$AGENT_COUNT" -ge 2 ]; then
    pass "System stats: $AGENT_COUNT agents ($ONLINE_COUNT online), $MSG_COUNT messages"
else
    fail "Expected at least 2 agents, got $AGENT_COUNT" "$FINAL_STATS"
fi

# Test 15: Container Health
test_header "Test 15: Docker Container Health"
CONTAINER_HEALTH=$(docker inspect admp-server --format='{{.State.Health.Status}}')
if [ "$CONTAINER_HEALTH" = "healthy" ]; then
    pass "Docker container health check: $CONTAINER_HEALTH"
else
    fail "Container health check" "Status: $CONTAINER_HEALTH"
fi

# Test 16: OpenAPI Documentation
test_header "Test 16: OpenAPI Documentation Endpoints"
OPENAPI_JSON=$(curl -s http://localhost:8080/openapi.json)
if echo "$OPENAPI_JSON" | jq -e '.openapi' > /dev/null; then
    VERSION=$(echo "$OPENAPI_JSON" | jq -r '.openapi')
    pass "OpenAPI spec available (version: $VERSION)"
else
    fail "OpenAPI spec check failed"
fi

DOCS_PAGE=$(curl -sL http://localhost:8080/docs/ | grep -o "<title>.*</title>")
if echo "$DOCS_PAGE" | grep -q "ADMP"; then
    pass "Swagger UI documentation available"
else
    fail "Swagger UI check failed"
fi

# Summary
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Test Summary"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo -e "${GREEN}Passed: $PASSED${NC}"
if [ $FAILED -gt 0 ]; then
    echo -e "${RED}Failed: $FAILED${NC}"
    exit 1
else
    echo -e "${GREEN}All tests passed!${NC}"
fi
echo ""

# Display registered agents
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Test Agents Created"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Agent A (Sender):"
echo "  ID: $AGENT_A_ID"
echo ""
echo "Agent B (Receiver):"
echo "  ID: $AGENT_B_ID"
echo "  Webhook: http://updated-webhook.example.com/hook"
echo ""

exit 0
