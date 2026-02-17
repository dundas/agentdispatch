/**
 * AgentDispatch Brain Configuration
 *
 * The brain that manages and improves AgentDispatch itself.
 */

export interface BrainConfig {
  // Identity
  brainName: string;
  agentId: string;
  agentType: string;
  projectPath: string;

  // Backend integration (AgentDispatch itself)
  backendUrl: string;
  backendHealthEndpoint: string;

  // Heartbeat
  heartbeatInterval: number;
  healthCheckInterval: number;

  // AgentDispatch (we connect to ourselves!)
  admpHubUrl: string;

  // Mech services
  mechAppId?: string;
  mechApiKey?: string;
  mechApiSecret?: string;

  // Teleportation (coding tool)
  teleportationRelayUrl?: string;
  teleportationApiKey?: string;

  // ThinkBrowse (research tool)
  thinkbrowseApiUrl?: string;

  // Webhooks
  webhookPort: number;
  webhookPath: string;

  // Self-improvement
  selfImprovementEnabled: boolean;
  selfImprovementInterval: number;
}

export const config: BrainConfig = {
  // Identity - AgentDispatch Brain
  brainName: process.env.BRAIN_NAME || 'AgentDispatch Brain',
  agentId: process.env.AGENT_ID || 'agent://agentdispatch-brain',
  agentType: 'infrastructure_brain',
  projectPath: process.env.PROJECT_PATH || '/Users/kefentse/dev_env/agentdispatch',

  // Backend integration - Monitor AgentDispatch itself
  backendUrl: process.env.BACKEND_URL || 'https://agentdispatch.fly.dev',
  backendHealthEndpoint: process.env.BACKEND_HEALTH_ENDPOINT || '/health',

  // Heartbeat intervals
  heartbeatInterval: parseInt(process.env.HEARTBEAT_INTERVAL || '1800000'), // 30 min
  healthCheckInterval: parseInt(process.env.HEALTH_CHECK_INTERVAL || '300000'), // 5 min

  // AgentDispatch - Connect to production hub
  admpHubUrl: process.env.ADMP_HUB_URL || 'https://agentdispatch.fly.dev',

  // Mech services
  mechAppId: process.env.MECH_APP_ID,
  mechApiKey: process.env.MECH_API_KEY,
  mechApiSecret: process.env.MECH_API_SECRET,

  // Teleportation (coding tool)
  teleportationRelayUrl: process.env.TELEPORTATION_RELAY_URL || 'https://relay.teleportation.io',
  teleportationApiKey: process.env.TELEPORTATION_API_KEY,

  // ThinkBrowse (research tool)
  thinkbrowseApiUrl: process.env.THINKBROWSE_API_URL || 'https://api.thinkbrowse.io',

  // Webhooks
  webhookPort: parseInt(process.env.WEBHOOK_PORT || '8080'),  // 8080 for Fly.io, 8081 for local
  webhookPath: process.env.WEBHOOK_PATH || '/webhook',

  // Self-improvement - enabled by default for infrastructure
  selfImprovementEnabled: process.env.SELF_IMPROVEMENT_ENABLED !== 'false',
  selfImprovementInterval: parseInt(process.env.SELF_IMPROVEMENT_INTERVAL || '86400000'), // 24 hours
};

// Validation
export function validateConfig(): void {
  const required = ['brainName', 'agentId', 'backendUrl', 'admpHubUrl'];

  for (const field of required) {
    if (!config[field as keyof BrainConfig]) {
      throw new Error(`Missing required config: ${field}`);
    }
  }

  console.log('✅ Configuration validated');
}
