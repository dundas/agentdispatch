import PostalMime from 'postal-mime';

// ============ TYPES ============

interface Env {
  ADMP_URL: string;
  INBOUND_EMAIL_SECRET: string;
  INBOUND_EMAIL_DOMAIN: string;
  // Optional: agent ID that receives worker error alerts via the inbound webhook.
  // If unset, errors are only logged (ephemeral). Set to a registered monitor agent.
  MONITOR_AGENT_ID?: string;
}

// ============ ADDRESS PARSER ============

/**
 * Extract the agent ID from an inbound email address.
 *
 * Format: {agentId}@{domain}
 *
 * The local part is the agent ID verbatim. No namespace prefix, no splitting.
 * Tenant/org grouping is an internal concept and is never encoded in the address.
 */
export function parseRecipient(address: string, _domain: string): string {
  const atIdx = address.lastIndexOf('@');
  return atIdx !== -1 ? address.slice(0, atIdx) : address;
}

// ============ ERROR REPORTING ============

/**
 * Report a worker error to the ADMP monitor agent inbox (if MONITOR_AGENT_ID is set).
 * This persists errors beyond ephemeral Cloudflare Worker logs.
 * Uses waitUntil so it doesn't block email delivery.
 */
async function reportError(env: Env, ctx: ExecutionContext, errorType: string, detail: string): Promise<void> {
  if (!env.MONITOR_AGENT_ID) return;
  try {
    await fetch(`${env.ADMP_URL}/api/webhooks/email/inbound`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Secret': env.INBOUND_EMAIL_SECRET
      },
      body: JSON.stringify({
        to_agent: env.MONITOR_AGENT_ID,
        from_email: 'worker-error@agentdispatch.io',
        subject: `[email-worker] ${errorType}`,
        text: detail,
        metadata: { error_type: errorType, worker: 'admp-email-ingestion' }
      })
    });
  } catch {
    // Swallow — if the monitor agent itself is unreachable, don't recurse
  }
}

// ============ EMAIL EVENT HANDLER ============

export default {
  async email(
    message: ForwardableEmailMessage,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    const domain = env.INBOUND_EMAIL_DOMAIN || 'agentdispatch.io';
    const agentId = parseRecipient(message.to, domain);

    // Read and parse raw MIME
    // message.raw is a ReadableStream — convert to ArrayBuffer for postal-mime
    const raw = await new Response(message.raw).arrayBuffer();
    const parsed = await new PostalMime().parse(raw);

    // Forward to ADMP inbound webhook
    const payload = {
      to_agent: agentId,
      from_email: parsed.from?.address ?? message.from,
      subject: parsed.subject ?? '(no subject)',
      text: parsed.text,
      html: parsed.html,
      raw_size: message.rawSize
    };

    let response: Response;
    try {
      response = await fetch(`${env.ADMP_URL}/api/webhooks/email/inbound`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Secret': env.INBOUND_EMAIL_SECRET
        },
        body: JSON.stringify(payload)
      });
    } catch (err) {
      // Network error — don't reject the email, log and report persistently
      const detail = `Network error forwarding to ADMP for recipient ${message.to}: ${err}`;
      console.error('[email-ingestion]', detail);
      ctx.waitUntil(reportError(env, ctx, 'NETWORK_ERROR', detail));
      return;
    }

    if (response.status === 404) {
      // Agent not found — bounce with SMTP rejection
      message.setReject('Unknown recipient');
      return;
    }

    if (!response.ok) {
      // Transient server error — log and report persistently, don't bounce
      const body = await response.text().catch(() => '');
      const detail = `ADMP returned ${response.status} for recipient ${message.to}: ${body}`;
      console.error('[email-ingestion]', detail);
      ctx.waitUntil(reportError(env, ctx, `ADMP_${response.status}`, detail));
    }
  }
};
