# Tasks: Brain Process Manager + ADMP CLI

## Relevant Files

- `brain/lib/process-manager.ts` - Process Manager core module
- `brain/lib/process-manager.test.ts` - Unit tests for Process Manager
- `brain/lib/admp.ts` - ADMP client (extend with inbox methods)
- `brain/lib/admp.test.ts` - Unit tests for ADMP client extensions
- `brain/processes/inbox-poller.ts` - Inbox polling process
- `brain/processes/index.ts` - Process registry and defaults
- `brain/index.ts` - Main entry point (refactor to use process manager)
- `brain/heartbeat.ts` - Existing heartbeat (convert to process)
- `cli/index.ts` - CLI entry point
- `cli/commands/health.ts` - Health check command
- `cli/commands/send.ts` - Send message command
- `cli/commands/inbox.ts` - Inbox commands
- `cli/commands/register.ts` - Agent registration command
- `cli/lib/config.ts` - CLI configuration management

### Notes
- Unit tests co-located with source files
- Use `bun test` for running tests
- Process Manager has no external dependencies

## Tasks

### Phase 1: Process Manager Core

- [x] 1.0 Create Process Manager Core
  - [x] 1.1 Create `brain/lib/process-manager.ts` with ProcessManager class
  - [x] 1.2 Implement `register(config)` method to register processes
  - [x] 1.3 Implement `start()` method to start all enabled processes
  - [x] 1.4 Implement `stop()` method to stop all processes
  - [x] 1.5 Implement `getStatus()` method to return process states
  - [x] 1.6 Implement `printStatus()` method for console output
  - [x] 1.7 Support three process types: interval, persistent, once
  - [x] 1.8 Write unit tests for ProcessManager

- [x] 2.0 Add Restart & Recovery Logic
  - [x] 2.1 Track error count and last error per process
  - [x] 2.2 Implement automatic restart on failure for interval processes
  - [x] 2.3 Implement automatic restart for persistent processes
  - [x] 2.4 Add configurable `maxRestarts` and `restartDelay`
  - [x] 2.5 Mark process as 'failed' when max restarts exceeded
  - [x] 2.6 Write tests for restart logic

### Phase 2: ADMP Client Extensions

- [x] 3.0 Extend ADMP Client
  - [x] 3.1 Add `pullMessages(options)` method to pull from inbox
  - [x] 3.2 Add `ackMessage(messageId)` method to acknowledge
  - [x] 3.3 Add `nackMessage(messageId, options)` method to reject/requeue
  - [x] 3.4 Add `getInboxStats()` method for inbox statistics
  - [x] 3.5 Implement Ed25519 signature for authenticated requests
  - [x] 3.6 Write tests for new ADMP client methods

### Phase 3: Inbox Integration

- [x] 4.0 Create Inbox Poller Process
  - [x] 4.1 Create `brain/processes/inbox-poller.ts`
  - [x] 4.2 Implement polling loop with configurable interval
  - [x] 4.3 Pull messages and invoke handler callback
  - [x] 4.4 Ack successful messages, nack failed ones
  - [x] 4.5 Add exponential backoff when inbox is empty
  - [x] 4.6 Write tests for inbox poller

- [x] 5.0 Integrate Process Manager into Brain
  - [x] 5.1 Create `brain/processes/index.ts` with default process configs
  - [x] 5.2 Register heartbeat as interval process
  - [x] 5.3 Register inbox-poller as interval process
  - [x] 5.4 Register webhook-server as persistent process
  - [x] 5.5 Refactor `brain/index.ts` to use process manager
  - [x] 5.6 Remove manual interval management from index.ts

- [x] 6.0 Add Graceful Shutdown
  - [x] 6.1 Add SIGTERM handler in brain/index.ts
  - [x] 6.2 Add SIGINT handler in brain/index.ts
  - [x] 6.3 Call processManager.stop() on shutdown signals
  - [x] 6.4 Wait for in-flight operations to complete
  - [x] 6.5 Test graceful shutdown behavior

### Phase 4: ADMP CLI

- [ ] 7.0 Create ADMP CLI
  - [ ] 7.1 Create `cli/index.ts` with Commander.js setup
  - [ ] 7.2 Create `cli/lib/config.ts` for config file management
  - [ ] 7.3 Implement `admp health` command
  - [ ] 7.4 Implement `admp register` command
  - [ ] 7.5 Implement `admp send` command
  - [ ] 7.6 Implement `admp inbox` command (list, pull, ack)
  - [ ] 7.7 Implement `admp config` command (get, set)
  - [ ] 7.8 Add to package.json scripts
  - [ ] 7.9 Write CLI tests

### Phase 5: End-to-End Testing

- [ ] 8.0 Test End-to-End
  - [ ] 8.1 Deploy updated brain to Fly.io
  - [ ] 8.2 Send test message via CLI
  - [ ] 8.3 Verify brain receives and processes message
  - [ ] 8.4 Verify brain can reply to messages
  - [ ] 8.5 Test restart behavior by killing process
  - [ ] 8.6 Document any issues found

---

*Generated: 2026-02-04*
*PRD: 0001-prd-brain-process-manager.md*
