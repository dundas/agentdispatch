import { homedir } from 'os';
import { join, dirname } from 'path';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';

export interface AdmpConfig {
  base_url: string;
  agent_id: string;
  secret_key: string;
  api_key?: string;
}

export interface ResolvedConfig extends AdmpConfig {
  base_url: string;
  agent_id: string;
  secret_key: string;
  api_key?: string;
}

export function getConfigPath(): string {
  return join(homedir(), '.admp', 'config.json');
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
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
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
