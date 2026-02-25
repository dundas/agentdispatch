import { Command } from 'commander';
import { createInterface } from 'readline';
import { AdmpClient, AdmpError } from '../client.js';
import { loadConfig, requireConfig, saveConfig } from '../config.js';
import { success, warn, error } from '../output.js';

interface RegisterResponse {
  agent_id: string;
  did?: string;
  registration_mode?: string;
  secret_key?: string;
}

export function register(program: Command): void {
  program
    .command('register')
    .description('Register a new agent with the ADMP hub')
    .option('--seed <hex>', 'Deterministic 32-byte seed (hex) — prefer ADMP_SEED env var to avoid shell history exposure')
    .option('--name <name>', 'Human-readable agent name')
    .option('--capabilities <list>', 'Comma-separated capability list')
    .addHelpText('after', '\nSecurity note: --seed appears in shell history and ps output. Set ADMP_SEED instead:\n  ADMP_SEED=deadbeef... admp register --name my-agent\n\nExample:\n  admp register --name my-agent\n  admp register --seed abc123...')
    .action(async (opts: { seed?: string; name?: string; capabilities?: string }) => {
      const config = loadConfig();
      const baseUrl = process.env.ADMP_BASE_URL ?? config.base_url ?? 'https://agentdispatch.fly.dev';

      const body: Record<string, unknown> = {};
      const seed = process.env.ADMP_SEED ?? opts.seed;
      if (seed) body.seed = seed;
      if (opts.name) body.name = opts.name;
      if (opts.capabilities) body.capabilities = opts.capabilities.split(',').map(s => s.trim());

      // Use AdmpClient with 'none' auth — registration is a public endpoint.
      const client = new AdmpClient({ base_url: baseUrl });
      let res: RegisterResponse;
      try {
        res = await client.request<RegisterResponse>('POST', '/api/agents/register', body, 'none');
      } catch (err: unknown) {
        if (err instanceof AdmpError) {
          error(err.message, err.code);
        } else {
          error(err instanceof Error ? err.message : String(err));
        }
        process.exit(1);
      }

      saveConfig({
        base_url: baseUrl,
        agent_id: res.agent_id,
        secret_key: res.secret_key ?? config.secret_key ?? '',
        api_key: config.api_key,
      });

      success(`Registered agent: ${res.agent_id}`, {
        agent_id: res.agent_id,
        did: res.did,
        registration_mode: res.registration_mode,
      });

      if (res.secret_key) {
        warn('secret_key returned — saved to ~/.admp/config.json. Back it up; it will not be shown again.');
      }
    });

  program
    .command('deregister')
    .description('Deregister and permanently delete your agent')
    .addHelpText('after', '\nExample:\n  admp deregister')
    .action(async () => {
      const config = requireConfig(['agent_id', 'secret_key', 'base_url']);

      const rl = createInterface({ input: process.stdin, output: process.stdout });
      let answer = 'n';
      try {
        answer = await new Promise<string>(r => rl.question('Are you sure you want to deregister? (y/N) ', r));
      } finally {
        rl.close();
      }

      if (answer.trim().toLowerCase() !== 'y') {
        console.log('Aborted.');
        return;
      }

      const client = new AdmpClient(config);
      await client.request('DELETE', `/api/agents/${config.agent_id}`, undefined, 'signature');

      // Remove agent_id and secret_key rather than setting to empty string.
      const { agent_id: _a, secret_key: _s, ...rest } = loadConfig();
      saveConfig(rest);

      success(`Agent ${config.agent_id} deregistered.`);
    });
}
