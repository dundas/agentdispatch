import PostalMime from 'postal-mime';

// ============ TYPES ============

interface Env {
  ADMP_URL: string;
  INBOUND_EMAIL_SECRET: string;
  INBOUND_EMAIL_DOMAIN: string;
}

interface ParsedRecipient {
  namespace: string | null;
  agentId: string;
}

// ============ ADDRESS PARSER ============

/**
 * Parse an ADMP agent email address into namespace and agentId.
 *
 * Format: {namespace}.{agentId}@{domain}  → namespace + agentId
 *         {agentId}@{domain}              → null namespace + agentId
 *
 * Edge case: dots in agentId are preserved.
 *   acme.alice       → { namespace: 'acme', agentId: 'alice' }
 *   acme.alice.v2    → { namespace: 'acme', agentId: 'alice.v2' }
 *   alice            → { namespace: null,   agentId: 'alice' }
 */
export function parseRecipient(address: string, domain: string): ParsedRecipient {
  // Strip @domain suffix (case-insensitive)
  const atIdx = address.lastIndexOf('@');
  const local = atIdx !== -1 ? address.slice(0, atIdx) : address;

  // Split on first '.' only
  const dotIdx = local.indexOf('.');
  if (dotIdx === -1) {
    return { namespace: null, agentId: local };
  }

  const namespace = local.slice(0, dotIdx);
  const agentId = local.slice(dotIdx + 1);
  return { namespace, agentId };
}

// ============ EMAIL EVENT HANDLER ============

export default {
  async email(
    message: ForwardableEmailMessage,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    const domain = env.INBOUND_EMAIL_DOMAIN || 'agentdispatch.io';
    const { namespace, agentId } = parseRecipient(message.to, domain);

    // Read and parse raw MIME
    const raw = await message.raw.arrayBuffer();
    const parsed = await new PostalMime().parse(raw);

    // Forward to ADMP inbound webhook
    const payload = {
      to_agent: agentId,
      to_namespace: namespace ?? undefined,
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
      // Network error — don't reject the email, log and let Cloudflare retry
      console.error('[email-ingestion] Network error forwarding to ADMP:', err);
      return;
    }

    if (response.status === 404) {
      // Agent not found — bounce with SMTP rejection
      message.setReject('Unknown recipient');
      return;
    }

    if (!response.ok) {
      // Transient error — log but don't reject to avoid bouncing on server issues
      const body = await response.text().catch(() => '');
      console.error(
        `[email-ingestion] ADMP returned ${response.status}: ${body}`
      );
    }
  }
};
