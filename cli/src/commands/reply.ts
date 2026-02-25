import { Command } from 'commander';
import { AdmpClient } from '../client.js';
import { requireConfig } from '../config.js';
import { signEnvelope } from '../auth.js';
import { success, error } from '../output.js';

export function register(program: Command): void {
  program
    .command('reply <messageId>')
    .description('Send a correlated reply to a message')
    .requiredOption('--subject <subject>', 'Reply subject')
    .option('--body <json>', 'Reply body as JSON string', '{}')
    .option('--type <type>', 'Message type', 'task.response')
    .option('--to <agentId>', 'Recipient agent ID (auto-detected from original message if omitted; requires api_key)')
    .addHelpText('after', '\nNote: omitting --to triggers an automatic status lookup to detect the sender.\nThat lookup uses api-key auth — ensure api_key is configured (admp config set api_key <key>).\n\nExample:\n  admp reply msg_abc123 --subject done --body \'{"result":"ok"}\'\n  admp reply msg_abc123 --to sender-agent --subject done  # skip status lookup (no api_key needed)')
    .action(async (messageId: string, opts: { subject: string; body: string; type: string; to?: string }) => {
      const config = requireConfig(['agent_id', 'secret_key', 'base_url']);
      const client = new AdmpClient(config);

      // Resolve the reply recipient: explicit --to or fetch from original message status
      let toAgentId = opts.to;
      if (!toAgentId) {
        // Throw early if api_key is absent — the status fetch will need it for auth
        requireConfig(['api_key']);
        const status = await client.request<{ from?: string }>(
          'GET',
          `/api/messages/${messageId}/status`,
          undefined,
          'api-key'
        );
        const from = status?.from;
        if (!from) {
          throw new Error(
            `Could not determine recipient for reply — use --to <agentId> to specify explicitly`
          );
        }
        // from is stored as raw agent ID (not agent:// URI) in the status response
        toAgentId = from.replace('agent://', '');
      }

      let body: unknown;
      try {
        body = JSON.parse(opts.body);
      } catch {
        error('--body must be valid JSON', 'INVALID_ARGUMENT');
        process.exit(1);
      }

      const envelope: Record<string, unknown> = {
        version: '1.0',
        id: crypto.randomUUID(),
        type: opts.type,
        from: `agent://${config.agent_id}`,
        to: `agent://${toAgentId}`,
        subject: opts.subject,
        correlation_id: messageId,
        body,
        timestamp: new Date().toISOString(),
      };

      // Dual-signing design: signEnvelope adds an Ed25519 body/from/to/timestamp
      // signature field inside the JSON payload; client.request('signature') also
      // adds HTTP Signature headers (request-target/host/date) over the transport.
      // Both use config.secret_key and derive kid from config.agent_id so the
      // server sees a single consistent signing identity.
      const signed = signEnvelope(envelope, config.secret_key);

      const res = await client.request<{ message_id: string; status: string }>(
        'POST',
        `/api/agents/${config.agent_id}/messages/${messageId}/reply`,
        signed,
        'signature'
      );

      success(`Reply sent to ${toAgentId}`, { message_id: res.message_id, status: res.status });
    });
}
