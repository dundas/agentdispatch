import { Command } from 'commander';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));

export const program = new Command();

program
  .name('admp')
  .description('Agent Dispatch Messaging Protocol CLI')
  .version(pkg.version);

async function main() {
  // Register sub-commands — each module exports register(program)
  const modules = [
    './commands/init.js',
    './commands/config.js',
    './commands/register.js',
    './commands/send.js',
    './commands/pull.js',
    './commands/ack.js',
    './commands/nack.js',
    './commands/reply.js',
    './commands/status.js',
    './commands/inbox.js',
    './commands/heartbeat.js',
    './commands/rotate-key.js',
    './commands/webhook.js',
    './commands/groups.js',
    './commands/outbox.js',
  ];

  for (const mod of modules) {
    try {
      const m = await import(mod) as { register: (p: Command) => void };
      m.register(program);
    } catch {
      // Module not yet implemented — skip during development
    }
  }

  program.parse(process.argv);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
