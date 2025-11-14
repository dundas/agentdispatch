/**
 * ADMP Webhook Push Example
 * Demonstrates registering an agent with webhook and receiving push notifications
 */

import { signMessage, fromBase64 } from '../src/utils/crypto.js';

const API_URL = process.env.API_URL || 'http://localhost:8080/api';
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'http://localhost:3000/webhook';

/**
 * Example: Register agent with webhook and send messages
 */
async function main() {
  console.log('=== ADMP Webhook Push Example ===\n');

  // 1. Register Agent A (sender)
  console.log('1. Registering Agent A (sender)...');
  const agentA = await registerAgent('agent-a', {
    project_name: 'sender-project'
  });
  console.log(`   ✓ Agent A registered: ${agentA.agent_id}`);

  // 2. Register Agent B with webhook (receiver)
  console.log('\n2. Registering Agent B with webhook...');
  const agentB = await registerAgent('agent-b', {
    project_name: 'receiver-project'
  }, WEBHOOK_URL);
  console.log(`   ✓ Agent B registered: ${agentB.agent_id}`);
  console.log(`   ✓ Webhook URL: ${agentB.webhook_url}`);
  console.log(`   ✓ Webhook secret: ${agentB.webhook_secret}`);

  // 3. Verify webhook configuration
  console.log('\n3. Verifying webhook configuration...');
  const webhookConfig = await getWebhookConfig(agentB.agent_id);
  console.log(`   ✓ Webhook configured: ${webhookConfig.webhook_configured}`);
  console.log(`   URL: ${webhookConfig.webhook_url}`);

  // 4. Send heartbeat
  console.log('\n4. Sending heartbeats...');
  await sendHeartbeat(agentA.agent_id);
  await sendHeartbeat(agentB.agent_id);
  console.log('   ✓ Both agents online');

  // 5. Send message from A to B
  console.log('\n5. Agent A sending message to Agent B...');
  console.log('   🔔 Message will be PUSHED to webhook immediately!');

  const message = await sendMessage(agentA, agentB.agent_id, {
    type: 'task.request',
    subject: 'run_tests',
    body: {
      command: 'npm test',
      project: 'my-project'
    }
  });
  console.log(`   ✓ Message sent: ${message.message_id}`);
  console.log('   📨 Webhook delivery triggered...');

  // Wait a bit for webhook delivery
  await new Promise(resolve => setTimeout(resolve, 1000));

  // 6. Check message status
  console.log('\n6. Checking message status...');
  const status = await getMessageStatus(message.message_id);
  console.log(`   Status: ${status.status}`);
  console.log(`   Attempts: ${status.attempts}`);

  // 7. Agent B can still poll if webhook failed
  console.log('\n7. Agent B can still poll inbox (fallback)...');
  const pulled = await pullMessage(agentB.agent_id);
  if (pulled) {
    console.log(`   ✓ Message available via polling: ${pulled.message_id}`);
    await ackMessage(agentB.agent_id, pulled.message_id);
    console.log('   ✓ Message acknowledged');
  } else {
    console.log('   ℹ️  No messages in queue (already delivered via webhook)');
  }

  // 8. Send another message to demonstrate push
  console.log('\n8. Sending second message (will be pushed)...');
  const message2 = await sendMessage(agentA, agentB.agent_id, {
    type: 'event',
    subject: 'deployment_complete',
    body: {
      environment: 'production',
      version: '1.2.3'
    }
  });
  console.log(`   ✓ Message sent: ${message2.message_id}`);
  console.log('   📨 Check your webhook receiver for the push notification!');

  // 9. Update webhook URL
  console.log('\n9. Updating webhook URL...');
  const newWebhookUrl = 'http://localhost:3001/webhook';
  const updated = await updateWebhook(agentB.agent_id, newWebhookUrl);
  console.log(`   ✓ Webhook updated: ${updated.webhook_url}`);

  // 10. Remove webhook (fall back to polling)
  console.log('\n10. Removing webhook (switching to polling mode)...');
  await removeWebhook(agentB.agent_id);
  console.log('   ✓ Webhook removed - agent will use polling');

  // Verify webhook removed
  const configAfter = await getWebhookConfig(agentB.agent_id);
  console.log(`   Webhook configured: ${configAfter.webhook_configured}`);

  console.log('\n=== Example Complete ===');
  console.log('\n💡 Key takeaways:');
  console.log('   • Messages are PUSHED to webhook URL immediately');
  console.log('   • No polling needed when webhook is configured');
  console.log('   • Webhook delivery has retry with exponential backoff');
  console.log('   • If webhook fails, message stays in queue for polling');
  console.log('   • Webhooks are optional - polling always works as fallback');
}

// Helper functions

async function registerAgent(name, metadata, webhook_url) {
  const res = await fetch(`${API_URL}/agents/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agent_id: `agent://${name}`,
      agent_type: 'example',
      metadata,
      webhook_url
    })
  });

  if (!res.ok) {
    const error = await res.json();
    throw new Error(`Registration failed: ${error.message}`);
  }

  return await res.json();
}

async function sendHeartbeat(agentId) {
  const res = await fetch(`${API_URL}/agents/${agentId}/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      metadata: { last_activity: Date.now() }
    })
  });

  return await res.json();
}

async function sendMessage(sender, recipientId, message) {
  const envelope = {
    version: '1.0',
    id: `msg-${Date.now()}`,
    type: message.type,
    from: sender.agent_id,
    to: recipientId,
    subject: message.subject,
    body: message.body,
    timestamp: new Date().toISOString(),
    ttl_sec: 3600
  };

  // Sign the message
  const secretKey = fromBase64(sender.secret_key);
  envelope.signature = signMessage(envelope, secretKey);

  const res = await fetch(`${API_URL}/agents/${recipientId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope)
  });

  if (!res.ok) {
    const error = await res.json();
    throw new Error(`Send failed: ${error.message}`);
  }

  return await res.json();
}

async function pullMessage(agentId) {
  const res = await fetch(`${API_URL}/agents/${agentId}/inbox/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visibility_timeout: 60 })
  });

  if (res.status === 204) {
    return null;
  }

  return await res.json();
}

async function ackMessage(agentId, messageId) {
  const res = await fetch(`${API_URL}/agents/${agentId}/messages/${messageId}/ack`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ result: { status: 'processed' } })
  });

  return await res.json();
}

async function getMessageStatus(messageId) {
  const res = await fetch(`${API_URL}/messages/${messageId}/status`);
  return await res.json();
}

async function getWebhookConfig(agentId) {
  const res = await fetch(`${API_URL}/agents/${agentId}/webhook`);
  return await res.json();
}

async function updateWebhook(agentId, webhook_url) {
  const res = await fetch(`${API_URL}/agents/${agentId}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ webhook_url })
  });

  return await res.json();
}

async function removeWebhook(agentId) {
  const res = await fetch(`${API_URL}/agents/${agentId}/webhook`, {
    method: 'DELETE'
  });

  return await res.json();
}

// Run example
main().catch(console.error);
