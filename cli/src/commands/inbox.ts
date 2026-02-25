import { Command } from 'commander';
import { AdmpClient } from '../client.js';
import { requireConfig } from '../config.js';
import { success } from '../output.js';

interface InboxStats {
  queued: number;
  leased: number;
  total: number;
}

export function register(program: Command): void {
  const cmd = program
    .command('inbox')
    .description('Inbox management commands');

  cmd
    .command('stats')
    .description('Show inbox queue statistics')
    .addHelpText('after', '\nExample:\n  admp inbox stats')
    .action(async () => {
      const config = requireConfig(['agent_id', 'secret_key', 'base_url']);
      const client = new AdmpClient(config);

      const res = await client.request<InboxStats>(
        'GET',
        `/api/agents/${config.agent_id}/inbox/stats`,
        undefined,
        'signature'
      );

      success(`Inbox stats for ${config.agent_id}`, res);
    });
}
