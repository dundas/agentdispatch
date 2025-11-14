/**
 * ADMP Webhook Receiver Example
 * Demonstrates how to receive messages via webhook instead of polling
 */

import express from 'express';
import crypto from 'crypto';

const app = express();
app.use(express.json());

const PORT = process.env.WEBHOOK_PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'your-webhook-secret-here';

/**
 * Verify webhook signature
 */
function verifyWebhookSignature(payload, signature, secret) {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(JSON.stringify(payload));
  const expected = hmac.digest('hex');
  return signature === expected;
}

/**
 * Webhook endpoint to receive messages
 * POST /webhook
 */
app.post('/webhook', async (req, res) => {
  try {
    const payload = req.body;
    const signature = payload.signature;

    console.log('\n=== Webhook Received ===');
    console.log('Event:', payload.event);
    console.log('Message ID:', payload.message_id);
    console.log('Delivered at:', new Date(payload.delivered_at).toISOString());

    // Verify signature if present
    if (signature) {
      const valid = verifyWebhookSignature(
        { ...payload, signature: undefined },
        signature,
        WEBHOOK_SECRET
      );

      if (!valid) {
        console.error('❌ Invalid signature');
        return res.status(401).json({
          error: 'INVALID_SIGNATURE',
          message: 'Webhook signature verification failed'
        });
      }

      console.log('✓ Signature verified');
    }

    // Extract message envelope
    const { envelope } = payload;

    console.log('\n--- Message Details ---');
    console.log('From:', envelope.from);
    console.log('Subject:', envelope.subject);
    console.log('Type:', envelope.type);
    console.log('Body:', JSON.stringify(envelope.body, null, 2));

    // Process the message
    await processMessage(envelope);

    // Acknowledge receipt with 200 OK
    // This tells ADMP server that webhook delivery was successful
    res.status(200).json({
      ok: true,
      message: 'Message received and processed'
    });

    console.log('✓ Message processed successfully');

  } catch (error) {
    console.error('❌ Error processing webhook:', error.message);

    // Return error - ADMP will retry delivery
    res.status(500).json({
      error: 'PROCESSING_FAILED',
      message: error.message
    });
  }
});

/**
 * Process received message
 */
async function processMessage(envelope) {
  const { type, subject, body } = envelope;

  // Handle different message types
  switch (type) {
    case 'task.request':
      console.log(`\n📝 Processing task: ${subject}`);

      // Example: Run a command
      if (body.command) {
        console.log(`   Command: ${body.command}`);
        // Execute command, run tests, etc.
      }

      // Optionally send reply (would need to call ADMP API)
      break;

    case 'event':
      console.log(`\n📢 Event received: ${subject}`);
      console.log('   Data:', body);
      break;

    case 'task.result':
      console.log(`\n✅ Task result: ${subject}`);
      console.log('   Result:', body);
      break;

    default:
      console.log(`\nℹ️  Unknown message type: ${type}`);
  }

  // Simulate processing delay
  await new Promise(resolve => setTimeout(resolve, 100));
}

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    webhook_configured: true,
    timestamp: new Date().toISOString()
  });
});

/**
 * Start webhook receiver
 */
app.listen(PORT, () => {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║  ADMP Webhook Receiver                 ║');
  console.log('╚════════════════════════════════════════╝\n');
  console.log(`🚀 Listening on http://localhost:${PORT}/webhook`);
  console.log(`📝 Webhook secret: ${WEBHOOK_SECRET.substring(0, 10)}...`);
  console.log('\n📋 To register this webhook with ADMP:');
  console.log(`
  POST http://localhost:8080/api/agents/{agentId}/webhook
  {
    "webhook_url": "http://localhost:${PORT}/webhook",
    "webhook_secret": "${WEBHOOK_SECRET}"
  }
  `);
  console.log('Ready to receive messages!\n');
});

export default app;
