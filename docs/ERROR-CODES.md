<!-- Generated: 2026-02-25T16:22:00Z -->
<!-- Source: Extracted from Agent Dispatch (ADMP) source files -->

# ADMP Error Codes Reference

Complete reference of all error codes returned by the Agent Dispatch Messaging Protocol API.

---

## Table of Contents

- [Authentication and Authorization Errors](#authentication-and-authorization-errors)
- [Agent Errors](#agent-errors)
- [Message and Inbox Errors](#message-and-inbox-errors)
- [Group Errors](#group-errors)
- [Outbox (Email) Errors](#outbox-email-errors)
- [Admin / Key Management Errors](#admin--key-management-errors)
- [Tenant Errors](#tenant-errors)
- [System Errors](#system-errors)
- [Identity Verification Errors](#identity-verification-errors)
- [Error Response Format](#error-response-format)
- [Retry Guidance](#retry-guidance)

---

## Authentication and Authorization Errors

| Code | HTTP | Retryable | Description | Hint |
|------|------|-----------|-------------|------|
| `API_KEY_REQUIRED` | 401 | No | No API key provided | Include `X-Api-Key` header or `Authorization: Bearer` |
| `INVALID_API_KEY` | 401 | No | API key not recognized or expired | Check key is correct and not expired. Expired keys return this same error to avoid leaking key existence |
| `MASTER_KEY_REQUIRED` | 401 | No | Endpoint requires the master API key | Use `MASTER_API_KEY` for admin endpoints (key issuance, approval) |
| `SIGNATURE_INVALID` | 403 | No | HTTP Signature header verification failed | Verify signing string matches: method, path, host, date headers. Check Ed25519 keypair. **Not the same as `INVALID_SIGNATURE`** — this code is for the HTTP `Signature:` header; `INVALID_SIGNATURE` is for the message envelope `signature` field. |
| `INVALID_SIGNATURE_HEADER` | 400 | No | Signature header missing keyId or signature | Format: `keyId="id",algorithm="ed25519",headers="(request-target) host date",signature="base64"` |
| `UNSUPPORTED_ALGORITHM` | 400 | No | Signature algorithm is not ed25519 | Only ed25519 is supported |
| `INSUFFICIENT_SIGNED_HEADERS` | 400 | No | `(request-target)` not in signed headers | Always include `(request-target)` in the headers param |
| `DATE_HEADER_REQUIRED` | 400 | No | Date header not in signed headers or missing | Include `Date` header and list `date` in signed headers |
| `REQUEST_EXPIRED` | 403 | Yes (with fresh timestamp) | Date header outside +/-5 minute window | Ensure system clock is synced. Regenerate `Date` header |
| `SIGNATURE_VERIFICATION_FAILED` | 400 | No | General signature verification error (catch-all) | Check signing string construction. Distinct from `SIGNATURE_INVALID` (specific Ed25519 mismatch) — this covers parse errors and unexpected failures. |
| `REGISTRATION_PENDING` | 403 | Yes (after approval) | Agent registration awaiting admin approval | Contact admin or wait for `POST /:agentId/approve` |
| `REGISTRATION_REJECTED` | 403 | No | Agent registration was rejected | Contact admin. Check `rejection_reason` |
| `FORBIDDEN` | 403 | No | Signature keyId doesn't match target agent | Agent can only access its own resources |
| `ENROLLMENT_TOKEN_USED` | 403 | No | Single-use enrollment token already consumed | Request a new enrollment token |
| `ENROLLMENT_TOKEN_SCOPE` | 403 | No | Token scoped to a different agent | Use the token only for the agent specified in `target_agent_id` |
| `INVALID_SIGNATURE` | 403 | No | Message-level envelope signature verification failed | Check the `signature` field in the message envelope body. **Not the same as `SIGNATURE_INVALID`** — this code is for the message envelope `signature` field; `SIGNATURE_INVALID` is for the HTTP `Signature:` header. |

## Agent Errors

| Code | HTTP | Retryable | Description | Hint |
|------|------|-----------|-------------|------|
| `REGISTRATION_FAILED` | 400 | No | Agent registration failed | Check `agent_id` uniqueness, required fields |
| `AGENT_NOT_FOUND` | 404 | No | Agent ID not found in storage | Verify `agent_id` is correct and agent is registered |
| `AGENT_ID_REQUIRED` | 400 | No | No agent ID provided | Include `agent_id` in URL path or `X-Agent-ID` header |
| `HEARTBEAT_FAILED` | 400 | Yes | Heartbeat update failed | Verify agent exists |
| `DEREGISTER_FAILED` | 400 | No | Agent deregistration failed | Verify agent exists |
| `ADD_TRUSTED_FAILED` | 400 | No | Failed to add trusted agent | Check both agent IDs exist |
| `REMOVE_TRUSTED_FAILED` | 400 | No | Failed to remove trusted agent | Verify trust relationship exists |
| `KEY_ROTATION_FAILED` | 400 | No | Key rotation failed | Only seed-based agents support rotation. Verify seed matches current key |
| `SEED_MISMATCH` | 403 | No | Provided seed doesn't match current key | The seed must derive the agent's current public key |
| `SEED_AND_TENANT_REQUIRED` | 400 | No | Missing seed or tenant_id for rotation | Provide both `seed` and `tenant_id` |

## Message and Inbox Errors

> **Note:** The `SEND_FAILED` code appears in both this section (inbox message send) and [Outbox (Email) Errors](#outbox-email-errors) (outbound email send). The two contexts have different retry semantics — check the endpoint that returned the error to determine the correct handling.

| Code | HTTP | Retryable | Description | Hint |
|------|------|-----------|-------------|------|
| `SEND_FAILED` | 400 | Yes | Inbox message send failed | Check envelope format, recipient exists |
| `RECIPIENT_NOT_FOUND` | 404 | No | Target agent not found | Verify recipient `agent_id` |
| `INVALID_TIMESTAMP` | 400 | No | Message timestamp invalid | Use ISO-8601 format |
| `PULL_FAILED` | 400 | Yes | Inbox pull failed | Verify agent exists and has messages |
| `ACK_FAILED` | 400 | No | Message acknowledgment failed | Ensure message is leased to this agent |
| `NACK_FAILED` | 400 | No | Message negative ack failed | Ensure message is leased to this agent |
| `REPLY_FAILED` | 400 | No | Reply failed | Verify original message exists |
| `MESSAGE_NOT_FOUND` | 404 | No | Message ID not found | Message may have been acked or expired |
| `MESSAGE_EXPIRED` | 410 | No | Message purged (ephemeral or TTL) | Message data is gone permanently |
| `STATS_FAILED` | 500 | Yes | Failed to retrieve inbox stats | Transient storage error. **Note:** This code also appears in [System Errors](#system-errors) for the `GET /api/stats` endpoint — context determines which endpoint failed. |
| `RECLAIM_FAILED` | 400 | Yes | Lease reclaim failed | Transient error, retry |

## Group Errors

| Code | HTTP | Retryable | Description | Hint |
|------|------|-----------|-------------|------|
| `CREATE_GROUP_FAILED` | 400 | No | Group creation failed | Check name format (alphanumeric, max 100 chars) |
| `INVALID_NAME` | 400 | No | Group name empty or invalid | Non-empty string required |
| `NAME_TOO_LONG` | 400 | No | Group name exceeds 100 chars | Shorten the name |
| `INVALID_NAME_CHARS` | 400 | No | Name has invalid characters | Only letters, numbers, spaces, hyphens, underscores, periods |
| `GROUP_NOT_FOUND` | 404 | No | Group not found | Verify group ID |
| `GET_GROUP_FAILED` | 400/404 | No | Failed to get group | Check group ID |
| `UPDATE_GROUP_FAILED` | 400/403 | No | Group update failed | Must be owner or admin |
| `DELETE_GROUP_FAILED` | 400/403 | No | Group deletion failed | Must be owner |
| `LIST_MEMBERS_FAILED` | 400/403 | No | Cannot list members | Must be a group member |
| `ADD_MEMBER_FAILED` | 400/403/409 | No | Cannot add member | Need admin/owner role, member limit not reached |
| `REMOVE_MEMBER_FAILED` | 400/403 | No | Cannot remove member | Cannot remove group owner |
| `JOIN_FAILED` | 400/403 | No | Cannot join group | Check access type (open/key/invite-only) |
| `LEAVE_FAILED` | 400 | No | Cannot leave group | Owner cannot leave |
| `POST_MESSAGE_FAILED` | 400/403 | No | Cannot post to group | Must be a member |
| `INVALID_MESSAGE` | 400 | No | Missing subject or body | Both `subject` and `body` required |
| `INVALID_SUBJECT` | 400 | No | Subject too long | Max 200 characters |
| `BODY_TOO_LARGE` | 400 | No | Message body exceeds 1MB | Reduce body size |
| `GET_MESSAGES_FAILED` | 400/403 | No | Cannot get messages | Must be a member |

## Outbox (Email) Errors

| Code | HTTP | Retryable | Description | Hint |
|------|------|-----------|-------------|------|
| `DOMAIN_CONFIG_FAILED` | 400/409 | No | Domain configuration failed | Agent may already have a domain |
| `DOMAIN_REQUIRED` | 400 | No | No domain provided | Include `domain` in request body |
| `NO_DOMAIN` | 404 | No | No domain configured for agent | Configure domain first |
| `DOMAIN_FETCH_FAILED` | 500 | Yes | Failed to fetch domain config | Transient error |
| `DOMAIN_VERIFY_FAILED` | 400/404 | Yes | DNS verification failed | Check DNS records are set correctly |
| `DOMAIN_DELETE_FAILED` | 400/404 | No | Domain removal failed | Check domain exists |
| `SEND_FAILED` | 400/403/404 | Depends | Outbox email send failed (see also [Message and Inbox Errors](#message-and-inbox-errors) for the inbox variant) | Domain must be verified. Check recipient format |
| `TO_REQUIRED` | 400 | No | No recipient email | Include `to` field |
| `INVALID_EMAIL` | 400 | No | Invalid email format | Use valid email: `user@domain.com` |
| `SUBJECT_REQUIRED` | 400 | No | No email subject | Include `subject` field |
| `BODY_REQUIRED` | 400 | No | No body or html content | Include `body` or `html` field |
| `OUTBOX_MESSAGE_NOT_FOUND` | 404 | No | Outbox message not found | Check message ID |
| `OUTBOX_FETCH_FAILED` | 500 | Yes | Failed to fetch outbox data | Transient error |

## Admin / Key Management Errors

| Code | HTTP | Retryable | Description | Hint |
|------|------|-----------|-------------|------|
| `INVALID_CLIENT_ID` | 400 | No | `client_id` missing or invalid format | Must be 1-100 chars matching `/^[a-zA-Z0-9_-]+$/` |
| `INVALID_EXPIRES_IN_DAYS` | 400 | No | `expires_in_days` invalid | Must be a positive finite number |
| `INVALID_DESCRIPTION` | 400 | No | Description too long | Max 500 characters |
| `KEY_ISSUANCE_FAILED` | 500 | Yes | Key creation failed | Transient storage error |
| `KEY_NOT_FOUND` | 404 | No | Key ID not found | Check `key_id` |
| `LIST_KEYS_FAILED` | 500 | Yes | Failed to list keys | Transient error |
| `REVOKE_KEY_FAILED` | 500 | Yes | Key revocation failed | Transient error |

## Tenant Errors

| Code | HTTP | Retryable | Description | Hint |
|------|------|-----------|-------------|------|
| `TENANT_ID_REQUIRED` | 400 | No | No `tenant_id` provided | Include `tenant_id` in body |
| `TENANT_EXISTS` | 409 | No | Tenant already exists | Use a different `tenant_id` |
| `TENANT_NOT_FOUND` | 404 | No | Tenant not found | Check `tenant_id` |
| `INVALID_REGISTRATION_POLICY` | 400 | No | Invalid policy value | Must be `open` or `approval_required` |
| `CREATE_TENANT_FAILED` | 400 | No | Tenant creation failed | Check required fields |
| `DELETE_TENANT_FAILED` | 400 | No | Tenant deletion failed | Verify tenant exists |
| `LIST_PENDING_FAILED` | 400 | No | Failed to list pending agents | Check `tenant_id` |
| `APPROVE_FAILED` | 400 | No | Agent approval failed | Check agent exists |
| `REJECT_FAILED` | 400 | No | Agent rejection failed | Check agent exists |
| `INVALID_REASON` | 400 | No | Rejection reason not a string | Must be a string |
| `REASON_TOO_LONG` | 400 | No | Rejection reason too long | Max 500 characters |

## System Errors

| Code | HTTP | Retryable | Description | Hint |
|------|------|-----------|-------------|------|
| `NOT_FOUND` | 404 | No | Endpoint doesn't exist | Check URL path |
| `INTERNAL_ERROR` | 500 | Yes | Unhandled server error | Transient, retry with backoff |
| `STATS_FAILED` | 500 | Yes | System stats retrieval failed | Transient error. **Note:** This code also appears in [Message and Inbox Errors](#message-and-inbox-errors) for `GET /api/agents/:agentId/inbox/stats` — context determines which endpoint failed. |
| `DISCOVERY_FAILED` | 500 | Yes | Public key directory failed | Transient error |
| `DID_DOCUMENT_FAILED` | 500 | Yes | DID document generation failed | Transient error |
| `WEBHOOK_FAILED` | 500 | Yes | Mailgun webhook processing failed | Transient error |
| `SIGNATURE_REQUIRED` | 400 | No | Mailgun webhook missing signature | Signing key is configured but no signature in request |

## Identity Verification Errors

| Code | HTTP | Retryable | Description | Hint |
|------|------|-----------|-------------|------|
| `GITHUB_LINK_FAILED` | 400 | No | GitHub handle linking failed | Check handle format |
| `CRYPTOGRAPHIC_VERIFY_FAILED` | 400 | No | Cryptographic tier verification failed | Agent must have a DID |
| `GET_IDENTITY_FAILED` | 400 | No | Failed to get identity info | Check agent exists |

---

## Error Response Format

All API errors return a consistent JSON structure:

```json
{
  "error": "ERROR_CODE",
  "message": "Human-readable description"
}
```

The `error` field contains one of the error codes listed in this document. The `message` field provides a human-readable explanation suitable for logging or developer-facing output. Do not rely on the exact wording of `message` for programmatic logic; always match on `error`.

**Example responses:**

```json
HTTP/1.1 401 Unauthorized
Content-Type: application/json

{
  "error": "API_KEY_REQUIRED",
  "message": "No API key provided"
}
```

```json
HTTP/1.1 404 Not Found
Content-Type: application/json

{
  "error": "AGENT_NOT_FOUND",
  "message": "Agent ID not found in storage"
}
```

```json
HTTP/1.1 500 Internal Server Error
Content-Type: application/json

{
  "error": "INTERNAL_ERROR",
  "message": "Unhandled server error"
}
```

---

## Retry Guidance

Not all errors should be retried. Use the HTTP status code and the **Retryable** column in the tables above to determine the correct behavior.

### By HTTP Status Code

| Status | Category | Action |
|--------|----------|--------|
| **400** | Client error | Fix the request before retrying. The request is malformed or missing required fields. |
| **401** | Authentication issue | Check credentials. Verify the API key or bearer token is correct and not expired. |
| **403** | Authorization issue | The caller lacks permission. Do not retry, except for `REQUEST_EXPIRED` which can be retried with a fresh `Date` header and regenerated signature. `REGISTRATION_PENDING` can be retried after the agent is approved. |
| **404** | Resource not found | Verify the resource ID (agent, message, group, key, tenant). Do not retry unless the resource is expected to be created by another process. |
| **409** | Conflict | The resource already exists. Use a different identifier or retrieve the existing resource. |
| **410** | Gone permanently | The resource has been permanently removed (e.g., expired messages). Do not retry. |
| **500** | Server error | Retry with exponential backoff. Start at 1 second, double each attempt, cap at 30 seconds. Include jitter to avoid thundering herd. |

### Recommended Backoff Strategy

For retryable 500-class errors:

```
attempt 1: wait 1s  (+/- jitter)
attempt 2: wait 2s  (+/- jitter)
attempt 3: wait 4s  (+/- jitter)
attempt 4: wait 8s  (+/- jitter)
attempt 5: wait 16s (+/- jitter)
attempt 6: wait 30s (+/- jitter)  <-- cap
```

After 5-6 attempts, log the error and alert. Continued retries are unlikely to succeed and may indicate a systemic issue.

### Special Cases

- **`REQUEST_EXPIRED` (403)**: Retryable, but you must regenerate the `Date` header and re-sign the request. Simply replaying the same request will fail again.
- **`REGISTRATION_PENDING` (403)**: Retryable after the agent has been approved by an admin. Poll infrequently (e.g., every 30 seconds) or use a webhook/callback if available.
- **`SEND_FAILED` in outbox context (400/403/404)**: Retryability depends on the underlying cause. A 403 (unverified domain) is not retryable until the domain is verified. A transient 500 is retryable.
- **`DOMAIN_VERIFY_FAILED` (400/404)**: DNS propagation may take time. Retry after a delay (e.g., 60 seconds) if you have just configured DNS records.
