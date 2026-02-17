/**
 * Team Analyzer
 *
 * Analyzes agent team coordination from ~/.claude/teams/
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';

export class TeamAnalyzer {
  constructor() {
    this.teamsDir = path.join(os.homedir(), '.claude', 'teams');
  }

  /**
   * Analyze agent teams from transcripts
   */
  async analyze(transcripts) {
    // 1. Load team configurations
    const teams = await this.loadTeams();

    if (teams.length === 0) {
      return [];
    }

    // 2. Correlate teams with transcript sessions
    const teamAnalysis = [];

    for (const team of teams) {
      // Find transcripts that match this team's members
      const teamTranscripts = transcripts.filter(t =>
        t.data?.sessionId && team.members.some(m => t.data.sessionId.startsWith(m.agentId))
      );

      if (teamTranscripts.length === 0) continue;

      // Extract inter-agent messages
      const messages = this.extractTeamMessages(teamTranscripts, team);

      // Calculate team metrics
      const analysis = {
        name: team.name,
        members: team.members.map(m => ({
          name: m.name || m.agentId,
          agentId: m.agentId,
          type: m.agentType
        })),
        active: {
          start: Math.min(...teamTranscripts.map(t =>
            new Date(t.data.startTime).getTime()
          )),
          end: Math.max(...teamTranscripts.map(t =>
            new Date(t.data.endTime || t.data.startTime).getTime()
          ))
        },
        sessions: teamTranscripts.length,
        messages: messages.length,
        messagingPatterns: this.analyzeMessagingPatterns(messages, team),
        tasksCompleted: this.extractCompletedTasks(teamTranscripts),
        outcome: 'Unknown' // Would need more context to determine
      };

      teamAnalysis.push(analysis);
    }

    return teamAnalysis;
  }

  /**
   * Load team configurations from ~/.claude/teams/
   */
  async loadTeams() {
    try {
      // Check if teams directory exists
      try {
        await fs.access(this.teamsDir);
      } catch {
        return [];
      }

      const teams = [];
      const entries = await fs.readdir(this.teamsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const configPath = path.join(this.teamsDir, entry.name, 'config.json');
          try {
            const content = await fs.readFile(configPath, 'utf-8');
            const config = JSON.parse(content);
            teams.push({
              name: entry.name,
              ...config
            });
          } catch (err) {
            // config.json doesn't exist or invalid
            continue;
          }
        }
      }

      return teams;
    } catch (err) {
      console.error(`   ⚠️  Failed to load teams: ${err.message}`);
      return [];
    }
  }

  /**
   * Extract inter-agent messages from transcripts
   */
  extractTeamMessages(transcripts, team) {
    const messages = [];

    for (const transcript of transcripts) {
      // Look for SendMessage tool uses
      for (const tool of transcript.data.toolUses) {
        if (tool.tool === 'SendMessage') {
          messages.push({
            from: this.inferAgent(transcript.data.sessionId, team),
            to: tool.parameters.recipientId,
            timestamp: tool.timestamp,
            preview: tool.parameters.message?.substring(0, 100)
          });
        }
      }

      // Look for message keywords in assistant messages
      for (const msg of transcript.data.messages) {
        if (msg.type === 'assistant') {
          const messagePattern = /send.*message.*to.*([a-z-]+)/gi;
          const matches = msg.content.matchAll(messagePattern);
          for (const match of matches) {
            messages.push({
              from: this.inferAgent(transcript.data.sessionId, team),
              to: match[1],
              timestamp: msg.timestamp,
              preview: msg.content.substring(0, 100)
            });
          }
        }
      }
    }

    return messages;
  }

  /**
   * Infer which agent based on session ID
   */
  inferAgent(sessionId, team) {
    for (const member of team.members) {
      if (sessionId.includes(member.agentId)) {
        return member.name || member.agentId;
      }
    }
    return 'unknown';
  }

  /**
   * Analyze messaging patterns
   */
  analyzeMessagingPatterns(messages, team) {
    const patterns = {};

    for (const msg of messages) {
      const key = `${msg.from} → ${msg.to}`;
      if (!patterns[key]) {
        patterns[key] = 0;
      }
      patterns[key]++;
    }

    return patterns;
  }

  /**
   * Extract completed tasks from team transcripts
   */
  extractCompletedTasks(transcripts) {
    const completedTasks = new Set();

    for (const transcript of transcripts) {
      for (const tool of transcript.data.toolUses) {
        if (tool.tool === 'TaskUpdate' &&
            tool.parameters.status === 'completed') {
          completedTasks.add(tool.parameters.taskId);
        }
      }
    }

    return Array.from(completedTasks);
  }
}
