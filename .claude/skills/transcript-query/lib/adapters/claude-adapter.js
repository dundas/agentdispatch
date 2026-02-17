/**
 * Claude Code Transcript Adapter
 *
 * Parses Claude Code .jsonl transcript files from ~/.claude/projects/
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';

export class ClaudeAdapter {
  constructor() {
    this.cli = 'claude';
    this.projectsDir = path.join(os.homedir(), '.claude', 'projects');
  }

  /**
   * Discover Claude Code transcripts for a project
   */
  async discover(projectPath) {
    const resolvedPath = path.resolve(projectPath);
    // Claude normalizes path: replaces / and _ with -
    const normalizedPath = resolvedPath.replace(/[/_]/g, '-');
    const projectDir = path.join(this.projectsDir, normalizedPath);

    try {
      const files = await fs.readdir(projectDir);
      const transcripts = [];

      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const filePath = path.join(projectDir, f);
        try {
          const stats = await fs.stat(filePath);
          transcripts.push({
            cli: this.cli,
            sessionId: f.replace('.jsonl', ''),
            path: filePath,
            mtime: stats.mtime
          });
        } catch {
          // Skip files we can't stat
        }
      }

      return transcripts;
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  /**
   * Parse a Claude Code JSONL transcript into normalized format
   */
  async parse(filePath) {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);

    const events = lines.map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean);

    return this.extractData(events);
  }

  extractData(events) {
    const data = {
      cli: this.cli,
      sessionId: null,
      startTime: null,
      endTime: null,
      cwd: null,
      gitBranch: null,
      messages: [],
      toolUses: [],
      filesModified: [],
      errors: [],
      summary: null
    };

    for (const event of events) {
      if (event.sessionId && !data.sessionId) data.sessionId = event.sessionId;
      if (event.cwd && !data.cwd) data.cwd = event.cwd;
      if (event.gitBranch && !data.gitBranch) data.gitBranch = event.gitBranch;

      if (event.timestamp) {
        if (!data.startTime || event.timestamp < data.startTime) data.startTime = event.timestamp;
        if (!data.endTime || event.timestamp > data.endTime) data.endTime = event.timestamp;
      }

      // User messages
      if (event.type === 'user' && event.message) {
        const content = typeof event.message.content === 'string'
          ? event.message.content
          : JSON.stringify(event.message.content);
        data.messages.push({ type: 'user', content, timestamp: event.timestamp });
      }
      // Assistant messages
      else if (event.type === 'assistant' && event.message) {
        let textContent;
        if (Array.isArray(event.message.content)) {
          textContent = event.message.content
            ?.filter(c => c.type === 'text')
            ?.map(c => c.text)
            ?.join('\n');
        } else if (typeof event.message.content === 'string') {
          textContent = event.message.content;
        }
        if (textContent) {
          data.messages.push({ type: 'assistant', content: textContent, timestamp: event.timestamp });
        }
      }

      // Tool uses
      if (event.type === 'tool_use') {
        data.toolUses.push({ tool: event.tool, parameters: event.parameters, timestamp: event.timestamp });
      }

      // File modifications
      if (event.type === 'tool_result' && event.toolName) {
        if (['Edit', 'Write'].includes(event.toolName) && event.result?.file_path) {
          data.filesModified.push({ path: event.result.file_path, action: event.toolName, timestamp: event.timestamp });
        }
      }

      // Errors
      if (event.type === 'error' || (event.result && event.result.error)) {
        data.errors.push({ message: event.error || event.result.error, timestamp: event.timestamp });
      }
    }

    data.summary = this.generateSummary(data);
    return data;
  }

  generateSummary(data) {
    const userMessages = data.messages.filter(m => m.type === 'user');
    const duration = data.endTime && data.startTime
      ? new Date(data.endTime) - new Date(data.startTime) : 0;
    return {
      messageCount: data.messages.length,
      userMessageCount: userMessages.length,
      toolUseCount: data.toolUses.length,
      filesModifiedCount: data.filesModified.length,
      errorCount: data.errors.length,
      durationMs: duration
    };
  }
}
