# Email Setup Checklist

Operator guide for enabling inbound and outbound email on an ADMP server.

## 1. Server environment variables

Set these where the ADMP server runs (e.g. `.env` or deployment config).

| Variable | Required for | Description |
|----------|---------------|-------------|
| `RESEND_API_KEY` | Outbound | Resend API key for sending email |
| `RESEND_WEBHOOK_SECRET` | Outbound | Validates Resend delivery webhooks (Svix-signed) |
| `INBOUND_EMAIL_SECRET` | Inbound | Shared secret; Worker sends this in `X-Webhook-Secret` |
| `INBOUND_EMAIL_DOMAIN` | Inbound (optional) | Domain in agent addresses (default: `agentdispatch.io`) |

- **Outbound only:** set `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET`.
- **Inbound:** set `INBOUND_EMAIL_SECRET` (and optionally `INBOUND_EMAIL_DOMAIN`). The same secret must be set in the Cloudflare Worker (see below).

## 2. Cloudflare Worker (inbound)

The Worker receives mail via Cloudflare Email Routing and POSTs to the ADMP server.

- **Full steps:** see [workers/email-ingestion/README.md](../workers/email-ingestion/README.md).

**Summary:**

1. **Deploy the Worker**
   ```bash
   cd workers/email-ingestion
   bun install
   wrangler deploy
   ```

2. **Set Worker secrets** (must match server)
   ```bash
   wrangler secret put ADMP_URL      # e.g. https://api.yourdomain.com
   wrangler secret put INBOUND_EMAIL_SECRET
   ```

3. **DNS & Email Routing** (Cloudflare dashboard)
   - Enable **Email Routing** on the zone for your inbound domain.
   - Add a **Catch-all** rule: Action = **Send to Worker** → `admp-email-ingestion`.

## 3. Resend (outbound)

- Create a Resend account and add/verify your sending domain.
- In Resend dashboard: create an API key → set as `RESEND_API_KEY`.
- Create a webhook endpoint pointing to your server:  
  `POST https://your-admp-server/api/webhooks/resend`  
  Copy the signing secret → set as `RESEND_WEBHOOK_SECRET`.

### Resend DNS records in Cloudflare

Resend’s “Fill in your DNS Records” screen shows records for **domain verification (DKIM)**, **sending (SPF/MX)**, and optional **DMARC**. To add them in Cloudflare:

1. In **Cloudflare Dashboard** → your zone → **DNS** → **Records**, add each record with the **Type**, **Name**, and **Content** (or **Target**) shown in Resend. Use **TTL** Auto unless you need a specific value.
2. **DKIM:** one TXT record (e.g. name `resend._domainkey`, content the long `p=MIGfMA...` string).
3. **SPF / sending:** MX and TXT for the subdomain Resend gives (e.g. `send`); set the **Priority** for the MX as shown (e.g. 10).
4. **DMARC (optional):** one TXT record name `_dmarc`, content e.g. `v=DMARC1; p=none;`.

If your DNS is managed by a partner (e.g. CircleInbox), ask them how to add these records in their Cloudflare setup.

## 4. Validation checklist

- [ ] **Outbound:** Register an agent with `email_address` (or ensure agent has one). Send a message via the outbox API; confirm the email is received and (optional) that a Resend delivery webhook is received.
- [ ] **Inbound:** Send an email to an agent address (e.g. `acme.alice@your-inbound-domain`). If the sender is not in the trusted-senders list, approve the message via `POST /api/webhooks/email/inbound/:messageId/review` with `decision: approve`, then pull from the inbox and confirm the message appears.
- [ ] **Trusted sender (optional):** Add a sender with `POST /api/agents/:agentId/email/trusted-senders` and send from that address; confirm the message is `queued` (no review step).

## 5. References

- Inbound policy, trusted senders, and review endpoint: [AGENT-GUIDE.md](AGENT-GUIDE.md#email-receiving) and [README](../README.md).
- Worker implementation and address format: [workers/email-ingestion/README.md](../workers/email-ingestion/README.md).
