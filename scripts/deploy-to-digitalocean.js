#!/usr/bin/env node

/**
 * Programmatic Digital Ocean App Platform Deployment
 *
 * This script demonstrates how to programmatically:
 * - Create a new app
 * - Update environment variables
 * - Deploy updates
 * - Monitor deployment status
 *
 * Usage:
 *   export DIGITALOCEAN_TOKEN="dop_v1_..."
 *   node scripts/deploy-to-digitalocean.js
 */

import https from 'https';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DIGITALOCEAN_TOKEN = process.env.DIGITALOCEAN_TOKEN;
const API_BASE = 'api.digitalocean.com';

if (!DIGITALOCEAN_TOKEN) {
  console.error('Error: DIGITALOCEAN_TOKEN environment variable not set');
  console.error('Get a token from: https://cloud.digitalocean.com/account/api/tokens');
  process.exit(1);
}

// Helper: Make API request
function apiRequest(method, path, data = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: API_BASE,
      path: `/v2${path}`,
      method: method,
      headers: {
        'Authorization': `Bearer ${DIGITALOCEAN_TOKEN}`,
        'Content-Type': 'application/json',
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            reject(new Error(`API Error ${res.statusCode}: ${JSON.stringify(parsed)}`));
          }
        } catch (err) {
          reject(new Error(`Failed to parse response: ${body}`));
        }
      });
    });

    req.on('error', reject);

    if (data) {
      req.write(JSON.stringify(data));
    }

    req.end();
  });
}

// 1. List existing apps
async function listApps() {
  console.log('📋 Listing existing apps...');
  const result = await apiRequest('GET', '/apps');
  return result.apps || [];
}

// 2. Get app by name
async function getAppByName(name) {
  const apps = await listApps();
  return apps.find(app => app.spec.name === name);
}

// 3. Create new app from spec
async function createApp(spec) {
  console.log(`🚀 Creating app: ${spec.name}...`);
  const result = await apiRequest('POST', '/apps', { spec });
  return result.app;
}

// 4. Update app spec
async function updateApp(appId, spec) {
  console.log(`🔄 Updating app ${appId}...`);
  const result = await apiRequest('PUT', `/apps/${appId}`, { spec });
  return result.app;
}

// 5. Create deployment (redeploy)
async function createDeployment(appId, forceRebuild = false) {
  console.log(`🏗️  Creating deployment for app ${appId}...`);
  const result = await apiRequest('POST', `/apps/${appId}/deployments`, {
    force_build: forceRebuild
  });
  return result.deployment;
}

// 6. Get deployment status
async function getDeployment(appId, deploymentId) {
  const result = await apiRequest('GET', `/apps/${appId}/deployments/${deploymentId}`);
  return result.deployment;
}

// 7. Wait for deployment to complete
async function waitForDeployment(appId, deploymentId, maxWaitSec = 600) {
  console.log('⏳ Waiting for deployment to complete...');
  const startTime = Date.now();

  while (true) {
    const deployment = await getDeployment(appId, deploymentId);
    const phase = deployment.phase;
    const progress = deployment.progress;

    console.log(`   Status: ${phase} (${progress?.steps_total || 0}/${progress?.steps_total || 0} steps)`);

    if (phase === 'ACTIVE') {
      console.log('✅ Deployment successful!');
      return deployment;
    }

    if (phase === 'ERROR' || phase === 'CANCELED') {
      throw new Error(`Deployment failed with phase: ${phase}`);
    }

    const elapsedSec = (Date.now() - startTime) / 1000;
    if (elapsedSec > maxWaitSec) {
      throw new Error(`Deployment timeout after ${maxWaitSec} seconds`);
    }

    await new Promise(resolve => setTimeout(resolve, 10000)); // Poll every 10 seconds
  }
}

// 8. Update environment variables
async function updateEnvironmentVariables(appId, newEnvVars) {
  console.log('🔧 Updating environment variables...');

  // Get current app spec
  const result = await apiRequest('GET', `/apps/${appId}`);
  const currentSpec = result.app.spec;

  // Update env vars in the first service
  if (currentSpec.services && currentSpec.services.length > 0) {
    const service = currentSpec.services[0];

    // Merge new env vars with existing ones
    const existingEnvs = service.envs || [];
    const envMap = new Map(existingEnvs.map(e => [e.key, e]));

    // Add/update new env vars
    for (const [key, value] of Object.entries(newEnvVars)) {
      envMap.set(key, {
        key,
        value: String(value),
        scope: 'RUN_TIME',
        type: 'GENERAL'
      });
    }

    service.envs = Array.from(envMap.values());
  }

  // Update the app
  return await updateApp(appId, currentSpec);
}

// 9. Get app logs
async function getAppLogs(appId, type = 'BUILD', follow = false) {
  console.log(`📜 Fetching ${type} logs...`);
  // Note: Logs endpoint is different - uses streaming
  const result = await apiRequest('GET', `/apps/${appId}/logs?type=${type}&follow=${follow}`);
  return result;
}

// Main deployment function
async function main() {
  try {
    const APP_NAME = 'admp-server';

    // Load app spec from file
    const specPath = join(__dirname, '..', '.do', 'app.yaml');
    console.log(`📄 Loading app spec from ${specPath}...`);

    // For JSON API, we need to convert YAML to JSON
    // Here's the spec in JSON format
    const appSpec = {
      name: APP_NAME,
      region: 'nyc',
      services: [
        {
          name: 'web',
          github: {
            repo: 'dundas/agentdispatch',
            branch: 'main',
            deploy_on_push: true
          },
          dockerfile_path: 'Dockerfile',
          http_port: 8080,
          health_check: {
            http_path: '/health',
            initial_delay_seconds: 5,
            period_seconds: 30,
            timeout_seconds: 3,
            success_threshold: 1,
            failure_threshold: 3
          },
          instance_count: 1,
          instance_size_slug: 'basic-xxs',
          envs: [
            { key: 'NODE_ENV', value: 'production', scope: 'RUN_TIME' },
            { key: 'PORT', value: '8080', scope: 'RUN_TIME' },
            { key: 'CORS_ORIGIN', value: '*', scope: 'RUN_TIME' },
            { key: 'HEARTBEAT_INTERVAL_MS', value: '60000', scope: 'RUN_TIME' },
            { key: 'HEARTBEAT_TIMEOUT_MS', value: '300000', scope: 'RUN_TIME' },
            { key: 'MESSAGE_TTL_SEC', value: '86400', scope: 'RUN_TIME' },
            { key: 'MAX_MESSAGE_SIZE_KB', value: '256', scope: 'RUN_TIME' },
            { key: 'MAX_MESSAGES_PER_AGENT', value: '1000', scope: 'RUN_TIME' }
          ],
          routes: [
            { path: '/' }
          ]
        }
      ]
    };

    // Check if app already exists
    let app = await getAppByName(APP_NAME);

    if (app) {
      console.log(`✅ App "${APP_NAME}" already exists (ID: ${app.id})`);
      console.log(`   Live URL: ${app.live_url}`);

      // Option: Update environment variables
      console.log('\n🔄 Updating app configuration...');
      app = await updateApp(app.id, appSpec);

      // Option: Create new deployment
      const deployment = await createDeployment(app.id, true);
      console.log(`   Deployment ID: ${deployment.id}`);

      // Wait for deployment
      await waitForDeployment(app.id, deployment.id);

    } else {
      console.log(`🆕 Creating new app "${APP_NAME}"...`);
      app = await createApp(appSpec);
      console.log(`   App ID: ${app.id}`);
      console.log(`   Live URL: ${app.live_url || 'Building...'}`);

      // Wait for initial deployment
      if (app.active_deployment) {
        await waitForDeployment(app.id, app.active_deployment.id);
      }
    }

    console.log('\n🎉 Deployment complete!');
    console.log(`   App URL: ${app.live_url || app.default_ingress}`);
    console.log(`   Dashboard: https://cloud.digitalocean.com/apps/${app.id}`);

    // Example: Update specific env vars
    // await updateEnvironmentVariables(app.id, {
    //   NEW_FEATURE_FLAG: 'true',
    //   API_VERSION: 'v2'
    // });

  } catch (error) {
    console.error('❌ Deployment failed:', error.message);
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export {
  listApps,
  getAppByName,
  createApp,
  updateApp,
  createDeployment,
  waitForDeployment,
  updateEnvironmentVariables,
  getAppLogs
};
