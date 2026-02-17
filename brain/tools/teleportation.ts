/**
 * Teleportation Client for Brains
 *
 * Enables brains to execute code changes via Teleportation/Claude Code.
 * Brain sends instructions → Teleportation routes to Claude Code → Returns results.
 */

export interface CodingTask {
  project: string;
  description: string;
  instructions: string;
  files?: string[];
  testRequired?: boolean;
  commitMessage?: string;
}

export interface CodingResult {
  success: boolean;
  filesModified: string[];
  testsPassed?: boolean;
  commitSha?: string;
  prUrl?: string;
  error?: string;
  output?: string;
}

export interface TeleportationSession {
  id: string;
  status: 'pending' | 'active' | 'completed' | 'failed';
  projectPath: string;
  createdAt: string;
}

export class TeleportationClient {
  private relayUrl: string;
  private apiKey?: string;
  private internalServiceKey?: string;
  private userId: string;
  private userEmail: string;

  constructor(config?: { relayUrl?: string; apiKey?: string; internalServiceKey?: string; userId?: string; userEmail?: string }) {
    this.relayUrl = config?.relayUrl || process.env.TELEPORTATION_RELAY_URL || 'https://teleportation-relay.fly.dev';
    this.apiKey = config?.apiKey || process.env.TELEPORTATION_API_KEY;
    this.internalServiceKey = config?.internalServiceKey || process.env.TELEPORTATION_INTERNAL_KEY;
    this.userId = config?.userId || process.env.AGENT_ID || 'agentdispatch-brain';
    this.userEmail = config?.userEmail || 'brain@agentdispatch.dev';
  }

  private getAuthHeaders(): Record<string, string> {
    // Prefer internal service key for service-to-service auth
    if (this.internalServiceKey) {
      return {
        'X-Internal-Service-Key': this.internalServiceKey,
        'X-User-Id': this.userId,
        'X-User-Email': this.userEmail,
      };
    }
    // Fall back to Bearer token auth
    return this.apiKey ? { 'Authorization': `Bearer ${this.apiKey}` } : {};
  }

  /**
   * Create a new coding session
   */
  async createSession(task: CodingTask): Promise<TeleportationSession> {
    console.log(`[Teleportation] Creating session for: ${task.description}`);

    const response = await fetch(`${this.relayUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.getAuthHeaders()
      },
      body: JSON.stringify({
        project: task.project,
        description: task.description,
        mode: 'headless',  // Brain sessions are headless
        metadata: {
          initiator: 'brain',
          timestamp: new Date().toISOString()
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Failed to create session: ${await response.text()}`);
    }

    const session = await response.json();
    console.log(`[Teleportation] Session created: ${session.id}`);

    return {
      id: session.id,
      status: 'pending',
      projectPath: task.project,
      createdAt: new Date().toISOString()
    };
  }

  /**
   * Execute code instructions in a session
   */
  async executeCode(sessionId: string, instructions: string): Promise<CodingResult> {
    console.log(`[Teleportation] Executing in session ${sessionId}`);

    const response = await fetch(`${this.relayUrl}/api/sessions/${sessionId}/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.getAuthHeaders()
      },
      body: JSON.stringify({
        instructions,
        timeout: 300000,  // 5 minutes
        autoApprove: true  // Brain-initiated sessions are auto-approved
      })
    });

    if (!response.ok) {
      return {
        success: false,
        filesModified: [],
        error: await response.text()
      };
    }

    const result = await response.json();

    return {
      success: result.success,
      filesModified: result.files_modified || [],
      testsPassed: result.tests_passed,
      commitSha: result.commit_sha,
      prUrl: result.pr_url,
      output: result.output
    };
  }

  /**
   * Get session status
   */
  async getSessionStatus(sessionId: string): Promise<TeleportationSession> {
    const response = await fetch(`${this.relayUrl}/api/sessions/${sessionId}`, {
      headers: {
        ...this.getAuthHeaders()
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to get session: ${await response.text()}`);
    }

    const session = await response.json();

    return {
      id: session.id,
      status: session.status,
      projectPath: session.project_path,
      createdAt: session.created_at
    };
  }

  /**
   * Close a session
   */
  async closeSession(sessionId: string): Promise<void> {
    await fetch(`${this.relayUrl}/api/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: {
        ...this.getAuthHeaders()
      }
    });

    console.log(`[Teleportation] Session ${sessionId} closed`);
  }

  /**
   * High-level: Execute a complete coding task
   *
   * Creates session → Executes instructions → Closes session
   */
  async runCodingTask(task: CodingTask): Promise<CodingResult> {
    const session = await this.createSession(task);

    try {
      // Build full instructions
      const fullInstructions = `
# Task: ${task.description}

## Instructions
${task.instructions}

${task.files?.length ? `## Files to modify\n${task.files.map(f => `- ${f}`).join('\n')}` : ''}

## Requirements
${task.testRequired ? '- Run tests after changes' : '- No tests required'}
${task.commitMessage ? `- Commit with message: "${task.commitMessage}"` : '- Do not commit'}

Please implement the changes and report what was modified.
`;

      const result = await this.executeCode(session.id, fullInstructions);
      return result;

    } finally {
      await this.closeSession(session.id);
    }
  }
}

/**
 * Create Teleportation client from environment
 */
export function createTeleportationClient(): TeleportationClient {
  return new TeleportationClient();
}
