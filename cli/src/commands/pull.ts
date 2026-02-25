import { Command } from 'commander';
import { AdmpClient, AdmpError } from '../client.js';
import { requireConfig } from '../config.js';
import { printMessage, success, isJsonMode } from '../output.js';

export function register(program: Command): void {
  program
    .command('pull')
    .description('Pull the next message from your inbox (leases it for processing)')
    .option('--timeout <seconds>', 'Long-poll timeout in seconds')
    .addHelpText('after', '\nExample:\n  admp pull\n  admp pull --timeout 30')
    .action(async (opts: { timeout?: string }) => {
      const config = requireConfig(['agent_id', 'secret_key', 'base_url']);
      const client = new AdmpClient(config);

      const body: Record<string, unknown> = {};
      if (opts.timeout) body.timeout = parseInt(opts.timeout, 10);

      try {
        const res = await client.request<Record<string, unknown>>(
          'POST',
          `/api/agents/${config.agent_id}/inbox/pull`,
          body,
          'signature'
        );

        if (res === undefined) {
          if (isJsonMode()) {
            console.log(JSON.stringify({ message: 'Inbox empty' }));
          } else {
            console.log('Inbox empty.');
          }
          return;
        }

        printMessage(res);
      } catch (err) {
        if (err instanceof AdmpError && err.status === 404) {
          if (isJsonMode()) {
            console.log(JSON.stringify({ message: 'Inbox empty' }));
          } else {
            console.log('Inbox empty.');
          }
          return;
        }
        throw err;
      }
    });
}
