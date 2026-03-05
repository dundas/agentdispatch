#!/usr/bin/env node
/**
 * End-to-end email flow test
 *
 * Tests:
 *   1. Register a test agent and check its email address
 *   2. Outbound — send an email via the outbox (requires verified Resend domain)
 *   3. Inbound (simulated) — POST to the inbound webhook as if the CF Worker did
 *   4. Quarantine — message starts as review_pending, not pullable
 *   5. Review — approve the message, then pull it from the inbox
 *   6. Trusted sender — add sender to allowlist, re-send, confirm auto-queued
 *
 * Usage:
 *   node scripts/test-email-flow.js
 *   BASE_URL=http://localhost:4200 node scripts/test-email-flow.js
 */

const BASE_URL = process.env.BASE_URL || 'https://agentdispatch.fly.dev';
const MASTER_KEY = process.env.MASTER_API_KEY || 'd18ff8c58075c1bc2136cff029d7ceebfb73e70d293f6518f75c558df3c94946';
const INBOUND_SECRET = process.env.INBOUND_EMAIL_SECRET || '94484783f6806b25d8649492b7a2e5e6e16a31790be9a07d6a4e91fe2dd225ba';

const agentId = `test-email-${Date.now()}`;
let apiKey = null;

function log(label, data) {
  const icon = data?.error ? '❌' : '✅';
  console.log(`\n${icon} ${label}`);
  if (data) console.log('  ', JSON.stringify(data, null, 2).split('\n').join('\n   '));
}

async function api(method, path, body, key) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': key || MASTER_KEY,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ...json };
}

async function main() {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`ADMP Email Flow Test — ${BASE_URL}`);
  console.log(`Agent: ${agentId}`);
  console.log(`${'─'.repeat(60)}`);

  // ── 1. Register agent ──────────────────────────────────────────
  console.log('\n── 1. Register test agent');
  const reg = await api('POST', '/api/agents/register', { agent_id: agentId });
  if (reg.status !== 201) { log('Registration failed', reg); process.exit(1); }
  // Server returns `secret_key` (base64 encoded Ed25519 secret)
  apiKey = reg.secret_key;
  log(`Registered ${agentId}`, { secret_key: apiKey?.slice(0, 10) + '...' });

  // ── 1b. Approve the agent (REGISTRATION_POLICY=approval_required) ─
  const approveRes = await api('POST', `/api/agents/${agentId}/approve`, null, MASTER_KEY);
  if (approveRes.registration_status !== 'approved') {
    log('Approval failed (may already be approved or policy is open)', approveRes);
  } else {
    log('Agent approved', { registration_status: approveRes.registration_status });
  }

  // ── 1c. Issue an API key for the agent ────────────────────────
  // secret_key is the Ed25519 private key (for HTTP Signature auth).
  // For simple REST calls we issue a bearer API key via the master key.
  const keyRes = await api('POST', '/api/keys/issue', { client_id: agentId }, MASTER_KEY);
  if (!keyRes.api_key) { log('Key issuance failed', keyRes); process.exit(1); }
  apiKey = keyRes.api_key;
  log('Issued API key', { key: apiKey.slice(0, 14) + '...' });

  // ── 2. Check email address ─────────────────────────────────────
  console.log('\n── 2. Check agent email address');
  const agentInfo = await api('GET', `/api/agents/${agentId}`, null, apiKey);
  const emailAddress = agentInfo.email_address;
  log('Email address', { email_address: emailAddress });

  // ── 3. Outbound — send email ───────────────────────────────────
  console.log('\n── 3. Outbound: send email via outbox');
  console.log('   (Requires verified Resend domain — skipped if domain not verified)');

  const domainStatus = await api('GET', `/api/agents/${agentId}/outbox/domain`, null, apiKey);
  if (domainStatus.status === 404 || domainStatus.status === 400) {
    // Register the domain first
    const domainReg = await api('POST', `/api/agents/${agentId}/outbox/domain`, { domain: 'agentdispatch.io' }, apiKey);
    log('Domain registration', { status: domainReg.status, domain: domainReg.domain, dns_status: domainReg.status });
  } else {
    log('Domain status', { domain: domainStatus.domain, status: domainStatus.status });
  }

  const sendRes = await api('POST', `/api/agents/${agentId}/outbox/send`, {
    to: 'kefentse@derivative.so',
    subject: 'ADMP email test — outbound',
    body: `Hello from agent ${agentId} on ADMP.\n\nThis is an automated outbound email test.`,
  }, apiKey);

  if (sendRes.status === 403) {
    console.log('   ⚠️  Domain not yet verified on Resend — outbound skipped');
    console.log(`      Check: https://resend.com/domains — verify agentdispatch.io then re-run`);
  } else {
    log('Outbound send', { id: sendRes.id, status: sendRes.status });
  }

  // ── 4. Inbound (simulated via webhook) ────────────────────────
  console.log('\n── 4. Inbound: simulate CF Worker posting email to webhook');
  const inboundRes = await fetch(`${BASE_URL}/api/webhooks/email/inbound`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': INBOUND_SECRET },
    body: JSON.stringify({
      to_agent: agentId,
      from_email: 'sender@example.com',
      subject: 'Hello from the internet',
      text: 'This is a test inbound email.',
    }),
  });
  const inbound = await inboundRes.json();
  log('Inbound webhook', { status: inboundRes.status, message_id: inbound.message_id });
  const messageId = inbound.message_id;

  // ── 5. Pull — should be empty (message in review_pending) ─────
  console.log('\n── 5. Pull inbox — should be empty (quarantined)');
  const pull1 = await api('POST', `/api/agents/${agentId}/inbox/pull`, {}, apiKey);
  log('Pull (pre-review)', { status: pull1.status, got_message: !!pull1.message_id });
  if (pull1.message_id) console.log('   ⚠️  Expected empty inbox but got a message — quarantine may not be active');

  // ── 6. Review — approve the message ───────────────────────────
  console.log('\n── 6. Approve the inbound message');
  const reviewRes = await fetch(`${BASE_URL}/api/webhooks/email/inbound/${messageId}/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': INBOUND_SECRET },
    body: JSON.stringify({ decision: 'approve', reason: 'manual test approval' }),
  });
  const review = await reviewRes.json();
  log('Review (approve)', { status: reviewRes.status, ...review });

  // ── 7. Pull — should now have the message ─────────────────────
  console.log('\n── 7. Pull inbox — should have approved message');
  const pull2 = await api('POST', `/api/agents/${agentId}/inbox/pull`, {}, apiKey);
  log('Pull (post-approve)', {
    status: pull2.status,
    got_message: !!pull2.message_id,
    type: pull2.envelope?.type,
    from: pull2.envelope?.from,
    subject: pull2.envelope?.subject,
  });

  if (pull2.message_id) {
    await api('POST', `/api/agents/${agentId}/inbox/ack/${pull2.message_id}`, {}, apiKey);
    log('Acked message', { message_id: pull2.message_id });
  }

  // ── 8. Trusted sender — bypass quarantine ────────────────────
  console.log('\n── 8. Add trusted sender → confirm auto-queued (no review needed)');
  const addTrusted = await api('POST', `/api/agents/${agentId}/email/trusted-senders`, { email: 'trusted@example.com' }, apiKey);
  log('Add trusted sender', { status: addTrusted.status });

  const inbound2Res = await fetch(`${BASE_URL}/api/webhooks/email/inbound`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': INBOUND_SECRET },
    body: JSON.stringify({
      to_agent: agentId,
      from_email: 'trusted@example.com',
      subject: 'From trusted sender',
      text: 'This should skip quarantine.',
    }),
  });
  const inbound2 = await inbound2Res.json();
  log('Inbound from trusted sender', { status: inbound2Res.status, message_id: inbound2.message_id });

  const pull3 = await api('POST', `/api/agents/${agentId}/inbox/pull`, {}, apiKey);
  log('Pull (trusted sender — should be immediate)', {
    status: pull3.status,
    got_message: !!pull3.message_id,
    from: pull3.envelope?.from,
    subject: pull3.envelope?.subject,
  });

  // ── Summary ───────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log('Test complete.');
  console.log(`Agent ${agentId} — email: ${agentInfo.email_address}`);
  console.log(`${'─'.repeat(60)}\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
