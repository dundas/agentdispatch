/**
 * Gemini CLI Transcript Adapter
 *
 * Parses Gemini CLI JSON sessions from ~/.gemini/tmp/<sha256>/chats/
 * Project hash: SHA-256 of absolute project path
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

export class GeminiAdapter {
  constructor() {
    this.cli = 'gemini';
    this.baseDir = path.join(os.homedir(), '.gemini', 'tmp');
  }

  /**
   * Compute project hash (SHA-256 of absolute path)
   */
  computeProjectHash(projectPath) {
    const resolved = path.resolve(projectPath);
    return crypto.createHash('sha256').update(resolved).digest('hex');
  }

  /**
   * Discover Gemini CLI transcripts for a project
   */
  async discover(projectPath) {
    const hash = this.computeProjectHash(projectPath);
    const chatsDir = path.join(this.baseDir, hash, 'chats');
    const transcripts = [];

    try {
      const files = await fs.readdir(chatsDir);
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const filePath = path.join(chatsDir, f);
        try {
          const stats = await fs.stat(filePath);
          // Extract session ID from filename or parse file
          const sessionId = f.replace('.json', '');
          transcripts.push({
            cli: this.cli,
            sessionId,
            path: filePath,
            mtime: stats.mtime
          });
        } catch {
          // Skip files we can't stat
        }
      }
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }

    return transcripts;
  }

  /**
   * Parse a Gemini CLI JSON session into normalized format
   */
  async parse(filePath) {
    const content = await fs.readFile(filePath, 'utf-8');
    const session = JSON.parse(content);
    return this.extractData(session);
  }

  extractData(session) {
    const data = {
      cli: this.cli,
      sessionId: session.sessionId || null,
      startTime: session.startTime || null,
      endTime: session.lastUpdated || null,
      cwd: null, // Gemini doesn't store cwd directly in session
      gitBranch: null,
      model: null,
      messages: [],
      toolUses: [],
      filesModified: [],
      errors: [],
      thoughts: [],
      tokens: { input: 0, output: 0, cached: 0, thoughts: 0, tool: 0, total: 0 },
      summary: null
    };

    if (!Array.isArray(session.messages)) {
      data.summary = this.generateSummary(data);
      return data;
    }

    for (const msg of session.messages) {
      // Skip info messages
      if (msg.type === 'info') continue;

      if (msg.type === 'user') {
        data.messages.push({
          type: 'user',
          content: msg.content || '',
          timestamp: msg.timestamp
        });
      } else if (msg.type === 'gemini') {
        // Extract model
        if (msg.model && !data.model) data.model = msg.model;

        // Add assistant message (skip empty content that's just tool calls)
        if (msg.content) {
          data.messages.push({
            type: 'assistant',
            content: msg.content,
            timestamp: msg.timestamp
          });
        }

        // Extract thoughts
        if (Array.isArray(msg.thoughts)) {
          for (const thought of msg.thoughts) {
            data.thoughts.push({
              subject: thought.subject,
              description: thought.description,
              timestamp: thought.timestamp
            });
          }
        }

        // Accumulate tokens
        if (msg.tokens) {
          data.tokens.input += msg.tokens.input || 0;
          data.tokens.output += msg.tokens.output || 0;
          data.tokens.cached += msg.tokens.cached || 0;
          data.tokens.thoughts += msg.tokens.thoughts || 0;
          data.tokens.tool += msg.tokens.tool || 0;
          data.tokens.total += msg.tokens.total || 0;
        }

        // Extract tool calls
        if (Array.isArray(msg.toolCalls)) {
          for (const tc of msg.toolCalls) {
            data.toolUses.push({
              tool: tc.name || tc.displayName || 'unknown',
              parameters: tc.args || {},
              timestamp: tc.timestamp || msg.timestamp,
              status: tc.status
            });

            // Track file modifications
            if (tc.name === 'edit_file' || tc.name === 'write_file') {
              const filePath = tc.args?.file_path || tc.args?.path;
              if (filePath) {
                data.filesModified.push({
                  path: filePath,
                  action: tc.name,
                  timestamp: tc.timestamp || msg.timestamp
                });
              }
            }

            // Track errors from failed tool calls
            if (tc.status === 'failed' && tc.result?.[0]?.functionResponse?.response?.error) {
              data.errors.push({
                message: tc.result[0].functionResponse.response.error,
                timestamp: tc.timestamp || msg.timestamp
              });
            }
          }
        }
      }
    }

    // Try to infer cwd from tool calls (read_file, run_shell_command paths)
    if (!data.cwd) {
      data.cwd = this.inferCwd(data.toolUses);
    }

    data.summary = this.generateSummary(data);
    return data;
  }

  /**
   * Try to infer the working directory from tool call paths
   */
  inferCwd(toolUses) {
    for (const tu of toolUses) {
      if (tu.parameters?.file_path) {
        const dir = path.dirname(tu.parameters.file_path);
        if (dir.startsWith('/')) return dir;
      }
      if (tu.tool === 'run_shell_command' && tu.parameters?.command) {
        const cdMatch = tu.parameters.command.match(/cd\s+([^\s;]+)/);
        if (cdMatch && cdMatch[1].startsWith('/')) return cdMatch[1];
      }
    }
    return null;
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
      model: data.model,
      totalTokens: data.tokens.total,
      thoughtCount: data.thoughts.length
    };
  }
}
