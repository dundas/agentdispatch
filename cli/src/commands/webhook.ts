import { Command } from 'commander';
import { createInterface } from 'readline';
import { AdmpClient } from '../client.js';
import { requireConfig } from '../config.js';
import { success } from '../output.js';

function maskSecret(s: string | undefined): string {
  if (!s) return '(not set)';
  return s.length <= 8 ? '***' : s.slice(0, 8) + '...';
}

export function register(program: Command): void {
  const cmd = program
    .command('webhook')
    .description('Manage webhook delivery for incoming messages');

  cmd
    .command('set')
    .description('Set or update the webhook URL and signing secret')
    .requiredOption('--url <url>', 'Webhook endpoint URL')
    .requiredOption('--secret <secret>', 'Webhook signing secret')
    .addHelpText('after', '\nExample:\n  admp webhook set --url https://myapp.com/hook --secret s3cr3t')
    .action(async (opts: { url: string; secret: string }) => {
      const config = requireConfig(['agent_id', 'secret_key', 'base_url']);
      const client = new AdmpClient(config);

      await client.request(
        'POST',
        `/api/agents/${config.agent_id}/webhook`,
        { url: opts.url, secret: opts.secret },
        'signature'
      );

      success(`Webhook set to ${opts.url}`);
    });

  cmd
    .command('get')
    .description('Show the current webhook configuration')
    .addHelpText('after', '\nExample:\n  admp webhook get')
    .action(async () => {
      const config = requireConfig(['agent_id', 'secret_key', 'base_url']);
      const client = new AdmpClient(config);

      const res = await client.request<{ url?: string; secret?: string }>(
        'GET',
        `/api/agents/${config.agent_id}/webhook`,
        undefined,
        'signature'
      );

      success('Webhook configuration', {
        url: res?.url ?? '(not set)',
        secret: maskSecret(res?.secret),
      });
    });

  cmd
    .command('delete')
    .description('Delete the webhook configuration')
    .addHelpText('after', '\nExample:\n  admp webhook delete')
    .action(async () => {
      const config = requireConfig(['agent_id', 'secret_key', 'base_url']);

      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>(r => rl.question('Delete webhook? (y/N) ', r));
      rl.close();

      if (answer.trim().toLowerCase() !== 'y') { console.log('Aborted.'); return; }

      const client = new AdmpClient(config);
      await client.request('DELETE', `/api/agents/${config.agent_id}/webhook`, undefined, 'signature');
      success('Webhook deleted.');
    });
}
