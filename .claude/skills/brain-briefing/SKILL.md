---
name: brain-briefing
description: Generate comprehensive project briefings from transcript history for brain onboarding
category: autonomy
---

# Brain Briefing

## Purpose
Generate comprehensive briefings from transcript history to help autonomous brains get up to speed on project work, decisions, and current state.

## Use Cases

1. **Brain Onboarding**: New brain deployed to a project needs full context
2. **Cross-Directory Context**: Understand work across parent and child directories
3. **Task-Transcript Correlation**: See which sessions completed which tasks
4. **Team Coordination History**: Understand agent team work and collaboration
5. **Decision Timeline**: Reconstruct key decisions and their rationale

## When to Use

**Use brain-briefing when:**
- Deploying a new brain to a project
- Resuming work after long absence
- Understanding child project relationship to parent
- Debugging: "what work led to current state?"
- Knowledge transfer between brains

## Usage

```bash
# Basic briefing for a directory
/brain-briefing ~/signal

# Include child directories recursively
/brain-briefing ~/signal --recursive

# Filter by date range
/brain-briefing ~/signal --since "2026-02-01"
/brain-briefing ~/signal --last 7  # Last 7 days

# Focus on specific aspects
/brain-briefing ~/signal --tasks-only
/brain-briefing ~/signal --decisions-only

# Output formats
/brain-briefing ~/signal --format markdown  # Default
/brain-briefing ~/signal --format json      # Machine readable
```

## How It Works

### 1. Transcript Discovery
- Searches `~/.claude/projects/` for transcripts matching directory path
- Optionally includes child directories (e.g., `~/signal/signal-workers-v2`)
- Sorts by timestamp (most recent first)

### 2. Task Correlation
- Queries `~/.claude/tasks/` for task list
- Correlates task IDs mentioned in transcripts with current task state
- Builds task timeline showing progression across sessions

### 3. Team Analysis
- Checks `~/.claude/teams/` for agent team configurations
- Identifies teammate coordination and messaging patterns
- Shows which teammates worked on which tasks

### 4. Briefing Generation
Produces structured output with:
- **Summary**: High-level overview of project activity
- **Timeline**: Chronological work history
- **Tasks**: Current state, completed work, blockers
- **Teams**: Agent team coordination (if applicable)
- **Key Decisions**: Important choices and rationale
- **Files**: Most frequently modified files
- **Current State**: Pending work and next steps

## Output Format

### Markdown (Default)

```markdown
# Brain Briefing: ~/signal

**Generated**: 2026-02-06 09:30 UTC
**Scope**: ~/signal + 1 child directory
**Transcripts**: 12 sessions (5 in last 7 days)
**Tasks**: 23 total (18 completed, 3 in_progress, 2 pending)

---

## Executive Summary

Signal Collective analytics platform. Recent work focused on deploying
independent brain for client work, audio transcription reliability, and
brain communication infrastructure.

---

## Active Tasks (3)

### #21 [in_progress] Fix Klaviyo sync errors
- **Owner**: signal-collective-001
- **Started**: 2026-02-05 14:30 UTC
- **Session**: f753dbf8-08e4-4d22-9436-49d0ef7db46a
- **Blocked by**: None
- **Status**: Investigating root cause in signal-workers-v2

### #22 [pending] Update BigQuery schema
- **Blocked by**: #21
- **Priority**: High
- **Next**: Unblocks after Klaviyo sync fixed

### #23 [pending] Add Facebook Ads tracking
- **Blocked by**: None
- **Priority**: Medium
- **Ready to start**: Yes

---

## Recent Sessions (Last 7 Days)

### Session f753dbf8 (2026-02-06, 4h 15m)
**Branch**: feat/signal-brain
**Tasks Completed**: #20 (Deploy Signal Collective brain)
**Files Modified**: 8
- brain/config.json
- brain/CLAUDE.md
- brain/MEMORY.md
- memory/MEMORY.md

**Key Activities**:
- Deployed independent brain for Signal Collective
- Configured standalone mode (no Derivative connection)
- Updated capabilities: klaviyo-analytics, bigquery-sync, shopify-integration

**Decisions**:
- ✅ Chose standalone brain (no AgentDispatch hub for client work)
- ✅ Set reportsTo: null (independent operation)
- ✅ Agent ID: signal-collective-001

### Session c5fc2201 (2026-02-05, 3h 50m)
**Branch**: main
**Tasks Completed**: #18 (Audio transcription reliability)
**PRs**: #128 (merged)
**Files Modified**: 12

**Key Activities**:
- Added audio transcription endpoint to mech-llms
- Fixed multipart FormData issues with Together.ai Whisper API
- Tested with 5.9MB audio file (successful)

**Decisions**:
- ✅ Use native FormData + Blob (not npm form-data package)
- ✅ Let fetch auto-set Content-Type boundary
- ❌ Rejected: Buffer approach (Together.ai returned 500)

---

## Agent Team Coordination

**Team**: signal-refactor (3 members)
**Active**: 2026-02-04 10:15 - 2026-02-04 14:45 (4h 30m)

### Team Members:
1. **intent-refactor** (Owner: claude-sonnet-4.5)
   - Tasks: #15, #16
   - Focus: Refactor intent handling system

2. **sdk-cleanup** (Owner: claude-sonnet-4.5)
   - Tasks: #17
   - Focus: Claude Agent SDK integration

3. **websocket-refactor** (Owner: claude-sonnet-4.5)
   - Tasks: #18, #19
   - Focus: WebSocket connection reliability

### Inter-Agent Messages: 47
- intent-refactor → sdk-cleanup: 12 messages
- sdk-cleanup → websocket-refactor: 8 messages
- websocket-refactor → intent-refactor: 5 messages

### Outcome:
✅ All tasks completed, merged to main
✅ No file conflicts (good task scoping)
⚠️ Websocket-refactor required lead intervention (debugging session timeout)

---

## Key Decisions Log

### 2026-02-06: Independent Brain Architecture
**Context**: Deploying brain for Signal Collective client work
**Decision**: Configure as standalone (no Derivative portfolio connection)
**Rationale**: External client work should remain independent
**Alternatives Considered**:
- ❌ Join mech-services group (rejected: not Derivative infrastructure)
- ❌ Report to decisive-gm (rejected: separate business entity)

### 2026-02-05: Audio Transcription Implementation
**Context**: Audio uploads failing with multipart boundary errors
**Decision**: Use native FormData with Blob for file uploads
**Rationale**: Together.ai Whisper API requires proper multipart encoding
**Alternatives Considered**:
- ❌ npm form-data package (rejected: created wrong headers)
- ❌ Buffer approach (rejected: 500 error from Together.ai)

### 2026-02-05: AgentDispatch Hub Deployment
**Context**: Need persistent brain communication infrastructure
**Decision**: Deploy to Fly.io with Mech Storage persistence
**Rationale**: 24/7 uptime, survives local restarts
**Alternatives Considered**:
- ❌ Local hub process (rejected: not reliable for production)

---

## File Modification Frequency (Top 10)

| File | Modifications | Last Modified | Sessions |
|------|---------------|---------------|----------|
| brain/config.json | 12 | 2026-02-06 | 3 |
| memory/MEMORY.md | 8 | 2026-02-06 | 4 |
| signal-workers-v2/src/sync.ts | 7 | 2026-02-05 | 2 |
| brain/CLAUDE.md | 6 | 2026-02-06 | 2 |
| mech-llms/src/routes/audio.route.ts | 5 | 2026-02-05 | 1 |

---

## Child Directories

### ~/signal/signal-workers-v2
- **Transcripts**: 8 sessions
- **Focus**: Klaviyo analytics, BigQuery sync
- **Recent Work**: Fixing sync errors, schema updates
- **Active Tasks**: #21 (Klaviyo sync errors)

---

## Pending Work

### Ready to Start (1)
- #23: Add Facebook Ads tracking (no blockers)

### Blocked (1)
- #22: Update BigQuery schema (blocked by #21)

### In Progress (1)
- #21: Fix Klaviyo sync errors (owner: signal-collective-001)

---

## Recommendations

1. **Next Action**: Complete task #21 (Klaviyo sync) to unblock #22
2. **High Priority**: None blocked, all progressing normally
3. **Technical Debt**: Consider adding retry logic to BigQuery sync
4. **Knowledge Gap**: Document Klaviyo API rate limits for future reference

---

**Last Updated**: 2026-02-06 09:30 UTC
**Generated by**: brain-briefing v1.0
```

### JSON Format

```json
{
  "generated": "2026-02-06T09:30:00Z",
  "scope": {
    "directory": "~/signal",
    "recursive": true,
    "childDirectories": ["~/signal/signal-workers-v2"]
  },
  "summary": {
    "transcripts": 12,
    "recentTranscripts": 5,
    "daysCovered": 7,
    "totalTasks": 23,
    "completedTasks": 18,
    "activeTasks": 3,
    "pendingTasks": 2
  },
  "tasks": [
    {
      "id": "21",
      "status": "in_progress",
      "subject": "Fix Klaviyo sync errors",
      "owner": "signal-collective-001",
      "sessionId": "f753dbf8-08e4-4d22-9436-49d0ef7db46a",
      "blockedBy": [],
      "blocks": ["22"]
    }
  ],
  "sessions": [
    {
      "sessionId": "f753dbf8-08e4-4d22-9436-49d0ef7db46a",
      "startTime": "2026-02-06T05:15:00Z",
      "duration": "4h 15m",
      "branch": "feat/signal-brain",
      "tasksCompleted": ["20"],
      "filesModified": 8,
      "keyDecisions": [
        {
          "topic": "Independent Brain Architecture",
          "decision": "Configure as standalone",
          "rationale": "External client work should remain independent"
        }
      ]
    }
  ],
  "teams": [
    {
      "name": "signal-refactor",
      "active": "2026-02-04T10:15:00Z",
      "duration": "4h 30m",
      "members": ["intent-refactor", "sdk-cleanup", "websocket-refactor"],
      "messages": 47,
      "outcome": "All tasks completed"
    }
  ]
}
```

## Integration with Other Systems

### 1. Autonomous Bootup
When a brain runs `/autonomous-bootup`, it should call `/brain-briefing` automatically:

```bash
# In brain bootstrap process
/brain-briefing $(pwd) --last 30
```

### 2. Session Start Hook
Add to `.claude/hooks/session_start.mjs`:

```javascript
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Generate briefing on session start
const { stdout } = await execAsync(`claude-skill brain-briefing ${process.cwd()} --last 7`);
console.log(stdout);
```

### 3. Daily Reports
Schedule automated briefings via cron:

```bash
# Daily briefing at 9am
0 9 * * * cd ~/signal && claude-skill brain-briefing . --last 1 >> memory/daily/$(date +%Y-%m-%d)-briefing.md
```

## Architecture

### Dependencies
- `transcript-query` skill (uses TranscriptParser library)
- Node.js fs/promises for task list reading
- Claude Code task system (`~/.claude/tasks/`)
- Agent teams system (`~/.claude/teams/`) (optional)

### File Structure
```
.claude/skills/brain-briefing/
├── SKILL.md              # This file
├── brain-briefing.mjs    # CLI entry point
└── lib/
    ├── briefing-generator.js  # Core briefing logic
    ├── task-correlator.js     # Task-transcript correlation
    └── team-analyzer.js       # Agent team analysis
```

## Limitations

- Transcript parsing is CPU-intensive for large histories (cache results)
- Task correlation requires tasks to be properly tagged with sessionId
- Team analysis only works if agent teams were actually used
- Large recursive directories may take time to process

## Future Enhancements

1. **Vector Search**: Use Mech Search for semantic queries across transcripts
2. **Auto-Summarization**: Use Claude API to summarize long sessions
3. **Trend Analysis**: Identify patterns over time (velocity, bug rates)
4. **Skill Extraction**: Automatically identify reusable patterns
5. **Decision Graph**: Build graph showing decision dependencies

## Security & Privacy

- Transcripts contain full conversation history including potentially sensitive data
- Brain briefings should respect same privacy constraints as transcripts
- Consider encrypting briefings if storing remotely
- This skill is read-only (never modifies transcripts or tasks)

---

**Created**: 2026-02-06
**Dependencies**: transcript-query, Node.js 18+, Claude Code 2.1+
**Related Skills**: transcript-query, autonomous-bootup, memory-manager
