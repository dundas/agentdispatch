import { Command } from 'commander';
import { createInterface } from 'readline';
import { AdmpClient } from '../client.js';
import { requireConfig } from '../config.js';
import { success, isJsonMode, error } from '../output.js';

export function register(program: Command): void {
  const cmd = program
    .command('outbox')
    .description('SMTP outbox — send email via your verified domain');

  // ── Domain sub-commands ──────────────────────────────────────────────────
  const domainCmd = cmd
    .command('domain')
    .description('Manage your outbox sending domain');

  domainCmd
    .command('set')
    .description('Set the SMTP sending domain')
    .requiredOption('--domain <domain>', 'Your sending domain (e.g. agents.example.com)')
    .addHelpText('after', '\nExample:\n  admp outbox domain set --domain agents.example.com')
    .action(async (opts: { domain: string }) => {
      const config = requireConfig(['agent_id', 'secret_key', 'base_url']);
      const client = new AdmpClient(config);

      const res = await client.request<{ domain: string; dns_records?: unknown[] }>(
        'POST',
        `/api/agents/${config.agent_id}/outbox/domain`,
        { domain: opts.domain },
        'signature'
      );

      success(`Domain set to ${res?.domain}`, { dns_records: res?.dns_records });
    });

  domainCmd
    .command('verify')
    .description('Verify DNS records for the configured domain')
    .addHelpText('after', '\nExample:\n  admp outbox domain verify')
    .action(async () => {
      const config = requireConfig(['agent_id', 'secret_key', 'base_url']);
      const client = new AdmpClient(config);

      const res = await client.request<{ verified: boolean; checks?: unknown[] }>(
        'POST',
        `/api/agents/${config.agent_id}/outbox/domain/verify`,
        {},
        'signature'
      );

      success(`DNS verification ${res?.verified ? 'passed' : 'failed'}`, res);
    });

  domainCmd
    .command('delete')
    .description('Remove the configured sending domain')
    .addHelpText('after', '\nExample:\n  admp outbox domain delete')
    .action(async () => {
      const config = requireConfig(['agent_id', 'secret_key', 'base_url']);

      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>(r => rl.question('Delete outbox domain? (y/N) ', r));
      rl.close();
      if (answer.trim().toLowerCase() !== 'y') { console.log('Aborted.'); return; }

      const client = new AdmpClient(config);
      await client.request('DELETE', `/api/agents/${config.agent_id}/outbox/domain`, undefined, 'signature');
      success('Outbox domain deleted.');
    });

  // ── Send ─────────────────────────────────────────────────────────────────
  cmd
    .command('send')
    .description('Send an email via SMTP outbox')
    .requiredOption('--to <email>', 'Recipient email address')
    .requiredOption('--subject <subject>', 'Email subject')
    .option('--body <text>', 'Plain text body')
    .option('--html <html>', 'HTML body')
    .option('--from-name <name>', 'Sender display name')
    .addHelpText('after', '\nExample:\n  admp outbox send --to user@example.com --subject "Hello" --body "Hi there"')
    .action(async (opts: { to: string; subject: string; body?: string; html?: string; fromName?: string }) => {
      const config = requireConfig(['agent_id', 'secret_key', 'base_url']);
      const client = new AdmpClient(config);

      const payload: Record<string, unknown> = { to: opts.to, subject: opts.subject };
      if (opts.body) payload.body = opts.body;
      if (opts.html) payload.html = opts.html;
      if (opts.fromName) payload.from_name = opts.fromName;

      const res = await client.request<{ message_id: string; status: string }>(
        'POST',
        `/api/agents/${config.agent_id}/outbox/send`,
        payload,
        'signature'
      );

      success(`Email sent to ${opts.to}`, { message_id: res?.message_id, status: res?.status });
    });

  // ── Messages list ─────────────────────────────────────────────────────────
  cmd
    .command('messages')
    .description('List outbox messages')
    .option('--status <status>', 'Filter by status (queued|sent|failed)')
    .option('--limit <n>', 'Max messages to show', '20')
    .addHelpText('after', '\nExample:\n  admp outbox messages --status sent --limit 10')
    .action(async (opts: { status?: string; limit: string }) => {
      const config = requireConfig(['agent_id', 'secret_key', 'base_url']);
      const client = new AdmpClient(config);

      const limitN = parseInt(opts.limit, 10);
      if (isNaN(limitN) || limitN <= 0) {
        error('--limit must be a positive integer', 'INVALID_ARGUMENT');
        process.exit(1);
      }
      const params = new URLSearchParams({ limit: String(limitN) });
      if (opts.status) params.set('status', opts.status);

      const res = await client.request<{ messages: Array<{ id: string; to: string; subject: string; status: string; created_at: string }> }>(
        'GET',
        `/api/agents/${config.agent_id}/outbox/messages?${params}`,
        undefined,
        'signature'
      );

      const messages = res?.messages ?? [];
      if (isJsonMode()) { console.log(JSON.stringify(messages, null, 2)); return; }

      if (messages.length === 0) { console.log('No outbox messages.'); return; }
      console.log(`\n${'TO'.padEnd(30)} ${'SUBJECT'.padEnd(30)} ${'STATUS'.padEnd(10)} CREATED`);
      console.log('─'.repeat(85));
      for (const m of messages) {
        console.log(`${m.to.padEnd(30)} ${String(m.subject).slice(0,28).padEnd(30)} ${m.status.padEnd(10)} ${m.created_at}`);
      }
      console.log('');
    });
}
