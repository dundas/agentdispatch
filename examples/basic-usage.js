/**
 * ADMP Basic Usage Example
 * Demonstrates agent registration, messaging, and inbox operations
 */

import { signMessage } from '../src/utils/crypto.js';
import { fromBase64 } from '../src/utils/crypto.js';

const API_URL = process.env.API_URL || 'http://localhost:8080/api';

/**
 * Example: Complete agent messaging workflow
 */
async function main() {
  console.log('=== ADMP Basic Usage Example ===\n');

  // 1. Register Agent A
  console.log('1. Registering Agent A...');
  const agentA = await registerAgent('agent-a', {
    project_name: 'sender-project'
  });
  console.log(`   ✓ Agent A registered: ${agentA.agent_id}`);
  console.log(`   Public Key: ${agentA.public_key.substring(0, 20)}...`);

  // 2. Register Agent B
  console.log('\n2. Registering Agent B...');
  const agentB = await registerAgent('agent-b', {
    project_name: 'receiver-project'
  });
  console.log(`   ✓ Agent B registered: ${agentB.agent_id}`);

  // 3. Send heartbeat from both agents
  console.log('\n3. Sending heartbeats...');
  await sendHeartbeat(agentA.agent_id);
  await sendHeartbeat(agentB.agent_id);
  console.log('   ✓ Both agents online');

  // 4. Agent A sends message to Agent B
  console.log('\n4. Agent A sending message to Agent B...');
  const message = await sendMessage(agentA, agentB.agent_id, {
    type: 'task.request',
    subject: 'run_tests',
    body: {
      command: 'npm test',
      project: 'my-project'
    }
  });
  console.log(`   ✓ Message sent: ${message.message_id}`);

  // 5. Agent B pulls message from inbox
  console.log('\n5. Agent B pulling message from inbox...');
  const pulled = await pullMessage(agentB.agent_id);
  if (!pulled) {
    console.log('   ✗ No messages in inbox');
    return;
  }
  console.log(`   ✓ Message pulled: ${pulled.message_id}`);
  console.log(`   Subject: ${pulled.envelope.subject}`);
  console.log(`   From: ${pulled.envelope.from}`);
  console.log(`   Body:`, pulled.envelope.body);

  // 6. Agent B processes and ACKs message
  console.log('\n6. Agent B acknowledging message...');
  await ackMessage(agentB.agent_id, pulled.message_id, {
    status: 'success',
    output: 'All tests passed'
  });
  console.log('   ✓ Message acknowledged');

  // 7. Agent B replies to Agent A
  console.log('\n7. Agent B replying to Agent A...');
  const reply = await replyToMessage(agentB, pulled.message_id, {
    type: 'task.result',
    subject: 'test_results',
    body: {
      status: 'passed',
      duration_ms: 1234,
      tests_run: 42
    }
  });
  console.log(`   ✓ Reply sent: ${reply.message_id}`);

  // 8. Agent A pulls reply
  console.log('\n8. Agent A pulling reply...');
  const replyMsg = await pullMessage(agentA.agent_id);
  if (replyMsg) {
    console.log(`   ✓ Reply received: ${replyMsg.message_id}`);
    console.log(`   Correlation ID: ${replyMsg.envelope.correlation_id}`);
    console.log(`   Result:`, replyMsg.envelope.body);

    await ackMessage(agentA.agent_id, replyMsg.message_id);
  }

  // 9. Check inbox stats
  console.log('\n9. Checking inbox stats...');
  const statsA = await getInboxStats(agentA.agent_id);
  const statsB = await getInboxStats(agentB.agent_id);
  console.log(`   Agent A inbox:`, statsA);
  console.log(`   Agent B inbox:`, statsB);

  // 10. System stats
  console.log('\n10. System stats:');
  const systemStats = await getSystemStats();
  console.log(`   Agents: ${systemStats.agents.total} (${systemStats.agents.online} online)`);
  console.log(`   Messages: ${systemStats.messages.total} total, ${systemStats.messages.acked} acked`);

  console.log('\n=== Example Complete ===');
}

// Helper functions

async function registerAgent(name, metadata) {
  const res = await fetch(`${API_URL}/agents/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agent_id: `agent://${name}`,
      agent_type: 'example',
      metadata
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
    return null;  // No messages
  }

  return await res.json();
}

async function ackMessage(agentId, messageId, result) {
  const res = await fetch(`${API_URL}/agents/${agentId}/messages/${messageId}/ack`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ result })
  });

  return await res.json();
}

async function replyToMessage(sender, originalMessageId, reply) {
  const envelope = {
    version: '1.0',
    id: `reply-${Date.now()}`,
    type: reply.type,
    subject: reply.subject,
    body: reply.body,
    timestamp: new Date().toISOString()
  };

  // Sign the reply
  const secretKey = fromBase64(sender.secret_key);
  envelope.signature = signMessage(envelope, secretKey);

  const res = await fetch(`${API_URL}/agents/${sender.agent_id}/messages/${originalMessageId}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope)
  });

  return await res.json();
}

async function getInboxStats(agentId) {
  const res = await fetch(`${API_URL}/agents/${agentId}/inbox/stats`);
  return await res.json();
}

async function getSystemStats() {
  const res = await fetch(`${API_URL}/stats`);
  return await res.json();
}

// Run example
main().catch(console.error);
