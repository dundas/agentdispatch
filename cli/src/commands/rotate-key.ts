import { Command } from 'commander';
import { AdmpClient } from '../client.js';
import { loadConfig, requireConfig, saveConfig } from '../config.js';
import { success, warn } from '../output.js';

interface RotateKeyResponse {
  secret_key?: string;
  public_key?: string;
  did?: string;
}

export function register(program: Command): void {
  program
    .command('rotate-key')
    .description('Rotate your agent signing key')
    .option('--seed <hex>', 'New deterministic 32-byte seed (hex) for key derivation')
    .addHelpText('after', '\nExample:\n  admp rotate-key\n  admp rotate-key --seed deadbeef...')
    .action(async (opts: { seed?: string }) => {
      const config = requireConfig(['agent_id', 'secret_key', 'base_url']);
      const client = new AdmpClient(config);

      const body: Record<string, unknown> = {};
      if (opts.seed) body.seed = opts.seed;

      const res = await client.request<RotateKeyResponse>(
        'POST',
        `/api/agents/${config.agent_id}/rotate-key`,
        body,
        'signature'
      );

      if (res?.secret_key) {
        const existing = loadConfig();
        saveConfig({ ...existing, secret_key: res.secret_key });
        warn('New secret_key saved to ~/.admp/config.json. Back it up; it will not be shown again.');
      }

      success(`Key rotated for ${config.agent_id}`, {
        did: res?.did,
        public_key: res?.public_key,
      });
    });
}
