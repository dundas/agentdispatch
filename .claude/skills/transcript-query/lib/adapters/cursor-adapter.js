/**
 * Cursor AI Transcript Adapter
 *
 * Parses Cursor plain text transcripts from ~/.cursor/projects/
 * Format: user:/assistant: markers with <user_query> tags and [Tool call] blocks
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';

export class CursorAdapter {
  constructor() {
    this.cli = 'cursor';
    this.projectsDir = path.join(os.homedir(), '.cursor', 'projects');
  }

  /**
   * Discover Cursor transcripts for a project.
   * Cursor uses project directory name in path.
   */
  async discover(projectPath) {
    const resolvedPath = path.resolve(projectPath);
    const projectName = path.basename(resolvedPath);
    const transcripts = [];

    try {
      await fs.access(this.projectsDir);
    } catch {
      return [];
    }

    try {
      const projects = await fs.readdir(this.projectsDir);

      for (const proj of projects) {
        // Match by project directory name
        if (!proj.includes(projectName)) continue;

        const transcriptDir = path.join(this.projectsDir, proj, 'agent-transcripts');
        try {
          const files = await fs.readdir(transcriptDir);
          for (const f of files) {
            if (!f.endsWith('.txt')) continue;
            const filePath = path.join(transcriptDir, f);
            const stats = await fs.stat(filePath);
            transcripts.push({
              cli: this.cli,
              sessionId: f.replace('.txt', ''),
              path: filePath,
              mtime: stats.mtime
            });
          }
        } catch {
          // No agent-transcripts directory
        }
      }
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }

    return transcripts;
  }

  /**
   * Parse a Cursor plain text transcript into normalized format
   */
  async parse(filePath) {
    const content = await fs.readFile(filePath, 'utf-8');
    const stats = await fs.stat(filePath);
    return this.extractData(content, filePath, stats);
  }

  extractData(content, filePath, stats) {
    const data = {
      cli: this.cli,
      sessionId: path.basename(filePath, '.txt'),
      startTime: stats.birthtime?.toISOString() || stats.mtime.toISOString(),
      endTime: stats.mtime.toISOString(),
      cwd: null,
      gitBranch: null,
      messages: [],
      toolUses: [],
      filesModified: [],
      errors: [],
      summary: null
    };

    // Split into message blocks by user:/assistant: markers
    const blocks = this.splitIntoBlocks(content);

    for (const block of blocks) {
      if (block.role === 'user') {
        // Extract content from <user_query> tags
        const queryMatch = block.content.match(/<user_query>([\s\S]*?)<\/user_query>/);
        const text = queryMatch ? queryMatch[1].trim() : block.content.trim();
        if (text) {
          data.messages.push({ type: 'user', content: text, timestamp: data.startTime });
        }
      } else if (block.role === 'assistant') {
        // Extract text content (remove thinking and tool call blocks)
        const text = this.extractAssistantText(block.content);
        if (text) {
          data.messages.push({ type: 'assistant', content: text, timestamp: data.startTime });
        }

        // Extract tool calls
        const toolCalls = this.extractToolCalls(block.content);
        for (const tc of toolCalls) {
          data.toolUses.push({ tool: tc.name, parameters: tc.params, timestamp: data.startTime });

          // Track file modifications from tool calls
          if (tc.name === 'ApplyPatch' || tc.name === 'Write' || tc.name === 'Edit') {
            const pathParam = tc.params.path || tc.params.file_path;
            if (pathParam) {
              data.filesModified.push({ path: pathParam, action: tc.name, timestamp: data.startTime });
            }
          }
        }
      }
    }

    data.summary = this.generateSummary(data);
    return data;
  }

  /**
   * Split transcript content into role-based blocks
   */
  splitIntoBlocks(content) {
    const blocks = [];
    // Match lines that start with "user:" or "assistant:" as block delimiters
    const lines = content.split('\n');
    let currentBlock = null;
    let currentLines = [];

    for (const line of lines) {
      if (/^user:\s*$/.test(line)) {
        if (currentBlock) {
          blocks.push({ role: currentBlock, content: currentLines.join('\n') });
        }
        currentBlock = 'user';
        currentLines = [];
      } else if (/^assistant:\s*$/.test(line)) {
        if (currentBlock) {
          blocks.push({ role: currentBlock, content: currentLines.join('\n') });
        }
        currentBlock = 'assistant';
        currentLines = [];
      } else {
        currentLines.push(line);
      }
    }

    // Push last block
    if (currentBlock) {
      blocks.push({ role: currentBlock, content: currentLines.join('\n') });
    }

    return blocks;
  }

  /**
   * Extract readable text from assistant block (remove thinking and tool blocks)
   */
  extractAssistantText(content) {
    let text = content;

    // Remove [Thinking] blocks
    text = text.replace(/\[Thinking\][\s\S]*?(?=\[Tool call\]|\[Thinking\]|$)/g, '');

    // Remove [Tool call] ... [Tool result] blocks
    text = text.replace(/\[Tool call\][\s\S]*?\[Tool result\][^\n]*/g, '');

    // Clean up excess whitespace
    text = text.replace(/\n{3,}/g, '\n\n').trim();

    return text;
  }

  /**
   * Extract tool calls from assistant block
   */
  extractToolCalls(content) {
    const toolCalls = [];
    const toolCallRegex = /\[Tool call\]\s*<?(\w+)>?\s*\n([\s\S]*?)(?=\[Tool result\]|\[Tool call\]|$)/g;

    let match;
    while ((match = toolCallRegex.exec(content)) !== null) {
      const name = match[1];
      const paramBlock = match[2].trim();
      const params = {};

      // Parse key: value parameters
      const paramLines = paramBlock.split('\n');
      for (const line of paramLines) {
        const paramMatch = line.match(/^\s+(\w+):\s*(.+)/);
        if (paramMatch) {
          const key = paramMatch[1];
          let value = paramMatch[2].trim();
          // Try to parse JSON values
          try { value = JSON.parse(value); } catch { /* keep as string */ }
          params[key] = value;
        }
      }

      toolCalls.push({ name, params });
    }

    return toolCalls;
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
