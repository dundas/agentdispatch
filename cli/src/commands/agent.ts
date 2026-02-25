import { Command } from 'commander';
import { AdmpClient } from '../client.js';
import { requireConfig } from '../config.js';
import { success } from '../output.js';

export function register(program: Command): void {
  const cmd = program
    .command('agent')
    .description('Agent identity and management');

  cmd
    .command('get')
    .description('Get details about your registered agent')
    .addHelpText('after', '\nExample:\n  admp agent get')
    .action(async () => {
      const config = requireConfig(['agent_id', 'secret_key', 'base_url']);
      const client = new AdmpClient(config);

      const res = await client.request<Record<string, unknown>>(
        'GET',
        `/api/agents/${config.agent_id}`,
        undefined,
        'signature'
      );

      success(`Agent: ${config.agent_id}`, res);
    });
}
