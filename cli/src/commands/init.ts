import { Command } from 'commander';
import { createInterface } from 'readline';
import { loadConfig, resolveConfig, saveConfig } from '../config.js';

function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve));
}

export function register(program: Command): void {
  program
    .command('init')
    .description('Initialize ADMP configuration interactively')
    .option('--from-env', 'Save current environment variables to config without prompting')
    .action(async (opts: { fromEnv?: boolean }) => {
      if (opts.fromEnv) {
        const env = resolveConfig();
        saveConfig({
          base_url: env.base_url ?? 'https://agentdispatch.fly.dev',
          agent_id: env.agent_id ?? '',
          secret_key: env.secret_key ?? '',
          api_key: env.api_key,
        });
        console.log('Config saved from environment variables.');
        return;
      }

      const existing = loadConfig();
      const rl = createInterface({ input: process.stdin, output: process.stdout });

      const base_url = await prompt(
        rl,
        `Base URL [${existing.base_url ?? 'https://agentdispatch.fly.dev'}]: `
      );
      const agent_id = await prompt(rl, `Agent ID [${existing.agent_id ?? ''}]: `);
      process.stdout.write('Note: secret key input is not masked — paste carefully.\n');
      const secret_key = await prompt(rl, `Secret key [${existing.secret_key ? '(keep existing)' : '(not set)'}]: `);
      const api_key = await prompt(rl, `API key (optional) [${existing.api_key ?? ''}]: `);

      rl.close();

      saveConfig({
        base_url: base_url.trim() || existing.base_url || 'https://agentdispatch.fly.dev',
        agent_id: agent_id.trim() || existing.agent_id || '',
        secret_key: secret_key.trim() || existing.secret_key || '',
        api_key: api_key.trim() || existing.api_key || undefined,
      });

      console.log('Config saved to ~/.admp/config.json');
    });
}
