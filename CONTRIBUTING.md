# Contributing to Agent Dispatch (ADMP)

Thank you for your interest in contributing to the Agent Dispatch Messaging Protocol.

## Ways to Contribute

- **Bug reports** — Open an issue describing the problem and steps to reproduce
- **Protocol improvements** — Propose changes to the ADMP spec via issues/PRs
- **New storage backends** — Implement and share your own persistent backend
- **Documentation** — Fix typos, clarify examples, add guides
- **Tests** — Improve coverage, add edge cases

## Development Setup

```bash
# Install dependencies
npm install

# Run with in-memory storage (no external deps)
STORAGE_BACKEND=memory npm start

# Run tests
STORAGE_BACKEND=memory node --test src/server.test.js
```

## Storage Backends

The server ships with an in-memory backend. To add a custom persistent backend:

1. Implement the interface defined in `src/storage/memory.js`
2. Add a `case` for your backend name in `src/storage/index.js`
3. Set `STORAGE_BACKEND=your-backend` in your environment

## Pull Requests

1. Fork the repo and create a feature branch from `main`
2. Add tests for any new behavior
3. Ensure all tests pass: `STORAGE_BACKEND=memory node --test src/server.test.js`
4. Open a PR with a clear description of the change

## Protocol Changes

Changes to the ADMP protocol spec (`whitepaper/v1.md`) should be discussed in an issue first. Breaking changes require a version bump and migration notes.

## Code of Conduct

Be respectful. Focus on the technical merits of proposed changes.
