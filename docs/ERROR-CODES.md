<!-- Generated: 2026-03-01T00:00:00Z -->
<!-- Source: Extracted from Agent Dispatch (ADMP) source files -->

# ADMP Error Codes Reference

Complete reference of all error codes returned by the Agent Dispatch Messaging Protocol API.

---

## Table of Contents

- [Authentication and Authorization Errors](#authentication-and-authorization-errors)
- [Agent Errors](#agent-errors)
- [Message and Inbox Errors](#message-and-inbox-errors)
- [Group Errors](#group-errors)
- [Round Table Errors](#round-table-errors)
- [Outbox (Email) Errors](#outbox-email-errors)
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
| `MASTER_KEY_REQUIRED` | 401 | No | Master API key required for this endpoint | Use the `MASTER_API_KEY` value, not a regular issued key |
| `SIGNATURE_INVALID` | 403 | No | HTTP Signature header verification failed | Verify signing string matches: method, path, host, date headers. Check Ed25519 keypair. **Not the same as `INVALID_SIGNATURE`** — this code is for the HTTP `Signature:` header; `INVALID_SIGNATURE` is for the message envelope `signature` field. |
| `INVALID_SIGNATURE_HEADER` | 400 | No | Signature header missing keyId or signature | Format: `keyId="id",algorithm="ed25519",headers="(request-target) host date",signature="base64"` |
| `UNSUPPORTED_ALGORITHM` | 400 | No | Signature algorithm is not ed25519 | Only ed25519 is supported |
| `INSUFFICIENT_SIGNED_HEADERS` | 400 | No | `(request-target)` not in signed headers | Always include `(request-target)` in the headers param |
| `DATE_HEADER_REQUIRED` | 400 | No | Date header not in signed headers or missing | Include `Date` header and list `date` in signed headers |
| `REQUEST_EXPIRED` | 403 | Yes (with fresh timestamp) | Date header outside +/-5 minute window | Ensure system clock is synced. Regenerate `Date` header and re-sign |
| `SIGNATURE_VERIFICATION_FAILED` | 400 | No | General signature verification error (catch-all) | Check signing string construction. Covers parse errors and unexpected failures. |
| `REGISTRATION_PENDING` | 403 | Yes (after approval) | Agent registration awaiting admin approval | Contact admin or wait for `POST /:agentId/approve` |
| `REGISTRATION_REJECTED` | 403 | No | Agent registration was rejected | Contact admin. Check rejection reason in the agent record |
| `FORBIDDEN` | 403 | No | Signature keyId doesn't match target agent | Agent can only access its own resources (except sending to others' inboxes) |
| `ENROLLMENT_TOKEN_USED` | 403 | No | Single-use enrollment token already consumed | Request a new enrollment token |
| `ENROLLMENT_TOKEN_SCOPE` | 403 | No | Token scoped to a different agent | Use the token only for the agent specified in `target_agent_id` |
| `INVALID_SIGNATURE` | 403 | No | Message-level envelope signature verification failed | Check the `signature` field in the message envelope body. **Not the same as `SIGNATURE_INVALID`** |

---

## Agent Errors

| Code | HTTP | Retryable | Description | Hint |
|------|------|-----------|-------------|------|
| `REGISTRATION_FAILED` | 400 | No | Agent registration failed | Check `agent_id` uniqueness, length (max 255 chars, checked before regex), character set (`^[a-zA-Z0-9._:-]+$`), reserved prefixes (`did:` and `agent:` are not allowed at the start of a registered ID), and required fields |
| `AGENT_NOT_FOUND` | 404 | No | Agent ID not found in storage | Verify `agent_id` is correct and agent is registered |
| `AGENT_ID_REQUIRED` | 400 | No | No agent ID provided | Include `agent_id` in URL path or `X-Agent-ID` header |
| `HEARTBEAT_FAILED` | 400 | Yes | Heartbeat update failed | Verify agent exists |
| `DEREGISTER_FAILED` | 400 | No | Agent deregistration failed | Verify agent exists |
| `ADD_TRUSTED_FAILED` | 400 | No | Failed to add trusted agent | Check both agent IDs exist |
| `REMOVE_TRUSTED_FAILED` | 400 | No | Failed to remove trusted agent | Verify trust relationship exists |
| `GET_WEBHOOK_FAILED` | 400 | No | Failed to get webhook config | Check agent exists |
| `WEBHOOK_URL_REQUIRED` | 400 | No | No webhook URL provided | Include `webhook_url` in request body |
| `WEBHOOK_CONFIG_FAILED` | 400 | No | Webhook configuration failed | Check URL format and agent exists |
| `REMOVE_WEBHOOK_FAILED` | 400 | No | Webhook removal failed | Verify agent exists |
| `LIST_GROUPS_FAILED` | 400 | No | Failed to list agent groups | Check agent exists |
| `KEY_ROTATION_FAILED` | 400 | No | Key rotation failed | Only seed-based agents support rotation. Verify seed matches current key |
| `SEED_MISMATCH` | 403 | No | Provided seed doesn't match current key | The seed must derive the agent's current public key |
| `SEED_AND_TENANT_REQUIRED` | 400 | No | Missing seed or tenant_id for rotation | Provide both `seed` and `tenant_id` |
| `APPROVE_FAILED` | 400 | No | Agent approval failed | Check agent exists |
| `REJECT_FAILED` | 400 | No | Agent rejection failed | Check agent exists |
| `INVALID_REASON` | 400 | No | Rejection reason not a string | Must be a string |
| `REASON_TOO_LONG` | 400 | No | Rejection reason too long | Max 500 characters |

---

## Message and Inbox Errors

> **Note:** The `SEND_FAILED` code appears in both this section (inbox message send) and [Outbox (Email) Errors](#outbox-email-errors) (outbound email send). The two contexts have different retry semantics — check the endpoint that returned the error to determine the correct handling.

| Code | HTTP | Retryable | Description | Hint |
|------|------|-----------|-------------|------|
| `SEND_FAILED` | 400 | Yes | Inbox message send failed | Check envelope format, recipient exists, signature valid |
| `RECIPIENT_NOT_FOUND` | 404 | No | Target agent not found | Verify recipient `agent_id` |
| `INVALID_TIMESTAMP` | 400 | No | Message timestamp invalid or outside window | Use ISO-8601 format. Timestamp must be within +/- 5 minutes |
| `PULL_FAILED` | 400 | Yes | Inbox pull failed | Verify agent exists and has messages |
| `ACK_FAILED` | 400 | No | Message acknowledgment failed | Ensure message is leased to this agent and in `leased` status |
| `NACK_FAILED` | 400 | No | Message negative ack failed | Ensure message is leased to this agent |
| `REPLY_FAILED` | 400 | No | Reply failed | Verify original message exists |
| `MESSAGE_NOT_FOUND` | 404 | No | Message ID not found | Message may have been acked or expired |
| `MESSAGE_EXPIRED` | 410 | No | Message purged (ephemeral or TTL) | Message data is gone permanently |
| `STATS_FAILED` | 500 | Yes | Failed to retrieve inbox stats | Transient storage error. **Note:** This code also appears in [System Errors](#system-errors) for the `GET /api/stats` endpoint |
| `RECLAIM_FAILED` | 400 | Yes | Lease reclaim failed | Transient error, retry |

---

## Group Errors

| Code | HTTP | Retryable | Description | Hint |
|------|------|-----------|-------------|------|
| `CREATE_GROUP_FAILED` | 400 | No | Group creation failed | Check name format |
| `INVALID_NAME` | 400 | No | Group name empty or invalid | Non-empty string required |
| `NAME_TOO_LONG` | 400 | No | Group name exceeds 100 chars | Shorten the name |
| `INVALID_NAME_CHARS` | 400 | No | Name has invalid characters | Only letters, numbers, spaces, hyphens, underscores, periods allowed |
| `GROUP_NOT_FOUND` | 404 | No | Group not found | Verify group ID |
| `GET_GROUP_FAILED` | 400/404 | No | Failed to get group | Check group ID |
| `UPDATE_GROUP_FAILED` | 400/403 | No | Group update failed | Must be owner or admin |
| `DELETE_GROUP_FAILED` | 400/403 | No | Group deletion failed | Must be owner |
| `LIST_MEMBERS_FAILED` | 400/403 | No | Cannot list members | Must be a group member |
| `ADD_MEMBER_FAILED` | 400/403/409 | No | Cannot add member | Need admin/owner role, member limit not reached |
| `REMOVE_MEMBER_FAILED` | 400/403 | No | Cannot remove member | Cannot remove group owner |
| `JOIN_FAILED` | 400/403 | No | Cannot join group | Check access type (open/key/invite-only) and key validity |
| `LEAVE_FAILED` | 400 | No | Cannot leave group | Owner cannot leave; transfer ownership first |
| `POST_MESSAGE_FAILED` | 400/403 | No | Cannot post to group | Must be a member |
| `INVALID_MESSAGE` | 400 | No | Missing subject or body | Both `subject` and `body` required |
| `INVALID_SUBJECT` | 400 | No | Subject too long | Max 200 characters |
| `BODY_TOO_LARGE` | 400 | No | Message body exceeds 1MB | Reduce body size |
| `GET_MESSAGES_FAILED` | 400/403 | No | Cannot get messages | Must be a member |

---

## Round Table Errors

| Code | HTTP | Retryable | Description | Hint |
|------|------|-----------|-------------|------|
| `INVALID_TOPIC` | 400 | No | topic is missing or empty | Provide a non-empty string of at most 500 characters |
| `TOPIC_TOO_LONG` | 400 | No | topic exceeds 500 characters | Shorten the topic |
| `INVALID_GOAL` | 400 | No | goal is missing or empty | Provide a non-empty string of at most 500 characters |
| `GOAL_TOO_LONG` | 400 | No | goal exceeds 500 characters | Shorten the goal |
| `INVALID_PARTICIPANTS` | 400 | No | participants is missing or not a non-empty array | Provide at least one participant agent ID |
| `INVALID_PARTICIPANT_ID` | 400 | No | A participant entry is not a valid string or exceeds 255 chars | Each participant must be a registered agent ID |
| `INVALID_TIMEOUT` | 400 | No | timeout_minutes is not an integer | Must be an integer between 1 and 10080 (7 days) |
| `FACILITATOR_IN_PARTICIPANTS` | 400 | No | The calling agent (facilitator) is listed as a participant | Remove the facilitator's own agent ID from participants |
| `CREATE_ROUND_TABLE_FAILED` | 400 | No | Round Table creation failed | Most commonly: no participants could be enrolled (all provided IDs are unregistered). The backing group is cleaned up automatically. |
| `GET_ROUND_TABLE_FAILED` | 403/404 | No | Session not found or caller is not a participant | Verify the session ID. Only the facilitator and enrolled participants can read a session. |
| `SPEAK_FAILED` | 403/404/409 | No | Cannot speak into session | 403: caller is not an enrolled participant. 404: session not found. 409: session is resolved/expired, or thread has reached the 200-entry limit. |
| `RESOLVE_FAILED` | 400/403/404/409 | No | Cannot resolve session | 400: outcome is missing. 403: caller is not the facilitator. 404: session not found. 409: session is already resolved or expired. |
| `LIST_ROUND_TABLES_FAILED` | 500 | Yes | Transient error listing Round Tables | Retry with backoff |

---

## Outbox (Email) Errors

| Code | HTTP | Retryable | Description | Hint |
|------|------|-----------|-------------|------|
| `DOMAIN_CONFIG_FAILED` | 400/409 | No | Domain configuration failed | Agent may already have a domain (409 Conflict) |
| `DOMAIN_REQUIRED` | 400 | No | No domain provided | Include `domain` in request body |
| `NO_DOMAIN` | 404 | No | No domain configured for agent | Configure domain first via `POST /outbox/domain` |
| `DOMAIN_FETCH_FAILED` | 500 | Yes | Failed to fetch domain config | Transient error |
| `DOMAIN_VERIFY_FAILED` | 400/404 | Yes | DNS verification failed | Check DNS records are set correctly. DNS propagation may take time |
| `DOMAIN_DELETE_FAILED` | 400/404 | No | Domain removal failed | Check domain exists |
| `SEND_FAILED` | 400/403/404 | Depends | Outbox email send failed | Domain must be verified (403). Check recipient format. See also inbox variant. |
| `TO_REQUIRED` | 400 | No | No recipient email | Include `to` field |
| `INVALID_EMAIL` | 400 | No | Invalid email format | Use valid email: `user@domain.com` |
| `SUBJECT_REQUIRED` | 400 | No | No email subject | Include `subject` field |
| `BODY_REQUIRED` | 400 | No | No body or html content | Include `body` or `html` field |
| `OUTBOX_MESSAGE_NOT_FOUND` | 404 | No | Outbox message not found | Check message ID |
| `OUTBOX_FETCH_FAILED` | 500 | Yes | Failed to fetch outbox data | Transient error |
| `FORBIDDEN` | 403 | No | Message belongs to a different agent | Agent can only access its own outbox messages |

---

## Tenant Errors

| Code | HTTP | Retryable | Description | Hint |
|------|------|-----------|-------------|------|
| `TENANT_ID_REQUIRED` | 400 | No | No `tenant_id` provided | Include `tenant_id` in body |
| `TENANT_EXISTS` | 409 | No | Tenant already exists | Use a different `tenant_id` |
| `TENANT_NOT_FOUND` | 404 | No | Tenant not found | Check `tenant_id` |
| `INVALID_REGISTRATION_POLICY` | 400 | No | Invalid policy value | Must be `open` or `approval_required` |
| `CREATE_TENANT_FAILED` | 400 | No | Tenant creation failed | Check required fields |
| `GET_TENANT_FAILED` | 400 | No | Failed to get tenant | Check `tenant_id` |
| `DELETE_TENANT_FAILED` | 400 | No | Tenant deletion failed | Verify tenant exists |
| `LIST_TENANT_AGENTS_FAILED` | 400 | No | Failed to list tenant agents | Check `tenant_id` |
| `LIST_PENDING_FAILED` | 400 | No | Failed to list pending agents | Check `tenant_id` and master key |

---

## System Errors

| Code | HTTP | Retryable | Description | Hint |
|------|------|-----------|-------------|------|
| `NOT_FOUND` | 404 | No | Endpoint doesn't exist | Check URL path |
| `INTERNAL_ERROR` | 500 | Yes | Unhandled server error | Transient, retry with backoff |
| `STATS_FAILED` | 500 | Yes | System stats retrieval failed | Transient error. **Note:** This code also appears in [Message and Inbox Errors](#message-and-inbox-errors) for `GET /api/agents/:agentId/inbox/stats` |
| `DISCOVERY_FAILED` | 500 | Yes | Public key directory failed | Transient error |
| `DID_DOCUMENT_FAILED` | 500 | Yes | DID document generation failed | Transient error |
| `WEBHOOK_FAILED` | 500 | Yes | Mailgun webhook processing failed | Transient error |
| `SIGNATURE_REQUIRED` | 400 | No | Mailgun webhook missing signature | Signing key is configured but no signature in request |

---

## Identity Verification Errors

| Code | HTTP | Retryable | Description | Hint |
|------|------|-----------|-------------|------|
| `GITHUB_LINK_FAILED` | 400 | No | GitHub handle linking failed | Check handle format |
| `CRYPTOGRAPHIC_VERIFY_FAILED` | 400 | No | Cryptographic tier verification failed | Agent must have a DID (seed-based registration) |
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
  "message": "API key is required"
}
```

```json
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "error": "REGISTRATION_FAILED",
  "message": "agent_id may only contain letters, numbers, dots, underscores, hyphens, and colons"
}
```

```json
HTTP/1.1 404 Not Found
Content-Type: application/json

{
  "error": "AGENT_NOT_FOUND",
  "message": "Agent my-agent not found"
}
```

```json
HTTP/1.1 500 Internal Server Error
Content-Type: application/json

{
  "error": "INTERNAL_ERROR",
  "message": "Internal server error"
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
| **403** | Authorization issue | The caller lacks permission. Do not retry, except for `REQUEST_EXPIRED` (re-sign with fresh Date) and `REGISTRATION_PENDING` (retry after approval). |
| **404** | Resource not found | Verify the resource ID (agent, message, group, tenant). Do not retry unless the resource is expected to be created by another process. |
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

- **`REQUEST_EXPIRED` (403)**: Retryable, but you must regenerate the `Date` header and re-sign the request with a fresh timestamp. Simply replaying the same request will fail again.
- **`REGISTRATION_PENDING` (403)**: Retryable after the agent has been approved by an admin. Poll infrequently (e.g., every 30 seconds) or use a webhook/callback if available.
- **`SEND_FAILED` in outbox context (400/403/404)**: Retryability depends on the underlying cause. A 403 (unverified domain) is not retryable until the domain is verified. A transient 500 is retryable.
- **`DOMAIN_VERIFY_FAILED` (400/404)**: DNS propagation may take time. Retry after a delay (e.g., 60 seconds) if you have just configured DNS records.
- **`REGISTRATION_FAILED` agent_id validation**: If you receive this because of an invalid `agent_id`, check all three constraints in order: (1) the `agent_id` must be 255 characters or fewer; (2) it must match `^[a-zA-Z0-9._:-]+$`; (3) it must not start with `did:` or `agent:` (reserved prefixes that protect system-generated DID identifiers). Slashes, spaces, and `agent://` prefixes are not valid registered agent IDs.
