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


## Autonomous Memory System

This project uses the agentbootup self-improvement system for continuous learning and autonomous operation.

### Memory Files (Always Consult)

**At session start, read**:
1. `memory/MEMORY.md` - Core operational knowledge and protocols
2. `memory/daily/<today>.md` - Today's session log (if exists)

**At session end, update**:
1. `memory/daily/<today>.md` - Session summary, decisions, learnings
2. `memory/MEMORY.md` - New permanent patterns (if discovered)

### Autonomous Operation Protocols

See `.ai/protocols/AUTONOMOUS_OPERATION.md` for complete protocols including:
- Decision-making authority (what to act on vs ask about)
- Phase gate protocol (when to pause for confirmation)
- Error handling protocol (fix immediately, never defer)
- Skill acquisition protocol (building permanent capabilities)
- Memory management protocol (what/when/how to update)

### Key Principles

**Decision-Making**:
- ✅ Act autonomously on: technical choices, testing, documentation, memory updates
- ❌ Ask for input on: destructive actions, external communications, strategic direction

**Communication Style**:
- Be decisive, not deferential
- State decisions with reasoning
- Signal confidence levels
- Silence = normal operation

**Error Handling**:
- Fix issues immediately
- Never mark tasks complete with caveats
- Test until it actually works
- Update memory with lessons learned

**Phase Gates**:
- Complete each phase fully
- Pause at major transitions
- Wait for explicit "Go" or "yes"
- No partial work left behind

### Skills System

**Location**: `.ai/skills/` (CLI-agnostic) or `.claude/skills/` (Claude-specific)

**Core Skills**:
- `skill-acquisition/` - Systematic skill building workflow
- `memory-manager/` - Automated memory management

**Creating New Skills**:
1. **Phase 0**: Check existing skills first (MANDATORY)
2. Only build if no existing skill covers the capability
3. Use skill-acquisition workflow for structured creation

### Task Management

**Use Claude Code native tasks**:
- TaskCreate - Create new tasks
- TaskUpdate - Update task status
- TaskList - View all tasks
- TaskGet - Get task details

**Coordinate with memory**:
- Tasks = tactical execution
- WORKQUEUE.md = strategic direction (if used)
- Memory = long-term knowledge

### Standing Orders

Execute continuously without being asked:

1. Check memory at session start
2. Monitor system health proactively
3. Learn continuously - update memory after significant interactions
4. Build skills permanently for novel challenges (check existing first!)
5. Pause at phase gates
6. Test before completion
7. Act proactively on routine items
8. Ask before destructive actions
9. Document decisions in daily logs
10. Fix issues immediately
