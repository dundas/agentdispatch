import { Command } from 'commander';
import { createInterface } from 'readline';
import { AdmpClient } from '../client.js';
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
    .option('--seed <hex>', 'Deterministic 32-byte seed (hex) for key derivation')
    .option('--name <name>', 'Human-readable agent name')
    .option('--capabilities <list>', 'Comma-separated capability list')
    .addHelpText('after', '\nExample:\n  admp register --name my-agent\n  admp register --seed abc123...')
    .action(async (opts: { seed?: string; name?: string; capabilities?: string }) => {
      const config = loadConfig();
      const baseUrl = process.env.ADMP_BASE_URL ?? config.base_url ?? 'https://agentdispatch.fly.dev';

      const body: Record<string, unknown> = {};
      if (opts.seed) body.seed = opts.seed;
      if (opts.name) body.name = opts.name;
      if (opts.capabilities) body.capabilities = opts.capabilities.split(',').map(s => s.trim());

      let res: RegisterResponse;
      try {
        const url = new URL('/api/agents/register', baseUrl);
        const timeoutMs = parseInt(process.env.ADMP_TIMEOUT ?? '30000', 10);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let httpRes: Response;
        try {
          httpRes = await fetch(url.toString(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
        if (!httpRes.ok) {
          const d = await httpRes.json() as Record<string, unknown>;
          error(String(d.error ?? d.message ?? httpRes.statusText), String(d.code ?? 'ERROR'));
          process.exit(1);
        }
        res = await httpRes.json() as RegisterResponse;
      } catch (err: unknown) {
        const isTimeout = err instanceof Error && err.name === 'AbortError';
        error(
          isTimeout
            ? `Request timed out — set ADMP_TIMEOUT (ms) to override`
            : `Could not connect to ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`
        );
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
      const answer = await new Promise<string>(r => rl.question('Are you sure you want to deregister? (y/N) ', r));
      rl.close();

      if (answer.trim().toLowerCase() !== 'y') {
        console.log('Aborted.');
        return;
      }

      const client = new AdmpClient(config);
      await client.request('DELETE', `/api/agents/${config.agent_id}`, undefined, 'signature');

      const existing = loadConfig();
      saveConfig({ ...existing, agent_id: '', secret_key: '' });

      success(`Agent ${config.agent_id} deregistered.`);
    });
}
