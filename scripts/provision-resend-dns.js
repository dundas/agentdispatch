#!/usr/bin/env node
/**
 * Provision Resend DNS records for a domain via Cloudflare API.
 *
 * Usage:
 *   CLOUDFLARE_API_TOKEN=xxx node scripts/provision-resend-dns.js <domain> [--check]
 *
 * Required env:
 *   CLOUDFLARE_API_TOKEN   Cloudflare API token (DNS:Edit)
 *   CLOUDFLARE_ZONE_ID     (optional) skip zone lookup
 *
 * Required env for provisioning (copy exact values from Resend dashboard):
 *   RESEND_DKIM_CONTENT    Full DKIM TXT content  (p=MIGfMA...wIDAQAB)
 *   RESEND_MX_CONTENT      MX mail server          (feedback-smtp.us-east-1.amazonses.com)
 *   RESEND_SPF_CONTENT     SPF TXT content         (v=spf1 include:amazonses.com ~all)
 *   RESEND_MX_PRIORITY     MX priority             (default: 10)
 *
 * Examples:
 *   # Check existing DNS records for a domain
 *   CLOUDFLARE_API_TOKEN=xxx node scripts/provision-resend-dns.js agentdispatch.io --check
 *
 *   # Provision all Resend records (upsert — safe to re-run)
 *   CLOUDFLARE_API_TOKEN=xxx \
 *     RESEND_DKIM_CONTENT="p=MIGfMA..." \
 *     RESEND_MX_CONTENT="feedback-smtp.us-east-1.amazonses.com" \
 *     RESEND_SPF_CONTENT="v=spf1 include:amazonses.com ~all" \
 *     node scripts/provision-resend-dns.js agentdispatch.io
 */

import {
  getZoneId,
  getDnsRecords,
  provisionResendDns,
  CloudflareApiError,
} from '../src/lib/cloudflare.js';

const domain = process.argv[2];
const checkOnly = process.argv.includes('--check');

if (!domain) {
  console.error('Usage: node scripts/provision-resend-dns.js <domain> [--check]');
  process.exit(1);
}

async function check() {
  console.log(`\nChecking DNS records for ${domain}...\n`);
  const zoneId = await getZoneId(domain);
  if (!zoneId) {
    console.error(`Zone not found for ${domain}. Add it to Cloudflare first.`);
    process.exit(1);
  }
  console.log(`Zone ID: ${zoneId}\n`);

  const records = await getDnsRecords(zoneId);

  const targets = [
    { type: 'TXT', name: `resend._domainkey.${domain}`, label: 'DKIM' },
    { type: 'MX',  name: `send.${domain}`,               label: 'SPF MX' },
    { type: 'TXT', name: `send.${domain}`,               label: 'SPF TXT' },
    { type: 'TXT', name: `_dmarc.${domain}`,             label: 'DMARC' },
  ];

  console.log('Resend record status:');
  for (const t of targets) {
    const match = records.find(r => r.type === t.type && r.name === t.name);
    const status = match ? '✅ exists' : '❌ missing';
    const preview = match ? `  → ${match.content.slice(0, 60)}${match.content.length > 60 ? '...' : ''}` : '';
    console.log(`  ${status}  [${t.label}] ${t.name}${preview}`);
  }
  console.log();
}

async function provision() {
  const dkimContent = process.env.RESEND_DKIM_CONTENT;
  const mxContent   = process.env.RESEND_MX_CONTENT;
  const spfContent  = process.env.RESEND_SPF_CONTENT;
  const mxPriority  = parseInt(process.env.RESEND_MX_PRIORITY || '10', 10);

  const missing = [
    !dkimContent && 'RESEND_DKIM_CONTENT',
    !mxContent   && 'RESEND_MX_CONTENT',
    !spfContent  && 'RESEND_SPF_CONTENT',
  ].filter(Boolean);

  if (missing.length) {
    console.error(`Missing required env vars: ${missing.join(', ')}`);
    console.error('Copy exact values from the Resend dashboard → Domains → your domain → DNS Records');
    process.exit(1);
  }

  console.log(`\nProvisioning Resend DNS records for ${domain}...\n`);

  const result = await provisionResendDns(domain, {
    dkimContent,
    mxContent,
    spfContent,
    mxPriority,
  });

  if (result.error) {
    console.error(`Error: ${result.error}`);
    process.exit(1);
  }

  console.log(`Zone ID: ${result.zoneId}\n`);
  for (const r of result.records) {
    const icon = r.success ? '✅' : '❌';
    const detail = r.success ? '' : `  → ${r.error}`;
    console.log(`  ${icon}  [${r.label}] ${r.type} ${r.name}${detail}`);
  }

  if (result.success) {
    console.log('\nAll records provisioned. Click Verify in the Resend dashboard (propagation 5–60 min).\n');
  } else {
    console.error('\nSome records failed. Check errors above.\n');
    process.exit(1);
  }
}

async function main() {
  try {
    if (checkOnly) {
      await check();
    } else {
      await check();
      await provision();
    }
  } catch (err) {
    if (err instanceof CloudflareApiError) {
      console.error(`Cloudflare API error: ${err.message}`);
    } else {
      console.error(err);
    }
    process.exit(1);
  }
}

main();
