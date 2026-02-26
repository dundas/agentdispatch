# CLAUDE.md

Guidance for coding agents working in this public repository.

## Project Summary

Agent Dispatch (ADMP) is an inbox-first messaging protocol for autonomous agents.

Core goals:
- Reliable send/pull/ack/nack message flow
- Transport-agnostic envelope format
- Deterministic delivery semantics
- Security defaults suitable for internet-facing deployments

## Repository Focus

Primary implementation and docs live in:
- `src/` — server code (routes, services, middleware, storage adapters)
- `docs/` — API and operator documentation
- `README.md` — setup, usage, and architecture overview
- `whitepaper/` — protocol specification
- `discovery/` — research and design notes

## Development Workflow

1. Keep changes scoped and minimal.
2. Add or update tests for behavior changes.
3. Run tests before submitting changes:
   - `npm test`
4. Prefer small, focused commits with clear messages.

## Security and Operations Expectations

When changing auth, transport, or federation paths:
- Preserve signature verification invariants.
- Avoid relaxing input validation without explicit rationale.
- Keep SSRF protections intact for `did:web` resolution.
- Document behavior changes in `docs/AGENT-GUIDE.md` and/or `README.md`.

When changing deployment defaults:
- Call out persistence expectations for `STORAGE_BACKEND`.
- Avoid permissive `CORS_ORIGIN` defaults in production unless explicitly documented.

## Contribution Notes

- Follow `CONTRIBUTING.md`.
- Prefer portable paths and generic placeholders in examples.
- Do not commit local machine paths, credentials, or private environment details.
