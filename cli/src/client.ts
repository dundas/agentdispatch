import { ResolvedConfig } from './config.js';
import { buildAuthHeaders } from './auth.js';

export class AdmpError extends Error {
  code: string;
  status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'AdmpError';
    this.code = code;
    this.status = status;
  }
}

export type AuthMode = 'signature' | 'api-key' | 'none';

export class AdmpClient {
  private config: ResolvedConfig;

  constructor(config: ResolvedConfig) {
    this.config = config;
  }

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    auth: AuthMode = 'signature'
  ): Promise<T> {
    const url = new URL(path, this.config.base_url);
    const host = url.hostname;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (auth === 'signature') {
      // buildAuthHeaders generates its own Date and Signature headers
      const authHeaders = buildAuthHeaders(method, url.pathname, host, this.config.secret_key, this.config.agent_id);
      Object.assign(headers, authHeaders);
    } else if (auth === 'api-key') {
      if (!this.config.api_key) {
        throw new AdmpError(
          'api_key not set — run `admp config set api_key <key>` or set ADMP_API_KEY',
          'INVALID_API_KEY',
          401
        );
      }
      headers['X-Api-Key'] = this.config.api_key;
    }

    let res: Response;
    try {
      res = await fetch(url.toString(), {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new AdmpError(
        `Could not connect to ${this.config.base_url}: ${msg}`,
        'NETWORK_ERROR',
        0
      );
    }

    if (res.status === 204) {
      return undefined as T;
    }

    let data: unknown;
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) {
      data = await res.json();
    } else {
      data = await res.text();
    }

    if (!res.ok) {
      const d = data as Record<string, unknown>;
      const code = (d?.code as string) ?? 'UNKNOWN_ERROR';
      const message = (d?.error as string) ?? (d?.message as string) ?? res.statusText;
      throw new AdmpError(message, code, res.status);
    }

    return data as T;
  }
}
