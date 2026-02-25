import { Command } from 'commander';
import { AdmpClient } from '../client.js';
import { requireConfig } from '../config.js';
import { success, error } from '../output.js';

export function register(program: Command): void {
  program
    .command('ack <messageId>')
    .description('Acknowledge successful processing of a message (removes from inbox)')
    .option('--result <json>', 'Optional result payload as JSON string')
    .addHelpText('after', '\nExample:\n  admp ack msg_abc123\n  admp ack msg_abc123 --result \'{"status":"done"}\'')
    .action(async (messageId: string, opts: { result?: string }) => {
      const config = requireConfig(['agent_id', 'secret_key', 'base_url']);
      const client = new AdmpClient(config);

      const body: Record<string, unknown> = {};
      if (opts.result) {
        try {
          body.result = JSON.parse(opts.result);
        } catch {
          error('--result must be valid JSON', 'INVALID_ARGUMENT');
          process.exit(1);
        }
      }

      await client.request(
        'POST',
        `/api/agents/${config.agent_id}/messages/${messageId}/ack`,
        body,
        'signature'
      );

      success(`Message ${messageId} acknowledged.`);
    });
}
