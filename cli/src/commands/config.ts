import { Command } from 'commander';
import { loadConfig, resolveConfig, saveConfig, AdmpConfig } from '../config.js';
import { isJsonMode, error, maskSecret } from '../output.js';

const VALID_KEYS: (keyof AdmpConfig)[] = ['base_url', 'agent_id', 'secret_key', 'api_key'];

export function register(program: Command): void {
  const cmd = program
    .command('config')
    .description('Manage ADMP configuration');

  cmd
    .command('show')
    .description('Show resolved configuration (secret_key masked)')
    .action(() => {
      const config = resolveConfig();
      if (isJsonMode()) {
        console.log(JSON.stringify({
          base_url: config.base_url ?? null,
          agent_id: config.agent_id ?? null,
          secret_key: maskSecret(config.secret_key),
          api_key: maskSecret(config.api_key),
        }));
        return;
      }
      console.log('base_url:   ', config.base_url ?? '(not set)');
      console.log('agent_id:   ', config.agent_id ?? '(not set)');
      console.log('secret_key: ', maskSecret(config.secret_key));
      console.log('api_key:    ', maskSecret(config.api_key));
    });

  cmd
    .command('set <key> <value>')
    .description('Set a configuration value (keys: base_url, agent_id, secret_key, api_key)')
    .action((key: string, value: string) => {
      if (!VALID_KEYS.includes(key as keyof AdmpConfig)) {
        error(`Unknown key: ${key}. Valid keys: ${VALID_KEYS.join(', ')}`, 'INVALID_ARGUMENT');
        process.exit(1);
      }
      const existing = loadConfig();
      saveConfig({ ...existing, [key]: value } as AdmpConfig);
      console.log(`${key} updated.`);
    });
}
