/**
 * Email address helpers for ADMP agent email addresses
 */

const DEFAULT_DOMAIN = process.env.INBOUND_EMAIL_DOMAIN || 'agentdispatch.io';

/**
 * Compute the inbound email address for an agent.
 *
 * Format:
 *   With tenant:    {tenantId}.{agentId}@{domain}
 *   Without tenant: {agentId}@{domain}
 *
 * @param {string} agentId
 * @param {string|null|undefined} tenantId
 * @param {string} [domain]
 * @returns {string}
 */
export function agentEmailAddress(agentId, tenantId, domain = DEFAULT_DOMAIN) {
  const local = tenantId ? `${tenantId}.${agentId}` : agentId;
  return `${local}@${domain}`;
}
