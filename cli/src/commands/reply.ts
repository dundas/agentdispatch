import { Command } from 'commander';
import { AdmpClient } from '../client.js';
import { requireConfig } from '../config.js';
import { signEnvelope } from '../auth.js';
import { success } from '../output.js';

export function register(program: Command): void {
  program
    .command('reply <messageId>')
    .description('Send a correlated reply to a message')
    .requiredOption('--subject <subject>', 'Reply subject')
    .option('--body <json>', 'Reply body as JSON string', '{}')
    .option('--type <type>', 'Message type', 'task.response')
    .option('--to <agentId>', 'Recipient agent ID (auto-detected from original message if omitted)')
    .addHelpText('after', '\nExample:\n  admp reply msg_abc123 --subject done --body \'{"result":"ok"}\'')
    .action(async (messageId: string, opts: { subject: string; body: string; type: string; to?: string }) => {
      const config = requireConfig(['agent_id', 'secret_key', 'base_url']);
      const client = new AdmpClient(config);

      // Resolve the reply recipient: explicit --to or fetch from original message status
      let toAgentId = opts.to;
      if (!toAgentId) {
        // api_key is only needed to authenticate the status lookup
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
        body = opts.body;
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

      const signed = signEnvelope(envelope, config.secret_key, config.agent_id);

      const res = await client.request<{ message_id: string; status: string }>(
        'POST',
        `/api/agents/${config.agent_id}/messages/${messageId}/reply`,
        signed,
        'signature'
      );

      success(`Reply sent to ${toAgentId}`, { message_id: res.message_id, status: res.status });
    });
}
