import { Command } from 'commander';
import { AdmpClient } from '../client.js';
import { requireConfig } from '../config.js';
import { success } from '../output.js';

interface MessageStatus {
  id: string;
  status: string;
  created_at?: string;
  delivered_at?: string;
  acked_at?: string;
  attempts?: number;
}

export function register(program: Command): void {
  program
    .command('status <messageId>')
    .description('Get delivery status of a sent message')
    .addHelpText('after', '\nExample:\n  admp status msg_abc123')
    .action(async (messageId: string) => {
      const config = requireConfig(['base_url', 'api_key']);
      const client = new AdmpClient(config);

      const res = await client.request<MessageStatus>(
        'GET',
        `/api/messages/${messageId}/status`,
        undefined,
        'api-key'
      );

      success(`Status for ${messageId}`, res);
    });
}
