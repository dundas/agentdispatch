import { Command } from 'commander';
import { readFileSync } from 'fs';
import { isAbsolute } from 'path';
import { AdmpClient } from '../client.js';
import { requireConfig } from '../config.js';
import { signEnvelope } from '../auth.js';
import { success, error } from '../output.js';

const MAX_BODY_FILE_BYTES = 1 * 1024 * 1024; // 1 MB guard

function parseBodyOrExit(raw: string): unknown {
  if (raw.startsWith('@')) {
    const filePath = raw.slice(1);
    // Reject absolute paths and directory traversal to prevent reading arbitrary files.
    if (isAbsolute(filePath) || filePath.includes('..')) {
      error('File path must be relative and must not contain ..', 'INVALID_ARGUMENT');
      process.exit(1);
    }
    // Read the file in one shot — avoids TOCTOU between stat and read.
    let buf: Buffer;
    try {
      buf = readFileSync(filePath);
    } catch {
      error(`Could not read body file: ${filePath}`, 'FILE_NOT_FOUND');
      process.exit(1);
    }
    if (buf.length > MAX_BODY_FILE_BYTES) {
      error(`Body file exceeds 1 MB limit (${buf.length} bytes): ${filePath}`, 'INVALID_ARGUMENT');
      process.exit(1);
    }
    try {
      return JSON.parse(buf.toString('utf8'));
    } catch {
      error(`Could not parse body file as JSON: ${filePath}`, 'INVALID_ARGUMENT');
      process.exit(1);
    }
  }
  try {
    return JSON.parse(raw);
  } catch {
    error('--body must be valid JSON (or @file.json to read from file)', 'INVALID_ARGUMENT');
    process.exit(1);
  }
}

export function register(program: Command): void {
  program
    .command('send')
    .description('Send a message to another agent')
    .requiredOption('--to <agentId>', 'Recipient agent ID')
    .requiredOption('--subject <subject>', 'Message subject')
    .option('--body <json|@file>', 'Message body as JSON string or @file.json', '{}')
    .option('--type <type>', 'Message type', 'task.request')
    .option('--correlation-id <id>', 'Correlation ID for threading')
    .option('--ttl <seconds>', 'Time-to-live in seconds')
    .option('--ephemeral', 'Do not persist message (best-effort delivery)')
    .addHelpText('after', '\nNote: send requires api_key for transport auth (run `admp config set api_key <key>` or set ADMP_API_KEY).\n\nExamples:\n  admp send --to storage.agent --subject create_user --body \'{"email":"a@b.com"}\'\n  admp send --to analyst --subject report --body @report.json')
    .action(async (opts: {
      to: string;
      subject: string;
      body: string;
      type: string;
      correlationId?: string;
      ttl?: string;
      ephemeral?: boolean;
    }) => {
      // api_key is required because send uses api-key auth for transport (the receiving
      // agent's server validates it). secret_key is required for Ed25519 envelope signing.
      const config = requireConfig(['agent_id', 'secret_key', 'api_key', 'base_url']);

      // Validate agent ID to prevent path traversal in the URL.
      if (!/^[\w.\-]+$/.test(opts.to)) {
        error('--to must contain only alphanumeric characters, hyphens, underscores, and dots', 'INVALID_ARGUMENT');
        process.exit(1);
      }

      const body = parseBodyOrExit(opts.body);
      const timestamp = new Date().toISOString();

      const envelope: Record<string, unknown> = {
        version: '1.0',
        id: crypto.randomUUID(),
        type: opts.type,
        from: `agent://${config.agent_id}`,
        to: `agent://${opts.to}`,
        subject: opts.subject,
        body,
        timestamp,
      };

      if (opts.correlationId) envelope.correlation_id = opts.correlationId;
      if (opts.ttl) {
        const n = parseInt(opts.ttl, 10);
        if (isNaN(n) || n <= 0) {
          error('--ttl must be a positive integer', 'INVALID_ARGUMENT');
          process.exit(1);
        }
        if (n > 86400) {
          error('--ttl max is 86400 seconds (24 h per ADMP spec)', 'INVALID_ARGUMENT');
          process.exit(1);
        }
        envelope.ttl_sec = n;
      }
      if (opts.ephemeral) envelope.ephemeral = true;

      // Dual-signing design: signEnvelope adds an Ed25519 body/from/to/timestamp
      // signature field inside the JSON payload; client.request('api-key') adds
      // an X-Api-Key header for transport auth. Both identities are verified by
      // the server: the envelope signature proves the message came from this agent,
      // and the api_key authorizes the sender to deliver to the recipient's inbox.
      const signed = signEnvelope(envelope, config.secret_key);

      const client = new AdmpClient(config);
      const res = await client.request<{ message_id: string; status: string }>(
        'POST',
        `/api/agents/${opts.to}/messages`,
        signed,
        'api-key'
      );

      success(`Message sent to ${opts.to}`, { message_id: res.message_id, status: res.status });
    });
}
