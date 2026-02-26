import { Command } from 'commander';
import { createInterface } from 'readline';
import { loadConfig, resolveConfig, saveConfig } from '../config.js';

function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve));
}

/**
 * Prompt for a secret value with character-by-character echo suppression.
 * In TTY mode, shows '*' for each character typed. Falls back to cleartext
 * readline in non-interactive (piped) contexts where raw mode is unavailable.
 */
function promptSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    // Non-TTY (piped/CI): readline cannot mask; warn and read cleartext.
    process.stderr.write('Warning: input not masked (non-interactive terminal)\n');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise<string>(resolve => {
      rl.once('error', () => { rl.close(); resolve(''); });
      rl.question(question, answer => { rl.close(); resolve(answer); });
    });
  }

  process.stdout.write(question);
  return new Promise<string>((resolve) => {
    const chars: Buffer[] = [];
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', handler);
      process.stdin.removeListener('end', onEnd);
    };

    const onEnd = () => {
      // EOF received (piped empty input) — resolve with whatever was typed so far.
      cleanup();
      process.stdout.write('\n');
      resolve(Buffer.concat(chars).toString('utf8'));
    };

    const handler = (char: Buffer) => {
      const str = char.toString('utf8');
      if (str === '\r' || str === '\n') {
        cleanup();
        process.stdout.write('\n');
        resolve(Buffer.concat(chars).toString('utf8'));
      } else if (str === '\u0003') { // Ctrl-C
        cleanup();
        process.exit(1);
      } else if (str === '\u007f' || str === '\b') { // Backspace
        if (chars.length > 0) {
          chars.pop();
          process.stdout.write('\b \b');
        }
      } else {
        chars.push(char);
        process.stdout.write('*');
      }
    };
    process.stdin.on('data', handler);
    process.stdin.once('end', onEnd);
  });
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

      // Prompt for non-secret fields first using readline.
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const base_url = await prompt(
        rl,
        `Base URL [${existing.base_url ?? 'https://agentdispatch.fly.dev'}]: `
      );
      const agent_id = await prompt(rl, `Agent ID [${existing.agent_id ?? ''}]: `);
      rl.close();

      // Prompt for secret key with echo suppressed (shows * per character in TTY mode).
      // Prefer ADMP_SECRET_KEY env var + --from-env to avoid terminal exposure entirely.
      const secret_key = await promptSecret(
        `Secret key [${existing.secret_key ? '(keep existing)' : '(not set)'}]: `
      );

      // Prompt for optional API key using a new readline interface.
      const rl2 = createInterface({ input: process.stdin, output: process.stdout });
      const api_key = await prompt(rl2, `API key (optional) [${existing.api_key ?? ''}]: `);
      rl2.close();

      saveConfig({
        base_url: base_url.trim() || existing.base_url || 'https://agentdispatch.fly.dev',
        agent_id: agent_id.trim() || existing.agent_id || '',
        secret_key: secret_key.trim() || existing.secret_key || '',
        api_key: api_key.trim() || existing.api_key || undefined,
      });

      console.log('Config saved to ~/.admp/config.json');
    });
}
