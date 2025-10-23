# Contributing to ADMP

Thank you for your interest in contributing to the Agent Dispatch Messaging Protocol! ADMP is an open protocol — the more implementations and use cases, the stronger the ecosystem becomes.

## Ways to Contribute

### 1. **Code Contributions**
- Bug fixes
- Feature implementations
- Performance improvements
- Additional language SDKs
- Storage backend implementations
- Transport bindings

### 2. **Documentation**
- Tutorials and guides
- API examples
- Architecture diagrams
- Translation to other languages

### 3. **Examples**
- Real-world use cases
- Integration patterns
- Best practices demonstrations

### 4. **Testing**
- Compliance test cases
- Load testing scenarios
- Security audits

### 5. **Community**
- Answer questions in discussions
- Review pull requests
- Share your ADMP projects

---

## Getting Started

### Development Setup

```bash
# Fork and clone the repository
git clone https://github.com/YOUR_USERNAME/agent-dispatch.git
cd agent-dispatch

# Install dependencies
npm install

# Start services
npm run docker:up

# Run tests
npm test

# Build packages
npm run build
```

### Project Structure

```
agent-dispatch/
├── packages/          # Monorepo packages
│   ├── core/         # Relay server
│   ├── client-js/    # JS/TS SDK
│   └── client-py/    # Python SDK
├── examples/         # Example applications
├── docs/            # Documentation
├── spec/            # OpenAPI spec & schemas
└── deploy/          # Deployment configs
```

---

## Contribution Workflow

### 1. Create an Issue

Before starting work, create an issue describing:
- What you want to build/fix
- Why it's valuable
- Your proposed approach

This helps avoid duplicate work and ensures alignment with project goals.

### 2. Fork and Branch

```bash
# Fork the repo on GitHub, then:
git clone https://github.com/YOUR_USERNAME/agent-dispatch.git
cd agent-dispatch

# Create a feature branch
git checkout -b feature/your-feature-name
# or
git checkout -b fix/bug-description
```

### 3. Make Changes

- Write clean, documented code
- Follow existing code style
- Add tests for new features
- Update documentation

### 4. Test Thoroughly

```bash
# Run all tests
npm test

# Run specific package tests
npm test -w @agent-dispatch/core

# Check linting
npm run lint

# Test examples
cd examples/request-response
npm install
npm run example
```

### 5. Commit with Conventional Commits

We use [Conventional Commits](https://www.conventionalcommits.org/):

```bash
# Format: <type>(<scope>): <description>

git commit -m "feat(core): add message priority field"
git commit -m "fix(client-js): handle connection timeouts"
git commit -m "docs(quickstart): add Python examples"
git commit -m "test(core): add idempotency test cases"
```

**Types:**
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `test`: Test additions/changes
- `refactor`: Code refactoring
- `perf`: Performance improvements
- `chore`: Build/tooling changes

### 6. Push and Create PR

```bash
git push origin feature/your-feature-name
```

Then create a Pull Request on GitHub with:
- Clear title following conventional commits
- Description of what changed and why
- Link to related issue(s)
- Screenshots/examples if applicable

---

## Code Guidelines

### TypeScript/JavaScript

```typescript
// Use TypeScript for type safety
export interface MessageEnvelope {
  version: string;
  id: string;
  type: MessageType;
  // ... more fields
}

// Document public APIs
/**
 * Sends a message to another agent's inbox.
 * @param message - The message envelope to send
 * @returns Promise resolving to the message ID
 */
async send(message: SendOptions): Promise<string> {
  // Implementation
}

// Use async/await (not callbacks)
// Handle errors explicitly
// Write tests for all public functions
```

### Python

```python
# Follow PEP 8
# Use type hints
from typing import Optional

async def send(
    self,
    to: str,
    subject: str,
    body: dict,
    correlation_id: Optional[str] = None
) -> str:
    """Send a message to another agent's inbox.

    Args:
        to: Target agent ID
        subject: Message subject
        body: Message body (JSON-serializable dict)
        correlation_id: Optional correlation ID for request/response

    Returns:
        Message ID
    """
    # Implementation

# Use black for formatting
# Use ruff for linting
# Write tests with pytest
```

---

## Testing Requirements

### Unit Tests

All new features must include unit tests:

```typescript
// packages/core/tests/inbox.test.ts
import { describe, it, expect } from 'vitest';
import { InboxManager } from '../src/inbox';

describe('InboxManager', () => {
  it('should enqueue message with correct status', async () => {
    const inbox = new InboxManager(db);
    const messageId = await inbox.send({
      to: 'agent-bob',
      subject: 'test',
      body: {}
    });

    const message = await inbox.get(messageId);
    expect(message.status).toBe('delivered');
  });
});
```

### Integration Tests

Test end-to-end flows:

```typescript
// packages/core/tests/integration/send-receive.test.ts
it('should complete full send-pull-ack cycle', async () => {
  const sender = new ADMPClient({ agentId: 'alice', ... });
  const receiver = new ADMPClient({ agentId: 'bob', ... });

  const msgId = await sender.send({ to: 'bob', ... });
  const message = await receiver.pull();
  expect(message.id).toBe(msgId);

  await receiver.ack(message.id);
  const stats = await receiver.inboxStats();
  expect(stats.ready).toBe(0);
});
```

### Test Coverage

- Aim for 80%+ coverage on new code
- Required for core relay logic
- Nice-to-have for examples

---

## Documentation Guidelines

### Code Documentation

```typescript
/**
 * Pulls the next available message from the agent's inbox.
 *
 * The message is leased for the specified duration, preventing other
 * workers from pulling it. If not ACKed within the lease period, the
 * message automatically returns to the queue.
 *
 * @param options - Pull options
 * @param options.leaseDuration - Lease duration in seconds (default: 30)
 * @returns The leased message, or null if inbox is empty
 *
 * @example
 * ```typescript
 * const message = await client.pull({ leaseDuration: 60 });
 * if (message) {
 *   await processMessage(message);
 *   await client.ack(message.id);
 * }
 * ```
 */
async pull(options?: PullOptions): Promise<Message | null>
```

### Markdown Documentation

- Use clear, concise language
- Include code examples
- Explain the "why" not just the "what"
- Use diagrams for complex flows

### README Updates

If adding a new package or example:
- Create a README.md in the directory
- Link it from the main README
- Include quickstart instructions

---

## SDK Contribution Guide

Adding a new language SDK? Great! Here's what's needed:

### Required Features

1. **Message Operations**
   - `send()` - Send message to agent
   - `pull()` - Pull from inbox
   - `ack()` - Acknowledge message
   - `nack()` - Negative acknowledge
   - `reply()` - Send correlated response

2. **Client Configuration**
   - Agent ID
   - Relay URL
   - API key/authentication
   - Optional: signing key

3. **Message Signing**
   - Ed25519 signature generation
   - HMAC signature generation
   - Timestamp-based replay protection

4. **Error Handling**
   - Network errors with retry
   - API errors (4xx, 5xx)
   - Validation errors

5. **Type Safety**
   - Message envelope types
   - Error types
   - Configuration types

### SDK Structure Template

```
packages/client-<lang>/
├── README.md
├── src/
│   ├── client.<ext>       # Main client class
│   ├── types.<ext>        # Type definitions
│   ├── crypto.<ext>       # Signature utilities
│   └── errors.<ext>       # Error classes
├── tests/
│   ├── unit/
│   └── integration/
└── examples/
    └── quickstart.<ext>
```

### Reference Implementations

See `packages/client-js/` and `packages/client-py/` for patterns to follow.

---

## Release Process

### Versioning

We use [Semantic Versioning](https://semver.org/):

- **Major** (1.0.0 → 2.0.0): Breaking changes
- **Minor** (1.0.0 → 1.1.0): New features (backwards compatible)
- **Patch** (1.0.0 → 1.0.1): Bug fixes

### Changelog

Update `CHANGELOG.md` with your changes:

```markdown
## [1.1.0] - 2026-01-15

### Added
- SMTP federation support (#123)
- DNS-based key discovery (#124)

### Fixed
- Handle connection timeouts gracefully (#125)

### Changed
- Improved error messages for policy denials (#126)
```

---

## Community Guidelines

### Code of Conduct

- Be respectful and inclusive
- Assume good intentions
- Focus on constructive feedback
- Help others learn

### Communication

- **GitHub Issues**: Bug reports, feature requests
- **GitHub Discussions**: Questions, ideas, showcases
- **Pull Requests**: Code review, technical discussion

---

## Questions?

- **General questions**: [GitHub Discussions](https://github.com/agent-dispatch/agent-dispatch/discussions)
- **Bug reports**: [GitHub Issues](https://github.com/agent-dispatch/agent-dispatch/issues)
- **Security issues**: Email security@agentdispatch.org

---

Thank you for contributing to ADMP! 🚀
