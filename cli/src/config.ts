import { homedir } from 'os';
import { join, dirname } from 'path';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, renameSync, existsSync } from 'fs';

export interface AdmpConfig {
  base_url: string;
  agent_id: string;
  secret_key: string;
  api_key?: string;
}

export type ResolvedConfig = Required<AdmpConfig>;

export function getConfigPath(): string {
  return process.env.ADMP_CONFIG_PATH ?? join(homedir(), '.admp', 'config.json');
}

export function loadConfig(): Partial<AdmpConfig> {
  const path = getConfigPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Partial<AdmpConfig>;
  } catch {
    return {};
  }
}

export function saveConfig(config: Partial<AdmpConfig>): void {
  const path = getConfigPath();
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  // Write to a temp file, chmod, then atomically rename to avoid a TOCTOU
  // window where the target file briefly holds new secrets with old permissions.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function resolveConfig(): Partial<ResolvedConfig> {
  const file = loadConfig();
  return {
    base_url: process.env.ADMP_BASE_URL ?? file.base_url ?? 'https://agentdispatch.fly.dev',
    agent_id: process.env.ADMP_AGENT_ID ?? file.agent_id,
    secret_key: process.env.ADMP_SECRET_KEY ?? file.secret_key,
    api_key: process.env.ADMP_API_KEY ?? file.api_key,
  };
}

const ENV_NAMES: Record<string, string> = {
  base_url: 'ADMP_BASE_URL',
  agent_id: 'ADMP_AGENT_ID',
  secret_key: 'ADMP_SECRET_KEY',
  api_key: 'ADMP_API_KEY',
};

export function requireConfig(fields: (keyof AdmpConfig)[]): ResolvedConfig {
  const config = resolveConfig();
  for (const field of fields) {
    if (!config[field]) {
      const envName = ENV_NAMES[field] ?? field.toUpperCase();
      throw new Error(
        `${field} not set — run \`admp init\` or set ${envName}`
      );
    }
  }
  return config as ResolvedConfig;
}
