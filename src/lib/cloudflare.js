/**
 * Cloudflare DNS & Email Routing API client.
 * Ported from circleinbox/api/lib/cloudflare.ts — adapted for agentdispatch.
 *
 * Required env vars:
 *   CLOUDFLARE_API_TOKEN  — API token with DNS:Edit + Email Routing:Edit permissions
 *   CLOUDFLARE_ZONE_ID    — (optional) skip zone lookup if already known
 */

const CLOUDFLARE_API_URL = 'https://api.cloudflare.com/client/v4';
const REQUEST_TIMEOUT = 30_000;

function getToken() {
  const token = process.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_API_KEY || '';
  if (!token) throw new CloudflareApiError('CLOUDFLARE_API_TOKEN is not set');
  return token;
}

// ─── Error ────────────────────────────────────────────────────────────────────

export class CloudflareApiError extends Error {
  constructor(message, statusCode, errors) {
    super(message);
    this.name = 'CloudflareApiError';
    this.statusCode = statusCode;
    this.errors = errors;
  }
}

// ─── Core request ─────────────────────────────────────────────────────────────

async function cfRequest(endpoint, method = 'GET', body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const res = await fetch(`${CLOUDFLARE_API_URL}${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${getToken()}`,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    clearTimeout(timer);

    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      const text = await res.text();
      throw new CloudflareApiError(`Unexpected response: ${text.slice(0, 100)}`, res.status);
    }

    const data = await res.json();

    if (!res.ok) {
      const msg = data.errors?.map(e => e.message).join(', ') || `HTTP ${res.status}`;
      throw new CloudflareApiError(msg, res.status, data.errors);
    }

    return data;
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof CloudflareApiError) throw err;
    if (err.name === 'AbortError') throw new CloudflareApiError('Request timed out');
    if (err instanceof TypeError) throw new CloudflareApiError(`Network error: ${err.message}`);
    throw new CloudflareApiError(err.message || 'Unknown error');
  }
}

// ─── Zones ────────────────────────────────────────────────────────────────────

export async function listZones() {
  const data = await cfRequest('/zones?per_page=50');
  return data.success ? data.result : [];
}

export async function getZoneId(domain) {
  // Allow caller to short-circuit via env var
  if (process.env.CLOUDFLARE_ZONE_ID) return process.env.CLOUDFLARE_ZONE_ID;

  // Strip to apex (e.g. sub.example.com → example.com)
  const apex = domain.split('.').slice(-2).join('.');
  const data = await cfRequest(`/zones?name=${encodeURIComponent(apex)}`);
  if (!data.success || data.result.length === 0) return null;
  return data.result[0].id;
}

// ─── DNS records ──────────────────────────────────────────────────────────────

export async function getDnsRecords(zoneId) {
  const data = await cfRequest(`/zones/${zoneId}/dns_records?per_page=200`);
  return data.success ? data.result : [];
}

/**
 * Create a DNS record.
 * @param {string} zoneId
 * @param {{ type, name, content, ttl?, priority?, proxied? }} record
 */
export async function createDnsRecord(zoneId, record) {
  const data = await cfRequest(`/zones/${zoneId}/dns_records`, 'POST', {
    type: record.type,
    name: record.name,
    content: record.content,
    ttl: record.ttl ?? 1,
    priority: record.priority,
    proxied: record.proxied ?? false,
  });

  if (!data.success) {
    return { success: false, error: data.errors?.map(e => e.message).join(', ') };
  }
  return { success: true, record: data.result };
}

export async function deleteDnsRecord(zoneId, recordId) {
  const data = await cfRequest(`/zones/${zoneId}/dns_records/${recordId}`, 'DELETE');
  if (!data.success) {
    return { success: false, error: data.errors?.map(e => e.message).join(', ') };
  }
  return { success: true };
}

/**
 * Upsert a DNS record: delete any existing record(s) with the same name+type, then create.
 */
export async function upsertDnsRecord(zoneId, record) {
  const existing = await getDnsRecords(zoneId);
  const stale = existing.filter(r => r.type === record.type && r.name === record.name);
  for (const r of stale) {
    await deleteDnsRecord(zoneId, r.id);
  }
  return createDnsRecord(zoneId, record);
}

// ─── Resend email DNS setup ───────────────────────────────────────────────────

/**
 * Provision all Resend-required DNS records for a sending domain.
 *
 * Resend uses a `send.<domain>` subdomain for SPF/MX and `resend._domainkey.<domain>` for DKIM.
 *
 * @param {string} domain           The sending domain (e.g. "agentdispatch.io")
 * @param {object} resendValues     Exact values from Resend dashboard
 * @param {string} resendValues.dkimContent   Full DKIM TXT content (p=MIGfMA...)
 * @param {string} resendValues.mxContent     MX mail server (e.g. feedback-smtp.us-east-1.amazonses.com)
 * @param {string} resendValues.spfContent    SPF TXT content (v=spf1 include:...)
 * @param {number} [resendValues.mxPriority]  MX priority (default 10)
 * @param {boolean} [upsert]        If true (default), delete stale records before creating
 */
export async function provisionResendDns(domain, resendValues, upsert = true) {
  const zoneId = await getZoneId(domain);
  if (!zoneId) {
    return {
      success: false,
      records: [],
      error: `Zone not found for ${domain}. Ensure the domain is in your Cloudflare account.`,
    };
  }

  const op = upsert ? upsertDnsRecord : createDnsRecord;
  const results = [];

  const records = [
    {
      label: 'DKIM',
      type: 'TXT',
      name: `resend._domainkey.${domain}`,
      content: resendValues.dkimContent,
    },
    {
      label: 'SPF MX',
      type: 'MX',
      name: `send.${domain}`,
      content: resendValues.mxContent,
      priority: resendValues.mxPriority ?? 10,
    },
    {
      label: 'SPF TXT',
      type: 'TXT',
      name: `send.${domain}`,
      content: resendValues.spfContent,
    },
    {
      label: 'DMARC',
      type: 'TXT',
      name: `_dmarc.${domain}`,
      content: 'v=DMARC1; p=none;',
    },
  ];

  for (const rec of records) {
    const { label, ...params } = rec;
    const result = await op(zoneId, params);
    results.push({ label, type: params.type, name: params.name, ...result });
  }

  return {
    success: results.every(r => r.success),
    zoneId,
    records: results,
  };
}

// ─── Email Routing ────────────────────────────────────────────────────────────

export async function getEmailRoutingSettings(zoneId) {
  try {
    const data = await cfRequest(`/zones/${zoneId}/email/routing`);
    return { enabled: data.success && data.result?.enabled === true, settings: data.result };
  } catch (err) {
    return { enabled: false, error: err.message };
  }
}

export async function enableEmailRouting(zoneId) {
  try {
    const data = await cfRequest(`/zones/${zoneId}/email/routing/enable`, 'POST');
    return { success: data.success };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

export async function getEmailRoutingRules(zoneId) {
  const data = await cfRequest(`/zones/${zoneId}/email/routing/rules`);
  return data.success ? data.result : [];
}

export async function getCatchAllRule(zoneId) {
  try {
    const data = await cfRequest(`/zones/${zoneId}/email/routing/rules/catch_all`);
    return data.success ? data.result : null;
  } catch {
    return null;
  }
}

/**
 * Set the catch-all rule to forward all inbound email to a Worker.
 * @param {string} zoneId
 * @param {string} workerName  Name of the deployed Cloudflare Worker
 */
export async function setCatchAllToWorker(zoneId, workerName) {
  try {
    const data = await cfRequest(`/zones/${zoneId}/email/routing/rules/catch_all`, 'PUT', {
      actions: [{ type: 'worker', value: [workerName] }],
      matchers: [{ type: 'all' }],
      enabled: true,
      name: `Route all to ${workerName}`,
    });
    if (!data.success) {
      return { success: false, error: data.errors?.map(e => e.message).join(', ') };
    }
    return { success: true, rule: data.result };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

export async function createEmailRoutingRule(zoneId, emailAddress, workerName) {
  try {
    const data = await cfRequest(`/zones/${zoneId}/email/routing/rules`, 'POST', {
      actions: [{ type: 'worker', value: [workerName] }],
      matchers: [{ type: 'literal', field: 'to', value: emailAddress }],
      enabled: true,
      name: `Route ${emailAddress} to ${workerName}`,
    });
    if (!data.success) {
      return { success: false, error: data.errors?.map(e => e.message).join(', ') };
    }
    return { success: true, rule: data.result };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

export async function deleteEmailRoutingRule(zoneId, ruleId) {
  try {
    const data = await cfRequest(`/zones/${zoneId}/email/routing/rules/${ruleId}`, 'DELETE');
    return { success: data.success };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Enable Email Routing on a zone and set the catch-all to a Worker.
 * @param {string} domain
 * @param {string} workerName
 */
export async function setupEmailRouting(domain, workerName) {
  const zoneId = await getZoneId(domain);
  if (!zoneId) {
    return { success: false, error: `Zone not found for ${domain}` };
  }

  const status = await getEmailRoutingSettings(zoneId);
  if (!status.enabled) {
    const enable = await enableEmailRouting(zoneId);
    if (!enable.success) console.warn('Could not enable email routing:', enable.error);
  }

  const catchAll = await setCatchAllToWorker(zoneId, workerName);
  return {
    success: catchAll.success,
    zoneId,
    emailRoutingEnabled: true,
    catchAllConfigured: catchAll.success,
    error: catchAll.error,
  };
}
