#!/usr/bin/env node
/**
 * Unified Cross-CLI Transcript Query
 *
 * Discover and search transcripts across Claude Code, Codex, Cursor, and Gemini CLI.
 */

import { UnifiedTranscriptParser } from './lib/unified-parser.js';
import { TranscriptParser } from './lib/transcript-parser.js';

const parser = new UnifiedTranscriptParser();
const legacyParser = new TranscriptParser();

const CLI_BADGES = {
  claude: '\x1b[35m[Claude]\x1b[0m',
  codex: '\x1b[32m[Codex]\x1b[0m',
  cursor: '\x1b[36m[Cursor]\x1b[0m',
  gemini: '\x1b[33m[Gemini]\x1b[0m'
};

function badge(cli) {
  return CLI_BADGES[cli] || `[${cli}]`;
}

function formatDuration(ms) {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes}m`);
  return parts.join(' ');
}

function parseArgs(args) {
  const opts = { projectPath: process.cwd() };
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--since') { opts.since = args[++i]; }
    else if (arg === '--until') { opts.until = args[++i]; }
    else if (arg === '--cli') { opts.cli = args[++i]; }
    else if (arg === '--limit') { opts.limit = parseInt(args[++i], 10); }
    else if (arg === '--all') { opts.all = true; }
    else if (!arg.startsWith('--')) { positional.push(arg); }
  }

  return { opts, positional };
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === 'help') {
    printHelp();
    return;
  }

  try {
    switch (command) {
      case 'list':
        await listSessions(args.slice(1));
        break;
      case 'timeline':
        await showTimeline(args.slice(1));
        break;
      case 'search':
        await searchTranscripts(args.slice(1));
        break;
      case 'summary':
        await showSummary(args.slice(1));
        break;
      case 'session':
        await showSession(args.slice(1));
        break;
      default:
        console.error(`Unknown command: ${command}`);
        printHelp();
        process.exit(1);
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

function printHelp() {
  console.log(`
Unified Cross-CLI Transcript Query

Discover and search AI coding transcripts across Claude Code, Codex, Cursor, and Gemini CLI.

Usage:
  unified-transcript-query.mjs <command> [options]

Commands:
  list [project]                        List all sessions grouped by CLI
  timeline [project]                    Chronological timeline across all CLIs
  search <keyword> [project]            Search across all CLIs
  summary [project]                     Aggregate stats per CLI
  session <id> [--cli name]             Show specific session details
  help                                  Show this help

Options:
  --since YYYY-MM-DD                    Filter sessions after date
  --until YYYY-MM-DD                    Filter sessions before date
  --cli name                            Filter by CLI (claude|codex|cursor|gemini)
  --limit N                             Limit number of results
  --all                                 Search all sessions (no limit)

Examples:
  unified-transcript-query.mjs list
  unified-transcript-query.mjs timeline --since 2026-02-01
  unified-transcript-query.mjs search "authentication"
  unified-transcript-query.mjs search "deploy" --cli gemini
  unified-transcript-query.mjs summary ~/dev_env/mech-reader
  unified-transcript-query.mjs session abc123 --cli claude
  `);
}

async function listSessions(args) {
  const { opts, positional } = parseArgs(args);
  const projectPath = positional[0] || opts.projectPath;

  const discovered = await parser.discoverAll(projectPath, opts);

  if (discovered.length === 0) {
    console.log('No transcripts found for this project across any CLI.');
    return;
  }

  // Group by CLI
  const grouped = {};
  for (const t of discovered) {
    if (!grouped[t.cli]) grouped[t.cli] = [];
    grouped[t.cli].push(t);
  }

  console.log(`Found ${discovered.length} sessions across ${Object.keys(grouped).length} CLIs:\n`);

  for (const [cli, sessions] of Object.entries(grouped)) {
    console.log(`${badge(cli)} ${sessions.length} sessions`);
    console.log('─'.repeat(50));

    const displayed = sessions.slice(0, 10);
    for (const s of displayed) {
      const date = new Date(s.mtime).toLocaleDateString();
      const time = new Date(s.mtime).toLocaleTimeString();
      console.log(`  ${s.sessionId.substring(0, 12)}...  ${date} ${time}`);
    }
    if (sessions.length > 10) {
      console.log(`  ... and ${sessions.length - 10} more`);
    }
    console.log();
  }
}

async function showTimeline(args) {
  const { opts, positional } = parseArgs(args);
  const projectPath = positional[0] || opts.projectPath;
  opts.limit = opts.limit || 20;

  console.log('Loading timeline across all CLIs...\n');

  const timeline = await parser.getTimeline(projectPath, opts);

  if (timeline.length === 0) {
    console.log('No sessions found.');
    return;
  }

  console.log(`Timeline: ${timeline.length} sessions\n`);

  for (const session of timeline) {
    const startTime = session.data.startTime
      ? new Date(session.data.startTime).toLocaleString()
      : new Date(session.mtime).toLocaleString();
    const duration = session.data.summary?.durationMs
      ? formatDuration(session.data.summary.durationMs)
      : '?';
    const msgs = session.data.summary?.messageCount || 0;
    const tools = session.data.summary?.toolUseCount || 0;
    const files = session.data.summary?.filesModifiedCount || 0;
    const branch = session.data.gitBranch || '';

    console.log(`${badge(session.cli)} ${startTime}  (${duration})`);
    console.log(`  Session: ${session.sessionId.substring(0, 20)}...`);
    console.log(`  ${msgs} messages, ${tools} tool uses, ${files} files modified`);
    if (branch) console.log(`  Branch: ${branch}`);

    // Show first user message as context
    const firstUser = session.data.messages.find(m => m.type === 'user');
    if (firstUser) {
      const preview = firstUser.content.substring(0, 100).replace(/\n/g, ' ').trim();
      console.log(`  First: "${preview}${firstUser.content.length > 100 ? '...' : ''}"`);
    }

    // Show key topics
    const topics = legacyParser.extractKeyTopics(session.data);
    if (topics.length > 0) {
      console.log(`  Topics: ${topics.slice(0, 6).join(', ')}`);
    }

    console.log();
  }
}

async function searchTranscripts(args) {
  const keyword = args[0];
  if (!keyword) {
    console.error('Error: search requires a keyword');
    process.exit(1);
  }

  const { opts, positional } = parseArgs(args.slice(1));
  const projectPath = positional[0] || opts.projectPath;
  if (opts.all) opts.limit = 999;

  console.log(`Searching for "${keyword}" across all CLIs...\n`);

  const results = await parser.searchAll(projectPath, keyword, opts);

  if (results.length === 0) {
    console.log(`No matches found for "${keyword}" across any CLI.`);
    return;
  }

  let totalMatches = 0;

  for (const result of results) {
    totalMatches += result.matches.length;
    const startTime = result.data.startTime
      ? new Date(result.data.startTime).toLocaleString()
      : new Date(result.mtime).toLocaleString();

    console.log(`${badge(result.cli)} ${result.sessionId.substring(0, 20)}...  (${startTime})`);
    console.log(`  ${result.matches.length} matches (best score: ${result.matches[0].score.toFixed(2)})`);

    result.matches.slice(0, 3).forEach(m => {
      const preview = m.content.substring(0, 120).replace(/\n/g, ' ');
      const matchTypes = m.matches.map(mt => mt.type).join(', ');
      console.log(`    [${m.type}] (${matchTypes}, score: ${m.score.toFixed(2)})`);
      console.log(`    ${preview}...`);
      console.log();
    });

    if (result.matches.length > 3) {
      console.log(`    ... and ${result.matches.length - 3} more matches`);
    }
    console.log();
  }

  console.log(`Total: ${totalMatches} matches across ${results.length} sessions.`);
}

async function showSummary(args) {
  const { opts, positional } = parseArgs(args);
  const projectPath = positional[0] || opts.projectPath;

  const summary = await parser.getSummary(projectPath, opts);

  console.log('Cross-CLI Transcript Summary\n');
  console.log(`Total Sessions: ${summary.total}`);

  if (summary.dateRange.earliest) {
    console.log(`Date Range: ${new Date(summary.dateRange.earliest).toLocaleDateString()} → ${new Date(summary.dateRange.latest).toLocaleDateString()}`);
  }

  console.log();

  for (const [cli, info] of Object.entries(summary.byCli)) {
    const status = info.count > 0
      ? `${info.count} sessions (latest: ${new Date(info.latest).toLocaleDateString()})`
      : 'No sessions found';
    console.log(`${badge(cli)} ${status}`);
  }

  console.log();
}

async function showSession(args) {
  const sessionId = args[0];
  if (!sessionId) {
    console.error('Error: session command requires a session ID');
    process.exit(1);
  }

  const { opts, positional } = parseArgs(args.slice(1));
  const projectPath = positional[0] || opts.projectPath;

  // Discover all and find matching session
  const cliFilter = opts.cli ? { cli: opts.cli } : {};
  const discovered = await parser.discoverAll(projectPath, cliFilter);

  const match = discovered.find(t => t.sessionId.startsWith(sessionId));
  if (!match) {
    console.error(`Session not found: ${sessionId}`);
    if (!opts.cli) console.error('Try specifying --cli to narrow the search');
    process.exit(1);
  }

  const data = await parser.parseSession(match.cli, match.path);

  console.log(`${badge(match.cli)} Session Details\n`);
  console.log(`Session ID: ${data.sessionId || match.sessionId}`);
  console.log(`CLI: ${match.cli}`);
  if (data.startTime) console.log(`Start: ${new Date(data.startTime).toLocaleString()}`);
  if (data.endTime) console.log(`End: ${new Date(data.endTime).toLocaleString()}`);
  if (data.summary?.durationMs) console.log(`Duration: ${formatDuration(data.summary.durationMs)}`);
  if (data.cwd) console.log(`Directory: ${data.cwd}`);
  if (data.gitBranch) console.log(`Branch: ${data.gitBranch}`);
  if (data.model) console.log(`Model: ${data.model}`);
  console.log();

  console.log('Activity:');
  console.log(`  Messages: ${data.summary?.messageCount || 0} (${data.summary?.userMessageCount || 0} from user)`);
  console.log(`  Tool Uses: ${data.summary?.toolUseCount || 0}`);
  console.log(`  Files Modified: ${data.summary?.filesModifiedCount || 0}`);
  console.log(`  Errors: ${data.summary?.errorCount || 0}`);

  if (data.tokens?.total) {
    console.log(`  Tokens: ${data.tokens.total.toLocaleString()} (${data.tokens.cached.toLocaleString()} cached)`);
  }
  if (data.summary?.thoughtCount) {
    console.log(`  Thoughts: ${data.summary.thoughtCount}`);
  }
  console.log();

  if (data.filesModified.length > 0) {
    console.log('Files Modified:');
    const uniqueFiles = [...new Set(data.filesModified.map(f => f.path))];
    uniqueFiles.slice(0, 20).forEach(f => console.log(`  ${f}`));
    if (uniqueFiles.length > 20) console.log(`  ... and ${uniqueFiles.length - 20} more`);
    console.log();
  }

  const topics = legacyParser.extractKeyTopics(data);
  if (topics.length > 0) {
    console.log('Key Topics:');
    console.log(`  ${topics.join(', ')}`);
    console.log();
  }

  console.log('Conversation:');
  data.messages.slice(0, 15).forEach((m, i) => {
    const time = m.timestamp ? new Date(m.timestamp).toLocaleTimeString() : '';
    const preview = m.content.substring(0, 100).replace(/\n/g, ' ');
    console.log(`  ${i + 1}. [${time}] ${m.type}: ${preview}${m.content.length > 100 ? '...' : ''}`);
  });

  if (data.messages.length > 15) {
    console.log(`  ... and ${data.messages.length - 15} more messages`);
  }
}

main();
