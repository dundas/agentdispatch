import { Command } from 'commander';
import { loadConfig, resolveConfig, saveConfig, AdmpConfig } from '../config.js';

const VALID_KEYS: (keyof AdmpConfig)[] = ['base_url', 'agent_id', 'secret_key', 'api_key'];

function maskSecret(value: string | undefined): string {
  if (!value) return '(not set)';
  if (value.length <= 8) return '***';
  return value.slice(0, 8) + '...';
}

export function register(program: Command): void {
  const cmd = program
    .command('config')
    .description('Manage ADMP configuration');

  cmd
    .command('show')
    .description('Show resolved configuration (secret_key masked)')
    .action(() => {
      const config = resolveConfig();
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
        console.error(`Unknown key: ${key}. Valid keys: ${VALID_KEYS.join(', ')}`);
        process.exit(1);
      }
      const existing = loadConfig();
      saveConfig({ ...existing, [key]: value } as AdmpConfig);
      console.log(`${key} updated.`);
    });
}
