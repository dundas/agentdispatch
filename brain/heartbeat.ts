/**
 * AgentDispatch Brain - Heartbeat
 *
 * Monitors and improves AgentDispatch autonomously.
 *
 * This brain can:
 * - Monitor hub health and message throughput
 * - Track agent registrations and activity
 * - Identify performance bottlenecks
 * - Research and implement improvements
 * - Add new features (like channels!)
 */

import { config } from './config';
import type { MechClient } from './lib/mech';
import type { ADMPClient } from './lib/admp';
import type { BrainTools } from './tools';

export interface HeartbeatContext {
  mech: MechClient | null;
  admp: ADMPClient;
  tools: BrainTools;
}

// Track when we last ran self-improvement
let lastSelfImprovementRun = 0;

/**
 * Main heartbeat function
 */
export async function runHeartbeat(ctx: HeartbeatContext): Promise<void> {
  const startTime = Date.now();
  console.log('💓 AgentDispatch Brain - Heartbeat starting...');

  try {
    // 1. Check AgentDispatch hub health
    const hubHealth = await checkHubHealth();
    console.log(`Hub health: ${hubHealth.status}`);

    // 2. Collect AgentDispatch-specific metrics
    const metrics = await collectADMPMetrics();
    console.log(`Metrics: agents=${metrics.totalAgents}, messages=${metrics.messagesProcessed}`);

    // 3. Analyze and take action
    await analyzeAndAct(ctx, { hubHealth, metrics });

    // 4. Report to brain network
    await reportToBrainNetwork(ctx.admp, { hubHealth, metrics });

    // 5. Self-improvement check
    if (config.selfImprovementEnabled && shouldRunSelfImprovement()) {
      console.log('🔧 Running self-improvement cycle...');
      await runSelfImprovement(ctx);
      lastSelfImprovementRun = Date.now();
    }

    // 6. Log to memory
    if (ctx.mech) {
      await logHeartbeat(ctx.mech, {
        timestamp: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        hub_health: hubHealth,
        metrics
      });
    }

    const duration = Date.now() - startTime;
    console.log(`💓 Heartbeat complete (${duration}ms)`);

  } catch (error) {
    console.error('Heartbeat failed:', error);

    await ctx.admp.postToChannel({
      channel: 'channel://brain-alerts',
      subject: 'heartbeat_failed',
      body: {
        brain: config.agentId,
        error: String(error),
        timestamp: new Date().toISOString()
      }
    });

    throw error;
  }
}

/**
 * Check AgentDispatch hub health
 */
async function checkHubHealth(): Promise<{
  status: 'healthy' | 'degraded' | 'down';
  response_time_ms: number;
  version?: string;
  error?: string;
}> {
  const startTime = Date.now();

  try {
    const response = await fetch(`${config.backendUrl}/health`, {
      signal: AbortSignal.timeout(5000)
    });

    const responseTime = Date.now() - startTime;

    if (response.ok) {
      const data = await response.json();
      return {
        status: responseTime > 1000 ? 'degraded' : 'healthy',
        response_time_ms: responseTime,
        version: data.version
      };
    } else {
      return {
        status: 'degraded',
        response_time_ms: responseTime,
        error: `HTTP ${response.status}`
      };
    }
  } catch (error) {
    return {
      status: 'down',
      response_time_ms: Date.now() - startTime,
      error: String(error)
    };
  }
}

/**
 * Collect AgentDispatch-specific metrics
 */
async function collectADMPMetrics(): Promise<{
  totalAgents: number;
  activeAgents: number;
  messagesProcessed: number;
  messagesInQueue: number;
  avgDeliveryTime?: number;
}> {
  try {
    // Try to fetch stats endpoint
    const response = await fetch(`${config.backendUrl}/v1/stats`, {
      signal: AbortSignal.timeout(5000)
    });

    if (response.ok) {
      const stats = await response.json();
      return {
        totalAgents: stats.agents?.total || 0,
        activeAgents: stats.agents?.active || 0,
        messagesProcessed: stats.messages?.processed || 0,
        messagesInQueue: stats.messages?.queued || 0,
        avgDeliveryTime: stats.messages?.avg_delivery_ms
      };
    }
  } catch (error) {
    console.warn('Could not fetch ADMP stats:', error);
  }

  // Fallback: basic metrics
  return {
    totalAgents: 0,
    activeAgents: 0,
    messagesProcessed: 0,
    messagesInQueue: 0
  };
}

/**
 * Analyze metrics and take action
 */
async function analyzeAndAct(
  ctx: HeartbeatContext,
  data: { hubHealth: any; metrics: any }
): Promise<void> {
  // Alert if hub is down
  if (data.hubHealth.status === 'down') {
    await ctx.admp.postToChannel({
      channel: 'channel://brain-alerts',
      subject: 'agentdispatch_down',
      body: {
        brain: config.agentId,
        error: data.hubHealth.error,
        timestamp: new Date().toISOString()
      }
    });
  }

  // Alert if message queue is backing up
  if (data.metrics.messagesInQueue > 100) {
    console.warn(`⚠️  High queue depth: ${data.metrics.messagesInQueue}`);
    await ctx.admp.postToChannel({
      channel: 'channel://brain-alerts',
      subject: 'queue_backup',
      body: {
        brain: config.agentId,
        queued_messages: data.metrics.messagesInQueue,
        timestamp: new Date().toISOString()
      }
    });
  }

  // Alert if response time is high
  if (data.hubHealth.response_time_ms > 2000) {
    console.warn(`⚠️  High response time: ${data.hubHealth.response_time_ms}ms`);
  }
}

/**
 * Report to brain network
 */
async function reportToBrainNetwork(
  admp: ADMPClient,
  data: { hubHealth: any; metrics: any }
): Promise<void> {
  try {
    // Post status update to brain-network channel
    await admp.postToChannel({
      channel: 'channel://brain-network',
      subject: 'status_update',
      body: {
        brain: config.agentId,
        project: 'agentdispatch',
        role: 'infrastructure',
        status: data.hubHealth.status,
        metrics: {
          agents: data.metrics.totalAgents,
          messages: data.metrics.messagesProcessed
        },
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.warn('Could not report to brain network:', error);
  }
}

/**
 * Check if it's time to run self-improvement
 */
function shouldRunSelfImprovement(): boolean {
  const timeSinceLastRun = Date.now() - lastSelfImprovementRun;
  return timeSinceLastRun >= config.selfImprovementInterval;
}

/**
 * Self-improvement cycle for AgentDispatch
 *
 * Priority areas:
 * 1. Add channel support (group messaging for agents)
 * 2. Optimize message delivery performance
 * 3. Add persistence layer (currently in-memory)
 * 4. Improve security (signature validation)
 */
async function runSelfImprovement(ctx: HeartbeatContext): Promise<void> {
  console.log('[Self-Improvement] AgentDispatch Brain analyzing...');

  if (!ctx.tools.thinkbrowse && !ctx.tools.teleportation) {
    console.log('[Self-Improvement] No tools available, skipping');
    return;
  }

  try {
    // Identify improvement priorities
    const issues = await identifyIssues(ctx);

    if (issues.length === 0) {
      console.log('[Self-Improvement] No issues identified');
      return;
    }

    console.log(`[Self-Improvement] Found ${issues.length} potential improvements`);
    const topIssue = issues[0];

    // Research phase (if ThinkBrowse available)
    if (ctx.tools.thinkbrowse && topIssue.researchUrl) {
      console.log(`[Self-Improvement] Researching: ${topIssue.description}`);

      const research = await ctx.tools.thinkbrowse.research({
        url: topIssue.researchUrl,
        prompt: `Find best practices and implementation patterns for: ${topIssue.description}`
      });

      console.log(`[Self-Improvement] Research summary: ${research.analysis.summary}`);

      // Store research
      if (ctx.mech) {
        await ctx.mech.storeDocument({
          collection: 'agentdispatch_improvements',
          id: crypto.randomUUID(),
          data: {
            issue: topIssue,
            research: research.analysis,
            timestamp: new Date().toISOString()
          }
        });
      }

      // Share learnings with other brains
      await ctx.admp.postToChannel({
        channel: 'channel://brain-learnings',
        subject: 'research_complete',
        body: {
          brain: config.agentId,
          topic: topIssue.description,
          summary: research.analysis.summary,
          insights: research.analysis.insights
        }
      });
    }

    // Implementation phase (if Teleportation available and issue is auto-fixable)
    if (ctx.tools.teleportation && topIssue.autoFix && topIssue.fixInstructions) {
      console.log(`[Self-Improvement] Implementing: ${topIssue.description}`);

      const result = await ctx.tools.teleportation.runCodingTask({
        project: config.projectPath,
        description: `Improve AgentDispatch: ${topIssue.description}`,
        instructions: topIssue.fixInstructions,
        testRequired: true,
        commitMessage: `feat: ${topIssue.description}\n\nAutonomously implemented by AgentDispatch Brain`
      });

      if (result.success) {
        console.log(`[Self-Improvement] ✅ Implementation successful`);

        await ctx.admp.postToChannel({
          channel: 'channel://brain-learnings',
          subject: 'self_improvement_applied',
          body: {
            brain: config.agentId,
            project: 'agentdispatch',
            improvement: topIssue.description,
            files: result.filesModified,
            commit: result.commitSha
          }
        });
      } else {
        console.log(`[Self-Improvement] ❌ Implementation failed: ${result.error}`);
      }
    }

  } catch (error) {
    console.error('[Self-Improvement] Error:', error);
  }
}

/**
 * Identify issues and improvements for AgentDispatch
 */
async function identifyIssues(ctx: HeartbeatContext): Promise<Array<{
  description: string;
  severity: 'low' | 'medium' | 'high';
  category: 'feature' | 'performance' | 'security' | 'reliability';
  autoFix?: boolean;
  fixInstructions?: string;
  researchUrl?: string;
}>> {
  const issues: Array<{
    description: string;
    severity: 'low' | 'medium' | 'high';
    category: 'feature' | 'performance' | 'security' | 'reliability';
    autoFix?: boolean;
    fixInstructions?: string;
    researchUrl?: string;
  }> = [];

  // Priority 1: Add channel support
  // Check if channels endpoint exists
  try {
    const response = await fetch(`${config.backendUrl}/v1/channels`, {
      signal: AbortSignal.timeout(3000)
    });
    if (response.status === 404) {
      issues.push({
        description: 'Add channel support for group messaging',
        severity: 'high',
        category: 'feature',
        researchUrl: 'https://www.pubnub.com/guides/channel-groups/',
        autoFix: false  // Too complex for auto-fix, needs design
      });
    }
  } catch {
    // If we can't reach the endpoint, don't add this issue
  }

  // Priority 2: Check for persistence
  // In-memory storage means messages are lost on restart
  issues.push({
    description: 'Add PostgreSQL persistence layer',
    severity: 'medium',
    category: 'reliability',
    researchUrl: 'https://bun.sh/docs/api/sql',
    autoFix: false
  });

  // Priority 3: Performance monitoring
  issues.push({
    description: 'Add Prometheus metrics endpoint',
    severity: 'low',
    category: 'performance',
    researchUrl: 'https://prometheus.io/docs/concepts/metric_types/',
    autoFix: true,
    fixInstructions: `
Add a /metrics endpoint to src/server.js that exposes Prometheus-format metrics:
- agentdispatch_messages_total (counter)
- agentdispatch_messages_in_queue (gauge)
- agentdispatch_agents_registered (gauge)
- agentdispatch_delivery_duration_seconds (histogram)

Use a simple text format, no external dependencies needed.
`
  });

  return issues;
}

/**
 * Log heartbeat to persistent memory
 */
async function logHeartbeat(
  mech: MechClient,
  data: Record<string, any>
): Promise<void> {
  try {
    await mech.storeDocument({
      collection: 'agentdispatch_heartbeats',
      id: crypto.randomUUID(),
      data: {
        brain: config.agentId,
        ...data
      }
    });
  } catch (error) {
    console.warn('Could not log heartbeat:', error);
  }
}
