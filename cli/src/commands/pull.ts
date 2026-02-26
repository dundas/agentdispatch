import { Command } from 'commander';
import { AdmpClient, AdmpError } from '../client.js';
import { requireConfig } from '../config.js';
import { printMessage, success, isJsonMode, error } from '../output.js';

export function register(program: Command): void {
  program
    .command('pull')
    .description('Pull the next message from your inbox (leases it for processing)')
    .option('--timeout <seconds>', 'Long-poll timeout in seconds')
    .addHelpText('after', '\nExample:\n  admp pull\n  admp pull --timeout 30')
    .action(async (opts: { timeout?: string }) => {
      const config = requireConfig(['agent_id', 'secret_key', 'base_url']);
      const client = new AdmpClient(config);

      let body: { timeout: number } | undefined;
      let clientTimeoutMs: number | undefined;
      if (opts.timeout) {
        const n = parseInt(opts.timeout, 10);
        if (isNaN(n) || n <= 0) {
          error('--timeout must be a positive integer', 'INVALID_ARGUMENT');
          process.exit(1);
        }
        if (n > 300) {
          error('--timeout max is 300 seconds (5 min)', 'INVALID_ARGUMENT');
          process.exit(1);
        }
        body = { timeout: n };
        // Add a 5s buffer so the client abort controller doesn't race the server's
        // long-poll window. Without this, ADMP_TIMEOUT (default 30s) fires before
        // the server responds for any --timeout value above ~25 s.
        clientTimeoutMs = (n + 5) * 1000;
      }

      try {
        const res = await client.request<Record<string, unknown>>(
          'POST',
          `/api/agents/${config.agent_id}/inbox/pull`,
          body,
          'signature',
          clientTimeoutMs
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
        // Use an allowlist: only treat as empty inbox for codes the server
        // explicitly emits for "no messages" — anything else surfaces as an error.
        const INBOX_EMPTY_CODES = new Set(['INBOX_EMPTY', 'NO_MESSAGES']);
        if (err instanceof AdmpError && err.status === 404 && INBOX_EMPTY_CODES.has(err.code)) {
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
