import { Command } from 'commander';
import { spawn } from 'child_process';
import { AdmpClient, AdmpError } from '../client.js';
import { requireConfig } from '../config.js';
import { success, error, warn, isJsonMode } from '../output.js';
import { validateRoundTableId } from '../validate.js';

// ---- Types ------------------------------------------------------------------

interface RoundTableEntry {
  id: string;
  from: string;
  message: string;
  timestamp: string;
}

interface RoundTable {
  id: string;
  topic: string;
  goal: string;
  facilitator: string;
  participants: string[];
  group_id: string;
  status: 'open' | 'resolved' | 'expired';
  thread: RoundTableEntry[];
  outcome: string | null;
  created_at: string;
  expires_at: string;
  resolved_at?: string;
  decision?: string;
}

interface RoundTableListResponse {
  round_tables: RoundTable[];
  count: number;
}

interface CreateRoundTableResponse extends RoundTable {
  excluded_participants?: string[];
}

// ---- Helpers ----------------------------------------------------------------

// NO_COLOR compliance — mirrors the pattern in output.ts
const NO_COLOR = 'NO_COLOR' in process.env;
function cyan(s: string): string  { return NO_COLOR ? s : `\x1b[36m${s}\x1b[0m`; }
function green(s: string): string { return NO_COLOR ? s : `\x1b[32m${s}\x1b[0m`; }
function yellow(s: string): string { return NO_COLOR ? s : `\x1b[33m${s}\x1b[0m`; }
function bold(s: string): string  { return NO_COLOR ? s : `\x1b[1m${s}\x1b[0m`; }
function dim(s: string): string   { return NO_COLOR ? s : `\x1b[2m${s}\x1b[0m`; }

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function printEntry(entry: RoundTableEntry): void {
  if (isJsonMode()) {
    console.log(JSON.stringify({ event: 'entry', entry }));
    return;
  }
  const ts = new Date(entry.timestamp).toLocaleTimeString();
  console.log(`[${ts}] ${cyan(entry.from)}`);
  console.log(`  ${entry.message}`);
  console.log('');
}

function printClosure(rt: RoundTable): void {
  if (isJsonMode()) {
    console.log(JSON.stringify({ event: 'closed', status: rt.status, outcome: rt.outcome, decision: rt.decision }));
    return;
  }
  console.log('');
  console.log(rt.status === 'resolved' ? green('✓ Round table resolved') : yellow('⚠ Round table expired'));
  if (rt.outcome) console.log(`  Outcome:  ${rt.outcome}`);
  if (rt.decision) console.log(`  Decision: ${rt.decision}`);
  console.log('');
}

function fireHook(cmd: string, entry: RoundTableEntry): void {
  const child = spawn('/bin/sh', ['-c', cmd], {
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  if (child.stdin) {
    child.stdin.on('error', () => { /* ignore EPIPE — hook exited before reading stdin */ });
    child.stdin.write(JSON.stringify(entry) + '\n');
    child.stdin.end();
  }
  child.on('error', (err) => warn(`--on-speak hook error: ${err.message}`));
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) warn(`--on-speak hook exited with code ${code}`);
  });
}

// ---- Command registration ---------------------------------------------------

export function register(program: Command): void {
  const cmd = program
    .command('round-tables')
    .description('Manage Round Table deliberation sessions');

  // ---- create ----------------------------------------------------------------

  cmd
    .command('create')
    .description('Create a new Round Table session')
    .requiredOption('--topic <topic>', 'Session topic (max 500 chars)')
    .requiredOption('--goal <goal>', 'Desired outcome (max 500 chars)')
    .requiredOption('--participants <ids>', 'Comma-separated participant agent IDs')
    .option('--timeout-minutes <n>', 'Auto-expire after N minutes (integer, 1–10080, default 30)')
    .addHelpText('after', `
Examples:
  admp round-tables create --topic "API design" --goal "Agree on schema" --participants agent-a,agent-b
  admp round-tables create --topic "Incident review" --goal "Root cause" --participants agent-a --timeout-minutes 60`)
    .action(async (opts: { topic: string; goal: string; participants: string; timeoutMinutes?: string }) => {
      const participants = opts.participants.split(',').map(s => s.trim()).filter(Boolean);
      if (participants.length === 0) {
        error('--participants must contain at least one agent ID', 'INVALID_ARGUMENT');
        process.exit(1);
      }

      let timeoutMinutes: number | undefined;
      if (opts.timeoutMinutes !== undefined) {
        timeoutMinutes = parseInt(opts.timeoutMinutes, 10);
        if (isNaN(timeoutMinutes) || !Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 10080) {
          error('--timeout-minutes must be an integer between 1 and 10080', 'INVALID_ARGUMENT');
          process.exit(1);
        }
      }

      const config = requireConfig(['agent_id', 'secret_key', 'base_url']);
      const client = new AdmpClient(config);

      const body: Record<string, unknown> = { topic: opts.topic, goal: opts.goal, participants };
      if (timeoutMinutes !== undefined) body.timeout_minutes = timeoutMinutes;

      const res = await client.request<CreateRoundTableResponse>('POST', '/api/round-tables', body, 'signature');

      if (!isJsonMode() && res.excluded_participants && res.excluded_participants.length > 0) {
        warn(`Some participants could not be enrolled: ${res.excluded_participants.join(', ')}`);
      }
      success('Round table created', res);
    });

  // ---- list ------------------------------------------------------------------

  cmd
    .command('list')
    .description('List Round Tables you are a facilitator or participant of')
    .option('--status <status>', 'Filter by status: open | resolved | expired')
    .addHelpText('after', `
Examples:
  admp round-tables list
  admp round-tables list --status open`)
    .action(async (opts: { status?: string }) => {
      const VALID_STATUSES = ['open', 'resolved', 'expired'];
      if (opts.status && !VALID_STATUSES.includes(opts.status)) {
        error(`--status must be one of: ${VALID_STATUSES.join(', ')}`, 'INVALID_ARGUMENT');
        process.exit(1);
      }

      const config = requireConfig(['agent_id', 'secret_key', 'base_url']);
      const client = new AdmpClient(config);

      const params = opts.status ? `?status=${encodeURIComponent(opts.status)}` : '';
      const res = await client.request<RoundTableListResponse>('GET', `/api/round-tables${params}`, undefined, 'signature');

      const tables = res?.round_tables ?? [];
      if (isJsonMode()) { console.log(JSON.stringify(tables, null, 2)); return; }

      if (tables.length === 0) { console.log('No round tables.'); return; }

      const idWidth = Math.max('ID'.length, ...tables.map(t => t.id.length));
      console.log(`\n${'ID'.padEnd(idWidth)} ${'TOPIC'.padEnd(42)} ${'STATUS'.padEnd(10)} ${'PARTS'.padEnd(5)} EXPIRES`);
      console.log('─'.repeat(idWidth + 1 + 42 + 1 + 10 + 1 + 5 + 1 + 24));
      for (const t of tables) {
        const topic = t.topic.length > 40 ? t.topic.slice(0, 39) + '…' : t.topic;
        console.log(`${t.id.padEnd(idWidth)} ${topic.padEnd(42)} ${t.status.padEnd(10)} ${String(t.participants.length).padEnd(5)} ${t.expires_at}`);
      }
      console.log('');
    });

  // ---- get -------------------------------------------------------------------

  cmd
    .command('get <id>')
    .description('Get a Round Table session and its full thread')
    .addHelpText('after', '\nExample:\n  admp round-tables get rt_abc123def456')
    .action(async (id: string) => {
      validateRoundTableId(id);
      const config = requireConfig(['agent_id', 'secret_key', 'base_url']);
      const client = new AdmpClient(config);

      const rt = await client.request<RoundTable>('GET', `/api/round-tables/${id}`, undefined, 'signature');

      if (isJsonMode()) { console.log(JSON.stringify(rt, null, 2)); return; }

      console.log('');
      console.log(`${bold(rt.topic)}  ${dim(rt.id)}`);
      console.log(`  Goal:         ${rt.goal}`);
      console.log(`  Facilitator:  ${rt.facilitator}`);
      console.log(`  Participants: ${rt.participants.join(', ') || '(none)'}`);
      console.log(`  Status:       ${rt.status}`);
      console.log(`  Expires:      ${rt.expires_at}`);
      if (rt.outcome) console.log(`  Outcome:      ${rt.outcome}`);
      if (rt.decision) console.log(`  Decision:     ${rt.decision}`);
      console.log('');

      if (rt.thread.length === 0) {
        console.log('  (no messages yet)');
      } else {
        console.log(dim('─'.repeat(60)));
        for (const entry of rt.thread) {
          printEntry(entry);
        }
      }
    });

  // ---- speak -----------------------------------------------------------------

  cmd
    .command('speak <id>')
    .description('Add a message to the Round Table thread')
    .requiredOption('--message <m>', 'Message to contribute (max 10000 chars)')
    .addHelpText('after', '\nExample:\n  admp round-tables speak rt_abc123def456 --message "I propose we use event sourcing."')
    .action(async (id: string, opts: { message: string }) => {
      validateRoundTableId(id);
      const config = requireConfig(['agent_id', 'secret_key', 'base_url']);
      const client = new AdmpClient(config);

      const res = await client.request<{ thread_entry_id: string; thread_length: number }>(
        'POST',
        `/api/round-tables/${id}/speak`,
        { message: opts.message },
        'signature'
      );

      success('Message posted', res);
    });

  // ---- resolve ---------------------------------------------------------------

  cmd
    .command('resolve <id>')
    .description('Close a Round Table with an outcome (facilitator only)')
    .requiredOption('--outcome <outcome>', 'Summary of what was decided (max 2000 chars)')
    .option('--decision <decision>', 'Structured decision string (defaults to "approved")')
    .addHelpText('after', `
Examples:
  admp round-tables resolve rt_abc123def456 --outcome "We will use event sourcing."
  admp round-tables resolve rt_abc123def456 --outcome "Rejected." --decision rejected`)
    .action(async (id: string, opts: { outcome: string; decision?: string }) => {
      validateRoundTableId(id);
      const config = requireConfig(['agent_id', 'secret_key', 'base_url']);
      const client = new AdmpClient(config);

      const body: Record<string, unknown> = { outcome: opts.outcome };
      if (opts.decision !== undefined) body.decision = opts.decision;

      const res = await client.request<RoundTable>('POST', `/api/round-tables/${id}/resolve`, body, 'signature');
      success('Round table resolved', res);
    });

  // ---- watch (daemon loop) ---------------------------------------------------

  cmd
    .command('watch <id>')
    .description('Watch a Round Table for new thread entries (daemon loop)')
    .option('--interval <ms>', 'Poll interval in milliseconds (min 500, default 3000)', '3000')
    .option('--on-speak <command>', 'Shell command to run on each new entry (entry JSON piped to stdin)')
    .option('--no-exit-on-close', 'Do not auto-exit when session resolves or expires')
    .addHelpText('after', `
Examples:
  admp round-tables watch rt_abc123def456
  admp round-tables watch rt_abc123def456 --interval 5000
  admp round-tables watch rt_abc123def456 --on-speak 'jq .message'
  admp round-tables watch rt_abc123def456 --json --on-speak 'my-agent-handler'
  admp round-tables watch rt_abc123def456 --no-exit-on-close`)
    .action(async (id: string, opts: { interval: string; onSpeak?: string; exitOnClose: boolean }) => {
      validateRoundTableId(id);

      const intervalMs = (() => {
        const n = parseInt(opts.interval, 10);
        if (isNaN(n) || n < 500) {
          error('--interval must be at least 500 ms', 'INVALID_ARGUMENT');
          process.exit(1);
        }
        return n;
      })();

      const config = requireConfig(['agent_id', 'secret_key', 'base_url']);
      const client = new AdmpClient(config);

      // Initial fetch — print banner and initialise cursor so we don't replay history
      const rt = await client.request<RoundTable>('GET', `/api/round-tables/${id}`, undefined, 'signature');

      const initialLength = rt.thread.length; // entries that existed before this watch started
      let lastLength = initialLength;

      if (isJsonMode()) {
        console.log(JSON.stringify({ event: 'watch_start', round_table: rt }));
      } else {
        console.log('');
        console.log(`${bold('Watching Round Table')} ${dim(rt.id)}`);
        console.log(`  Topic:        ${rt.topic}`);
        console.log(`  Goal:         ${rt.goal}`);
        console.log(`  Expires:      ${rt.expires_at}`);
        console.log(`  Participants: ${rt.participants.length}  (${rt.participants.join(', ')})`);
        console.log(`  Status:       ${rt.status}`);
        if (lastLength > 0) console.log(`  Thread:       ${lastLength} existing entries (skipped)`);
        console.log(`Polling every ${intervalMs}ms — Ctrl+C to exit`);
        console.log(dim('─'.repeat(60)));
        console.log('');
      }

      if (opts.exitOnClose && rt.status !== 'open') {
        printClosure(rt);
        process.exit(rt.status === 'resolved' ? 0 : 1);
      }

      // Signal handlers — report only entries seen during this watch, not pre-existing ones
      const handleSignal = (signal: string) => {
        const entriesSeen = lastLength - initialLength;
        if (isJsonMode()) {
          console.log(JSON.stringify({ event: 'interrupted', signal, entries_seen: entriesSeen }));
        } else {
          console.log(`\nReceived ${signal} — stopping watch.`);
          console.log(`  Entries seen: ${entriesSeen}`);
        }
        process.exit(0);
      };
      process.once('SIGTERM', () => handleSignal('SIGTERM'));
      process.once('SIGINT',  () => handleSignal('SIGINT'));

      // Poll loop
      const MAX_CONSECUTIVE_ERRORS = 10;
      let consecutiveErrors = 0;
      let capWarned = false;

      while (true) {
        await sleep(intervalMs);

        let current: RoundTable;
        try {
          current = await client.request<RoundTable>('GET', `/api/round-tables/${id}`, undefined, 'signature');
          consecutiveErrors = 0; // reset on success
        } catch (err) {
          if (err instanceof AdmpError && err.status < 500) {
            // Fatal client error (403 removed from session, 404 session deleted, etc.) — stop watching
            error(`Watch terminated: ${err.message}`, err.code);
            process.exit(1);
          }
          consecutiveErrors++;
          const msg = err instanceof AdmpError ? err.message : String(err);
          warn(`Poll error (will retry): ${msg}`);
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            error(`Watch terminated: ${MAX_CONSECUTIVE_ERRORS} consecutive poll errors`, 'POLL_FAILED');
            process.exit(1);
          }
          continue;
        }

        // Emit new entries
        const newEntries = current.thread.slice(lastLength);
        for (const entry of newEntries) {
          printEntry(entry);
          if (opts.onSpeak) fireHook(opts.onSpeak, entry);
        }
        lastLength = current.thread.length;

        // Warn once when thread hits the server-side cap
        if (!capWarned && lastLength >= 200 && current.status === 'open') {
          warn('Thread is at the 200-entry cap — no new messages can be added until the session resolves or expires');
          capWarned = true;
        }

        // Auto-exit when session closes
        if (opts.exitOnClose && current.status !== 'open') {
          printClosure(current);
          process.exit(current.status === 'resolved' ? 0 : 1);
        }
      }
    });
}
