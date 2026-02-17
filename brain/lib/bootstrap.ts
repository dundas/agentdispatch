/**
 * Agent Identity Bootstrap
 *
 * Self-registers agent with ADMP hub on startup
 * Handles identity, credentials, group membership
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

interface BrainConfig {
  serviceName: string;
  agentId: string;
  type: string;
  role: string;
  capabilities?: string[];
  reportsTo?: string;
  groups?: string[];
  communication: {
    hub: string;
    secretKey?: string;
  };
}

interface AgentIdentity {
  agent_id: string;
  agent_type: string;
  public_key: string;
  secret_key: string;
  webhook_url: string | null;
  capabilities: string[];
  reports_to: string | null;
  groups: string[];
}

/**
 * Bootstrap agent identity
 * Reads config, self-registers with hub, stores credentials
 */
export async function bootstrapAgent(configPath?: string): Promise<AgentIdentity> {
  // 1. Read brain config
  const config = readBrainConfig(configPath);

  console.log(`🧠 Bootstrapping agent: ${config.agentId}`);

  // 2. Check if already registered
  if (config.communication.secretKey) {
    console.log('   Already registered, verifying with hub...');

    const isValid = await verifyRegistration(config);

    if (isValid) {
      console.log('   ✅ Existing registration valid');
      return {
        agent_id: config.agentId,
        agent_type: config.type,
        public_key: '', // Not needed after registration
        secret_key: config.communication.secretKey,
        webhook_url: null,
        capabilities: config.capabilities || [],
        reports_to: config.reportsTo || null,
        groups: config.groups || []
      };
    }

    console.log('   ⚠️  Registration invalid, re-registering...');
  }

  // 3. Register with hub
  console.log('   Registering with ADMP hub...');

  const response = await fetch(`${config.communication.hub}/api/agents/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      agent_id: config.agentId,
      agent_type: config.type,
      metadata: {
        service: config.serviceName,
        role: config.role,
        capabilities: config.capabilities || [],
        reports_to: config.reportsTo,
        version: process.env.npm_package_version || '1.0.0'
      }
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Registration failed: ${error}`);
  }

  const registration = await response.json();

  console.log(`   ✅ Registered as ${registration.agent_id}`);

  // 4. Store secret key in config
  config.communication.secretKey = registration.secret_key;
  saveBrainConfig(config, configPath);

  console.log('   💾 Credentials saved');

  // 5. Join groups
  if (config.groups && config.groups.length > 0) {
    console.log(`   📢 Joining ${config.groups.length} groups...`);

    for (const groupId of config.groups) {
      try {
        await joinGroup(config, groupId);
        console.log(`      ✅ Joined ${groupId}`);
      } catch (error) {
        console.warn(`      ⚠️  Failed to join ${groupId}:`, error);
      }
    }
  }

  // 6. Announce to parent (if configured)
  if (config.reportsTo) {
    console.log(`   📨 Announcing to parent: ${config.reportsTo}`);

    try {
      await announceToParent(config);
      console.log('      ✅ Announcement sent');
    } catch (error) {
      console.warn('      ⚠️  Announcement failed:', error);
    }
  }

  console.log(`✅ Bootstrap complete - ${config.agentId} is online\n`);

  return {
    agent_id: registration.agent_id,
    agent_type: registration.agent_type,
    public_key: registration.public_key,
    secret_key: registration.secret_key,
    webhook_url: registration.webhook_url,
    capabilities: config.capabilities || [],
    reports_to: config.reportsTo || null,
    groups: config.groups || []
  };
}

/**
 * Read brain config from file
 */
function readBrainConfig(configPath?: string): BrainConfig {
  const path = configPath || join(process.cwd(), 'brain/config.json');

  try {
    const content = readFileSync(path, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`Failed to read brain config from ${path}: ${error}`);
  }
}

/**
 * Save brain config to file
 */
function saveBrainConfig(config: BrainConfig, configPath?: string): void {
  const path = configPath || join(process.cwd(), 'brain/config.json');

  try {
    writeFileSync(path, JSON.stringify(config, null, 2), 'utf-8');
  } catch (error) {
    throw new Error(`Failed to save brain config to ${path}: ${error}`);
  }
}

/**
 * Verify existing registration is still valid
 */
async function verifyRegistration(config: BrainConfig): Promise<boolean> {
  try {
    const response = await fetch(
      `${config.communication.hub}/api/agents/${config.agentId}`,
      {
        headers: {
          'X-Agent-ID': config.agentId
        }
      }
    );

    return response.ok;
  } catch (error) {
    return false;
  }
}

/**
 * Join a group
 */
async function joinGroup(config: BrainConfig, groupId: string): Promise<void> {
  const response = await fetch(
    `${config.communication.hub}/api/groups/${groupId}/join`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-ID': config.agentId
      }
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to join group ${groupId}: ${error}`);
  }
}

/**
 * Announce bootup to parent agent
 */
async function announceToParent(config: BrainConfig): Promise<void> {
  if (!config.reportsTo) return;

  const message = {
    from: config.agentId,
    subject: 'Brain Online',
    body: `${config.serviceName} (${config.agentId}) is now online and ready to operate`,
    metadata: {
      type: 'bootup',
      service: config.serviceName,
      role: config.role,
      capabilities: config.capabilities || [],
      version: process.env.npm_package_version || '1.0.0',
      timestamp: new Date().toISOString()
    }
  };

  const response = await fetch(
    `${config.communication.hub}/api/agents/${config.reportsTo}/inbox`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-ID': config.agentId
      },
      body: JSON.stringify(message)
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to announce to parent: ${error}`);
  }
}

/**
 * Example usage:
 *
 * import { bootstrapAgent } from './lib/bootstrap.js';
 *
 * async function main() {
 *   const identity = await bootstrapAgent();
 *   console.log(`I am ${identity.agent_id}`);
 *   console.log(`Capabilities: ${identity.capabilities.join(', ')}`);
 * }
 */
