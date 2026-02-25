import { Command } from 'commander';
import { AdmpClient } from '../client.js';
import { requireConfig } from '../config.js';
import { success } from '../output.js';

export function register(program: Command): void {
  program
    .command('nack <messageId>')
    .description('Reject or defer a message (requeues for retry)')
    .option('--extend <seconds>', 'Extend the lease by N seconds before requeuing')
    .option('--requeue', 'Force immediate requeue without waiting for lease to expire')
    .addHelpText('after', '\nExample:\n  admp nack msg_abc123\n  admp nack msg_abc123 --extend 60 --requeue')
    .action(async (messageId: string, opts: { extend?: string; requeue?: boolean }) => {
      const config = requireConfig(['agent_id', 'secret_key', 'base_url']);
      const client = new AdmpClient(config);

      const body: Record<string, unknown> = {};
      if (opts.extend) body.extend = parseInt(opts.extend, 10);
      if (opts.requeue) body.requeue = true;

      await client.request(
        'POST',
        `/api/agents/${config.agent_id}/messages/${messageId}/nack`,
        body,
        'signature'
      );

      success(`Message ${messageId} nacked.`);
    });
}
