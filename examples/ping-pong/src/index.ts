/**
 * ADMP Ping-Pong Example
 * Demonstrates basic SEND → PULL → ACK workflow
 */

import { ADMPClient } from '@agent-dispatch/client';

const RELAY_URL = process.env.RELAY_URL || 'http://localhost:3030';
const API_KEY = process.env.API_KEY || 'dev-key-admp-local';

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log('🚀 ADMP Ping-Pong Example\n');

  // Create two agents: Alice (sender) and Bob (receiver)
  const alice = new ADMPClient({
    agentId: 'alice',
    relayUrl: RELAY_URL,
    apiKey: API_KEY,
  });

  const bob = new ADMPClient({
    agentId: 'bob',
    relayUrl: RELAY_URL,
    apiKey: API_KEY,
  });

  try {
    // Step 1: Alice sends a message to Bob
    console.log('📤 [Alice] Sending message to Bob...');
    const messageId = await alice.send({
      to: 'agent://bob',
      type: 'task.request',
      subject: 'ping',
      body: {
        message: 'Hello, Bob!',
        timestamp: new Date().toISOString(),
      },
    });
    console.log(`   ✓ Message sent: ${messageId}\n`);

    // Wait a moment for message to be available
    await sleep(500);

    // Step 2: Bob pulls the message from his inbox
    console.log('📬 [Bob] Checking inbox...');
    const message = await bob.pull({ leaseDuration: 30 });

    if (!message) {
      console.log('   ✗ No messages in inbox');
      return;
    }

    console.log('   ✓ Message received!');
    console.log(`     From: ${message.from}`);
    console.log(`     Subject: ${message.subject}`);
    console.log(`     Body: ${JSON.stringify(message.body)}\n`);

    // Step 3: Bob processes the message
    console.log('⚙️  [Bob] Processing message...');
    await sleep(1000); // Simulate processing
    console.log('   ✓ Processing complete\n');

    // Step 4: Bob acknowledges the message
    console.log('✅ [Bob] Acknowledging message...');
    await bob.ack(message.id);
    console.log('   ✓ Message acknowledged and removed from inbox\n');

    // Step 5: Verify inbox is empty
    console.log('📊 [Bob] Checking inbox stats...');
    const stats = await bob.inboxStats();
    console.log(`   Ready messages: ${stats.ready}`);
    console.log(`   Leased messages: ${stats.leased}`);
    console.log(`   Dead messages: ${stats.dead}\n`);

    console.log('✨ Example completed successfully!');
    console.log('\n📝 Summary:');
    console.log('   1. Alice sent a message to Bob\'s inbox');
    console.log('   2. Bob pulled the message (with 30s lease)');
    console.log('   3. Bob processed the message');
    console.log('   4. Bob acknowledged the message (removed from inbox)');
    console.log('\n🎉 ADMP workflow complete!');
  } catch (err: any) {
    console.error('\n❌ Error:', err.message);
    if (err.code) {
      console.error(`   Code: ${err.code}`);
    }
    if (err.statusCode) {
      console.error(`   Status: ${err.statusCode}`);
    }
    process.exit(1);
  }
}

main();
