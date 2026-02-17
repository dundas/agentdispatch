#!/usr/bin/env bun

/**
 * AgentDispatch Brain
 *
 * The brain that monitors and improves AgentDispatch itself.
 *
 * This is a self-improving brain that:
 * - Monitors hub health and message throughput
 * - Tracks agent activity across the network
 * - Identifies areas for improvement
 * - Researches solutions via ThinkBrowse
 * - Implements changes via Teleportation
 * - Coordinates with other brains via AgentDispatch (itself!)
 */

import { config, validateConfig } from './config';
import { createMechClient } from './lib/mech';
import { createADMPClient } from './lib/admp';
import { runHeartbeat } from './heartbeat';
import { initializeBrainTools, type BrainTools } from './tools';

/**
 * Main entry point
 */
async function main() {
  console.log(`🧠 ${config.brainName} - Starting...`);
  console.log('═══════════════════════════════════════════════');
  console.log('Configuration:');
  console.log(`  Agent ID:        ${config.agentId}`);
  console.log(`  Project:         ${config.projectPath}`);
  console.log(`  Hub URL:         ${config.backendUrl}`);
  console.log(`  Self-Improve:    ${config.selfImprovementEnabled ? 'enabled' : 'disabled'}`);
  console.log(`  Heartbeat:       every ${config.heartbeatInterval / 1000 / 60} minutes`);
  console.log('═══════════════════════════════════════════════');

  // Validate configuration
  validateConfig();

  // Initialize Mech client
  const mech = createMechClient();
  if (mech) {
    console.log('✅ Mech client initialized');
  } else {
    console.log('⚠️  Mech client disabled (no credentials)');
  }

  // Initialize brain tools
  const tools = initializeBrainTools();
  if (tools.teleportation) {
    console.log('✅ Teleportation ready (can implement code changes)');
  }
  if (tools.thinkbrowse) {
    console.log('✅ ThinkBrowse ready (can research solutions)');
  }

  // Initialize AgentDispatch client (we connect to ourselves!)
  const admp = createADMPClient({
    hubUrl: config.admpHubUrl,
    agentId: config.agentId,
    agentType: config.agentType,
    webhookUrl: process.env.WEBHOOK_URL
  });

  // Register in AgentDispatch
  try {
    const registration = await admp.register();
    console.log(`✅ Registered in AgentDispatch: ${registration.agent_id}`);
    process.env.ADMP_SECRET_KEY = registration.secret_key;
  } catch (error) {
    console.error('❌ AgentDispatch registration failed:', error);
    console.log('   Note: This brain monitors AgentDispatch itself.');
    console.log('   Make sure the hub is running at:', config.backendUrl);
  }

  // Subscribe to brain network channels
  try {
    await admp.subscribeToChannel('channel://brain-network');
    await admp.subscribeToChannel('channel://brain-alerts');
    await admp.subscribeToChannel('channel://brain-learnings');
    console.log('✅ Subscribed to brain network channels');
  } catch (error) {
    console.warn('Could not subscribe to channels:', error);
  }

  // Run initial heartbeat
  console.log('🫀 Running initial heartbeat...');
  try {
    await runHeartbeat({ mech, admp, tools });
  } catch (error) {
    console.error('❌ Initial heartbeat failed:', error);
  }

  // Start periodic heartbeat
  const heartbeatTimer = setInterval(async () => {
    try {
      await runHeartbeat({ mech, admp, tools });

      await admp.heartbeat({
        last_run: new Date().toISOString(),
        tools_available: {
          teleportation: !!tools.teleportation,
          thinkbrowse: !!tools.thinkbrowse
        }
      });
    } catch (error) {
      console.error('Heartbeat error:', error);
    }
  }, config.heartbeatInterval);

  // Start health check loop (more frequent)
  const healthCheckTimer = setInterval(async () => {
    try {
      const response = await fetch(`${config.backendUrl}/health`, {
        signal: AbortSignal.timeout(5000)
      });

      if (!response.ok) {
        console.warn(`⚠️  AgentDispatch health check failed: ${response.status}`);

        await admp.postToChannel({
          channel: 'channel://brain-alerts',
          subject: 'agentdispatch_unhealthy',
          body: {
            brain: config.agentId,
            status: response.status,
            timestamp: new Date().toISOString()
          }
        });
      }
    } catch (error) {
      console.error('Health check error:', error);
    }
  }, config.healthCheckInterval);

  // Start webhook server
  const server = Bun.serve({
    port: config.webhookPort,
    async fetch(req) {
      const url = new URL(req.url);

      // Health endpoint
      if (url.pathname === '/health') {
        return new Response(JSON.stringify({
          status: 'healthy',
          brain: config.agentId,
          project: 'agentdispatch',
          tools: {
            teleportation: !!tools.teleportation,
            thinkbrowse: !!tools.thinkbrowse
          },
          timestamp: new Date().toISOString()
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // ADMP webhook
      if (url.pathname === config.webhookPath && req.method === 'POST') {
        try {
          const payload = await req.json();
          console.log('📨 Received message:', payload.envelope?.subject);

          await handleMessage(payload, { mech, admp, tools });

          return new Response(JSON.stringify({ ok: true }), {
            headers: { 'Content-Type': 'application/json' }
          });
        } catch (error) {
          console.error('Webhook error:', error);
          return new Response(JSON.stringify({ error: String(error) }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }

      return new Response('Not Found', { status: 404 });
    }
  });

  console.log('');
  console.log('═══════════════════════════════════════════════');
  console.log(`✨ ${config.brainName} is now operational!`);
  console.log('═══════════════════════════════════════════════');
  console.log('Services:');
  console.log(`  Webhook server:  http://localhost:${config.webhookPort}`);
  console.log(`  Heartbeat:       every ${config.heartbeatInterval / 1000 / 60} minutes`);
  console.log(`  Health checks:   every ${config.healthCheckInterval / 1000 / 60} minutes`);
  console.log(`  Self-improve:    every ${config.selfImprovementInterval / 1000 / 60 / 60} hours`);
  console.log('');
  console.log('Capabilities:');
  console.log(`  Monitor:         AgentDispatch hub health`);
  console.log(`  Research:        ${tools.thinkbrowse ? 'enabled via ThinkBrowse' : 'disabled'}`);
  console.log(`  Code:            ${tools.teleportation ? 'enabled via Teleportation' : 'disabled'}`);
  console.log('');
  console.log('Press Ctrl+C to stop');
  console.log('');

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down gracefully...');

    clearInterval(heartbeatTimer);
    clearInterval(healthCheckTimer);
    server.stop();

    console.log('👋 AgentDispatch Brain signing off!');
    process.exit(0);
  });
}

/**
 * Handle incoming messages
 */
async function handleMessage(
  payload: any,
  ctx: { mech: any; admp: any; tools: BrainTools }
): Promise<void> {
  const envelope = payload.envelope;

  if (!envelope) {
    console.warn('Invalid payload: missing envelope');
    return;
  }

  console.log(`Processing: ${envelope.subject} from ${envelope.from}`);

  switch (envelope.subject) {
    case 'health_check':
      await ctx.admp.sendMessage({
        to: envelope.from,
        subject: 'health_check_response',
        body: {
          status: 'healthy',
          brain: config.agentId,
          project: 'agentdispatch',
          tools: {
            teleportation: !!ctx.tools.teleportation,
            thinkbrowse: !!ctx.tools.thinkbrowse
          },
          timestamp: new Date().toISOString()
        }
      });
      break;

    case 'improvement_request':
      // Another brain is asking us to improve something
      if (payload.body?.feature && ctx.tools.teleportation) {
        console.log(`Received improvement request: ${payload.body.feature}`);

        // Research first if we have ThinkBrowse
        if (ctx.tools.thinkbrowse && payload.body.researchUrl) {
          const research = await ctx.tools.thinkbrowse.research({
            url: payload.body.researchUrl,
            prompt: `How to implement: ${payload.body.feature}`
          });

          // Share research
          await ctx.admp.sendMessage({
            to: envelope.from,
            subject: 'research_complete',
            body: research.analysis
          });
        }

        // Implement if instructions provided
        if (payload.body.instructions) {
          const result = await ctx.tools.teleportation.runCodingTask({
            project: config.projectPath,
            description: payload.body.feature,
            instructions: payload.body.instructions,
            testRequired: true
          });

          await ctx.admp.sendMessage({
            to: envelope.from,
            subject: 'improvement_complete',
            body: result
          });
        }
      }
      break;

    case 'status_request':
      // Report current status
      await ctx.admp.sendMessage({
        to: envelope.from,
        subject: 'status_response',
        body: {
          brain: config.agentId,
          project: 'agentdispatch',
          status: 'operational',
          timestamp: new Date().toISOString()
        }
      });
      break;

    default:
      console.log(`Unknown message type: ${envelope.subject}`);
  }
}

// Run
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
