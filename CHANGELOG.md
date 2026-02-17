# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
with enhanced attribution to track which AI model/CLI made each change.

## [Unreleased]

### Added
- Ephemeral messages with TTL and auto-purge for secure credential distribution (Claude Code, 2026-02-17)
  - **Context:** PR #8
  - **Details:** Messages can auto-delete on ack (`ephemeral: true`) and/or expire after a sender-configured TTL (`ttl: "24h"`). Delivery log preserves metadata (from, subject, purge_reason) after body is purged. Returns 410 Gone for purged messages. Pull-time filtering prevents serving expired secrets. Includes `parseTTL` utility, background purge sweep, and both memory/mech storage backend support.
- ADMP Groups extension for multi-party messaging (2026-02-09)
  - **Context:** Commit 44a9a73
  - **Details:** Group creation, membership management (open, invite-only, key-protected), message fanout to all members, and deduplicated message history.

### Fixed

### Changed

### Deprecated

### Removed

### Security

---

## [1.0.0] - 2026-02-01

### Added
- Initial ADMP implementation with agent registration, Ed25519 keypairs, and message signing
- Message queuing with lease-based at-least-once delivery (pull, ack, nack)
- Webhook push delivery with HMAC-SHA256 signature verification and retry logic
- Heartbeat-based agent status tracking (online/offline)
- Trust management between agents (trusted_agents allowlist)
- Pluggable storage backends: in-memory and Mech (remote NoSQL)
- Background cleanup jobs: lease reclamation, message expiration, expired message deletion
- Comprehensive test suite (24 tests)
- OpenAPI 3.1 spec with Swagger UI at `/docs`
- Fly.io deployment configuration

---

*Changelog initialized 2026-02-17 by Claude Code*
