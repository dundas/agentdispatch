/**
 * Codex CLI Transcript Adapter
 *
 * Parses Codex .jsonl transcripts from ~/.codex/sessions/
 * Format: { timestamp, type: "session_meta"|"event_msg"|"response_item"|"turn_context", payload }
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';

export class CodexAdapter {
  constructor() {
    this.cli = 'codex';
    this.sessionsDir = path.join(os.homedir(), '.codex', 'sessions');
  }

  /**
   * Discover Codex transcripts for a project.
   * Codex organizes by date, not project — must scan all and filter by cwd.
   */
  async discover(projectPath) {
    const resolvedPath = path.resolve(projectPath);
    const transcripts = [];

    try {
      await fs.access(this.sessionsDir);
    } catch {
      return [];
    }

    // Walk year/month/day directories
    try {
      const years = await fs.readdir(this.sessionsDir);
      for (const year of years) {
        const yearDir = path.join(this.sessionsDir, year);
        const yearStat = await fs.stat(yearDir).catch(() => null);
        if (!yearStat?.isDirectory()) continue;

        const months = await fs.readdir(yearDir);
        for (const month of months) {
          const monthDir = path.join(yearDir, month);
          const monthStat = await fs.stat(monthDir).catch(() => null);
          if (!monthStat?.isDirectory()) continue;

          const days = await fs.readdir(monthDir);
          for (const day of days) {
            const dayDir = path.join(monthDir, day);
            const dayStat = await fs.stat(dayDir).catch(() => null);
            if (!dayStat?.isDirectory()) continue;

            const files = await fs.readdir(dayDir);
            for (const f of files) {
              if (!f.endsWith('.jsonl')) continue;
              const filePath = path.join(dayDir, f);

              // Read first line to check cwd
              const cwd = await this.extractCwd(filePath);
              if (cwd && cwd.startsWith(resolvedPath)) {
                const stats = await fs.stat(filePath);
                const sessionId = await this.extractSessionId(filePath) || f.replace('.jsonl', '');
                transcripts.push({
                  cli: this.cli,
                  sessionId,
                  path: filePath,
                  mtime: stats.mtime
                });
              }
            }
          }
        }
      }
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }

    return transcripts;
  }

  /**
   * Extract cwd from session_meta event (first few lines)
   */
  async extractCwd(filePath) {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n').slice(0, 5);
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === 'session_meta' && event.payload?.cwd) {
            return event.payload.cwd;
          }
        } catch { continue; }
      }
    } catch { /* ignore */ }
    return null;
  }

  async extractSessionId(filePath) {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n').slice(0, 5);
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === 'session_meta' && event.payload?.id) {
            return event.payload.id;
          }
        } catch { continue; }
      }
    } catch { /* ignore */ }
    return null;
  }

  /**
   * Parse a Codex JSONL transcript into normalized format
   */
  async parse(filePath) {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);

    const events = lines.map(line => {
      try { return JSON.parse(line); }
      catch { return null; }
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
      model: null,
      messages: [],
      toolUses: [],
      filesModified: [],
      errors: [],
      summary: null
    };

    for (const event of events) {
      const ts = event.timestamp;
      if (ts) {
        if (!data.startTime || ts < data.startTime) data.startTime = ts;
        if (!data.endTime || ts > data.endTime) data.endTime = ts;
      }

      switch (event.type) {
        case 'session_meta':
          if (event.payload?.id) data.sessionId = event.payload.id;
          if (event.payload?.cwd) data.cwd = event.payload.cwd;
          break;

        case 'event_msg':
          if (event.payload?.type === 'user_message' && event.payload?.message) {
            data.messages.push({
              type: 'user',
              content: event.payload.message,
              timestamp: ts
            });
          }
          break;

        case 'response_item':
          if (event.payload?.role === 'assistant' && Array.isArray(event.payload?.content)) {
            const text = event.payload.content
              .filter(c => c.type === 'output_text')
              .map(c => c.text)
              .join('\n');
            if (text) {
              data.messages.push({
                type: 'assistant',
                content: text,
                timestamp: ts
              });
            }

            // Extract tool calls from function_call content items
            for (const item of event.payload.content) {
              if (item.type === 'function_call') {
                data.toolUses.push({
                  tool: item.name || 'unknown',
                  parameters: item.arguments ? JSON.parse(item.arguments) : {},
                  timestamp: ts
                });
              }
            }
          }
          break;

        case 'turn_context':
          if (event.payload?.model && !data.model) data.model = event.payload.model;
          break;
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
      durationMs: duration,
      model: data.model
    };
  }
}
