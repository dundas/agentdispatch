import { Command } from 'commander';
import { AdmpError } from './client.js';
import { error } from './output.js';
import pkg from '../package.json' with { type: 'json' };

// Static imports so the single-file build bundles everything
import * as initCmd from './commands/init.js';
import * as configCmd from './commands/config.js';
import * as registerCmd from './commands/register.js';
import * as agentCmd from './commands/agent.js';
import * as sendCmd from './commands/send.js';
import * as pullCmd from './commands/pull.js';
import * as ackCmd from './commands/ack.js';
import * as nackCmd from './commands/nack.js';
import * as replyCmd from './commands/reply.js';
import * as statusCmd from './commands/status.js';
import * as inboxCmd from './commands/inbox.js';
import * as heartbeatCmd from './commands/heartbeat.js';
import * as rotateKeyCmd from './commands/rotate-key.js';
import * as webhookCmd from './commands/webhook.js';
import * as groupsCmd from './commands/groups.js';
import * as outboxCmd from './commands/outbox.js';

export const program = new Command();

program
  .name('admp')
  .description('Agent Dispatch Messaging Protocol CLI')
  .version(pkg.version)
  .option('--json', 'Output raw JSON (machine-readable)');

const commandModules = [
  initCmd, configCmd, registerCmd, agentCmd,
  sendCmd, pullCmd, ackCmd, nackCmd, replyCmd,
  statusCmd, inboxCmd, heartbeatCmd, rotateKeyCmd,
  webhookCmd, groupsCmd, outboxCmd,
];

for (const mod of commandModules) {
  mod.register(program);
}

program.parseAsync(process.argv).catch((err: unknown) => {
  if (err instanceof AdmpError) {
    error(err.message, err.code);
    process.exit(1);
  }
  if (err instanceof Error) {
    error(err.message, 'ERROR');
    process.exit(1);
  }
  error(String(err));
  process.exit(1);
});
