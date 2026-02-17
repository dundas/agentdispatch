/**
 * Mech API Client for Brains
 *
 * Provides access to Mech Storage, LLMs, Reader, etc.
 */

interface MechConfig {
  appId: string;
  apiKey: string;
  apiSecret: string;
}

export class MechClient {
  private config: MechConfig;

  constructor(config: MechConfig) {
    this.config = config;
  }

  /**
   * Make request to Mech Storage
   */
  async storageRequest<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `https://storage.mechdna.net${endpoint}`;

    const headers = {
      'Content-Type': 'application/json',
      'X-Mech-App-ID': this.config.appId,
      'X-Mech-API-Key': this.config.apiKey,
      'X-Mech-API-Secret': this.config.apiSecret,
      ...options.headers,
    };

    const response = await fetch(url, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Mech Storage request failed (${response.status}): ${errorText}`
      );
    }

    return response.json();
  }

  /**
   * Make request to Mech LLMs
   */
  async llmRequest<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `https://llms.mechdna.net${endpoint}`;

    const headers = {
      'Content-Type': 'application/json',
      'X-Mech-App-ID': this.config.appId,
      'X-Mech-API-Key': this.config.apiKey,
      'X-Mech-API-Secret': this.config.apiSecret,
      ...options.headers,
    };

    const response = await fetch(url, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Mech LLM request failed (${response.status}): ${errorText}`
      );
    }

    return response.json();
  }

  /**
   * Analyze data with LLM
   */
  async analyze(params: {
    prompt: string;
    data?: any;
    model?: string;
  }): Promise<any> {
    return this.llmRequest('/api/analyze', {
      method: 'POST',
      body: JSON.stringify({
        model: params.model || 'claude-sonnet-4',
        messages: [{
          role: 'user',
          content: params.prompt + (params.data ? `\n\nData:\n${JSON.stringify(params.data, null, 2)}` : '')
        }]
      })
    });
  }

  /**
   * Store document in NoSQL
   */
  async storeDocument(params: {
    collection: string;
    id: string;
    data: any;
  }): Promise<void> {
    const appId = this.config.appId;

    await this.storageRequest(`/api/apps/${appId}/nosql/documents`, {
      method: 'POST',
      body: JSON.stringify({
        collection_name: params.collection,
        id: params.id,
        data: params.data,
      }),
    });
  }

  /**
   * Query documents
   */
  async queryDocuments(params: {
    collection: string;
    filter?: Record<string, any>;
    limit?: number;
  }): Promise<any[]> {
    const appId = this.config.appId;
    const query = new URLSearchParams();
    query.set('collection_name', params.collection);
    if (params.limit) query.set('limit', params.limit.toString());

    const response = await this.storageRequest<{ documents: Array<{ data: any }> }>(
      `/api/apps/${appId}/nosql/documents?${query}`,
      { method: 'GET' }
    );

    return response.documents?.map(doc => doc.data) || [];
  }
}

/**
 * Create Mech client from environment variables
 */
export function createMechClient(): MechClient | null {
  const appId = process.env.MECH_APP_ID;
  const apiKey = process.env.MECH_API_KEY;
  const apiSecret = process.env.MECH_API_SECRET;

  if (!appId || !apiKey || !apiSecret) {
    console.warn('Mech credentials not found, client disabled');
    return null;
  }

  return new MechClient({ appId, apiKey, apiSecret });
}
