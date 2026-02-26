import { Command } from 'commander';
import { AdmpClient } from '../client.js';
import { requireConfig } from '../config.js';
import { success, error } from '../output.js';

export function register(program: Command): void {
  program
    .command('heartbeat')
    .description('Send a heartbeat to keep your agent registration alive')
    .option('--metadata <json>', 'Optional metadata as JSON string')
    .addHelpText('after', '\nExample:\n  admp heartbeat\n  admp heartbeat --metadata \'{"load":0.3}\'')
    .action(async (opts: { metadata?: string }) => {
      const config = requireConfig(['agent_id', 'secret_key', 'base_url']);
      const client = new AdmpClient(config);

      const body: Record<string, unknown> = {};
      if (opts.metadata) {
        try {
          body.metadata = JSON.parse(opts.metadata);
        } catch {
          error('--metadata must be valid JSON', 'INVALID_ARGUMENT');
          process.exit(1);
        }
      }

      const res = await client.request<{ timestamp: string }>(
        'POST',
        `/api/agents/${config.agent_id}/heartbeat`,
        body,
        'signature'
      );

      success(`Heartbeat sent for ${config.agent_id}`, { timestamp: res?.timestamp });
    });
}
