import { Command } from 'commander';
import { createInterface } from 'readline';
import { AdmpClient } from '../client.js';
import { requireConfig } from '../config.js';
import { success, isJsonMode, error } from '../output.js';

export function register(program: Command): void {
  const cmd = program
    .command('groups')
    .description('Manage agent groups');

  cmd
    .command('create')
    .description('Create a new group')
    .requiredOption('--name <name>', 'Group name')
    .option('--access <type>', 'Access type: open | key-protected | invite', 'open')
    .addHelpText('after', '\nExample:\n  admp groups create --name "ml-agents" --access key-protected')
    .action(async (opts: { name: string; access: string }) => {
      const config = requireConfig(['agent_id', 'secret_key', 'base_url']);
      const client = new AdmpClient(config);

      const res = await client.request<{ group_id: string; name: string; access: string }>(
        'POST',
        '/api/groups',
        { name: opts.name, access: opts.access },
        'signature'
      );

      success(`Group created`, { group_id: res.group_id, name: res.name, access: res.access });
    });

  cmd
    .command('list')
    .description('List groups you are a member of')
    .addHelpText('after', '\nExample:\n  admp groups list')
    .action(async () => {
      const config = requireConfig(['agent_id', 'secret_key', 'base_url']);
      const client = new AdmpClient(config);

      const res = await client.request<{ groups: Array<{ group_id: string; name: string; role: string; member_count: number }> }>(
        'GET',
        `/api/agents/${config.agent_id}/groups`,
        undefined,
        'signature'
      );

      const groups = res?.groups ?? [];
      if (isJsonMode()) { console.log(JSON.stringify(groups, null, 2)); return; }

      if (groups.length === 0) { console.log('No groups.'); return; }
      const idWidth = Math.max('GROUP ID'.length, ...groups.map(g => g.group_id.length));
      console.log(`\n${'GROUP ID'.padEnd(idWidth)} ${'NAME'.padEnd(24)} ${'ROLE'.padEnd(10)} MEMBERS`);
      console.log('─'.repeat(idWidth + 1 + 24 + 1 + 10 + 1 + 7));
      for (const g of groups) {
        console.log(`${g.group_id.padEnd(idWidth)} ${String(g.name).slice(0, 24).padEnd(24)} ${g.role.padEnd(10)} ${g.member_count}`);
      }
      console.log('');
    });

  cmd
    .command('join <groupId>')
    .description('Join a group')
    .option('--key <key>', 'Access key for key-protected groups')
    .addHelpText('after', '\nExample:\n  admp groups join grp_abc123 --key mykey')
    .action(async (groupId: string, opts: { key?: string }) => {
      const config = requireConfig(['agent_id', 'secret_key', 'base_url']);
      const client = new AdmpClient(config);

      const body: Record<string, unknown> = {};
      if (opts.key) body.key = opts.key;

      await client.request('POST', `/api/groups/${groupId}/join`, body, 'signature');
      success(`Joined group ${groupId}`);
    });

  cmd
    .command('leave <groupId>')
    .description('Leave a group')
    .addHelpText('after', '\nExample:\n  admp groups leave grp_abc123')
    .action(async (groupId: string) => {
      const config = requireConfig(['agent_id', 'secret_key', 'base_url']);

      const rl = createInterface({ input: process.stdin, output: process.stdout });
      let answer = 'n';
      try {
        answer = await new Promise<string>(r => rl.question(`Leave group ${groupId}? (y/N) `, r));
      } finally {
        rl.close();
      }
      if (answer.trim().toLowerCase() !== 'y') {
        success('Aborted');
        return;
      }

      const client = new AdmpClient(config);
      await client.request('POST', `/api/groups/${groupId}/leave`, undefined, 'signature');
      success(`Left group ${groupId}`);
    });

  cmd
    .command('send <groupId>')
    .description('Send a message to all group members')
    .requiredOption('--subject <subject>', 'Message subject')
    .option('--body <json>', 'Message body as JSON', '{}')
    .addHelpText('after', '\nExample:\n  admp groups send grp_abc123 --subject alert --body \'{"msg":"hello"}\'')
    .action(async (groupId: string, opts: { subject: string; body: string }) => {
      const config = requireConfig(['agent_id', 'secret_key', 'base_url']);
      const client = new AdmpClient(config);

      let body: unknown;
      try {
        body = JSON.parse(opts.body);
      } catch {
        error('--body must be valid JSON', 'INVALID_ARGUMENT');
        process.exit(1);
      }

      const res = await client.request<{ message_id: string; delivered: number }>(
        'POST',
        `/api/groups/${groupId}/messages`,
        { subject: opts.subject, body },
        'signature'
      );

      success(`Group message sent`, { message_id: res?.message_id, delivered: res?.delivered });
    });

  cmd
    .command('messages <groupId>')
    .description('List recent messages in a group')
    .option('--limit <n>', 'Max number of messages to show', '20')
    .addHelpText('after', '\nExample:\n  admp groups messages grp_abc123 --limit 10')
    .action(async (groupId: string, opts: { limit: string }) => {
      const config = requireConfig(['agent_id', 'secret_key', 'base_url']);
      const client = new AdmpClient(config);

      const limitN = parseInt(opts.limit, 10);
      if (isNaN(limitN) || limitN <= 0) {
        error('--limit must be a positive integer', 'INVALID_ARGUMENT');
        process.exit(1);
      }
      const params = new URLSearchParams({ limit: String(limitN) });
      const res = await client.request<{ messages: Array<{ id: string; from: string; subject: string; timestamp: string }> }>(
        'GET',
        `/api/groups/${groupId}/messages?${params}`,
        undefined,
        'signature'
      );

      const messages = res?.messages ?? [];
      if (isJsonMode()) { console.log(JSON.stringify(messages, null, 2)); return; }

      if (messages.length === 0) { console.log('No messages.'); return; }
      console.log(`\n${'FROM'.padEnd(30)} ${'SUBJECT'.padEnd(30)} TIMESTAMP`);
      console.log('─'.repeat(75));
      for (const m of messages) {
        const from = String(m.from).replace('agent://', '').slice(0, 28).padEnd(30);
        const subj = String(m.subject).slice(0, 28).padEnd(30);
        console.log(`${from} ${subj} ${m.timestamp}`);
      }
      console.log('');
    });
}
