import { ResolvedConfig } from './config.js';
import { buildAuthHeaders } from './auth.js';

// The deployed server mounts routes under /api/ (see src/server.js line 109:
// app.use('/api/agents', agentRoutes)). The ADMP whitepaper and OpenAPI spec
// use /v1/ as the path prefix — that is aspirational. Until the server is
// updated, all CLI commands use the live /api/ prefix.
const _API_PREFIX = '/api'; // documented divergence from /v1/ spec

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
    auth: AuthMode = 'signature',
    timeoutOverrideMs?: number
  ): Promise<T> {
    const url = new URL(path, this.config.base_url);
    const host = url.hostname;

    // Only set Content-Type when there is a body; avoids spurious header on GETs.
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    if (auth === 'signature') {
      // Include query string in signed path so the server can verify GET requests
      // that carry query params (e.g. groups messages, outbox messages).
      const signedPath = url.pathname + url.search;
      const authHeaders = buildAuthHeaders(method, signedPath, host, this.config.secret_key, this.config.agent_id);
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
    // auth === 'none': no auth headers added (e.g. public endpoints)

    // Use caller-supplied override (e.g. pull long-poll + 5s buffer), else env/default.
    const timeoutMs = timeoutOverrideMs ?? parseInt(process.env.ADMP_TIMEOUT ?? '30000', 10);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
      res = await fetch(url.toString(), {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const isTimeout = err instanceof Error && err.name === 'AbortError';
      throw new AdmpError(
        isTimeout
          ? `Request timed out after ${timeoutMs}ms — set ADMP_TIMEOUT to override`
          : `Could not connect to ${this.config.base_url}: ${msg}`,
        isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
        0
      );
    } finally {
      clearTimeout(timer);
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
