#!/bin/bash

# Programmatic Digital Ocean App Platform Deployment (Bash)
#
# This script uses curl and jq to interact with the Digital Ocean API
#
# Usage:
#   export DIGITALOCEAN_TOKEN="dop_v1_..."
#   ./scripts/deploy-to-digitalocean.sh

set -e

# Check for required tools
command -v jq >/dev/null 2>&1 || { echo "Error: jq is required. Install with: brew install jq"; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "Error: curl is required"; exit 1; }

# Check for token
if [ -z "$DIGITALOCEAN_TOKEN" ]; then
  echo "Error: DIGITALOCEAN_TOKEN environment variable not set"
  echo "Get a token from: https://cloud.digitalocean.com/account/api/tokens"
  exit 1
fi

API_BASE="https://api.digitalocean.com/v2"
APP_NAME="admp-server"

# Helper: Make API request
api_request() {
  local method=$1
  local path=$2
  local data=$3

  if [ -n "$data" ]; then
    curl -s -X "$method" \
      -H "Authorization: Bearer $DIGITALOCEAN_TOKEN" \
      -H "Content-Type: application/json" \
      -d "$data" \
      "${API_BASE}${path}"
  else
    curl -s -X "$method" \
      -H "Authorization: Bearer $DIGITALOCEAN_TOKEN" \
      -H "Content-Type: application/json" \
      "${API_BASE}${path}"
  fi
}

# 1. List apps
list_apps() {
  api_request "GET" "/apps" | jq -r '.apps'
}

# 2. Get app by name
get_app_by_name() {
  local name=$1
  list_apps | jq -r ".[] | select(.spec.name == \"$name\")"
}

# 3. Create app
create_app() {
  local spec=$1
  echo "🚀 Creating app: $APP_NAME..."
  api_request "POST" "/apps" "$spec"
}

# 4. Update app
update_app() {
  local app_id=$1
  local spec=$2
  echo "🔄 Updating app $app_id..."
  api_request "PUT" "/apps/$app_id" "$spec"
}

# 5. Create deployment
create_deployment() {
  local app_id=$1
  local force_rebuild=${2:-false}
  echo "🏗️  Creating deployment for app $app_id..."
  api_request "POST" "/apps/$app_id/deployments" "{\"force_build\": $force_rebuild}"
}

# 6. Get deployment status
get_deployment() {
  local app_id=$1
  local deployment_id=$2
  api_request "GET" "/apps/$app_id/deployments/$deployment_id"
}

# 7. Wait for deployment
wait_for_deployment() {
  local app_id=$1
  local deployment_id=$2
  local max_wait=${3:-600}

  echo "⏳ Waiting for deployment to complete..."
  local start_time=$(date +%s)

  while true; do
    local deployment=$(get_deployment "$app_id" "$deployment_id")
    local phase=$(echo "$deployment" | jq -r '.deployment.phase')
    local steps_complete=$(echo "$deployment" | jq -r '.deployment.progress.steps_successful // 0')
    local steps_total=$(echo "$deployment" | jq -r '.deployment.progress.steps_total // 0')

    echo "   Status: $phase ($steps_complete/$steps_total steps)"

    if [ "$phase" = "ACTIVE" ]; then
      echo "✅ Deployment successful!"
      return 0
    fi

    if [ "$phase" = "ERROR" ] || [ "$phase" = "CANCELED" ]; then
      echo "❌ Deployment failed with phase: $phase"
      return 1
    fi

    local elapsed=$(($(date +%s) - start_time))
    if [ $elapsed -gt $max_wait ]; then
      echo "❌ Deployment timeout after $max_wait seconds"
      return 1
    fi

    sleep 10
  done
}

# App specification
get_app_spec() {
  cat <<EOF
{
  "spec": {
    "name": "$APP_NAME",
    "region": "nyc",
    "services": [
      {
        "name": "web",
        "github": {
          "repo": "dundas/agentdispatch",
          "branch": "main",
          "deploy_on_push": true
        },
        "dockerfile_path": "Dockerfile",
        "http_port": 8080,
        "health_check": {
          "http_path": "/health",
          "initial_delay_seconds": 5,
          "period_seconds": 30,
          "timeout_seconds": 3,
          "success_threshold": 1,
          "failure_threshold": 3
        },
        "instance_count": 1,
        "instance_size_slug": "basic-xxs",
        "envs": [
          {"key": "NODE_ENV", "value": "production", "scope": "RUN_TIME"},
          {"key": "PORT", "value": "8080", "scope": "RUN_TIME"},
          {"key": "CORS_ORIGIN", "value": "*", "scope": "RUN_TIME"},
          {"key": "HEARTBEAT_INTERVAL_MS", "value": "60000", "scope": "RUN_TIME"},
          {"key": "HEARTBEAT_TIMEOUT_MS", "value": "300000", "scope": "RUN_TIME"},
          {"key": "MESSAGE_TTL_SEC", "value": "86400", "scope": "RUN_TIME"},
          {"key": "MAX_MESSAGE_SIZE_KB", "value": "256", "scope": "RUN_TIME"},
          {"key": "MAX_MESSAGES_PER_AGENT", "value": "1000", "scope": "RUN_TIME"}
        ],
        "routes": [
          {"path": "/"}
        ]
      }
    ]
  }
}
EOF
}

# Main
main() {
  echo "📋 Checking for existing app..."
  local app=$(get_app_by_name "$APP_NAME")

  if [ -n "$app" ] && [ "$app" != "null" ]; then
    local app_id=$(echo "$app" | jq -r '.id')
    local live_url=$(echo "$app" | jq -r '.live_url // "N/A"')

    echo "✅ App \"$APP_NAME\" already exists (ID: $app_id)"
    echo "   Live URL: $live_url"

    # Update app
    echo ""
    echo "🔄 Updating app configuration..."
    local spec=$(get_app_spec)
    app=$(update_app "$app_id" "$spec")

    # Create deployment
    local deployment=$(create_deployment "$app_id" "true")
    local deployment_id=$(echo "$deployment" | jq -r '.deployment.id')
    echo "   Deployment ID: $deployment_id"

    # Wait for deployment
    wait_for_deployment "$app_id" "$deployment_id"

  else
    echo "🆕 Creating new app \"$APP_NAME\"..."
    local spec=$(get_app_spec)
    app=$(create_app "$spec")
    local app_id=$(echo "$app" | jq -r '.app.id')
    echo "   App ID: $app_id"

    # Wait for initial deployment
    local active_deployment_id=$(echo "$app" | jq -r '.app.active_deployment.id // empty')
    if [ -n "$active_deployment_id" ]; then
      wait_for_deployment "$app_id" "$active_deployment_id"
    fi
  fi

  local final_url=$(echo "$app" | jq -r '.app.live_url // .app.default_ingress // "Building..."')
  local final_id=$(echo "$app" | jq -r '.app.id')

  echo ""
  echo "🎉 Deployment complete!"
  echo "   App URL: $final_url"
  echo "   Dashboard: https://cloud.digitalocean.com/apps/$final_id"
}

main
