/**
 * Email address helpers for ADMP agent email addresses
 */

/**
 * Compute the inbound email address for an agent.
 *
 * Format: {agentId}@{domain}
 *
 * Tenant/org grouping is an internal concept and is never encoded in the address.
 *
 * @param {string} agentId
 * @param {string} [domain] - defaults to INBOUND_EMAIL_DOMAIN env var
 * @returns {string}
 */
export function agentEmailAddress(agentId, domain) {
  const d = domain ?? (process.env.INBOUND_EMAIL_DOMAIN || 'agentdispatch.io');
  return `${agentId}@${d}`;
}
