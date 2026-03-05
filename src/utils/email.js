/**
 * Email address helpers for ADMP agent email addresses
 */

/**
 * Compute the inbound email address for an agent.
 *
 * Format:
 *   With tenant:    {tenantId}.{agentId}@{domain}
 *   Without tenant: {agentId}@{domain}
 *
 * @param {string} agentId
 * @param {string|null|undefined} tenantId
 * @param {string} [domain] - defaults to INBOUND_EMAIL_DOMAIN env var, read at call time
 * @returns {string}
 */
export function agentEmailAddress(agentId, tenantId, domain) {
  const d = domain ?? (process.env.INBOUND_EMAIL_DOMAIN || 'agentdispatch.io');
  const local = tenantId ? `${tenantId}.${agentId}` : agentId;
  return `${local}@${d}`;
}
